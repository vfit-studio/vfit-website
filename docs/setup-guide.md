# VFIT Booking Website — Setup Guide for New Clients

## Overview

This is a complete booking website system with:
- Public-facing website (events, countdowns, booking forms)
- Admin dashboard (manage events, bookings, members, calendar)
- Payment processing (Stripe)
- Email notifications (Resend)
- Real-time spot tracking
- Membership scheduling with calendar

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  PUBLIC WEBSITE (index.html)                │
│  - Static HTML/CSS/JS                       │
│  - Hosted on Netlify (free)                 │
│  - Connects to API for live data            │
├─────────────────────────────────────────────┤
│  ADMIN DASHBOARD (admin.html)               │
│  - Password-protected                       │
│  - Manage events, bookings, members         │
│  - Calendar with slot assignment            │
├─────────────────────────────────────────────┤
│  API (Netlify Functions)                    │
│  - api.js — all business logic              │
│  - stripe-webhook.js — payment confirmation │
│  - Serverless, auto-scaling, free tier      │
├─────────────────────────────────────────────┤
│  DATABASE (Supabase)                        │
│  - PostgreSQL                               │
│  - 8 tables                                 │
│  - Free tier: 500MB, 50K rows               │
├─────────────────────────────────────────────┤
│  PAYMENTS (Stripe)                          │
│  - Checkout sessions with 10-min holds      │
│  - Webhook for confirmation                 │
│  - Test mode available                      │
├─────────────────────────────────────────────┤
│  EMAIL (Resend) — Optional                  │
│  - Booking confirmations                    │
│  - Notification blasts                      │
│  - Owner alerts                             │
│  - Free tier: 100 emails/day                │
└─────────────────────────────────────────────┘
```

---

## Accounts & Subscriptions Needed

### Required (all free tier)

| Service | Purpose | Free Tier | Paid When? | Setup Time |
|---------|---------|-----------|------------|------------|
| **Netlify** | Hosting + serverless functions | 100GB bandwidth, 125K function calls/mo | High traffic | 2 min |
| **GitHub** | Code repository + auto-deploy | Unlimited repos | Never for this use | 2 min |
| **Supabase** | Database | 500MB, 50K rows, 2 projects | >2 projects or high usage | 5 min |

### Optional

| Service | Purpose | Free Tier | Paid When? | Setup Time |
|---------|---------|-----------|------------|------------|
| **Stripe** | Payments | 0 monthly, 1.75% + 30c per transaction | Immediately (per transaction) | 10 min |
| **Resend** | Email notifications | 100 emails/day | >100 emails/day ($20/mo for 50K) | 5 min |

### Total monthly cost for a typical client: $0
(Unless taking payments, then just Stripe's per-transaction fee)

---

## Setup Flow for a New Client

### Step 1: Create Accounts (10 min)

1. **GitHub**
   - Create an organization for the client (e.g., `clientname-studio`)
   - Create a repo (e.g., `clientname-website`)
   - Push the template code

2. **Netlify**
   - Sign up / log in
   - Import the GitHub repo
   - Branch: `main`, Publish directory: `.`
   - Site deploys automatically

3. **Supabase**
   - Sign up with GitHub
   - Create new project (name: client name, region: closest)
   - Run the SQL schema (copy from schema files)
   - Copy Project URL + service_role key

### Step 2: Configure Environment Variables (5 min)

In Netlify CLI or dashboard, set:

```bash
netlify env:set SUPABASE_URL "https://xxxxx.supabase.co"
netlify env:set SUPABASE_SERVICE_KEY "eyJhbGci..."
netlify env:set ADMIN_KEY "chosen-password"
netlify env:set SITE_URL "https://clientname.netlify.app"
```

Optional (if using payments):
```bash
netlify env:set STRIPE_SECRET_KEY "sk_test_..."
netlify env:set STRIPE_WEBHOOK_SECRET "whsec_..."
```

Optional (if using email):
```bash
netlify env:set RESEND_API_KEY "re_..."
netlify env:set OWNER_EMAIL "client@email.com"
```

### Step 3: Run Database Schema (5 min)

Paste into Supabase SQL Editor:

```sql
-- File 1: Core tables (events, bookings, memberships, notifications, contacts)
-- File 2: Scheduling tables (schedule_slots, members, member_slots)
```

Both SQL files are in the project root.

### Step 4: Customize the Website (varies)

1. **Branding**: Update CSS variables, fonts, logo text
2. **Content**: Update copy, images, offerings
3. **Offerings**: Configure what services the client offers
4. **Images**: Replace placeholder images with client's photos
5. **Videos**: Replace stock videos with client's content (or remove)

### Step 5: Deploy & Test (5 min)

```bash
git add -A && git commit -m "Initial setup" && git push
netlify deploy --prod
```

Test:
- [ ] Website loads
- [ ] Admin login works (password from ADMIN_KEY)
- [ ] Can create an event in admin
- [ ] Event appears on website countdown
- [ ] Booking form submits successfully
- [ ] Booking appears in admin
- [ ] Membership wizard works
- [ ] Contact form works

### Step 6: Optional — Stripe Setup (10 min)

1. Client creates Stripe account (their bank details for payouts)
2. Stay in test mode initially
3. Copy secret key → set as env var
4. Add webhook endpoint: `https://site.netlify.app/.netlify/functions/stripe-webhook`
5. Select events: `checkout.session.completed`, `checkout.session.expired`
6. Copy webhook signing secret → set as env var
7. Test a payment in test mode
8. Switch to live mode when ready

