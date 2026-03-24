-- Create membership_plans table
create table if not exists membership_plans (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  price_cents integer not null,
  period_label text not null default 'session',
  badge_text text,
  badge_style text not null default 'pop',
  description text,
  features jsonb not null default '[]'::jsonb,
  display_order integer not null default 0,
  status text not null default 'active',
  created_at timestamptz default now()
);

-- Create testimonials table
create table if not exists testimonials (
  id uuid default gen_random_uuid() primary key,
  quote text not null,
  attribution text not null default 'Client Testimonial · Toowoomba',
  page text not null default 'home',
  display_order integer not null default 0,
  status text not null default 'active',
  created_at timestamptz default now()
);

-- Create site_content table
create table if not exists site_content (
  id uuid default gen_random_uuid() primary key,
  section text not null,
  content_key text not null,
  content_value text not null default '',
  content_type text not null default 'text',
  label text not null,
  display_order integer not null default 0,
  unique(section, content_key)
);
