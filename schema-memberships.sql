-- ═══════════════════════════════════════════════
-- VFIT Membership Scheduling System
-- Run this in the Supabase SQL Editor
-- ═══════════════════════════════════════════════

-- Weekly schedule slots (Georgie's recurring timetable)
create table schedule_slots (
  id uuid default gen_random_uuid() primary key,
  day_of_week integer not null, -- 0=Monday, 1=Tuesday... 5=Saturday
  time text not null, -- e.g. '5:15 AM', '6:15 AM'
  max_capacity integer not null default 4,
  status text not null default 'active', -- active, inactive
  created_at timestamptz default now()
);

-- Members (accepted from membership enquiries)
create table members (
  id uuid default gen_random_uuid() primary key,
  membership_id uuid references memberships(id), -- link to original enquiry
  name text not null,
  email text not null,
  phone text,
  plan text not null, -- Signature, Flexible, VIP
  sessions_per_week integer not null default 1,
  status text not null default 'active', -- active, paused, cancelled
  start_date date,
  notes text,
  created_at timestamptz default now()
);

-- Member slot assignments (which slots a member is booked into)
create table member_slots (
  id uuid default gen_random_uuid() primary key,
  member_id uuid references members(id) on delete cascade,
  slot_id uuid references schedule_slots(id) on delete cascade,
  status text not null default 'active', -- active, paused
  created_at timestamptz default now(),
  unique(member_id, slot_id)
);
