/*
 * VFIT Studio - Main API Endpoint
 * Handles all operations via query parameter ?action=...
 *
 * Environment variables required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_SECRET_KEY,
 *   STRIPE_WEBHOOK_SECRET, ADMIN_KEY, SITE_URL
 *
 * Optional (SMS via Twilio):
 *   TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, OWNER_PHONE
 *
 * ──────────────────────────────────────────────
 * SUPABASE DATABASE SCHEMA
 * Run this in the Supabase SQL Editor:
 * ──────────────────────────────────────────────
 *
 * create table events (
 *   id uuid default gen_random_uuid() primary key,
 *   name text not null,
 *   type text not null,                        -- 'runclub' or 'pilattes'
 *   tickets_open timestamptz not null,
 *   session_date timestamptz not null,
 *   spots_total integer not null default 20,
 *   price_cents integer not null default 0,    -- 0 = free, 1500 = $15.00
 *   status text not null default 'active',     -- active, closed, archived
 *   created_at timestamptz default now()
 * );
 *
 * create table bookings (
 *   id uuid default gen_random_uuid() primary key,
 *   event_id uuid references events(id),
 *   name text not null,
 *   email text not null,
 *   phone text,
 *   status text not null default 'held',       -- held, confirmed, cancelled, expired
 *   stripe_session_id text,
 *   stripe_payment_id text,
 *   amount_cents integer default 0,
 *   held_at timestamptz default now(),
 *   confirmed_at timestamptz,
 *   created_at timestamptz default now()
 * );
 *
 * create table memberships (
 *   id uuid default gen_random_uuid() primary key,
 *   name text not null,
 *   email text not null,
 *   phone text,
 *   plan text not null,
 *   sessions text,
 *   days text,
 *   times text,
 *   notes text,
 *   status text not null default 'new',        -- new, contacted, active, inactive
 *   created_at timestamptz default now()
 * );
 *
 * create table notifications (
 *   id uuid default gen_random_uuid() primary key,
 *   email text not null,
 *   name text,
 *   interest text,
 *   type text default 'notify',                -- notify, waitlist
 *   notified boolean default false,
 *   created_at timestamptz default now()
 * );
 *
 * create table contacts (
 *   id uuid default gen_random_uuid() primary key,
 *   name text not null,
 *   email text not null,
 *   phone text,
 *   message text,
 *   created_at timestamptz default now()
 * );
 *
 * create table if not exists reviews (
 *   id uuid default gen_random_uuid() primary key,
 *   event_id uuid references events(id),
 *   email text not null,
 *   rating integer not null,
 *   comment text,
 *   created_at timestamptz default now()
 * );
 *
 * -- Add to bookings table: referral_code text
 */

const { supabase } = require('./utils/supabase');
const { sendNotifyConfirmation, sendBookingsOpenEmail, sendBookingConfirmation, sendMembershipConfirmation, sendOwnerAlert, sendWaitlistSpotEmail, sendReviewRequestEmail } = require('./utils/email');
const { sendOwnerSMS } = require('./utils/sms');
const { requireMember, sendMagicLink } = require('./utils/lounge-auth');
const {
  evaluateCancellation,
  pauseDaysUsed,
  pauseDaysInRange,
  PAUSE_CAP_DAYS_PER_YEAR,
} = require('./utils/lounge-policy');
const {
  isStripeConfigured,
  getPlanForMember,
  estimateSessionFeeCents,
  buildPortalSession,
} = require('./utils/lounge-billing');

// Stripe SDK is ~5MB. Lazy-load it so non-checkout requests (which is
// >95% of traffic — the website, lounge, admin reads) don't pay the
// load cost on every cold start.
let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  const Stripe = require('stripe');
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
const SITE_URL = process.env.SITE_URL || 'https://vfit-studio.netlify.app';
const ADMIN_KEY = process.env.ADMIN_KEY;
const HOLD_EXPIRY_MINUTES = 10;

// ─── CORS headers applied to every response ─────────────────────────
// Restricted to first-party origins (was '*' on every endpoint, which
// let any third-party page mount a form against the admin handlers).
const ALLOWED_ORIGINS = new Set([
  'https://valdalfit.com.au',
  'https://www.valdalfit.com.au',
  'https://vfit-studio.netlify.app',
  'http://localhost:5173',
  'http://localhost:8888',
]);

function corsHeadersFor(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || '';
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://valdalfit.com.au';
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}
// Default headers kept for back-compat with handler internals that
// reference CORS_HEADERS directly.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://valdalfit.com.au',
  'Vary': 'Origin',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// HTML-escape helper for any user-controlled string we splice into an
// outbound HTML email (owner alerts, member-facing transactional mail).
function escapeHtmlPlain(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// ─── Cleanup expired holds ───
// Throttled to once per minute per Lambda instance — was running on
// every POST, paying for a write to the bookings table even on
// unrelated requests (and giving attackers a write-amplification surface).
let _lastHoldCleanup = 0;
async function cleanupExpiredHolds() {
  const now = Date.now();
  if (now - _lastHoldCleanup < 60_000) return;
  _lastHoldCleanup = now;
  const cutoff = new Date(now - HOLD_EXPIRY_MINUTES * 60 * 1000).toISOString();
  await supabase
    .from('bookings')
    .update({ status: 'expired' })
    .eq('status', 'held')
    .lt('held_at', cutoff);
}

// ─── Validate admin key (POST body) ───
// Constant-time compare to avoid leaking length/character via timing.
function requireAdmin(adminKey) {
  if (!adminKey || !ADMIN_KEY) throw new Error('unauthorized');
  const a = Buffer.from(String(adminKey));
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length) throw new Error('unauthorized');
  const crypto = require('crypto');
  if (!crypto.timingSafeEqual(a, b)) throw new Error('unauthorized');
}

// ─── Validate admin key for GET requests (header or query param) ───
// GET handlers can't rely on body, so accept the key from either an
// X-Admin-Key header (preferred) or ?admin_key=... query param.
function requireAdminFromEvent(event) {
  const headers = event?.headers || {};
  const headerKey = headers['x-admin-key'] || headers['X-Admin-Key'] || headers['x-Admin-Key'];
  const queryKey = event?.queryStringParameters?.admin_key;
  requireAdmin(headerKey || queryKey);
}

// ─── Count taken spots for an event (confirmed + held) ───
function formatSessionDate(dateStr) {
  try {
    const d = new Date(dateStr);
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()];
  } catch(e) { return dateStr; }
}

async function spotsTaken(eventId) {
  const { count, error } = await supabase
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .in('status', ['confirmed', 'held']);
  if (error) throw error;
  return count || 0;
}

// ═══════════════════════════════════════════════
// GET handlers
// ═══════════════════════════════════════════════

async function handleConfig() {
  // Run cleanup + events fetch in parallel so we don't pay two round-trips.
  const [, eventsRes] = await Promise.all([
    cleanupExpiredHolds(),
    supabase
      .from('events')
      .select('*')
      .eq('status', 'active')
      .gte('session_date', new Date().toISOString())
      .order('session_date', { ascending: true }),
  ]);
  if (eventsRes.error) throw eventsRes.error;
  const events = eventsRes.data || [];

  // Fetch spots-taken for every event in a single batched query (one
  // round-trip instead of N) by selecting all eligible bookings and
  // tallying client-side.
  const eventIds = events.map((e) => e.id);
  let takenMap = {};
  if (eventIds.length) {
    const { data: bookings } = await supabase
      .from('bookings')
      .select('event_id')
      .in('event_id', eventIds)
      .in('status', ['confirmed', 'held']);
    for (const b of (bookings || [])) {
      takenMap[b.event_id] = (takenMap[b.event_id] || 0) + 1;
    }
  }

  const config = events.map((event) => ({
    id: event.id,
    name: event.name,
    type: event.type,
    tickets_open: event.tickets_open,
    session_date: event.session_date,
    spots_total: event.spots_total,
    spots_remaining: Math.max(0, event.spots_total - (takenMap[event.id] || 0)),
    price_cents: event.price_cents,
    glofox_url: event.glofox_url || null,
    status: event.status,
  }));

  return respond(200, { success: true, events: config });
}

async function handleEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .order('session_date', { ascending: false });
  if (error) throw error;
  return respond(200, { success: true, events: data });
}

async function handleBookings(eventId) {
  if (!eventId) return respond(400, { success: false, error: 'event_id required' });
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('event_id', eventId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return respond(200, { success: true, bookings: data });
}

async function handleNotifications() {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return respond(200, { success: true, notifications: data });
}

async function handleDashboard() {
  const [upcomingRes, memberCount, enquiryCount] = await Promise.all([
    supabase.from('events').select('*').eq('status', 'active')
      .gte('session_date', new Date().toISOString())
      .order('session_date', { ascending: true }),
    supabase.from('members').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('memberships').select('*', { count: 'exact', head: true }),
  ]);

  return respond(200, {
    success: true,
    dashboard: {
      upcoming_events: upcomingRes.data || [],
      total_memberships: enquiryCount.count || 0,
      total_members: memberCount.count || 0,
    },
  });
}

// ═══════════════════════════════════════════════
// POST handlers
// ═══════════════════════════════════════════════

async function handleBook(body) {
  const { name, email, phone, event_id, referral_code } = body;
  if (!name || !email || !event_id) {
    return respond(400, { success: false, error: 'name, email, and event_id are required' });
  }

  // Fetch event
  const { data: event, error: eventErr } = await supabase
    .from('events')
    .select('*')
    .eq('id', event_id)
    .single();
  if (eventErr || !event) {
    return respond(404, { success: false, error: 'event_not_found' });
  }

  // Check spots
  const taken = await spotsTaken(event_id);
  if (taken >= event.spots_total) {
    return respond(200, { success: false, error: 'sold_out' });
  }

  // Check duplicate
  const { count: dupeCount } = await supabase
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', event_id)
    .eq('email', email.toLowerCase().trim())
    .in('status', ['confirmed', 'held']);
  if (dupeCount > 0) {
    return respond(200, { success: false, error: 'duplicate' });
  }

  // Create booking row (held)
  const { data: booking, error: bookErr } = await supabase
    .from('bookings')
    .insert({
      event_id,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      phone: phone ? phone.trim() : null,
      status: event.price_cents === 0 ? 'confirmed' : 'held',
      amount_cents: event.price_cents,
      held_at: new Date().toISOString(),
      confirmed_at: event.price_cents === 0 ? new Date().toISOString() : null,
      referral_code: referral_code ? referral_code.trim().toUpperCase() : null,
    })
    .select()
    .single();
  if (bookErr) throw bookErr;

  // Free event — skip Stripe, already confirmed
  if (event.price_cents === 0) {
    const spotsRemaining = Math.max(0, event.spots_total - taken - 1);
    const sessionInfo = event.type === 'runclub'
      ? 'Every Tuesday · 5:15 AM · Glennie School Track'
      : formatSessionDate(event.session_date) + ' · 7:00 AM · The Dairy, Ravensbourne';
    // Send confirmation email to booker
    await sendBookingConfirmation(email, name, event.name, sessionInfo);
    // Alert Georgie
    await sendOwnerAlert(
      `New Booking — ${event.name} (${taken + 1}/${event.spots_total})`,
      `<p><strong>${escapeHtmlPlain(name)}</strong> (${escapeHtmlPlain(email)}, ${escapeHtmlPlain(phone || 'no phone')}) booked <strong>${escapeHtmlPlain(event.name)}</strong>.</p><p>Spots: ${taken + 1} / ${event.spots_total}</p>`
    );
    // SMS alert
    await sendOwnerSMS(`VFIT: New booking — ${name} for ${event.name}. ${taken + 1}/${event.spots_total} spots taken.`);
    return respond(200, {
      success: true,
      message: 'Booking confirmed! Check your email.',
      booking_id: booking.id,
      spots_remaining: spotsRemaining,
      free: true,
    });
  }

  // Create Stripe Checkout Session
  const session = await stripe().checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: 'aud',
          unit_amount: event.price_cents,
          product_data: { name: event.name },
        },
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: `${SITE_URL}?booking=success`,
    cancel_url: `${SITE_URL}?booking=cancelled`,
    metadata: {
      booking_id: booking.id,
      event_id: event.id,
    },
    customer_email: email.toLowerCase().trim(),
    expires_at: Math.floor(Date.now() / 1000) + 600, // 10 minutes
  });

  // Update booking with stripe session id
  await supabase
    .from('bookings')
    .update({ stripe_session_id: session.id })
    .eq('id', booking.id);

  const spotsRemaining = Math.max(0, event.spots_total - taken - 1);
  return respond(200, {
    success: true,
    checkout_url: session.url,
    booking_id: booking.id,
    spots_remaining: spotsRemaining,
  });
}

