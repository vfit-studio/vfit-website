-- ═══════════════════════════════════════════════
-- Stripe-ready columns on members (Phase 4)
-- ═══════════════════════════════════════════════
-- Adds columns to link a member to their Stripe customer + subscription.
-- All nullable — code paths gracefully no-op if Stripe isn't configured.

alter table members
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text;

create unique index if not exists idx_members_stripe_customer on members(stripe_customer_id) where stripe_customer_id is not null;
