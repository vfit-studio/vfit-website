/*
 * Stripe-ready helpers for the lounge.
 *
 * Designed so the entire flow gracefully no-ops when Stripe isn't
 * configured (no STRIPE_SECRET_KEY, or member has no stripe_customer_id),
 * and starts working the instant those things exist — no code change.
 */

const Stripe = require('stripe');
const { supabase } = require('./supabase');

function isStripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function getStripe() {
  if (!isStripeConfigured()) return null;
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// Fetch the member's plan record so we can compute per-session pricing
// for late-cancellation fees.
async function getPlanForMember(member) {
  if (!member?.plan) return null;
  // Try exact match first, then a fuzzy name match.
  const { data: exact } = await supabase
    .from('membership_plans')
    .select('id, name, price_cents, period_label')
    .ilike('name', member.plan)
    .maybeSingle();
  if (exact) return exact;

  const { data: rows } = await supabase
    .from('membership_plans')
    .select('id, name, price_cents, period_label')
    .ilike('name', `%${member.plan.split(' ')[0] || ''}%`);
  return (rows && rows[0]) || null;
}

// Estimated fee for a single session given a plan record.
// Plans store price + period_label ("session" | "week" | "month"). For
// per-week or per-month plans we divide by the member's sessions_per_week
// to back out a per-session number, falling back to the raw price for
// session-billed plans.
function estimateSessionFeeCents(plan, member) {
  if (!plan?.price_cents) return null;
  const period = String(plan.period_label || '').toLowerCase();
  const spw = Math.max(1, member?.sessions_per_week || 1);
  if (period.includes('session')) return plan.price_cents;
  if (period.includes('week'))    return Math.round(plan.price_cents / spw);
  if (period.includes('month'))   return Math.round(plan.price_cents / (spw * 4));
  return plan.price_cents;
}

// Build the Stripe Customer Portal session URL for this member.
// Returns null if Stripe isn't ready (caller decides what to show).
async function buildPortalSession(member, returnUrl) {
  const stripe = getStripe();
  if (!stripe) return { configured: false };
  if (!member?.stripe_customer_id) return { configured: true, customer: false };
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: member.stripe_customer_id,
      return_url: returnUrl,
    });
    return { configured: true, customer: true, url: session.url };
  } catch (err) {
    console.error('billing portal error:', err);
    return { configured: true, customer: true, error: 'portal_failed' };
  }
}

module.exports = {
  isStripeConfigured,
  getStripe,
  getPlanForMember,
  estimateSessionFeeCents,
  buildPortalSession,
};
