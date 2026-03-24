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

-- ═══════════════════════════════════════════════
-- CMS Tables — Editable site content via admin portal
-- ═══════════════════════════════════════════════

-- Membership plans (displayed on public site, editable via admin)
create table membership_plans (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  price_cents integer not null,              -- 6000 = $60.00
  period_label text not null default 'session',
  badge_text text,                           -- e.g. 'Most Popular', 'No Commitment'
  badge_style text not null default 'pop',   -- pop, flex, vip (maps to CSS classes)
  description text,                          -- optional tagline
  features jsonb not null default '[]'::jsonb,
  display_order integer not null default 0,
  status text not null default 'active',     -- active, inactive
  created_at timestamptz default now()
);

-- Testimonials (displayed on public site, editable via admin)
create table testimonials (
  id uuid default gen_random_uuid() primary key,
  quote text not null,
  attribution text not null default 'Client Testimonial · Toowoomba',
  page text not null default 'home',         -- home, studio, about
  display_order integer not null default 0,
  status text not null default 'active',
  created_at timestamptz default now()
);

-- Site content key-value store (all editable text/media)
create table site_content (
  id uuid default gen_random_uuid() primary key,
  section text not null,                     -- hero, about, runclub, pilattes, studio, contact, footer
  content_key text not null,                 -- headline, description, video_url, etc.
  content_value text not null default '',
  content_type text not null default 'text', -- text, textarea, image, video
  label text not null,                       -- human label for admin UI
  display_order integer not null default 0,
  unique(section, content_key)
);

-- ═══════════════════════════════════════════════
-- Seed data — current hardcoded content
-- ═══════════════════════════════════════════════

-- Seed membership plans
insert into membership_plans (name, price_cents, period_label, badge_text, badge_style, description, features, display_order, status)
values
  ('Signature', 6000, 'session', 'Most Popular', 'pop', null,
   '["Weekly recurring group session/s (max 4 ppl)", "3-month minimum commitment", "Best value per session"]'::jsonb,
   0, 'active'),
  ('Flexible', 7000, 'session', 'No Commitment', 'flex', null,
   '["Weekly recurring group session/s (max 4 ppl)", "No minimum contract", "Full flexibility, no lock-in"]'::jsonb,
   1, 'active'),
  ('VIP', 19000, 'session', '✦ VIP', 'vip', '1-on-1 coaching, premium access, full lifestyle support.',
   '["Weekly private 1-on-1 PT session", "Direct line to Georgie anytime", "Fridge access (juices, waters & snacks)", "3-month commitment"]'::jsonb,
   2, 'active');

-- Seed testimonials
insert into testimonials (quote, attribution, page, display_order, status)
values
  ('So refreshing to have a trainer that keeps things new, exciting and challenging. No matter what stage of fitness I''m in, VFIT always gets the most out of every session.', 'Client Testimonial · Toowoomba', 'home', 0, 'active'),
  ('So refreshing to have a trainer that keeps things new, exciting and challenging. VFIT always gets the most out of every session.', 'Member Testimonial · Toowoomba', 'studio', 0, 'active'),
  ('No matter what stage of fitness I''m in, VFIT always tailor their training to get the most out of my sessions.', 'Client Testimonial · Toowoomba', 'about', 0, 'active');

