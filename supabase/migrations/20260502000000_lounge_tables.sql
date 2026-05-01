-- ═══════════════════════════════════════════════
-- VIP Member Lounge — schema additions
-- ═══════════════════════════════════════════════
-- Adds tables to power the member lounge:
--   - member_auth            : link Supabase auth.users → members
--   - member_preferences     : per-member lounge preferences
--   - member_session_log     : per-occurrence billing/state (lazy)
--   - travel_holds           : pause-membership date ranges
--   - lounge_messages        : direct messages between member ↔ trainer
--   - lounge_message_attachments
--   - challenges, challenge_participants, challenge_entries
--   - lounge_audit_log       : privacy audit trail
--
-- Plan-tier cancellation rules (48h vs 1 week) live in code, not DB,
-- because they mirror the static text in src/js/agreement.js.

-- ─── 1. Auth link ──────────────────────────────
create table if not exists member_auth (
  user_id uuid primary key references auth.users(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  first_login_at timestamptz default now(),
  last_login_at  timestamptz default now()
);

create unique index if not exists idx_member_auth_member on member_auth(member_id);

-- ─── 2. Preferences ────────────────────────────
create table if not exists member_preferences (
  member_id uuid primary key references members(id) on delete cascade,
  display_name text,
  stealth_handle text,
  notify_email boolean not null default true,
  challenges_opted_in boolean not null default false,
  read_receipts boolean not null default true,
  quiet_hours_start time,
  quiet_hours_end   time,
  updated_at timestamptz not null default now()
);

-- ─── 3. Session log (per occurrence) ───────────
-- Default state for any future occurrence of an active member_slot is
-- implied "scheduled". Rows here only exist when state deviates:
-- cancelled_in_time | cancelled_late | paused | attended | no_show.
create table if not exists member_session_log (
  id uuid default gen_random_uuid() primary key,
  member_id uuid not null references members(id) on delete cascade,
  slot_id uuid references schedule_slots(id) on delete set null,
  session_date date not null,
  session_time text,
  state text not null check (state in (
    'scheduled', 'cancelled_in_time', 'cancelled_late',
    'paused', 'attended', 'no_show', 'rescheduled'
  )),
  charge_required boolean not null default false,
  charge_amount_cents integer,
  notice_hours numeric,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(member_id, slot_id, session_date)
);

create index if not exists idx_session_log_member_date on member_session_log(member_id, session_date);

-- ─── 4. Travel holds ───────────────────────────
-- Pause the membership for a date range. Policy: max 1 month / year
-- (enforced in app code, not DB).
create table if not exists travel_holds (
  id uuid default gen_random_uuid() primary key,
  member_id uuid not null references members(id) on delete cascade,
  start_date date not null,
  end_date   date not null,
  status text not null default 'active' check (status in ('active', 'cancelled', 'completed')),
  reason text,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists idx_travel_holds_member on travel_holds(member_id, start_date);

-- ─── 5. Direct messages ────────────────────────
-- direction: 'in'  = from member to trainer
--            'out' = from trainer to member
create table if not exists lounge_messages (
  id uuid default gen_random_uuid() primary key,
  member_id uuid not null references members(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  body text,
  read_at timestamptz,
  sent_at timestamptz not null default now()
);

create index if not exists idx_lounge_messages_member_sent on lounge_messages(member_id, sent_at desc);
create index if not exists idx_lounge_messages_unread     on lounge_messages(member_id, read_at) where read_at is null;

create table if not exists lounge_message_attachments (
  id uuid default gen_random_uuid() primary key,
  message_id uuid not null references lounge_messages(id) on delete cascade,
  storage_path text not null,
  mime_type text,
  size_bytes integer,
  created_at timestamptz not null default now()
);

-- ─── 6. Challenges ─────────────────────────────
create table if not exists challenges (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  description text,
  challenge_type text not null check (challenge_type in ('solo', 'squad', 'studio')),
  metric text not null,                  -- e.g. 'attendance', 'pb_lift', 'streak'
  start_date date not null,
  end_date   date not null,
  visibility text not null default 'opt_in' check (visibility in ('opt_in', 'invite_only')),
  status text not null default 'active' check (status in ('draft', 'active', 'finished', 'cancelled')),
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table if not exists challenge_participants (
  id uuid default gen_random_uuid() primary key,
  challenge_id uuid not null references challenges(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  joined_at timestamptz not null default now(),
  use_stealth_handle boolean not null default false,
  unique (challenge_id, member_id)
);

create table if not exists challenge_entries (
  id uuid default gen_random_uuid() primary key,
  challenge_id uuid not null references challenges(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  entry_date date not null default current_date,
  value numeric,
  note text,
  created_at timestamptz not null default now(),
  unique (challenge_id, member_id, entry_date)
);

create index if not exists idx_challenge_entries_challenge on challenge_entries(challenge_id, member_id, entry_date);

-- ─── 7. Audit log ──────────────────────────────
-- Used to back the "who has accessed my data" privacy promise.
create table if not exists lounge_audit_log (
  id bigserial primary key,
  member_id uuid references members(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_role text not null check (actor_role in ('member', 'trainer', 'system')),
  action text not null,
  resource text,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_audit_member on lounge_audit_log(member_id, occurred_at desc);
