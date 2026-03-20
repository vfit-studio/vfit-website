/*
 * VFIT Studio - Main API Endpoint
 * Handles all operations via query parameter ?action=...
 *
 * Environment variables required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_SECRET_KEY,
 *   STRIPE_WEBHOOK_SECRET, ADMIN_KEY, SITE_URL
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
 */

const { supabase } = require('./utils/supabase');
const Stripe = require('stripe');
const { sendNotifyConfirmation, sendBookingsOpenEmail, sendBookingConfirmation, sendMembershipConfirmation, sendOwnerAlert } = require('./utils/email');

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

  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('status', 'active')
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

  // Contact messages
  const { count: totalContacts } = await supabase
    .from('contacts')
    .select('*', { count: 'exact', head: true });

  return respond(200, {
    success: true,
    dashboard: {
      total_bookings: totalBookings || 0,
      total_revenue_cents: totalRevenue,
      upcoming_events: upcoming || [],
      total_memberships: totalMemberships || 0,
      total_contacts: totalContacts || 0,
    },
  });
}

// ═══════════════════════════════════════════════
// POST handlers
// ═══════════════════════════════════════════════

async function handleBook(body) {
  const { name, email, phone, event_id } = body;
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
  // Alert Georgie
  await sendOwnerAlert(
    'New Contact Message — ' + name,
    `<p><strong>From:</strong> ${name} (${email}${phone ? ', ' + phone : ''})</p><p><strong>Message:</strong> ${message || 'No message'}</p>`
  );
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
  // Send confirmation to the person
  await sendMembershipConfirmation(email, name, plan);
  // Alert Georgie
  await sendOwnerAlert(
    'New Membership Enquiry — ' + plan,
    `<p><strong>${name}</strong> (${email}, ${phone || 'no phone'})</p><p><strong>Plan:</strong> ${plan}</p><p><strong>Sessions/wk:</strong> ${sessions || '—'}</p><p><strong>Days:</strong> ${days || '—'}</p><p><strong>Times:</strong> ${times || '—'}</p><p><strong>Notes:</strong> ${notes || 'None'}</p>`
  );
  return respond(200, { success: true, message: 'Enquiry sent! Check your email.' });
}

async function handleCreateEvent(body) {
  requireAdmin(body.admin_key);
  const { name, type, session_date, spots_total, price_cents } = body;
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
    slots: slotMap[m.id] || [],
  }));

  return respond(200, { success: true, members: result });
}

async function handleGetSchedule() {
  const { data: slots, error } = await supabase
    .from('schedule_slots')
    .select('*')
    .eq('status', 'active')
    .order('time', { ascending: true });
  if (error) throw error;

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
  const { membership_id, sessions_per_week } = body;
  if (!membership_id) return respond(400, { success: false, error: 'membership_id is required' });

  // Fetch the membership enquiry
  const { data: enquiry, error: fetchErr } = await supabase
    .from('memberships')
    .select('*')
    .eq('id', membership_id)
    .single();
  if (fetchErr || !enquiry) return respond(404, { success: false, error: 'membership_not_found' });

  // Create the member record
  const { data: member, error: insertErr } = await supabase
    .from('members')
    .insert({
      membership_id: enquiry.id,
      name: enquiry.name,
      email: enquiry.email,
      phone: enquiry.phone,
      plan: enquiry.plan,
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

  return respond(200, { success: true, member });
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