async function handleNotify(body) {
  const { name, email, interest } = body;
  if (!email) return respond(400, { success: false, error: 'email is required' });

  const { error } = await supabase.from('notifications').insert({
    email: email.toLowerCase().trim(),
    name: name ? name.trim() : null,
    interest: interest || null,
    type: 'notify',
  });
  if (error) throw error;

  // Send confirmation email
  await sendNotifyConfirmation(email, name, interest);
  // Alert Georgie
  await sendOwnerAlert('New notification signup', `<p><strong>${escapeHtmlPlain(name || 'Unknown')}</strong> (${escapeHtmlPlain(email)}) wants to be notified about <strong>${escapeHtmlPlain(interest || 'upcoming sessions')}</strong>.</p>`);

  return respond(200, { success: true, message: "You're on the list! We'll email you when bookings open." });
}

async function handleWaitlist(body) {
  const { name, email, interest } = body;
  if (!email) return respond(400, { success: false, error: 'email is required' });

  const { error } = await supabase.from('notifications').insert({
    email: email.toLowerCase().trim(),
    name: name ? name.trim() : null,
    interest: interest || null,
    type: 'waitlist',
  });
  if (error) throw error;

  // Send confirmation email
  await sendNotifyConfirmation(email, name, interest);
  // Alert Georgie
  await sendOwnerAlert('New waitlist signup', `<p><strong>${escapeHtmlPlain(name || 'Unknown')}</strong> (${escapeHtmlPlain(email)}) joined the waitlist for <strong>${escapeHtmlPlain(interest || 'upcoming sessions')}</strong>.</p>`);

  return respond(200, { success: true, message: "You're on the waitlist! We'll email you if a spot opens up." });
}

async function handleContact(body) {
  const { name, email, phone, message } = body;
  if (!name || !email) return respond(400, { success: false, error: 'name and email are required' });

  const { error } = await supabase.from('contacts').insert({
    name: name.trim(),
    email: email.toLowerCase().trim(),
    phone: phone ? phone.trim() : null,
    message: message || null,
  });
  if (error) throw error;
  return respond(200, { success: true, message: 'Message sent!' });
}

async function handleMembership(body) {
  const { name, email, phone, plan, sessions, days, times, notes } = body;
  if (!name || !email || !plan) {
    return respond(400, { success: false, error: 'name, email, and plan are required' });
  }

  const { error } = await supabase.from('memberships').insert({
    name: name.trim(),
    email: email.toLowerCase().trim(),
    phone: phone ? phone.trim() : null,
    plan,
    sessions: sessions || null,
    days: days || null,
    times: times || null,
    notes: notes || null,
  });
  if (error) throw error;
  return respond(200, { success: true, message: 'Enquiry received! We will be in touch shortly.' });
}

async function handleCreateEvent(body) {
  requireAdmin(body.admin_key);
  const { name, type, session_date, spots_total, price_cents, glofox_url } = body;
  const tickets_open = body.tickets_open || session_date;
  if (!name || !type || !session_date) {
    return respond(400, { success: false, error: 'name, type, and session_date are required' });
  }

  const { data, error } = await supabase
    .from('events')
    .insert({
      name,
      type,
      tickets_open,
      session_date,
      spots_total: spots_total || 20,
      price_cents: price_cents || 0,
      glofox_url: glofox_url || null,
    })
    .select()
    .single();
  if (error) throw error;
  return respond(200, { success: true, event: data });
}

async function handleUpdateEvent(body) {
  requireAdmin(body.admin_key);
  const { event_id } = body;
  if (!event_id) return respond(400, { success: false, error: 'event_id is required' });

  const ALLOWED = ['name', 'type', 'tickets_open', 'session_date',
                   'spots_total', 'price_cents', 'status', 'glofox_url'];
  const update = {};
  for (const k of ALLOWED) if (k in body) update[k] = body[k];
  if (!Object.keys(update).length) {
    return respond(400, { success: false, error: 'no fields to update' });
  }

  const { data, error } = await supabase
    .from('events')
    .update(update)
    .eq('id', event_id)
    .select()
    .single();
  if (error) throw error;
  return respond(200, { success: true, event: data });
}

async function handleCancelBooking(body) {
  requireAdmin(body.admin_key);
  const { booking_id } = body;
  if (!booking_id) return respond(400, { success: false, error: 'booking_id is required' });

  const { data: booking, error: fetchErr } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', booking_id)
    .single();
  if (fetchErr || !booking) {
    return respond(404, { success: false, error: 'booking_not_found' });
  }

  // Process Stripe refund if there was a payment
  if (booking.stripe_payment_id && booking.amount_cents > 0) {
    try {
      await stripe.refunds.create({ payment_intent: booking.stripe_payment_id });
    } catch (refundErr) {
      // Log but don't fail — the payment may already be refunded
      console.error('Stripe refund error:', refundErr.message);
    }
  }

  const { error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', booking_id);
  if (error) throw error;

  // Auto-promote from waitlist
  await autoPromoteWaitlist(booking.event_id);

  return respond(200, { success: true });
}

async function handleSendNotifications(body) {
  requireAdmin(body.admin_key);
  const { event_type } = body;
  if (!event_type) return respond(400, { success: false, error: 'event_type is required' });

  // Fetch un-notified signups matching interest/type
  const { data: signups, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('notified', false)
    .or(`interest.eq.${event_type},interest.is.null`);
  if (error) throw error;

  // Mark them as notified
  if (signups && signups.length > 0) {
    const ids = signups.map((s) => s.id);
    await supabase
      .from('notifications')
      .update({ notified: true })
      .in('id', ids);
  }

  // Send "bookings are open" email to each signup
  const siteUrl = process.env.SITE_URL || 'https://vfit-studio.netlify.app';
  let sent = 0;
  for (const signup of (signups || [])) {
    try {
      await sendBookingsOpenEmail(signup.email, signup.name, event_type, siteUrl);
      sent++;
    } catch (e) {
      console.error('Failed to email:', signup.email, e);
    }
  }

  // Alert Georgie
  await sendOwnerAlert(
    `Notifications sent — ${event_type}`,
    `<p>Sent <strong>${sent}</strong> "bookings are open" emails for <strong>${escapeHtmlPlain(event_type)}</strong>.</p>`
  );

  return respond(200, { success: true, count: sent, message: `${sent} notification emails sent!` });
}

async function handleMemberships() {
  const { data, error } = await supabase
    .from('memberships')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return respond(200, { success: true, data: data || [] });
}

async function handleContacts() {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return respond(200, { success: true, data: data || [] });
}

async function handleCleanupHolds() {
  await cleanupExpiredHolds();
  return respond(200, { success: true });
}

// ═══════════════════════════════════════════════
// Membership scheduling handlers
// ═══════════════════════════════════════════════

async function handleGetMembers() {
  const { data: members, error } = await supabase
    .from('members')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;

  // Fetch all slot assignments with slot details
  const memberIds = (members || []).map((m) => m.id);
  // Lounge auth links — present iff the member has signed in to the lounge
  let loungeMap = {};
  if (memberIds.length > 0) {
    const { data: links } = await supabase
      .from('member_auth')
      .select('member_id, last_login_at')
      .in('member_id', memberIds);
    for (const l of (links || [])) loungeMap[l.member_id] = l.last_login_at;
  }
  let slotMap = {};
  if (memberIds.length > 0) {
    const { data: assignments, error: slotErr } = await supabase
      .from('member_slots')
      .select('member_id, slot_id, schedule_slots(id, day_of_week, time)')
      .eq('status', 'active')
      .in('member_id', memberIds);
    if (slotErr) throw slotErr;

    for (const a of (assignments || [])) {
      if (!slotMap[a.member_id]) slotMap[a.member_id] = [];
      if (a.schedule_slots) {
        slotMap[a.member_id].push({
          slot_id: a.schedule_slots.id,
          day_of_week: a.schedule_slots.day_of_week,
          time: a.schedule_slots.time,
        });
      }
    }
  }

  const result = (members || []).map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    phone: m.phone,
    plan: m.plan,
    sessions_per_week: m.sessions_per_week,
    status: m.status,
    start_date: m.start_date,
    notes: m.notes,
    welcome_sent_at: m.welcome_sent_at,
    agreed_at: m.agreed_at,
    lounge_active: !!loungeMap[m.id],
    lounge_last_login_at: loungeMap[m.id] || null,
    slots: slotMap[m.id] || [],
  }));

  return respond(200, { success: true, members: result });
}