### Step 7: Optional — Resend Setup (5 min)

1. Sign up at resend.com
2. Verify a sending domain (or use their test domain)
3. Copy API key → set as env var
4. Set OWNER_EMAIL → client's email for alerts

### Step 8: Custom Domain (5 min)

1. Client buys domain (e.g., clientstudio.com.au)
2. In Netlify: Domain settings → Add custom domain
3. Update DNS records as Netlify instructs
4. SSL auto-provisions

---

## Database Schema (8 tables)

```
events          — Run Club sessions, Pi'lattes dates, etc.
bookings        — Individual bookings with payment tracking
memberships     — Membership enquiries from the wizard
notifications   — "Get Notified" signups
contacts        — Contact form messages
schedule_slots  — Weekly recurring time slots (for memberships)
members         — Accepted members from enquiries
member_slots    — Which members are in which time slots
```

---

## File Structure

```
/project
├── index.html              ← Public website (single file)
├── admin.html              ← Admin dashboard (single file)
├── netlify.toml            ← Netlify config (functions, headers)
├── package.json            ← Dependencies (stripe, supabase)
├── package-lock.json
├── .gitignore
├── schema-memberships.sql  ← DB schema for scheduling tables
├── apps-script.js          ← Google Apps Script (legacy/optional)
├── netlify/
│   └── functions/
│       ├── api.js              ← Main API (all endpoints)
│       ├── stripe-webhook.js   ← Stripe payment handler
│       └── utils/
│           ├── supabase.js     ← DB client
│           └── email.js        ← Email templates (Resend)
└── docs/
    └── setup-guide.md      ← This file
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key |
| `ADMIN_KEY` | Yes | Password for admin dashboard |
| `SITE_URL` | Yes | Full URL of the live site |
| `STRIPE_SECRET_KEY` | For payments | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | For payments | Stripe webhook signing secret |
| `RESEND_API_KEY` | For emails | Resend API key |
| `OWNER_EMAIL` | For emails | Client's email for alerts |

---

## Customization Checklist for New Client

- [ ] CSS variables (colors) in `:root`
- [ ] Logo text (nav + footer)
- [ ] Font choices (Google Fonts link)
- [ ] Hero image/video
- [ ] Offering names and descriptions
- [ ] Pricing
- [ ] Session types (what they offer)
- [ ] Location details
- [ ] Social media links (@instagram handle)
- [ ] Contact info (address, phone)
- [ ] Google Maps embed coordinates
- [ ] Testimonials
- [ ] About/founder bio + photo
- [ ] Terms & conditions
- [ ] ADMIN_KEY password
- [ ] OWNER_EMAIL
- [ ] og:image for social sharing
- [ ] Favicon

---

## Maintenance

### Client manages (via admin dashboard):
- Creating events (sessions with dates, spots, prices)
- Viewing bookings
- Managing membership enquiries
- Assigning members to calendar slots
- Sending notifications

### Developer manages:
- Code updates (push to GitHub → auto-deploys)
- Adding new features
- Design changes
- Database schema changes
- Environment variable updates

### Automated:
- SSL certificate renewal (Netlify)
- Spot counting (real-time from database)
- Expired hold cleanup (on every API call)
- Countdown state transitions (client-side JS)

---

## Scaling Notes

- **Netlify free tier** handles ~125K function calls/month. For a boutique studio this is more than enough (each page load = 1 API call).
- **Supabase free tier** handles 50K rows. A studio doing 20 bookings/week = ~1K rows/year. You won't hit limits for years.
- **If a client grows**: Netlify Pro ($19/mo), Supabase Pro ($25/mo). Still very affordable.
- **Multiple clients**: Each client gets their own Supabase project and Netlify site. The code is the same template.
