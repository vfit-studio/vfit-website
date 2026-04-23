-- Adds welcome/agreement tracking columns to members.
-- agreement_token: unique per member, used in the confirmation URL
-- welcome_sent_at: set when Georgie sends the welcome email+SMS
-- agreed_at:       set when the member taps "Confirm & Agree" on the agreement page

ALTER TABLE members ADD COLUMN IF NOT EXISTS agreement_token uuid DEFAULT gen_random_uuid();
ALTER TABLE members ADD COLUMN IF NOT EXISTS welcome_sent_at timestamptz;
ALTER TABLE members ADD COLUMN IF NOT EXISTS agreed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_members_agreement_token ON members(agreement_token);

-- Backfill tokens for any members that existed before this migration
UPDATE members SET agreement_token = gen_random_uuid() WHERE agreement_token IS NULL;
