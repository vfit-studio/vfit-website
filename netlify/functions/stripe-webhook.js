/*
 * VFIT Studio - Stripe Webhook Handler
 *
 * Handles:
 *   - checkout.session.completed  -> confirm the booking
 *   - checkout.session.expired    -> expire the held booking
 *
 * Verifies signature using STRIPE_WEBHOOK_SECRET.
 */

const { supabase } = require('./utils/supabase');
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let stripeEvent;

  // Verify webhook signature
  try {
    const sig = event.headers['stripe-signature'];
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const bookingId = session.metadata?.booking_id;

        if (!bookingId) {
          console.warn('No booking_id in session metadata');
          break;
        }

        // Update booking to confirmed
        const { error } = await supabase
          .from('bookings')
          .update({
            status: 'confirmed',
            stripe_payment_id: session.payment_intent,
            amount_cents: session.amount_total,
            confirmed_at: new Date().toISOString(),
          })
          .eq('id', bookingId)
          .eq('status', 'held');

        if (error) {
          console.error('Error confirming booking:', error);
        } else {
          console.log(`Booking ${bookingId} confirmed`);
        }
        break;
      }

      case 'checkout.session.expired': {
        const session = stripeEvent.data.object;
        const bookingId = session.metadata?.booking_id;

        if (!bookingId) {
          console.warn('No booking_id in session metadata');
          break;
        }

        // Expire the held booking to release the spot
        const { error } = await supabase
          .from('bookings')
          .update({ status: 'expired' })
          .eq('id', bookingId)
          .eq('status', 'held');

        if (error) {
          console.error('Error expiring booking:', error);
        } else {
          console.log(`Booking ${bookingId} expired (checkout session expired)`);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
    return { statusCode: 500, body: 'Webhook processing error' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