async function handleGetSchedule() {
  const { data: slotsRaw, error } = await supabase
    .from('schedule_slots')
    .select('*')
    .eq('status', 'active');
  if (error) throw error;

  // Sort by chronological time, not alphabetical (so 5:15 AM comes before 10:15 AM)
  const timeToMinutes = (t) => {
    const m = String(t || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return 99999;
    let h = parseInt(m[1], 10);
    const mn = parseInt(m[2], 10);
    const ampm = m[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h * 60 + mn;
  };
  const slots = (slotsRaw || []).slice().sort((a, b) => {
    if (a.day_of_week !== b.day_of_week) return a.day_of_week - b.day_of_week;
    return timeToMinutes(a.time) - timeToMinutes(b.time);
  });

  const slotIds = (slots || []).map((s) => s.id);
  let assignmentMap = {};
  if (slotIds.length > 0) {
    const { data: assignments, error: aErr } = await supabase
      .from('member_slots')
      .select('slot_id, members(id, name, plan)')
      .eq('status', 'active')
      .in('slot_id', slotIds);
    if (aErr) throw aErr;

    for (const a of (assignments || [])) {
      if (!assignmentMap[a.slot_id]) assignmentMap[a.slot_id] = [];
      if (a.members) {
        assignmentMap[a.slot_id].push({
          id: a.members.id,
          name: a.members.name,
          plan: a.members.plan,
        });
      }
    }
  }

  // Group by day_of_week
  const schedule = {};
  for (const slot of (slots || [])) {
    const day = String(slot.day_of_week);
    if (!schedule[day]) schedule[day] = [];
    schedule[day].push({
      id: slot.id,
      time: slot.time,
      max_capacity: slot.max_capacity,
      members: assignmentMap[slot.id] || [],
    });
  }

  return respond(200, { success: true, schedule });
}

async function handleGetMember(memberId) {
  if (!memberId) return respond(400, { success: false, error: 'id is required' });

  const { data: member, error } = await supabase
    .from('members')
    .select('*')
    .eq('id', memberId)
    .single();
  if (error || !member) return respond(404, { success: false, error: 'member_not_found' });

  const { data: assignments, error: slotErr } = await supabase
    .from('member_slots')
    .select('slot_id, schedule_slots(id, day_of_week, time)')
    .eq('status', 'active')
    .eq('member_id', memberId);
  if (slotErr) throw slotErr;

  const slots = (assignments || [])
    .filter((a) => a.schedule_slots)
    .map((a) => ({
      slot_id: a.schedule_slots.id,
      day_of_week: a.schedule_slots.day_of_week,
      time: a.schedule_slots.time,
    }));

  return respond(200, {
    success: true,
    member: {
      id: member.id,
      name: member.name,
      email: member.email,
      phone: member.phone,
      plan: member.plan,
      sessions_per_week: member.sessions_per_week,
      status: member.status,
      start_date: member.start_date,
      notes: member.notes,
      slots,
    },
  });
}

async function handleAcceptMembership(body) {
  requireAdmin(body.admin_key);
  const { membership_id, name, email, phone, plan, sessions_per_week, slot_ids } = body;
  if (!membership_id) return respond(400, { success: false, error: 'membership_id is required' });

  // Fetch the membership enquiry
  const { data: enquiry, error: fetchErr } = await supabase
    .from('memberships')
    .select('*')
    .eq('id', membership_id)
    .single();
  if (fetchErr || !enquiry) return respond(404, { success: false, error: 'membership_not_found' });

  // Create the member record (override fields from modal if provided)
  const { data: member, error: insertErr } = await supabase
    .from('members')
    .insert({
      membership_id: enquiry.id,
      name: name || enquiry.name,
      email: email || enquiry.email,
      phone: phone || enquiry.phone || null,
      plan: plan || enquiry.plan,
      sessions_per_week: sessions_per_week || 1,
      status: 'active',
      start_date: new Date().toISOString().split('T')[0],
    })
    .select()
    .single();
  if (insertErr) throw insertErr;

  // Update the membership enquiry status to 'active'
  const { error: updateErr } = await supabase
    .from('memberships')
    .update({ status: 'active' })
    .eq('id', membership_id);
  if (updateErr) throw updateErr;

  // Optionally assign the chosen slots in one go
  let assigned_slots = [];
  let slot_errors = [];
  if (Array.isArray(slot_ids) && slot_ids.length > 0) {
    for (const slot_id of slot_ids) {
      const { data: slot } = await supabase.from('schedule_slots').select('*').eq('id', slot_id).single();
      if (!slot) { slot_errors.push({ slot_id, error: 'not_found' }); continue; }
      const { count } = await supabase
        .from('member_slots')
        .select('*', { count: 'exact', head: true })
        .eq('slot_id', slot_id)
        .eq('status', 'active');
      if ((count || 0) >= slot.max_capacity) {
        slot_errors.push({ slot_id, time: slot.time, day_of_week: slot.day_of_week, error: 'full' });
        continue;
      }
      const { error: aerr } = await supabase.from('member_slots').insert({ member_id: member.id, slot_id, status: 'active' });
      if (aerr) slot_errors.push({ slot_id, error: aerr.message });
      else assigned_slots.push(slot_id);
    }
  }

  return respond(200, { success: true, member, assigned_slots, slot_errors });
}

const DAY_NAMES_FULL = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const OWNER_PHONE_DISPLAY = '0417 645 924';

async function fetchMemberSlots(memberId) {
  const { data: assignments, error } = await supabase
    .from('member_slots')
    .select('schedule_slots(day_of_week, time)')
    .eq('status', 'active')
    .eq('member_id', memberId);
  if (error) return [];
  return (assignments || [])
    .filter((a) => a.schedule_slots)
    .map((a) => ({ day_of_week: a.schedule_slots.day_of_week, time: a.schedule_slots.time }))
    .sort((a, b) => (a.day_of_week - b.day_of_week) || String(a.time).localeCompare(String(b.time)));
}

function formatSlotLine(slot) {
  const day = DAY_NAMES_FULL[slot.day_of_week] || 'Day ' + slot.day_of_week;
  return `${day} · ${slot.time}`;
}

async function handleSendWelcome(body) {
  requireAdmin(body.admin_key);
  const { member_id } = body;
  if (!member_id) return respond(400, { success: false, error: 'member_id is required' });

  const { data: member, error: fetchErr } = await supabase
    .from('members')
    .select('*')
    .eq('id', member_id)
    .single();
  if (fetchErr || !member) return respond(404, { success: false, error: 'member_not_found' });

  // Ensure token exists (in case row predates the migration default)
  let token = member.agreement_token;
  if (!token) {
    const { randomUUID } = require('crypto');
    token = randomUUID();
    await supabase.from('members').update({ agreement_token: token }).eq('id', member_id);
  }

  const agreementUrl = `${SITE_URL}/agreement.html?token=${token}`;

  // Build slot list: prefer assigned slots, fall back to enquiry preferences
  const slots = await fetchMemberSlots(member_id);
  let slotLines = slots.map(formatSlotLine);
  if (slotLines.length === 0 && member.membership_id) {
    const { data: enquiry } = await supabase
      .from('memberships')
      .select('days, times')
      .eq('id', member.membership_id)
      .single();
    if (enquiry && enquiry.days && enquiry.days !== 'Not specified') {
      const suffix = (enquiry.times && enquiry.times !== 'Not specified') ? ' — ' + enquiry.times : '';
      slotLines = [`${enquiry.days}${suffix} (to be confirmed)`];
    }
  }

  const { sendWelcomeEmail } = require('./utils/email');
  await sendWelcomeEmail(member.email, member.name, member.plan, slotLines, agreementUrl, OWNER_PHONE_DISPLAY);

  await supabase.from('members').update({ welcome_sent_at: new Date().toISOString() }).eq('id', member_id);

  return respond(200, {
    success: true,
    email_configured: !!process.env.RESEND_API_KEY,
    agreement_url: agreementUrl,
  });
}

async function handleGetAgreement(token) {
  if (!token) return respond(400, { success: false, error: 'token required' });

  const { data: member, error } = await supabase
    .from('members')
    .select('id, name, plan, sessions_per_week, agreed_at')
    .eq('agreement_token', token)
    .single();
  if (error || !member) return respond(404, { success: false, error: 'invalid_token' });

  const slots = await fetchMemberSlots(member.id);

  return respond(200, {
    success: true,
    name: member.name,
    plan: member.plan,
    sessions_per_week: member.sessions_per_week,
    slots,
    agreed_at: member.agreed_at,
    owner_phone: OWNER_PHONE_DISPLAY,
  });
}

async function handleConfirmAgreement(body) {
  const { token } = body;
  if (!token) return respond(400, { success: false, error: 'token required' });

  const { data: existing, error } = await supabase
    .from('members')
    .select('id, name, plan, agreed_at')
    .eq('agreement_token', token)
    .single();
  if (error || !existing) return respond(404, { success: false, error: 'invalid_token' });

  if (existing.agreed_at) {
    return respond(200, { success: true, already_agreed: true, agreed_at: existing.agreed_at });
  }

  const now = new Date().toISOString();
  const { error: updErr } = await supabase
    .from('members')
    .update({ agreed_at: now })
    .eq('id', existing.id);
  if (updErr) throw updErr;

  // Notify Georgie (email only)
  try {
    const { sendOwnerAlert } = require('./utils/email');
    const when = new Date(now).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
    await sendOwnerAlert(
      `VFIT — ${existing.name} confirmed their agreement`,
      `<h2 style="font-family:Georgia,serif;font-size:22px;color:#3d3530;margin:0 0 14px;">Agreement confirmed</h2>
       <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 14px;"><strong>${escapeHtmlPlain(existing.name)}</strong> (${escapeHtmlPlain(existing.plan)}) confirmed their liability waiver and cancellation policy.</p>
       <p style="font-size:13px;color:#8c7660;margin:0;">${escapeHtmlPlain(when)}</p>`
    );
  } catch (e) { console.error('Owner notify error:', e); }

  return respond(200, { success: true, agreed_at: now });
}

async function handleCreateMember(body) {
  requireAdmin(body.admin_key);
  const { name, email, phone, plan, sessions_per_week, notes } = body;
  if (!name || !email || !plan) {
    return respond(400, { success: false, error: 'name, email, and plan are required' });
  }

  const { data: member, error } = await supabase
    .from('members')
    .insert({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      phone: phone ? phone.trim() : null,
      plan,
      sessions_per_week: sessions_per_week || 1,
      status: 'active',
      start_date: new Date().toISOString().split('T')[0],
      notes: notes || null,
    })
    .select()
    .single();
  if (error) throw error;

  return respond(200, { success: true, member });
}

async function handleUpdateMember(body) {
  requireAdmin(body.admin_key);
  const { member_id } = body;
  if (!member_id) return respond(400, { success: false, error: 'member_id is required' });

  // Explicit allowlist — never let a request overwrite agreement_token,
  // agreed_at, ical_token, stripe_customer_id or any other security-
  // critical column via mass-assignment.
  const ALLOWED = ['name', 'email', 'phone', 'plan', 'sessions_per_week',
                   'status', 'start_date', 'notes', 'admin_notes',
                   'goals', 'health_notes', 'last_contacted_at'];
  const update = {};
  for (const k of ALLOWED) if (k in body) update[k] = body[k];
  if (!Object.keys(update).length) {
    return respond(400, { success: false, error: 'no fields to update' });
  }

  const { data: member, error } = await supabase
    .from('members')
    .update(update)
    .eq('id', member_id)
    .select()
    .single();
  if (error) throw error;

  return respond(200, { success: true, member });
}

async function handleCreateSlot(body) {
  requireAdmin(body.admin_key);
  const { day_of_week, time, max_capacity } = body;
  if (day_of_week === undefined || !time) {
    return respond(400, { success: false, error: 'day_of_week and time are required' });
  }

  const { data: slot, error } = await supabase
    .from('schedule_slots')
    .insert({
      day_of_week,
      time,
      max_capacity: max_capacity || 4,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;

  return respond(200, { success: true, slot });
}

async function handleUpdateSlot(body) {
  requireAdmin(body.admin_key);
  const { slot_id } = body;
  if (!slot_id) return respond(400, { success: false, error: 'slot_id is required' });

  const ALLOWED = ['day_of_week', 'time', 'max_capacity', 'status', 'session_type'];
  const update = {};
  for (const k of ALLOWED) if (k in body) update[k] = body[k];
  if (!Object.keys(update).length) {
    return respond(400, { success: false, error: 'no fields to update' });
  }

  const { data: slot, error } = await supabase
    .from('schedule_slots')
    .update(update)
    .eq('id', slot_id)
    .select()
    .single();
  if (error) throw error;

  return respond(200, { success: true, slot });
}

async function handleDeleteSlot(body) {
  requireAdmin(body.admin_key);
  const { slot_id } = body;
  if (!slot_id) return respond(400, { success: false, error: 'slot_id is required' });

  const { data: slot, error } = await supabase
    .from('schedule_slots')
    .update({ status: 'inactive' })
    .eq('id', slot_id)
    .select()
    .single();
  if (error) throw error;

  return respond(200, { success: true, slot });
}

async function handleAssignSlot(body) {
  requireAdmin(body.admin_key);
  const { member_id, slot_id } = body;
  if (!member_id || !slot_id) {
    return respond(400, { success: false, error: 'member_id and slot_id are required' });
  }

  // Fetch the slot to check capacity
  const { data: slot, error: slotErr } = await supabase
    .from('schedule_slots')
    .select('*')
    .eq('id', slot_id)
    .single();
  if (slotErr || !slot) return respond(404, { success: false, error: 'slot_not_found' });

  // Count current active assignments for this slot
  const { count, error: countErr } = await supabase
    .from('member_slots')
    .select('*', { count: 'exact', head: true })
    .eq('slot_id', slot_id)
    .eq('status', 'active');
  if (countErr) throw countErr;

  if ((count || 0) >= slot.max_capacity) {
    return respond(400, { success: false, error: 'slot_full', message: `This slot is full (${count}/${slot.max_capacity})` });
  }

  const { data: assignment, error } = await supabase
    .from('member_slots')
    .insert({
      member_id,
      slot_id,
      status: 'active',
    })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      return respond(400, { success: false, error: 'already_assigned', message: 'Member is already assigned to this slot' });
    }
    throw error;
  }

  return respond(200, { success: true, assignment });
}

async function handleUnassignSlot(body) {
  requireAdmin(body.admin_key);
  const { member_id, slot_id } = body;
  if (!member_id || !slot_id) {
    return respond(400, { success: false, error: 'member_id and slot_id are required' });
  }

  const { error } = await supabase
    .from('member_slots')
    .delete()
    .eq('member_id', member_id)
    .eq('slot_id', slot_id);
  if (error) throw error;

  return respond(200, { success: true });
}

// ═══════════════════════════════════════════════
// Waitlist auto-promote
// ═══════════════════════════════════════════════

async function autoPromoteWaitlist(eventId) {
  try {
    // Fetch the event to know its type/name
    const { data: event } = await supabase
      .from('events')
      .select('*')
      .eq('id', eventId)
      .single();
    if (!event) return;

    // Find the oldest un-notified waitlist signup matching this event type
    const { data: waitlistEntries } = await supabase
      .from('notifications')
      .select('*')
      .eq('type', 'waitlist')
      .eq('notified', false)
      .or(`interest.ilike.%${event.type}%,interest.ilike.%${event.name}%,interest.is.null`)
      .order('created_at', { ascending: true })
      .limit(1);

    if (!waitlistEntries || waitlistEntries.length === 0) return;

    const entry = waitlistEntries[0];
    const siteUrl = process.env.SITE_URL || 'https://vfit-studio.netlify.app';

    // Send spot-opened email
    await sendWaitlistSpotEmail(entry.email, entry.name, event.name, siteUrl);

    // SMS alert to owner
    await sendOwnerSMS(`VFIT: Spot opened — auto-notified ${entry.name || entry.email} from waitlist.`);

    // Mark as notified
    await supabase
      .from('notifications')
      .update({ notified: true })
      .eq('id', entry.id);
  } catch (err) {
    console.error('Waitlist auto-promote error:', err);
  }
}

// ═══════════════════════════════════════════════
// Post-session review requests
// ═══════════════════════════════════════════════

async function handleSendReviewRequests(body) {
  requireAdmin(body.admin_key);
  const { event_id } = body;
  if (!event_id) return respond(400, { success: false, error: 'event_id is required' });

  // Fetch event
  const { data: event, error: eventErr } = await supabase
    .from('events')
    .select('*')
    .eq('id', event_id)
    .single();
  if (eventErr || !event) return respond(404, { success: false, error: 'event_not_found' });

  // Get confirmed bookings
  const { data: bookings, error: bookErr } = await supabase
    .from('bookings')
    .select('*')
    .eq('event_id', event_id)
    .eq('status', 'confirmed');
  if (bookErr) throw bookErr;

  const siteUrl = process.env.SITE_URL || 'https://vfit-studio.netlify.app';
  const reviewBaseUrl = `${siteUrl}?review=${event_id}`;
  let sent = 0;

  for (const booking of (bookings || [])) {
    try {
      await sendReviewRequestEmail(booking.email, booking.name, event.name, reviewBaseUrl);
      sent++;
    } catch (e) {
      console.error('Failed to send review request to:', booking.email, e);
    }
  }

  return respond(200, { success: true, count: sent, message: `${sent} review request emails sent.` });
}

async function handleSubmitReview(params) {
  const { event_id, rating, email, comment } = params;
  if (!event_id || !rating || !email) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
      body: '<html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px;"><h2>Missing required fields.</h2></body></html>',
    };
  }

  const ratingNum = parseInt(rating, 10);
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
      body: '<html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px;"><h2>Invalid rating.</h2></body></html>',
    };
  }

  const cleanEmail = String(email).toLowerCase().trim();

  // Gate: only accept reviews from emails that actually had a confirmed
  // booking for this event. Was previously a public CSRF surface — any
  // GET with a guessable event UUID + email could submit unlimited
  // reviews. Now also dedup'd one-per-(event,email).
  const { data: hasBooking } = await supabase
    .from('bookings')
    .select('id', { head: true, count: 'exact' })
    .eq('event_id', event_id)
    .ilike('email', cleanEmail)
    .eq('status', 'confirmed')
    .limit(1);
  if (!hasBooking) {
    return {
      statusCode: 403,
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
      body: '<html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px;"><h2>This review link is no longer valid.</h2></body></html>',
    };
  }
  const { count: existingCount } = await supabase
    .from('reviews')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', event_id)
    .ilike('email', cleanEmail);
  if ((existingCount || 0) > 0) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
      body: '<html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px;"><h2>Thanks — you’ve already left feedback for this session.</h2></body></html>',
    };
  }

  const { error } = await supabase.from('reviews').insert({
    event_id,
    email: cleanEmail,
    rating: ratingNum,
    comment: comment || null,
  });

  if (error) {
    console.error('Review save error:', error);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
      body: '<html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px;"><h2>Something went wrong. Please try again.</h2></body></html>',
    };
  }

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
    body: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#faf7f2;font-family:Arial,'Helvetica Neue',sans-serif;">
