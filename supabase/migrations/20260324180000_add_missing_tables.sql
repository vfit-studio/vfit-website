-- Create memberships table
create table if not exists memberships (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  email text not null,
  phone text,
  plan text not null,
  sessions text,
  days text,
  times text,
  notes text,
  status text not null default 'new',
  created_at timestamptz default now()
);

-- Create contacts table
create table if not exists contacts (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  email text not null,
  phone text,
  message text,
  created_at timestamptz default now()
);

-- Create notifications table
create table if not exists notifications (
  id uuid default gen_random_uuid() primary key,
  email text not null,
  name text,
  interest text,
  type text default 'notify',
  notified boolean default false,
  created_at timestamptz default now()
);

-- Create reviews table
create table if not exists reviews (
  id uuid default gen_random_uuid() primary key,
  event_id uuid references events(id),
  email text not null,
  rating integer not null,
  comment text,
  created_at timestamptz default now()
);
