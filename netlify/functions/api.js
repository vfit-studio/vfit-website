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
const Stripe = require('stripe');
const { sendNotifyConfirmation, sendBookingsOpenEmail, sendBookingConfirmation, sendMembershipConfirmation, sendOwnerAlert, sendWaitlistSpotEmail, sendReviewRequestEmail } = require('./utils/email');
const { sendOwnerSMS } = require('./utils/sms');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SITE_URL = process.env.SITE_URL || 'https://vfit-studio.netlify.app';
const ADMIN_KEY = process.env.ADMIN_KEY;
const HOLD_EXPIRY_MINUTES = 10;

// ─── CORS headers applied to every response ───
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ─── Cleanup expired holds ───
async function cleanupExpiredHolds() {
  const cutoff = new Date(Date.now() - HOLD_EXPIRY_MINUTES * 60 * 1000).toISOString();
  await supabase
    .from('bookings')
    .update({ status: 'expired' })
    .eq('status', 'held')
    .lt('held_at', cutoff);
}

// ─── Validate admin key ───
function requireAdmin(adminKey) {
  if (!adminKey || adminKey !== ADMIN_KEY) {
    throw new Error('unauthorized');
  }
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
  // Clean up expired holds before returning live counts
  await cleanupExpiredHolds();

  // Only return future events (session_date >= now) so the frontend
  // always gets upcoming sessions rather than stale past ones.
  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('status', 'active')
    .gte('session_date', new Date().toISOString())
    .order('session_date', { ascending: true });

  if (error) throw error;

  const config = [];
  for (const event of events) {
    const taken = await spotsTaken(event.id);
    config.push({
      id: event.id,
      name: event.name,
      type: event.type,
      tickets_open: event.tickets_open,
      session_date: event.session_date,
      spots_total: event.spots_total,
      spots_remaining: Math.max(0, event.spots_total - taken),
      price_cents: event.price_cents,
      glofox_url: event.glofox_url || null,
      status: event.status,
    });
  }

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
  // Total bookings (confirmed)
  const { count: totalBookings } = await supabase
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'confirmed');

  // Total revenue
  const { data: revenueRows } = await supabase
    .from('bookings')
    .select('amount_cents')
    .eq('status', 'confirmed');
  const totalRevenue = (revenueRows || []).reduce((sum, r) => sum + (r.amount_cents || 0), 0);

  // Upcoming events
  const { data: upcoming } = await supabase
    .from('events')
    .select('*')
    .eq('status', 'active')
    .gte('session_date', new Date().toISOString())
    .order('session_date', { ascending: true });

  // Membership enquiries
  const { count: totalMemberships } = await supabase
    .from('memberships')
    .select('*', { count: 'exact', head: true });

  // Active members count
  const { count: totalMembers } = await supabase
    .from('members')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  return respond(200, {
    success: true,
    dashboard: {
      upcoming_events: upcoming || [],
      total_memberships: totalMemberships || 0,
      total_members: totalMembers || 0,
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
      `<p><strong>${name}</strong> (${email}, ${phone || 'no phone'}) booked <strong>${event.name}</strong>.</p><p>Spots: ${taken + 1} / ${event.spots_total}</p>`
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
  const session = await stripe.checkout.sessions.create({
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
  await sendOwnerAlert('New notification signup', `<p><strong>${name || 'Unknown'}</strong> (${email}) wants to be notified about <strong>${interest || 'upcoming sessions'}</strong>.</p>`);

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
  await sendOwnerAlert('New waitlist signup', `<p><strong>${name || 'Unknown'}</strong> (${email}) joined the waitlist for <strong>${interest || 'upcoming sessions'}</strong>.</p>`);

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
  const { event_id, ...fields } = body;
  if (!event_id) return respond(400, { success: false, error: 'event_id is required' });

  // Strip non-updatable fields
  delete fields.admin_key;
  delete fields.action;
  delete fields.id;
  delete fields.created_at;

  const { data, error } = await supabase
    .from('events')
    .update(fields)
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
    `<p>Sent <strong>${sent}</strong> "bookings are open" emails for <strong>${event_type}</strong>.</p>`
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
       <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 14px;"><strong>${existing.name}</strong> (${existing.plan}) confirmed their liability waiver and cancellation policy.</p>
       <p style="font-size:13px;color:#8c7660;margin:0;">${when}</p>`
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
  const { member_id, ...fields } = body;
  if (!member_id) return respond(400, { success: false, error: 'member_id is required' });

  // Strip non-updatable fields
  delete fields.admin_key;
  delete fields.action;
  delete fields.id;
  delete fields.created_at;

  const { data: member, error } = await supabase
    .from('members')
    .update(fields)
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
  const { slot_id, ...fields } = body;
  if (!slot_id) return respond(400, { success: false, error: 'slot_id is required' });

  // Strip non-updatable fields
  delete fields.admin_key;
  delete fields.action;
  delete fields.id;
  delete fields.created_at;

  const { data: slot, error } = await supabase
    .from('schedule_slots')
    .update(fields)
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

  const { error } = await supabase.from('reviews').insert({
    event_id,
    email: email.toLowerCase().trim(),
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
  const { plan_id, ...fields } = body;
  if (!plan_id) return respond(400, { success: false, error: 'plan_id is required' });
  delete fields.admin_key;
  delete fields.action;
  delete fields.id;
  delete fields.created_at;
  const { data, error } = await supabase
    .from('membership_plans')
    .update(fields)
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
  const { testimonial_id, ...fields } = body;
  if (!testimonial_id) return respond(400, { success: false, error: 'testimonial_id is required' });
  delete fields.admin_key;
  delete fields.action;
  delete fields.id;
  delete fields.created_at;
  const { data, error } = await supabase
    .from('testimonials')
    .update(fields)
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

  // Fetch bookings for each event
  const vevents = [];
  for (const event of (events || [])) {
    const { data: bookings } = await supabase
      .from('bookings')
      .select('name')
      .eq('event_id', event.id)
      .in('status', ['confirmed', 'held']);

    const bookedNames = (bookings || []).map(b => b.name).join(', ');
    const bookedCount = (bookings || []).length;

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

    vevents.push(
`BEGIN:VEVENT
DTSTART:${formatDt(dtStart)}
DTEND:${formatDt(dtEnd)}
SUMMARY:${event.name} (${bookedCount}/${event.spots_total} booked)
DESCRIPTION:Booked: ${bookedNames || 'None yet'}
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
  const { appointment_id, ...fields } = body;
  if (!appointment_id) return respond(400, { success: false, error: 'appointment_id is required' });
  delete fields.admin_key; delete fields.action; delete fields.id; delete fields.created_at;
  fields.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from('appointments')
    .update(fields)
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
// Main handler
// ═══════════════════════════════════════════════

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    // ─── GET requests ───
    if (event.httpMethod === 'GET') {
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
          if (body.admin_key === process.env.ADMIN_KEY) {
            return respond(200, { success: true });
          }
          return respond(401, { success: false, error: 'Invalid password' });
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
          const { id: memId, status: memStatus } = body;
          if (!memId || !memStatus) return respond(400, { success: false, error: 'id and status required' });
          const { error: memErr } = await supabase.from('memberships').update({ status: memStatus }).eq('id', memId);
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
    return respond(500, { success: false, error: err.message || 'internal server error' });
  }
};