<div style="max-width:540px;margin:80px auto;text-align:center;background:#fefcf8;padding:60px 40px;border-radius:8px;">
  <h1 style="font-family:Georgia,serif;font-size:28px;font-weight:normal;color:#3d3530;margin:0 0 16px;">Thank you!</h1>
  <p style="font-size:16px;color:#6b5e52;line-height:1.7;">Your feedback (${'★'.repeat(ratingNum)}${'☆'.repeat(5 - ratingNum)}) has been recorded.</p>
  <p style="font-size:14px;color:#8c7660;margin-top:24px;">We appreciate you being part of VFIT.</p>
</div>
</body>
</html>`,
  };
}

// ═══════════════════════════════════════════════
// CMS handlers — Plans, Site Content, Testimonials, Media
// ═══════════════════════════════════════════════

async function handleGetPlans() {
  const { data, error } = await supabase
    .from('membership_plans')
    .select('*')
    .eq('status', 'active')
    .order('display_order', { ascending: true });
  if (error) throw error;
  return respond(200, { success: true, plans: data || [] });
}

async function handleGetAllPlans() {
  const { data, error } = await supabase
    .from('membership_plans')
    .select('*')
    .order('display_order', { ascending: true });
  if (error) throw error;
  return respond(200, { success: true, plans: data || [] });
}

async function handleCreatePlan(body) {
  requireAdmin(body.admin_key);
  const { name, price_cents, period_label, badge_text, badge_style, description, features, display_order } = body;
  if (!name || price_cents === undefined) {
    return respond(400, { success: false, error: 'name and price_cents are required' });
  }
  const { data: plan, error } = await supabase
    .from('membership_plans')
    .insert({
      name,
      price_cents: parseInt(price_cents),
      period_label: period_label || 'session',
      badge_text: badge_text || null,
      badge_style: badge_style || 'pop',
      description: description || null,
      features: features || [],
      display_order: display_order || 0,
    })
    .select()
    .single();
  if (error) throw error;
  return respond(200, { success: true, plan });
}

async function handleUpdatePlan(body) {
  requireAdmin(body.admin_key);
  const { plan_id } = body;
  if (!plan_id) return respond(400, { success: false, error: 'plan_id is required' });
  const ALLOWED = ['name', 'price_cents', 'period_label', 'badge_text',
                   'badge_style', 'description', 'features',
                   'display_order', 'status'];
  const update = {};
  for (const k of ALLOWED) if (k in body) update[k] = body[k];
  if (!Object.keys(update).length) {
    return respond(400, { success: false, error: 'no fields to update' });
  }
  const { data, error } = await supabase
    .from('membership_plans')
    .update(update)
    .eq('id', plan_id)
    .select()
    .single();
  if (error) throw error;
  return respond(200, { success: true, plan: data });
}

async function handleDeletePlan(body) {
  requireAdmin(body.admin_key);
  const { plan_id } = body;
  if (!plan_id) return respond(400, { success: false, error: 'plan_id is required' });
  const { error } = await supabase
    .from('membership_plans')
    .delete()
    .eq('id', plan_id);
  if (error) throw error;
  return respond(200, { success: true });
}

async function handleGetSiteContent() {
  const { data, error } = await supabase
    .from('site_content')
    .select('*')
    .order('display_order', { ascending: true });
  if (error) throw error;
  return respond(200, { success: true, content: data || [] });
}

async function handleUpdateSiteContent(body) {
  requireAdmin(body.admin_key);
  const { items } = body;
  if (!items || !Array.isArray(items)) {
    return respond(400, { success: false, error: 'items array is required' });
  }
  for (const item of items) {
    const { error } = await supabase
      .from('site_content')
      .update({ content_value: item.content_value })
      .eq('section', item.section)
      .eq('content_key', item.content_key);
    if (error) throw error;
  }
  return respond(200, { success: true });
}

async function handleGetTestimonials() {
  const { data, error } = await supabase
    .from('testimonials')
    .select('*')
    .eq('status', 'active')
    .order('display_order', { ascending: true });
  if (error) throw error;
  return respond(200, { success: true, testimonials: data || [] });
}

async function handleGetAllTestimonials() {
  const { data, error } = await supabase
    .from('testimonials')
    .select('*')
    .order('display_order', { ascending: true });
  if (error) throw error;
  return respond(200, { success: true, testimonials: data || [] });
}

async function handleCreateTestimonial(body) {
  requireAdmin(body.admin_key);
  const { quote, attribution, page, display_order } = body;
  if (!quote) return respond(400, { success: false, error: 'quote is required' });
  const { data, error } = await supabase
    .from('testimonials')
    .insert({
      quote,
      attribution: attribution || 'Client Testimonial · Toowoomba',
      page: page || 'home',
      display_order: display_order || 0,
    })
    .select()
    .single();
  if (error) throw error;
  return respond(200, { success: true, testimonial: data });
}

async function handleUpdateTestimonial(body) {
  requireAdmin(body.admin_key);
  const { testimonial_id } = body;
  if (!testimonial_id) return respond(400, { success: false, error: 'testimonial_id is required' });
  const ALLOWED = ['quote', 'attribution', 'page', 'display_order', 'status'];
  const update = {};
  for (const k of ALLOWED) if (k in body) update[k] = body[k];
  if (!Object.keys(update).length) {
    return respond(400, { success: false, error: 'no fields to update' });
  }
  const { data, error } = await supabase
    .from('testimonials')
    .update(update)
    .eq('id', testimonial_id)
    .select()
    .single();
  if (error) throw error;
  return respond(200, { success: true, testimonial: data });
}

async function handleDeleteTestimonial(body) {
  requireAdmin(body.admin_key);
  const { testimonial_id } = body;
  if (!testimonial_id) return respond(400, { success: false, error: 'testimonial_id is required' });
  const { error } = await supabase
    .from('testimonials')
    .delete()
    .eq('id', testimonial_id);
  if (error) throw error;
  return respond(200, { success: true });
}

async function handleUploadMedia(body) {
  requireAdmin(body.admin_key);
  const { file_data, file_name, content_type } = body;
  if (!file_data || !file_name) {
    return respond(400, { success: false, error: 'file_data and file_name are required' });
  }
  const buffer = Buffer.from(file_data, 'base64');
  const path = `${Date.now()}-${file_name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { error } = await supabase.storage
    .from('media')
    .upload(path, buffer, {
      contentType: content_type || 'application/octet-stream',
      upsert: false,
    });
  if (error) throw error;
  const { data: urlData } = supabase.storage.from('media').getPublicUrl(path);
  return respond(200, { success: true, url: urlData.publicUrl, path });
}

async function handleListMedia() {
  const { data, error } = await supabase.storage
    .from('media')
    .list('', { limit: 200, sortBy: { column: 'created_at', order: 'desc' } });
  if (error) throw error;
  const files = (data || []).filter(f => f.name !== '.emptyFolderPlaceholder').map(f => {
    const { data: urlData } = supabase.storage.from('media').getPublicUrl(f.name);
    return { name: f.name, url: urlData.publicUrl, size: f.metadata?.size, created_at: f.created_at };
  });
  return respond(200, { success: true, files });
}

async function handleDeleteMedia(body) {
  requireAdmin(body.admin_key);
  const { path } = body;
  if (!path) return respond(400, { success: false, error: 'path is required' });
  const { error } = await supabase.storage.from('media').remove([path]);
  if (error) throw error;
  return respond(200, { success: true });
}

// ═══════════════════════════════════════════════
// Referral tracking
// ═══════════════════════════════════════════════

async function handleReferrals() {
  const { data, error } = await supabase
    .from('bookings')
    .select('referral_code')
    .not('referral_code', 'is', null)
    .eq('status', 'confirmed');
  if (error) throw error;

  // Aggregate counts
  const counts = {};
  for (const row of (data || [])) {
    const code = row.referral_code;
    counts[code] = (counts[code] || 0) + 1;
  }

  const referrals = Object.entries(counts)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  return respond(200, { success: true, referrals });
}

// ═══════════════════════════════════════════════
// Google Calendar iCal feed
// ═══════════════════════════════════════════════