-- Seed site content
insert into site_content (section, content_key, content_value, content_type, label, display_order) values
-- Hero
('hero', 'eyebrow', 'Toowoomba''s Boutique Fitness Studio', 'text', 'Hero Eyebrow', 0),
('hero', 'headline', 'Move with Purpose.', 'text', 'Hero Headline', 1),
('hero', 'description', 'Three distinct ways to move — exclusive studio sessions, monthly Pilates at The Dairy, and a weekly run club. All led by Georgie Valdal.', 'textarea', 'Hero Description', 2),
('hero', 'image_url', 'https://images.squarespace-cdn.com/content/v1/65364431ba61ae35026dfa32/89f1d767-5458-4258-b797-66c07ac4875a/DSC09877.JPEG', 'image', 'Hero Background Image', 3),
-- Studio Sessions
('studio', 'badge', 'Exclusive · Members Only', 'text', 'Badge Text', 0),
('studio', 'eyebrow', 'Private Gym Access', 'text', 'Eyebrow', 1),
('studio', 'title', 'Studio Sessions.', 'text', 'Title', 2),
('studio', 'description', 'Private gym access. Small group training with a maximum of four people. Recurring weekly sessions, expert coaching in an intimate, purposeful environment.', 'textarea', 'Description', 3),
('studio', 'price_text', 'From $60 per session', 'text', 'Price Text', 4),
('studio', 'hero_video', 'https://videos.pexels.com/video-files/4108054/4108054-hd_1920_1080_25fps.mp4', 'video', 'Hero Video', 5),
('studio', 'hero_poster', 'https://images.squarespace-cdn.com/content/v1/65364431ba61ae35026dfa32/89f1d767-5458-4258-b797-66c07ac4875a/DSC09877.JPEG', 'image', 'Hero Video Poster', 6),
('studio', 'page_description', 'Priced per session. Select a plan to enquire — we''ll match your preferred days and times.', 'textarea', 'Page Description', 7),
('studio', 'why_title', 'Small by design, powerful by nature.', 'text', 'Why Section Title', 8),
('studio', 'why_1_title', 'Intimate & Intentional', 'text', 'Why Point 1 Title', 9),
('studio', 'why_1_desc', 'Every member is seen, coached and progressed every single session.', 'textarea', 'Why Point 1 Description', 10),
('studio', 'why_2_title', 'Recurring & Consistent', 'text', 'Why Point 2 Title', 11),
('studio', 'why_2_desc', 'Same time, same group, every week. Real results come from routine.', 'textarea', 'Why Point 2 Description', 12),
('studio', 'why_3_title', 'Expert Programming', 'text', 'Why Point 3 Title', 13),
('studio', 'why_3_desc', 'Progressively built sessions — a long-term movement practice.', 'textarea', 'Why Point 3 Description', 14),
-- Pi'lattes
('pilattes', 'badge', 'Monthly · Open to All', 'text', 'Badge Text', 0),
('pilattes', 'eyebrow', 'The Dairy, Ravensbourne', 'text', 'Eyebrow', 1),
('pilattes', 'title', 'Pi''lattes at The Dairy.', 'text', 'Title', 2),
('pilattes', 'description', 'Mat Pilates at one of SEQ''s most stunning venues. A burn that fires up your core, followed by a complimentary coffee from Then Bakehouse Café. All equipment provided.', 'textarea', 'Description', 3),
('pilattes', 'hero_video', 'https://videos.pexels.com/video-files/6111088/6111088-hd_1920_1080_25fps.mp4', 'video', 'Hero Video', 4),
('pilattes', 'hero_poster', 'https://images.squarespace-cdn.com/content/v1/65364431ba61ae35026dfa32/89f1d767-5458-4258-b797-66c07ac4875a/DSC09877.JPEG', 'image', 'Hero Video Poster', 5),
('pilattes', 'venue', 'The Dairy Ravensbourne', 'text', 'Venue', 6),
('pilattes', 'frequency', 'Monthly Sundays', 'text', 'Frequency', 7),
('pilattes', 'frequency_sub', 'Follow @valdalfit for dates', 'text', 'Frequency Subtitle', 8),
('pilattes', 'time', '7:00 – 8:00 AM', 'text', 'Time', 9),
('pilattes', 'included_1_title', 'All Equipment Provided', 'text', 'Included 1 Title', 10),
('pilattes', 'included_1_desc', 'Just show up. Mats, props and everything you need is taken care of.', 'textarea', 'Included 1 Description', 11),
('pilattes', 'included_2_title', 'Complimentary Coffee', 'text', 'Included 2 Title', 12),
('pilattes', 'included_2_desc', 'A coffee from Then Bakehouse Café is included in every class ticket.', 'textarea', 'Included 2 Description', 13),
('pilattes', 'included_3_title', 'Expert Instruction', 'text', 'Included 3 Title', 14),
('pilattes', 'included_3_desc', 'A thoughtfully designed session for all levels by VFIT''s instructors.', 'textarea', 'Included 3 Description', 15),
('pilattes', 'included_4_title', 'Stunning Setting', 'text', 'Included 4 Title', 16),
('pilattes', 'included_4_desc', 'The Dairy is one of South-East Queensland''s most beautiful venues.', 'textarea', 'Included 4 Description', 17),
('pilattes', 'cta_headline', 'Spots are limited.', 'text', 'CTA Headline', 18),
('pilattes', 'cta_details', 'Monthly Sundays · The Dairy, Ravensbourne · 7:00–8:00 AM · Coffee included.', 'textarea', 'CTA Details', 19),
-- Run Club
('runclub', 'badge', 'Weekly · Open to All', 'text', 'Badge Text', 0),
('runclub', 'eyebrow', 'Every Tuesday · 5:15 AM', 'text', 'Eyebrow', 1),
('runclub', 'title', 'Track Tuesday.', 'text', 'Title', 2),
('runclub', 'description', 'All fitness levels welcome — intervals, tempo runs, strength circuits. No two sessions are the same. Led by Georgie Valdal with world-class credentials in Track & Field.', 'textarea', 'Description', 3),
('runclub', 'hero_video', 'https://videos.pexels.com/video-files/8459966/8459966-hd_1080_1920_25fps.mp4', 'video', 'Hero Video', 4),
('runclub', 'hero_poster', 'https://images.squarespace-cdn.com/content/v1/65364431ba61ae35026dfa32/89f1d767-5458-4258-b797-66c07ac4875a/DSC09877.JPEG', 'image', 'Hero Video Poster', 5),
('runclub', 'location', 'Glennie School Track', 'text', 'Location', 6),
('runclub', 'when', 'Every Tuesday', 'text', 'When', 7),
('runclub', 'time', '5:15 – 6:00 AM', 'text', 'Time', 8),
('runclub', 'expect_1_title', 'All Levels Welcome', 'text', 'Expect 1 Title', 9),
('runclub', 'expect_1_desc', 'Brand new to running or training for your next event — there''s a place for you.', 'textarea', 'Expect 1 Description', 10),
('runclub', 'expect_2_title', 'No Two Sessions Alike', 'text', 'Expect 2 Title', 11),
('runclub', 'expect_2_desc', 'Each Tuesday is programmed differently — intervals, tempo, strength circuits.', 'textarea', 'Expect 2 Description', 12),
('runclub', 'expect_3_title', 'Expert Coaching', 'text', 'Expect 3 Title', 13),
('runclub', 'expect_3_desc', 'Led by Georgie Valdal with world-class Track and Field credentials.', 'textarea', 'Expect 3 Description', 14),
('runclub', 'expect_4_title', 'Real Community', 'text', 'Expect 4 Title', 15),
('runclub', 'expect_4_desc', 'Early mornings are better together. A welcoming group that celebrates every milestone.', 'textarea', 'Expect 4 Description', 16),
('runclub', 'cta_headline', 'See you at the track.', 'text', 'CTA Headline', 17),
('runclub', 'cta_details', 'Tuesdays at 5:15 AM · Glennie School Track · All levels welcome.', 'textarea', 'CTA Details', 18),
-- About
('about', 'hero_eyebrow', 'Our Story', 'text', 'Hero Eyebrow', 0),
('about', 'hero_title', 'World-class coaching.', 'text', 'Hero Title', 1),
('about', 'hero_description', 'VFIT was born from a belief that everyone deserves the quality of training found in the world''s leading private studios — right here in Toowoomba.', 'textarea', 'Hero Description', 2),
('about', 'pull_quote', 'Everyone deserves the quality of training found in the world''s leading private studios.', 'textarea', 'Pull Quote', 3),
('about', 'founder_image', 'https://images.squarespace-cdn.com/content/v1/65364431ba61ae35026dfa32/ac84636d-ca66-4a87-9347-aa829c413aa9/Georgie-Valdal-VFIT-Founder.jpg', 'image', 'Founder Photo', 4),
('about', 'founder_label', 'The Founder', 'text', 'Founder Label', 5),
('about', 'founder_name', 'Georgie Valdal.', 'text', 'Founder Name', 6),
('about', 'founder_bio_1', 'With nearly two decades in the industry, Georgie has built her career at the highest levels of private fitness — training celebrities, executives, and the world''s most discerning clients.', 'textarea', 'Founder Bio Paragraph 1', 7),
('about', 'founder_bio_2', 'Holding world-class credentials in Pilates, Strength and Conditioning, Stretch Therapy and Track and Field. Now she''s brought all of it to Toowoomba — in an intimate studio designed entirely around you.', 'textarea', 'Founder Bio Paragraph 2', 8),
('about', 'video_url', 'https://videos.pexels.com/video-files/4108054/4108054-hd_1920_1080_25fps.mp4', 'video', 'About Video', 9),
('about', 'video_poster', 'https://images.squarespace-cdn.com/content/v1/65364431ba61ae35026dfa32/89f1d767-5458-4258-b797-66c07ac4875a/DSC09877.JPEG', 'image', 'About Video Poster', 10),
('about', 'video_caption', 'Inside a VFIT Session', 'text', 'Video Caption', 11),
('about', 'values_title', 'What we believe in.', 'text', 'Values Title', 12),
('about', 'value_1_title', 'Quality Over Quantity', 'text', 'Value 1 Title', 13),
('about', 'value_1_desc', 'Smaller groups, better coaching, real attention.', 'textarea', 'Value 1 Description', 14),
('about', 'value_2_title', 'Movement for Life', 'text', 'Value 2 Title', 15),
('about', 'value_2_desc', 'Whether you''re 18 or 80, movement should build you up.', 'textarea', 'Value 2 Description', 16),
('about', 'value_3_title', 'Community First', 'text', 'Value 3 Title', 17),
('about', 'value_3_desc', 'The relationships extend far beyond the studio.', 'textarea', 'Value 3 Description', 18),
('about', 'value_4_title', 'Results You Feel', 'text', 'Value 4 Title', 19),
('about', 'value_4_desc', 'Stronger physically and mentally. That''s the VFIT standard.', 'textarea', 'Value 4 Description', 20),
-- Contact
('contact', 'eyebrow', 'Get in Touch', 'text', 'Eyebrow', 0),
('contact', 'title', 'Book. Connect.', 'text', 'Title', 1),
('contact', 'description', 'Whether you''re ready to join, have a question, or just want to know more — we''d love to hear from you.', 'textarea', 'Description', 2),
('contact', 'address', 'Shop 8/203 Margaret St / Toowoomba City QLD 4350', 'text', 'Address', 3),
('contact', 'runclub_location', 'Glennie School Track / Tuesdays · 5:15 AM', 'text', 'Run Club Location', 4),
('contact', 'pilattes_location', 'The Dairy, Ravensbourne / Monthly Sundays · 7:00 AM', 'text', 'Pi''lattes Location', 5),
('contact', 'maps_url', 'https://maps.app.goo.gl/tEuLFAM49yoJuzKv9', 'text', 'Google Maps URL', 6),
-- Footer
('footer', 'tagline', 'A timeless approach to fitness. Toowoomba''s boutique luxury studio.', 'textarea', 'Tagline', 0),
('footer', 'address', 'Shop 8/203 Margaret St / Toowoomba City QLD 4350', 'text', 'Address', 1),
('footer', 'instagram_handle', '@valdalfit', 'text', 'Instagram Handle', 2),
('footer', 'instagram_url', 'https://www.instagram.com/valdalfit', 'text', 'Instagram URL', 3);

-- ═══════════════════════════════════════════════
-- Supabase Storage: Create a 'media' bucket with public access
-- (Do this via Supabase Dashboard > Storage > New Bucket)
-- Bucket name: media
-- Public: Yes
-- ═══════════════════════════════════════════════