async function handleCalendarFeed() {
  // Fetch all upcoming active events
  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('status', 'active')
    .gte('session_date', new Date().toISOString())
    .order('session_date', { ascending: true });
  if (error) throw error;

  // Single batched count of bookings per event — drops the N+1 loop
  const eventIds = (events || []).map((e) => e.id);
  const countByEvent = {};
  if (eventIds.length) {
    const { data: bookings } = await supabase
      .from('bookings')
      .select('event_id')
      .in('event_id', eventIds)
      .in('status', ['confirmed', 'held']);
    for (const b of (bookings || [])) {
      countByEvent[b.event_id] = (countByEvent[b.event_id] || 0) + 1;
    }
  }

  const vevents = [];
  for (const event of (events || [])) {
    const bookedCount = countByEvent[event.id] || 0;

    const dtStart = new Date(event.session_date);
    const dtEnd = new Date(dtStart.getTime() + 45 * 60 * 1000); // 45 min default duration

    const formatDt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    // Determine location based on event type
    let location = '';
    if (event.type === 'runclub') {
      location = 'Glennie School Track';
    } else {
      location = 'The Dairy, Ravensbourne';
    }

    // PRIVACY: this feed is public (anyone with the URL can subscribe).
    // Don't include booker names — only counts.
    vevents.push(
`BEGIN:VEVENT
DTSTART:${formatDt(dtStart)}
DTEND:${formatDt(dtEnd)}
SUMMARY:${event.name} (${bookedCount}/${event.spots_total} booked)
DESCRIPTION:${bookedCount}/${event.spots_total} spots booked
LOCATION:${location}
UID:${event.id}@vfit-studio
END:VEVENT`
    );
  }

  const ical = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//VFIT//Booking System//EN
X-WR-CALNAME:VFIT Studio Schedule
${vevents.join('\n')}
END:VCALENDAR`;

  return {
    statusCode: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="vfit-schedule.ics"',
    },
    body: ical,
  };
}

// ═══════════════════════════════════════════════
// CRM handlers
// ═══════════════════════════════════════════════
//
// Required DB migration (run once in Supabase SQL Editor):
//
// create table if not exists appointments (
//   id              uuid default gen_random_uuid() primary key,
//   member_id       uuid references members(id) on delete cascade not null,
//   session_type    text not null default 'pt',
//   scheduled_at    timestamptz not null,
//   duration_mins   integer not null default 60,
//   location        text,
//   status          text not null default 'scheduled',
//   notes           text,
//   linked_event_id uuid references events(id) on delete set null,
//   created_at      timestamptz default now(),
//   updated_at      timestamptz default now()
// );
// create index if not exists appointments_member_id_idx on appointments(member_id);
// create index if not exists appointments_scheduled_at_idx on appointments(scheduled_at);
// alter table members add column if not exists goals text;
// alter table members add column if not exists health_notes text;
// alter table memberships add column if not exists admin_notes text;
// alter table memberships add column if not exists last_contacted_at timestamptz;

async function handleCrmDashboard() {
  // Active member count + new enquiry count (always available)
  const { count: activeMembers } = await supabase
    .from('members').select('*', { count: 'exact', head: true }).eq('status', 'active');
  const { count: newEnquiries } = await supabase
    .from('memberships').select('*', { count: 'exact', head: true }).eq('status', 'new');

  // Today's appointments + unbooked members (may fail if table not yet created)
  let todayApts = [], unbookedMembers = [];
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const { data: apts } = await supabase
      .from('appointments')
      .select('*, members(id, name, email, phone)')
      .gte('scheduled_at', todayStart.toISOString())
      .lte('scheduled_at', todayEnd.toISOString())
      .neq('status', 'cancelled')
      .order('scheduled_at', { ascending: true });
    todayApts = apts || [];

    const { data: allActive } = await supabase
      .from('members').select('id, name').eq('status', 'active');
    const { data: upcoming } = await supabase
      .from('appointments').select('member_id')
      .gte('scheduled_at', now.toISOString()).neq('status', 'cancelled');
    const bookedIds = new Set((upcoming || []).map(a => a.member_id));
    unbookedMembers = (allActive || []).filter(m => !bookedIds.has(m.id));
  } catch (e) { /* appointments table not yet created */ }

  return respond(200, {
    success: true,
    today_appointments: todayApts,
    active_members: activeMembers || 0,
    new_enquiries: newEnquiries || 0,
    unbooked_members: unbookedMembers,
  });
}

async function handleGetAppointments(params) {
  let query = supabase
    .from('appointments')
    .select('*, members(id, name, email, phone)')
    .order('scheduled_at', { ascending: true });

  if (params.from && params.to) {
    query = query.gte('scheduled_at', params.from).lte('scheduled_at', params.to);
  }
  if (params.member_id) {
    query = query.eq('member_id', params.member_id);
  }
  if (!params.include_cancelled) {
    query = query.neq('status', 'cancelled');
  }

  const { data, error } = await query;
  if (error) throw error;
  return respond(200, { success: true, appointments: data || [] });
}

async function handleCreateAppointment(body) {
  requireAdmin(body.admin_key);
  const { member_id, session_type, scheduled_at, duration_mins, location, notes, linked_event_id } = body;
  if (!member_id || !scheduled_at) {
    return respond(400, { success: false, error: 'member_id and scheduled_at are required' });
  }

  // Conflict check: any non-cancelled appointment within 30 min window
  const aptTime = new Date(scheduled_at);
  const windowStart = new Date(aptTime.getTime() - 30 * 60 * 1000);
  const windowEnd   = new Date(aptTime.getTime() + 30 * 60 * 1000);
  const { data: conflicts } = await supabase
    .from('appointments')
    .select('id, scheduled_at, members(name)')
    .gte('scheduled_at', windowStart.toISOString())
    .lte('scheduled_at', windowEnd.toISOString())
    .neq('status', 'cancelled');

  if (conflicts && conflicts.length > 0) {
    const c = conflicts[0];
    return respond(200, {
      success: false, conflict: true,
      conflict_with: c.members?.name || 'another client',
      conflict_time: c.scheduled_at,
    });
  }

  const { data, error } = await supabase
    .from('appointments')
    .insert({
      member_id,
      session_type: session_type || 'pt',
      scheduled_at,
      duration_mins: duration_mins || 60,
      location: location || null,
      notes: notes || null,
      status: 'scheduled',
      linked_event_id: linked_event_id || null,
    })
    .select('*, members(id, name, email, phone)')
    .single();
  if (error) throw error;
  return respond(200, { success: true, appointment: data });
}

async function handleUpdateAppointment(body) {
  requireAdmin(body.admin_key);
  const { appointment_id } = body;
  if (!appointment_id) return respond(400, { success: false, error: 'appointment_id is required' });
  const ALLOWED = ['member_id', 'starts_at', 'ends_at', 'kind', 'notes',
                   'status', 'linked_event_id'];
  const update = { updated_at: new Date().toISOString() };
  for (const k of ALLOWED) if (k in body) update[k] = body[k];
  const { data, error } = await supabase
    .from('appointments')
    .update(update)
    .eq('id', appointment_id)
    .select('*, members(id, name, email, phone)')
    .single();
  if (error) throw error;
  return respond(200, { success: true, appointment: data });
}

async function handleDeleteAppointment(body) {
  requireAdmin(body.admin_key);
  const { appointment_id } = body;
  if (!appointment_id) return respond(400, { success: false, error: 'appointment_id is required' });
  const { error } = await supabase
    .from('appointments')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', appointment_id);
  if (error) throw error;
  return respond(200, { success: true });
}

async function handleUpdateMemberNotes(body) {
  requireAdmin(body.admin_key);
  const { member_id, notes, goals, health_notes } = body;
  if (!member_id) return respond(400, { success: false, error: 'member_id is required' });
  const update = {};
  if (notes !== undefined) update.notes = notes;
  if (goals !== undefined) update.goals = goals;
  if (health_notes !== undefined) update.health_notes = health_notes;
  const { data, error } = await supabase.from('members').update(update).eq('id', member_id).select().single();
  if (error) throw error;
  return respond(200, { success: true, member: data });
}

async function handleUpdateEnquiryNotes(body) {
  requireAdmin(body.admin_key);
  const { membership_id, admin_notes, status, last_contacted_at } = body;
  if (!membership_id) return respond(400, { success: false, error: 'membership_id is required' });
  const update = {};
  if (admin_notes !== undefined) update.admin_notes = admin_notes;
  if (status !== undefined) update.status = status;
  if (last_contacted_at !== undefined) update.last_contacted_at = last_contacted_at;
  const { error } = await supabase.from('memberships').update(update).eq('id', membership_id);
  if (error) throw error;
  return respond(200, { success: true });
}

// ═══════════════════════════════════════════════
// Member Lounge handlers
// ═══════════════════════════════════════════════

async function handleLoungeAuthSend(body) {
  const { email } = body || {};
  await sendMagicLink(email);
  // Always return success — silent on missing-member so the response
  // can't be used to enumerate accounts.
  return respond(200, { success: true });
}

async function handleLoungeMe(event) {
  let ctx;
  try {
    ctx = await requireMember(event);
  } catch (err) {
    return respond(err.statusCode || 401, { success: false, error: err.message });
  }
  const { user, member } = ctx;

  // Audit: log a "viewed lounge" entry — used by the privacy log in the
  // profile drawer ("who has accessed my data"). Throttled by app code
  // (the lounge calls lounge_me on load, so once per session is fine).
  supabase.from('lounge_audit_log').insert({
    member_id: member.id,
    actor_user_id: user.id,
    actor_role: 'member',
    action: 'view_lounge',
  }).then(() => {}, () => {});

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + 28);
  const todayIso = today.toISOString().slice(0, 10);
  const horizonIso = horizon.toISOString().slice(0, 10);

  // Fan out every read in parallel — these were 7 sequential round-trips
  // costing ~700ms; running them concurrently brings it under ~150ms.
  const [
    prefsRes,
    assignmentsRes,
    overridesRes,
    holdsRes,
    unreadRes,
    planRecord,
  ] = await Promise.all([
    supabase.from('member_preferences').select('*').eq('member_id', member.id).maybeSingle(),
    supabase.from('member_slots')
      .select('slot_id, schedule_slots(id, day_of_week, time)')
      .eq('member_id', member.id).eq('status', 'active'),
    supabase.from('member_session_log')
      .select('slot_id, session_date, state, charge_required, reason')
      .eq('member_id', member.id)
      .gte('session_date', todayIso).lte('session_date', horizonIso),
    supabase.from('travel_holds')
      .select('id, start_date, end_date, status, reason')
      .eq('member_id', member.id).in('status', ['active'])
      .order('start_date', { ascending: true }),
    supabase.from('lounge_messages')
      .select('*', { count: 'exact', head: true })
      .eq('member_id', member.id).eq('direction', 'out').is('read_at', null),
    getPlanForMember(member).catch(() => null),
  ]);

  // Preferences — lazy-create default if missing (fire-and-forget)
  let prefs = prefsRes.data;
  if (!prefs) {
    prefs = {
      member_id: member.id,
      display_name: member.name,
      notify_email: true,
      challenges_opted_in: false,
      read_receipts: true,
    };
    supabase.from('member_preferences').insert(prefs).then(() => {}, () => {});
  }

  const slots = (assignmentsRes.data || []).map((a) => a.schedule_slots).filter(Boolean);

  const overrideMap = {};
  for (const o of (overridesRes.data || [])) {
    overrideMap[`${o.slot_id}|${o.session_date}`] = o;
  }

  // schedule_slots.day_of_week uses Mon=0 convention (per the admin
  // form). JS Date.getDay() is Sun=0. Convert before comparing.
  const upcoming = [];
  for (let d = new Date(today); d <= horizon; d.setDate(d.getDate() + 1)) {
    const adminDow = (d.getDay() + 6) % 7;  // Sun=0 → 6, Mon=1 → 0, etc.
    for (const s of slots) {
      if (s.day_of_week === adminDow) {
        const dateKey = d.toISOString().slice(0, 10);
        const override = overrideMap[`${s.id}|${dateKey}`];
        upcoming.push({
          slot_id: s.id,
          date: dateKey,
          time: s.time,
          day_of_week: adminDow,
          state: override?.state || 'scheduled',
          charge_required: override?.charge_required || false,
          reason: override?.reason || null,
        });
      }
    }
  }
  upcoming.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const holds = holdsRes.data || [];
  const unread = unreadRes.count || 0;
  const billing = {
    stripe_configured: isStripeConfigured(),
    customer_linked: !!member.stripe_customer_id,
    plan_price_cents: planRecord?.price_cents ?? null,
    plan_period: planRecord?.period_label ?? null,
    estimated_session_fee_cents: estimateSessionFeeCents(planRecord, member),
  };

  return respond(200, {
    success: true,
    user: { id: user.id, email: user.email },
    member: {
      id: member.id,
      name: member.name,
      email: member.email,
      phone: member.phone,
      plan: member.plan,
      sessions_per_week: member.sessions_per_week,
      start_date: member.start_date,
      agreed_at: member.agreed_at,
      ical_url: member.ical_token ? `${SITE_URL}/.netlify/functions/api?action=lounge_ical&token=${member.ical_token}` : null,
    },
    preferences: prefs,
    upcoming_sessions: upcoming,
    travel_holds: holds,
    unread_messages: unread,
    billing,
  });
}

// ─── Lounge: cancel a single session ───
async function handleLoungeCancelSession(event, body) {
  let ctx;
  try {
    ctx = await requireMember(event);
  } catch (err) {
    return respond(err.statusCode || 401, { success: false, error: err.message });
  }
  const { member } = ctx;
  const { slot_id, session_date, reason } = body || {};
  if (!slot_id || !session_date) {
    return respond(400, { success: false, error: 'slot_id and session_date required' });
  }

  // Confirm the slot is one this member is actually assigned to
  const { data: assignment } = await supabase
    .from('member_slots')
    .select('slot_id, schedule_slots(id, day_of_week, time)')
    .eq('member_id', member.id)
    .eq('slot_id', slot_id)
    .eq('status', 'active')
    .maybeSingle();
  if (!assignment || !assignment.schedule_slots) {
    return respond(403, { success: false, error: 'not your slot' });
  }
  const slotTime = assignment.schedule_slots.time;

  const policy = evaluateCancellation({
    plan: member.plan,
    sessionDate: session_date,
    sessionTime: slotTime,
  });

  const state = policy.chargeRequired ? 'cancelled_late' : 'cancelled_in_time';

  // Calculate the late-cancel fee from the member's plan, if charge required.
  // (Stripe never gets called here — we only record the amount so admin can
  // see/charge it now or later when Stripe is wired up.)
  let chargeAmountCents = null;
  if (policy.chargeRequired) {
    try {
      const plan = await getPlanForMember(member);
      chargeAmountCents = estimateSessionFeeCents(plan, member);
    } catch (e) { console.error('fee calc failed', e); }
  }

  // Upsert into member_session_log (unique on member_id+slot_id+session_date)
  const { error: logErr } = await supabase
    .from('member_session_log')
    .upsert({
      member_id: member.id,
      slot_id,
      session_date,
      session_time: slotTime,
      state,
      charge_required: policy.chargeRequired,
      charge_amount_cents: chargeAmountCents,
      notice_hours: Math.round(policy.noticeHours * 10) / 10,
      reason: reason || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'member_id,slot_id,session_date' });
  if (logErr) {
    console.error('cancel log error:', logErr);
    return respond(500, { success: false, error: 'failed to record cancellation' });
  }

  // Audit
  await supabase.from('lounge_audit_log').insert({
    member_id: member.id,
    actor_user_id: ctx.user.id,
    actor_role: 'member',
    action: 'cancel_session',
    resource: `${slot_id}|${session_date}`,
  });

  // Notify Georgie
  try {
    await sendOwnerAlert(
      `Lounge: ${member.name} cancelled ${session_date} ${slotTime}`,
      `<p><strong>${escapeHtmlPlain(member.name)}</strong> (${escapeHtmlPlain(member.plan || '—')}) cancelled their ${escapeHtmlPlain(session_date)} ${escapeHtmlPlain(slotTime || '')} session.</p>` +
      `<p>Notice: ${Math.round(policy.noticeHours)}h (required ${policy.requiredHours}h). ` +
      `${policy.chargeRequired ? '<strong style="color:#b85c5c;">Charge required (late cancellation).</strong>' : 'Within policy — no charge.'}</p>` +
      (reason ? `<p>Member note: ${escapeHtmlPlain(reason)}</p>` : '')
    );
  } catch (e) { console.error('owner alert failed', e); }

  return respond(200, {
    success: true,
    state,
    charge_required: policy.chargeRequired,
    notice_hours: policy.noticeHours,
    required_hours: policy.requiredHours,
  });
}

// ─── Lounge: create a travel hold ───
async function handleLoungeCreateTravelHold(event, body) {
  let ctx;
  try {
    ctx = await requireMember(event);
  } catch (err) {
    return respond(err.statusCode || 401, { success: false, error: err.message });
  }
  const { member } = ctx;
  const { start_date, end_date, reason } = body || {};
  if (!start_date || !end_date) {
    return respond(400, { success: false, error: 'start_date and end_date required' });
  }
  if (end_date < start_date) {
    return respond(400, { success: false, error: 'end_date must be on or after start_date' });
  }

  // Cap check — sum existing holds in the rolling year + this new one
  const { data: existing } = await supabase
    .from('travel_holds')
    .select('start_date, end_date, status')
    .eq('member_id', member.id);

  const usedDays = pauseDaysUsed(existing || []);
  const requestDays = pauseDaysInRange(start_date, end_date);
  if (usedDays + requestDays > PAUSE_CAP_DAYS_PER_YEAR) {
    return respond(400, {
      success: false,
      error: 'pause_cap_exceeded',
      message: `Your plan allows up to ${PAUSE_CAP_DAYS_PER_YEAR} pause days per year. You'd be at ${usedDays + requestDays}.`,
      used_days: usedDays,
      requested_days: requestDays,
      cap_days: PAUSE_CAP_DAYS_PER_YEAR,
    });
  }

  // Insert the hold
  const { data: hold, error: holdErr } = await supabase
    .from('travel_holds')
    .insert({ member_id: member.id, start_date, end_date, reason: reason || null })
    .select('*')
    .single();
  if (holdErr) {
    console.error('travel_hold insert error:', holdErr);
    return respond(500, { success: false, error: 'failed to create hold' });
  }

  // Mark all of this member's recurring sessions in the range as paused
  // (so they show greyed-out on the lounge calendar and don't trigger charges)
  await markSessionsPaused(member.id, start_date, end_date);

  // Audit
  await supabase.from('lounge_audit_log').insert({
    member_id: member.id,
    actor_user_id: ctx.user.id,
    actor_role: 'member',
    action: 'create_travel_hold',
    resource: hold.id,
  });

  // Notify Georgie
  try {
    await sendOwnerAlert(
      `Lounge: ${member.name} added a travel hold`,
      `<p><strong>${escapeHtmlPlain(member.name)}</strong> (${escapeHtmlPlain(member.plan || '—')}) is on hold from <strong>${escapeHtmlPlain(start_date)}</strong> to <strong>${escapeHtmlPlain(end_date)}</strong>.</p>` +
      (reason ? `<p>Note: ${escapeHtmlPlain(reason)}</p>` : '') +
      `<p>Pause days used in last 12 months: ${usedDays + requestDays} of ${PAUSE_CAP_DAYS_PER_YEAR}.</p>`
    );
  } catch (e) { console.error('owner alert failed', e); }

  return respond(200, { success: true, hold, used_days: usedDays + requestDays, cap_days: PAUSE_CAP_DAYS_PER_YEAR });
}

// ─── Lounge: cancel a travel hold ───
async function handleLoungeCancelTravelHold(event, body) {
  let ctx;
  try {
    ctx = await requireMember(event);
  } catch (err) {
    return respond(err.statusCode || 401, { success: false, error: err.message });
  }
  const { member } = ctx;
  const { hold_id } = body || {};
  if (!hold_id) return respond(400, { success: false, error: 'hold_id required' });

  const { data: hold } = await supabase
    .from('travel_holds')
    .select('*')
    .eq('id', hold_id)
    .eq('member_id', member.id)
    .maybeSingle();
  if (!hold) return respond(404, { success: false, error: 'not found' });

  await supabase
    .from('travel_holds')
    .update({ status: 'cancelled' })
    .eq('id', hold_id);

  // Reverse the per-session log: drop any 'paused' rows in this range
  await supabase
    .from('member_session_log')
    .delete()
    .eq('member_id', member.id)
    .eq('state', 'paused')
    .gte('session_date', hold.start_date)
    .lte('session_date', hold.end_date);

  await supabase.from('lounge_audit_log').insert({
    member_id: member.id,
    actor_user_id: ctx.user.id,
    actor_role: 'member',
    action: 'cancel_travel_hold',
    resource: hold_id,
  });

  return respond(200, { success: true });
}

// Mark every scheduled occurrence in a date range as 'paused' for a member.
// Idempotent — uses upsert.
async function markSessionsPaused(memberId, startDate, endDate) {
  const { data: assignments } = await supabase
    .from('member_slots')
    .select('slot_id, schedule_slots(id, day_of_week, time)')
    .eq('member_id', memberId)
    .eq('status', 'active');
  const slots = (assignments || []).map((a) => a.schedule_slots).filter(Boolean);
  if (!slots.length) return;

  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  const rows = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const adminDow = (d.getDay() + 6) % 7;  // see handleLoungeMe note
    for (const s of slots) {
      if (s.day_of_week === adminDow) {
        rows.push({
          member_id: memberId,
          slot_id: s.id,
          session_date: d.toISOString().slice(0, 10),
          session_time: s.time,
          state: 'paused',
          charge_required: false,
          updated_at: new Date().toISOString(),
        });
      }
    }
  }
  if (rows.length) {
    await supabase.from('member_session_log').upsert(rows, {
      onConflict: 'member_id,slot_id,session_date',
    });
  }
}

// ─── Admin: generate a magic-link for a member (dev/manual override) ───
// Doesn't send email — returns the action_link so Georgie can text/share it
// directly. Used for testing while Resend is verifying, or as an ongoing
// "I never got the email" recovery path.
async function handleAdminGenerateLoungeLink(body) {
  requireAdmin(body.admin_key);
  const memberId = body.member_id;
  if (!memberId) return respond(400, { success: false, error: 'member_id required' });

  const { data: member } = await supabase
    .from('members')
    .select('id, name, email, agreed_at')
    .eq('id', memberId)
    .maybeSingle();
  if (!member) return respond(404, { success: false, error: 'member not found' });
  if (!member.email) return respond(400, { success: false, error: 'member has no email' });

  const { data: link, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: member.email,
    options: { redirectTo: `${SITE_URL}/lounge` },
  });
  if (error || !link?.properties?.action_link) {
    console.error('generateLink failed:', error);
    return respond(500, { success: false, error: 'link generation failed' });
  }
  // Audit — every admin-initiated impersonation link is logged so abuse
  // is detectable from the lounge_audit_log table.
  await supabase.from('lounge_audit_log').insert({
    member_id: member.id,
    actor_role: 'trainer',
    action: 'admin_generate_lounge_link',
    resource: member.id,
  });
  return respond(200, {
    success: true,
    member: { id: member.id, name: member.name, email: member.email },
    action_link: link.properties.action_link,
  });
}

// ─── Lounge: rotate iCal token (revoke any leaked subscription URLs) ───
async function handleLoungeRotateIcal(event) {
  let ctx;
  try { ctx = await requireMember(event); }
  catch (err) { return respond(err.statusCode || 401, { success: false, error: err.message }); }
  const { member, user } = ctx;
  const newToken = require('crypto').randomUUID();
  await supabase.from('members').update({ ical_token: newToken }).eq('id', member.id);
  await supabase.from('lounge_audit_log').insert({
    member_id: member.id, actor_user_id: user.id, actor_role: 'member',
    action: 'rotate_ical_token',
  });
  return respond(200, {
    success: true,
    ical_url: `${SITE_URL}/.netlify/functions/api?action=lounge_ical&token=${newToken}`,
  });
}

// ─── Lounge: audit log (member-readable subset) ───
async function handleLoungeAuditLog(event) {
  let ctx;
  try { ctx = await requireMember(event); }
  catch (err) { return respond(err.statusCode || 401, { success: false, error: err.message }); }
  const { member } = ctx;
  const { data: entries } = await supabase
    .from('lounge_audit_log')
    .select('id, actor_role, action, resource, occurred_at')
    .eq('member_id', member.id)
    .order('occurred_at', { ascending: false })
    .limit(80);
  return respond(200, { success: true, entries: entries || [] });
}

// ─── Lounge: concierge request (rides on lounge_messages) ───
async function handleLoungeConcierge(event, body) {
  let ctx;
  try { ctx = await requireMember(event); }
  catch (err) { return respond(err.statusCode || 401, { success: false, error: err.message }); }
  const { member } = ctx;
  const { request_type, details } = body || {};
  if (!request_type) return respond(400, { success: false, error: 'request_type required' });
  const labelMap = {
    at_home: 'At-home session',
    travel: 'Travel program',
    nutrition: 'Nutrition consult',
    other: 'Custom request',
  };
  const label = labelMap[request_type] || 'Concierge request';
  const composedBody =
    `[Concierge · ${label}]\n\n${(details || '').trim() || '(no details)'}\n\n— Sent from the Lounge`;

  const { data: row, error } = await supabase
    .from('lounge_messages')
    .insert({ member_id: member.id, direction: 'in', body: composedBody })
    .select('*')
    .single();
  if (error) return respond(500, { success: false, error: 'failed' });

  try {
    await sendOwnerAlert(
      `Concierge request from ${member.name}: ${label}`,
      `<p><strong>${escapeHtmlPlain(member.name)}</strong> (${escapeHtmlPlain(member.plan || '—')}) submitted a concierge request.</p>` +
      `<p style="font-weight:500;">Type: ${escapeHtmlPlain(label)}</p>` +
      (details ? `<blockquote style="border-left:3px solid #c9b99a;padding:8px 16px;color:#3d3530;">${escapeHtmlPlain(details)}</blockquote>` : '') +
      `<p style="margin-top:16px;"><a href="${SITE_URL}/admin.html" style="color:#3d3530;">Open in admin →</a></p>`
    );
  } catch (e) { console.error('owner alert failed', e); }

  return respond(200, { success: true, message: row });
}

// ─── Lounge: per-member iCal feed ───
async function handleLoungeIcal(params) {
  const token = params.token;
  if (!token) {
    return { statusCode: 400, headers: { 'Content-Type': 'text/plain' }, body: 'token required' };
  }
  const { data: member } = await supabase
    .from('members')
    .select('id, name, plan')
    .eq('ical_token', token)
    .maybeSingle();
  if (!member) {
    return { statusCode: 404, headers: { 'Content-Type': 'text/plain' }, body: 'not found' };
  }

  const { data: assignments } = await supabase
    .from('member_slots')
    .select('slot_id, schedule_slots(id, day_of_week, time)')
    .eq('member_id', member.id)
    .eq('status', 'active');
  const slots = (assignments || []).map((a) => a.schedule_slots).filter(Boolean);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizon = new Date(today); horizon.setDate(horizon.getDate() + 90);

  const { data: overrides } = await supabase
    .from('member_session_log')
    .select('slot_id, session_date, state')
    .eq('member_id', member.id)
    .gte('session_date', today.toISOString().slice(0, 10))
    .lte('session_date', horizon.toISOString().slice(0, 10));
  const skip = new Set();
  for (const o of (overrides || [])) {
    if (['cancelled_in_time', 'cancelled_late', 'paused', 'rescheduled'].includes(o.state)) {
      skip.add(`${o.slot_id}|${o.session_date}`);
    }
  }

  const events = [];
  for (let d = new Date(today); d <= horizon; d.setDate(d.getDate() + 1)) {
    const adminDow = (d.getDay() + 6) % 7;  // see handleLoungeMe note
    for (const s of slots) {
      if (s.day_of_week === adminDow) {
        const dateKey = d.toISOString().slice(0, 10);
        if (skip.has(`${s.id}|${dateKey}`)) continue;
        events.push(buildIcalEvent(member, s, dateKey));
      }
    }
  }

  const ical = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//VFIT Studio//Lounge//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:VFIT — ${escapeIcalText(member.name)}`,
    'X-WR-TIMEZONE:Australia/Brisbane',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
    },
    body: ical,
  };
}

function buildIcalEvent(member, slot, dateKey) {
  const m = String(slot.time || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  let h = 6, mn = 0;
  if (m) {
    h = parseInt(m[1], 10);
    mn = parseInt(m[2], 10);
    if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
    if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  }
  const startLocal = `${dateKey.replace(/-/g, '')}T${String(h).padStart(2, '0')}${String(mn).padStart(2, '0')}00`;
  const endH = (h + 1) % 24;
  const endLocal = `${dateKey.replace(/-/g, '')}T${String(endH).padStart(2, '0')}${String(mn).padStart(2, '0')}00`;
  const uid = `${slot.id}-${dateKey}@vfit.studio`;
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=Australia/Brisbane:${startLocal}`,
    `DTEND;TZID=Australia/Brisbane:${endLocal}`,
    `SUMMARY:VFIT Studio Session`,
    `DESCRIPTION:Studio session at VFIT. Manage in the Lounge.`,
    `LOCATION:VFIT Studio · Shop 8/203 Margaret St, Toowoomba`,
    'END:VEVENT',
  ].join('\r\n');
}

function escapeIcalText(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// ─── Lounge: challenges (member side) ───
async function handleLoungeChallenges(event) {
  let ctx;
  try { ctx = await requireMember(event); }
  catch (err) { return respond(err.statusCode || 401, { success: false, error: err.message }); }
  const { member } = ctx;

  const today = new Date().toISOString().slice(0, 10);
  const { data: challenges } = await supabase
    .from('challenges')
    .select('id, title, description, challenge_type, metric, start_date, end_date, visibility, status, created_at')
    .in('status', ['active', 'finished'])
    .gte('end_date', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))
    .order('start_date', { ascending: false });

  const challengeIds = (challenges || []).map((c) => c.id);
  let myParticipationMap = {};
  if (challengeIds.length) {
    const { data: parts } = await supabase
      .from('challenge_participants')
      .select('challenge_id, joined_at, use_stealth_handle')
      .eq('member_id', member.id)
      .in('challenge_id', challengeIds);
    for (const p of (parts || [])) myParticipationMap[p.challenge_id] = p;
  }

  return respond(200, {
    success: true,
    challenges: (challenges || []).map((c) => ({
      ...c,
      joined: !!myParticipationMap[c.id],
      use_stealth_handle: myParticipationMap[c.id]?.use_stealth_handle || false,
    })),
  });
}

async function handleLoungeChallengeJoin(event, body) {
  let ctx;
  try { ctx = await requireMember(event); }
  catch (err) { return respond(err.statusCode || 401, { success: false, error: err.message }); }
  const { member } = ctx;
  const { challenge_id, use_stealth_handle } = body || {};
  if (!challenge_id) return respond(400, { success: false, error: 'challenge_id required' });
  const { error } = await supabase
    .from('challenge_participants')
    .upsert({
      challenge_id,
      member_id: member.id,
      use_stealth_handle: !!use_stealth_handle,
    }, { onConflict: 'challenge_id,member_id' });
  if (error) return respond(500, { success: false, error: 'failed' });
  return respond(200, { success: true });
}

async function handleLoungeChallengeLeave(event, body) {
  let ctx;
  try { ctx = await requireMember(event); }
  catch (err) { return respond(err.statusCode || 401, { success: false, error: err.message }); }
  const { member } = ctx;
  const { challenge_id } = body || {};
  if (!challenge_id) return respond(400, { success: false, error: 'challenge_id required' });
  await supabase
    .from('challenge_participants')
    .delete()
    .eq('challenge_id', challenge_id)
    .eq('member_id', member.id);
  return respond(200, { success: true });
}

async function handleLoungeChallengeLog(event, body) {
  let ctx;
  try { ctx = await requireMember(event); }
  catch (err) { return respond(err.statusCode || 401, { success: false, error: err.message }); }
  const { member } = ctx;
  const { challenge_id, value, note, entry_date } = body || {};
  if (!challenge_id) return respond(400, { success: false, error: 'challenge_id required' });
  const date = entry_date || new Date().toISOString().slice(0, 10);
  const { error } = await supabase
    .from('challenge_entries')
    .upsert({
      challenge_id,
      member_id: member.id,
      entry_date: date,
      value: value ?? null,
      note: note ?? null,
    }, { onConflict: 'challenge_id,member_id,entry_date' });
  if (error) return respond(500, { success: false, error: 'failed' });
  return respond(200, { success: true });
}

async function handleLoungeChallengeLeaderboard(event, params) {
  let ctx;
  try { ctx = await requireMember(event); }
  catch (err) { return respond(err.statusCode || 401, { success: false, error: err.message }); }
  const { member } = ctx;
  const challengeId = params.challenge_id;
  if (!challengeId) return respond(400, { success: false, error: 'challenge_id required' });

  // Pull challenge meta
  const { data: ch } = await supabase
    .from('challenges')
    .select('id, title, metric, challenge_type, start_date, end_date, status')
    .eq('id', challengeId)
    .single();
  if (!ch) return respond(404, { success: false, error: 'not found' });

  // Pull participants and their entries
  const { data: parts } = await supabase
    .from('challenge_participants')
    .select('member_id, use_stealth_handle, members(id, name)')
    .eq('challenge_id', challengeId);
  const memberIds = (parts || []).map((p) => p.member_id);

  let entriesByMember = {};
  if (memberIds.length) {
    const { data: entries } = await supabase
      .from('challenge_entries')
      .select('member_id, entry_date, value')
      .eq('challenge_id', challengeId)
      .in('member_id', memberIds);
    for (const e of (entries || [])) {
      if (!entriesByMember[e.member_id]) entriesByMember[e.member_id] = [];
      entriesByMember[e.member_id].push(e);
    }
  }

  // Build per-participant scores. Score is sum(value) for value-based metrics
  // (PBs, lifts, etc.) and entry count for attendance/streak.
  const valueMetrics = ['pb_lift', 'volume', 'distance'];
  const isCount = !valueMetrics.includes(ch.metric);

  const board = (parts || []).map((p) => {
    const myEntries = entriesByMember[p.member_id] || [];
    const score = isCount
      ? myEntries.length
      : myEntries.reduce((s, e) => s + (Number(e.value) || 0), 0);
    const handle = p.use_stealth_handle
      ? `Member ${(p.member_id || '').slice(0, 4).toUpperCase()}`
      : (p.members?.name || '—');
    const isMe = p.member_id === member.id;
    return { handle, score, isMe };
  }).sort((a, b) => b.score - a.score);

  return respond(200, { success: true, challenge: ch, leaderboard: board, is_count_metric: isCount });
}

// ─── Lounge: challenges (admin side) ───
async function handleAdminCreateChallenge(body) {
  requireAdmin(body.admin_key);
  const { title, description, challenge_type, metric, start_date, end_date, visibility } = body;
  if (!title || !challenge_type || !metric || !start_date || !end_date) {
    return respond(400, { success: false, error: 'title, challenge_type, metric, start_date, end_date required' });
  }
  const { data, error } = await supabase
    .from('challenges')
    .insert({
      title, description: description || null,
      challenge_type, metric, start_date, end_date,
      visibility: visibility || 'opt_in',
    })
    .select('*')
    .single();
  if (error) return respond(500, { success: false, error: error.message });
  return respond(200, { success: true, challenge: data });
}

async function handleAdminListChallenges() {
  const { data: challenges } = await supabase
    .from('challenges')
    .select('id, title, description, challenge_type, metric, start_date, end_date, visibility, status, created_at')
    .order('start_date', { ascending: false })
    .limit(50);

  const ids = (challenges || []).map((c) => c.id);
  let countsByChallenge = {};
  if (ids.length) {
    const { data: parts } = await supabase
      .from('challenge_participants')
      .select('challenge_id')
      .in('challenge_id', ids);
    for (const p of (parts || [])) {
      countsByChallenge[p.challenge_id] = (countsByChallenge[p.challenge_id] || 0) + 1;
    }
  }
  return respond(200, {
    success: true,
    challenges: (challenges || []).map((c) => ({ ...c, participants: countsByChallenge[c.id] || 0 })),
  });
}

async function handleAdminFinishChallenge(body) {
  requireAdmin(body.admin_key);
  const { challenge_id } = body;
  if (!challenge_id) return respond(400, { success: false, error: 'challenge_id required' });
  await supabase.from('challenges').update({ status: 'finished' }).eq('id', challenge_id);
  return respond(200, { success: true });
}

// ─── Lounge: billing portal (Stripe) ───
async function handleLoungeBillingPortal(event) {
  let ctx;
  try { ctx = await requireMember(event); }
  catch (err) { return respond(err.statusCode || 401, { success: false, error: err.message }); }
  const { member } = ctx;
  const result = await buildPortalSession(member, `${SITE_URL}/lounge#/payments`);
  return respond(200, { success: true, ...result });
}

// ─── Lounge: messaging (member side) ───
async function handleLoungeMessagesList(event) {
  let ctx;
  try { ctx = await requireMember(event); }
  catch (err) { return respond(err.statusCode || 401, { success: false, error: err.message }); }
  const { member } = ctx;

  const { data: messages } = await supabase
    .from('lounge_messages')
    .select('id, direction, body, read_at, sent_at')
    .eq('member_id', member.id)
    .order('sent_at', { ascending: true })
    .limit(200);

  // Mark inbound (out = trainer→member) messages as read
  await supabase
    .from('lounge_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('member_id', member.id)
    .eq('direction', 'out')
    .is('read_at', null);

  return respond(200, { success: true, messages: messages || [] });
}

async function handleLoungeSendMessage(event, body) {
  let ctx;
  try { ctx = await requireMember(event); }
  catch (err) { return respond(err.statusCode || 401, { success: false, error: err.message }); }
  const { member } = ctx;
  const text = String(body?.body || '').trim();
  if (!text) return respond(400, { success: false, error: 'empty' });
  if (text.length > 4000) return respond(400, { success: false, error: 'too_long' });

  const { data: row, error } = await supabase
    .from('lounge_messages')
    .insert({ member_id: member.id, direction: 'in', body: text })
    .select('*')
    .single();
  if (error) {
    console.error('send msg error:', error);
    return respond(500, { success: false, error: 'failed to send' });
  }

  // Notify Georgie (single email per send is noisy; you can mute later)
  try {
    await sendOwnerAlert(
      `Lounge message from ${member.name}`,
      `<p><strong>${escapeHtmlPlain(member.name)}</strong> (${escapeHtmlPlain(member.plan || '—')}) sent you a message in the Lounge:</p>` +
      `<blockquote style="border-left:3px solid #c9b99a;padding:8px 16px;color:#3d3530;">${escapeHtmlPlain(text)}</blockquote>` +
      `<p style="margin-top:16px;"><a href="${SITE_URL}/admin.html" style="color:#3d3530;">Reply in admin →</a></p>`
    );
  } catch (e) { console.error('owner alert failed', e); }

  return respond(200, { success: true, message: row });
}

// ─── Lounge: messaging (admin side) ───
async function handleLoungeAdminInbox() {
  // Audit (admin read of member-message data)
  supabase.from('lounge_audit_log').insert({
    actor_role: 'trainer',
    action: 'admin_view_inbox',
    resource: 'all',
  }).then(() => {}, () => {});

  // Latest message per member, with unread count, ordered by activity
  const { data: messages } = await supabase
    .from('lounge_messages')
    .select('id, member_id, direction, body, read_at, sent_at, members(id, name, email, plan)')
    .order('sent_at', { ascending: false })
    .limit(500);

  const threadMap = {};
  for (const m of (messages || [])) {
    const mid = m.member_id;
    if (!threadMap[mid]) {
      threadMap[mid] = {
        member_id: mid,
        member_name: m.members?.name || '—',
        member_plan: m.members?.plan || '—',
        last_message: m.body,
        last_direction: m.direction,
        last_sent_at: m.sent_at,
        unread_count: 0,
      };
    }
    if (m.direction === 'in' && !m.read_at) threadMap[mid].unread_count += 1;
  }
  const threads = Object.values(threadMap).sort(
    (a, b) => new Date(b.last_sent_at) - new Date(a.last_sent_at)
  );
  return respond(200, { success: true, threads });
}

async function handleLoungeAdminThread(event, params) {
  const memberId = params.member_id;
  if (!memberId) return respond(400, { success: false, error: 'member_id required' });

  const [msgsRes, memberRes] = await Promise.all([
    supabase.from('lounge_messages')
      .select('id, direction, body, read_at, sent_at')
      .eq('member_id', memberId)
      .order('sent_at', { ascending: true })
      .limit(500),
    supabase.from('members').select('id, name, email, plan').eq('id', memberId).single(),
  ]);

  // Audit (admin read of member data)
  supabase.from('lounge_audit_log').insert({
    member_id: memberId,
    actor_role: 'trainer',
    action: 'admin_view_thread',
    resource: memberId,
  }).then(() => {}, () => {});

  return respond(200, {
    success: true,
    member: memberRes.data,
    messages: msgsRes.data || [],
  });
}

// Separate POST so admins explicitly mark read (was happening as a
// silent side-effect on a GET, letting any drive-by request destroy
// the unread state Georgie depends on).
async function handleLoungeAdminMarkThreadRead(body) {
  requireAdmin(body.admin_key);
  const memberId = body.member_id;
  if (!memberId) return respond(400, { success: false, error: 'member_id required' });
  await supabase
    .from('lounge_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('member_id', memberId)
    .eq('direction', 'in')
    .is('read_at', null);
  return respond(200, { success: true });
}

async function handleLoungeAdminSendMessage(body) {
  requireAdmin(body.admin_key);
  const { member_id, body: text } = body;
  if (!member_id || !text || !String(text).trim()) {
    return respond(400, { success: false, error: 'member_id and body required' });
  }
  const { data: row, error } = await supabase
    .from('lounge_messages')
    .insert({ member_id, direction: 'out', body: String(text).trim() })
    .select('*')
    .single();
  if (error) return respond(500, { success: false, error: 'failed to send' });
  return respond(200, { success: true, message: row });
}

// ─── Lounge: admin-side activity feed (cancellations + holds) ───
async function handleLoungeAdminActivity() {
  // Audit (admin read of member-session data)
  supabase.from('lounge_audit_log').insert({
    actor_role: 'trainer',
    action: 'admin_view_activity',
    resource: 'all',
  }).then(() => {}, () => {});

  // Recent cancellations (last 60 days)
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const cutoffStr = sixtyDaysAgo.toISOString().slice(0, 10);

  const { data: logs } = await supabase
    .from('member_session_log')
    .select('id, member_id, slot_id, session_date, session_time, state, charge_required, charge_amount_cents, notice_hours, reason, created_at, members(id, name, email, plan, stripe_customer_id)')
    .in('state', ['cancelled_late', 'cancelled_in_time', 'paused'])
    .gte('session_date', cutoffStr)
    .order('created_at', { ascending: false })
    .limit(120);

  const { data: holds } = await supabase
    .from('travel_holds')
    .select('id, member_id, start_date, end_date, status, reason, created_at, members(id, name, email, plan)')
    .in('status', ['active', 'completed', 'cancelled'])
    .order('start_date', { ascending: false })
    .limit(100);

  return respond(200, {
    success: true,
    cancellations: (logs || []).map((l) => ({
      id: l.id,
      member_id: l.member_id,
      member_name: l.members?.name || '—',
      member_plan: l.members?.plan || '—',
      stripe_customer_id: l.members?.stripe_customer_id || null,
      session_date: l.session_date,
      session_time: l.session_time,
      state: l.state,
      charge_required: l.charge_required,
      charge_amount_cents: l.charge_amount_cents,
      notice_hours: l.notice_hours,
      reason: l.reason,
      created_at: l.created_at,
    })),
    travel_holds: (holds || []).map((h) => ({
      id: h.id,
      member_id: h.member_id,
      member_name: h.members?.name || '—',
      member_plan: h.members?.plan || '—',
      start_date: h.start_date,
      end_date: h.end_date,
      status: h.status,
      reason: h.reason,
      created_at: h.created_at,
    })),
  });
}

// ─── Lounge: save member preferences ───
async function handleLoungeSavePreferences(event, body) {
  let ctx;
  try {
    ctx = await requireMember(event);
  } catch (err) {
    return respond(err.statusCode || 401, { success: false, error: err.message });
  }
  const { member } = ctx;
  const allowed = ['display_name', 'stealth_handle', 'notify_email', 'challenges_opted_in', 'read_receipts'];
  const patch = { updated_at: new Date().toISOString() };
  for (const k of allowed) {
    if (k in (body || {})) patch[k] = body[k];
  }
  if (Object.keys(patch).length === 1) {
    return respond(400, { success: false, error: 'no fields to update' });
  }

  // Upsert (preferences row may not exist yet)
  const { data, error } = await supabase
    .from('member_preferences')
    .upsert({ member_id: member.id, ...patch }, { onConflict: 'member_id' })
    .select('*')
    .single();
  if (error) {
    console.error('save prefs error:', error);
    return respond(500, { success: false, error: 'failed to save' });
  }
  return respond(200, { success: true, preferences: data });
}

// ═══════════════════════════════════════════════
// Main handler
// ═══════════════════════════════════════════════

// Admin-only GET actions — must present X-Admin-Key header (or
// admin_key query param). Anything not in this set is public OR
// gated by member JWT inside its own handler.
const ADMIN_GET_ACTIONS = new Set([
  'events', 'bookings', 'notifications', 'memberships', 'contacts',
  'dashboard', 'members', 'schedule', 'member', 'referrals',
  'all_plans', 'all_testimonials', 'media',
  'crm_dashboard', 'appointments',
  'lounge_admin_activity', 'lounge_admin_challenges',
  'lounge_admin_inbox', 'lounge_admin_thread',
]);

exports.handler = async (event) => {
  const corsHeaders = corsHeadersFor(event);

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    // ─── GET requests ───
    if (event.httpMethod === 'GET') {
      if (ADMIN_GET_ACTIONS.has(action)) {
        try { requireAdminFromEvent(event); }
        catch { return respond(401, { success: false, error: 'unauthorized' }); }
      }
      switch (action) {
        case 'config':
          return await handleConfig();
        case 'events':
          return await handleEvents();
        case 'bookings':
          return await handleBookings(params.event_id);
        case 'notifications':
          return await handleNotifications();
        case 'memberships':
          return await handleMemberships();
        case 'contacts':
          return await handleContacts();
        case 'dashboard':
          return await handleDashboard();
        case 'members':
          return await handleGetMembers();
        case 'schedule':
          return await handleGetSchedule();
        case 'member':
          return await handleGetMember(params.id);
        case 'submit_review':
          return await handleSubmitReview(params);
        case 'referrals':
          return await handleReferrals();
        case 'calendar_feed':
          return await handleCalendarFeed();
        case 'plans':
          return await handleGetPlans();
        case 'all_plans':
          return await handleGetAllPlans();
        case 'site_content':
          return await handleGetSiteContent();
        case 'testimonials':
          return await handleGetTestimonials();
        case 'all_testimonials':
          return await handleGetAllTestimonials();
        case 'media':
          return await handleListMedia();
        case 'crm_dashboard':
          return await handleCrmDashboard();
        case 'appointments':
          return await handleGetAppointments(params);
        case 'agreement':
          return await handleGetAgreement(params.token);
        case 'lounge_me':
          return await handleLoungeMe(event);
        case 'lounge_admin_activity':
          return await handleLoungeAdminActivity();
        case 'lounge_messages':
          return await handleLoungeMessagesList(event);
        case 'lounge_billing_portal':
          return await handleLoungeBillingPortal(event);
        case 'lounge_challenges':
          return await handleLoungeChallenges(event);
        case 'lounge_challenge_leaderboard':
          return await handleLoungeChallengeLeaderboard(event, params);
        case 'lounge_admin_challenges':
          return await handleAdminListChallenges();
        case 'lounge_ical':
          return await handleLoungeIcal(params);
        case 'lounge_audit_log':
          return await handleLoungeAuditLog(event);
        case 'lounge_admin_inbox':
          return await handleLoungeAdminInbox();
        case 'lounge_admin_thread':
          return await handleLoungeAdminThread(event, params);
        default:
          return respond(400, { success: false, error: 'unknown action' });
      }
    }

    // ─── POST requests ───
    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body);
      } catch {
        return respond(400, { success: false, error: 'invalid JSON body' });
      }

      const postAction = body.action || action;

      // Clean up expired holds before every POST operation
      await cleanupExpiredHolds();

      switch (postAction) {
        case 'verify_admin':
          try { requireAdmin(body.admin_key); return respond(200, { success: true }); }
          catch { return respond(401, { success: false, error: 'Invalid password' }); }
        case 'book':
          return await handleBook(body);
        case 'notify':
          return await handleNotify(body);
        case 'waitlist':
          return await handleWaitlist(body);
        case 'contact':
          return await handleContact(body);
        case 'membership':
          return await handleMembership(body);
        case 'create_event':
          return await handleCreateEvent(body);
        case 'update_event':
          return await handleUpdateEvent(body);
        case 'delete_event':
          requireAdmin(body.admin_key);
          if (!body.event_id) return respond(400, { success: false, error: 'event_id required' });
          const { error: delErr } = await supabase.from('events').delete().eq('id', body.event_id);
          if (delErr) throw delErr;
          return respond(200, { success: true });
        case 'cancel_booking':
          return await handleCancelBooking(body);
        case 'send_notifications':
          return await handleSendNotifications(body);
        case 'update_membership':
          requireAdmin(body.admin_key);
          const { id: memId, status: memStatus, notes: memNotesUpd, follow_up_at: memFollowUp } = body;
          if (!memId) return respond(400, { success: false, error: 'id required' });
          const memUpdates = {};
          if (memStatus !== undefined) memUpdates.status = memStatus;
          if (memNotesUpd !== undefined) memUpdates.notes = memNotesUpd;
          if (memFollowUp !== undefined) memUpdates.follow_up_at = memFollowUp || null;
          if (Object.keys(memUpdates).length === 0) return respond(400, { success: false, error: 'nothing to update' });
          const { error: memErr } = await supabase.from('memberships').update(memUpdates).eq('id', memId);
          if (memErr) throw memErr;
          return respond(200, { success: true });
        case 'cleanup_holds':
          return await handleCleanupHolds();
        case 'accept_membership':
          return await handleAcceptMembership(body);
        case 'send_welcome':
          return await handleSendWelcome(body);
        case 'confirm_agreement':
          return await handleConfirmAgreement(body);
        case 'create_member':
          return await handleCreateMember(body);
        case 'update_member':
          return await handleUpdateMember(body);
        case 'create_slot':
          return await handleCreateSlot(body);
        case 'update_slot':
          return await handleUpdateSlot(body);
        case 'delete_slot':
          return await handleDeleteSlot(body);
        case 'assign_slot':
          return await handleAssignSlot(body);
        case 'unassign_slot':
          return await handleUnassignSlot(body);
        case 'send_review_requests':
          return await handleSendReviewRequests(body);
        case 'sync_calendar':
          return await handleCalendarFeed();
        case 'create_plan':
          return await handleCreatePlan(body);
        case 'update_plan':
          return await handleUpdatePlan(body);
        case 'delete_plan':
          return await handleDeletePlan(body);
        case 'update_site_content':
          return await handleUpdateSiteContent(body);
        case 'create_testimonial':
          return await handleCreateTestimonial(body);
        case 'update_testimonial':
          return await handleUpdateTestimonial(body);
        case 'delete_testimonial':
          return await handleDeleteTestimonial(body);
        case 'upload_media':
          return await handleUploadMedia(body);
        case 'delete_media':
          return await handleDeleteMedia(body);
        case 'delete_membership_request':
          requireAdmin(body.admin_key);
          if (!body.membership_id) return respond(400, { success: false, error: 'membership_id required' });
          const { error: delMreqErr } = await supabase.from('memberships').delete().eq('id', body.membership_id);
          if (delMreqErr) throw delMreqErr;
          return respond(200, { success: true });
        case 'delete_member':
          requireAdmin(body.admin_key);
          if (!body.member_id) return respond(400, { success: false, error: 'member_id required' });
          const { error: delMemErr } = await supabase.from('members').delete().eq('id', body.member_id);
          if (delMemErr) throw delMemErr;
          return respond(200, { success: true });
        case 'delete_contact':
          requireAdmin(body.admin_key);
          if (!body.contact_id) return respond(400, { success: false, error: 'contact_id required' });
          const { error: delContactErr } = await supabase.from('contacts').delete().eq('id', body.contact_id);
          if (delContactErr) throw delContactErr;
          return respond(200, { success: true });
        case 'create_appointment':
          return await handleCreateAppointment(body);
        case 'update_appointment':
          return await handleUpdateAppointment(body);
        case 'delete_appointment':
          return await handleDeleteAppointment(body);
        case 'update_member_notes':
          return await handleUpdateMemberNotes(body);
        case 'update_enquiry_notes':
          return await handleUpdateEnquiryNotes(body);
        case 'lounge_auth_send':
          return await handleLoungeAuthSend(body);
        case 'lounge_cancel_session':
          return await handleLoungeCancelSession(event, body);
        case 'lounge_create_travel_hold':
          return await handleLoungeCreateTravelHold(event, body);
        case 'lounge_cancel_travel_hold':
          return await handleLoungeCancelTravelHold(event, body);
        case 'lounge_save_preferences':
          return await handleLoungeSavePreferences(event, body);
        case 'lounge_send_message':
          return await handleLoungeSendMessage(event, body);
        case 'lounge_admin_send_message':
          return await handleLoungeAdminSendMessage(body);
        case 'lounge_admin_mark_thread_read':
          return await handleLoungeAdminMarkThreadRead(body);
        case 'lounge_challenge_join':
          return await handleLoungeChallengeJoin(event, body);
        case 'lounge_challenge_leave':
          return await handleLoungeChallengeLeave(event, body);
        case 'lounge_challenge_log':
          return await handleLoungeChallengeLog(event, body);
        case 'admin_create_challenge':
          return await handleAdminCreateChallenge(body);
        case 'admin_finish_challenge':
          return await handleAdminFinishChallenge(body);
        case 'lounge_concierge':
          return await handleLoungeConcierge(event, body);
        case 'admin_generate_lounge_link':
          return await handleAdminGenerateLoungeLink(body);
        case 'lounge_rotate_ical':
          return await handleLoungeRotateIcal(event);
        default:
          return respond(400, { success: false, error: 'unknown action' });
      }
    }

    return respond(405, { success: false, error: 'method not allowed' });
  } catch (err) {
    console.error('API error:', err);
    if (err.message === 'unauthorized') {
      return respond(401, { success: false, error: 'unauthorized' });
    }
    // Generic 500 — never leak err.message (could expose Postgres column
    // names, stack hints, internal paths). Real diagnostics go to logs.
    return respond(500, { success: false, error: 'internal server error' });
  }
};
