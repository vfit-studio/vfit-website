# CLAUDE.md — VFIT Studio (Website + Booking System)

## What is this?
Booking website and admin portal for VFIT, a boutique fitness studio in Toowoomba run by Georgie Valdal. Built by Fred as a showcase — "build it all, then present."

## Related project
The member subscription app (SvelteKit PWA) is at `/Users/freddevelopments/Desktop/vfit-app/`. Both share the same Supabase project: `wmhthnfnjzmdocmufkjr`.

## Tech Stack
- **Frontend:** Vanilla JS + HTML/CSS (multi-page: index, admin, crm)
- **Build:** Vite with multi-page rollup (src/ root)
- **Backend:** Netlify Functions (Node.js) at `netlify/functions/api.js`
- **Database:** Supabase (project: `wmhthnfnjzmdocmufkjr`)
- **Payments:** Stripe (checkout sessions, webhooks)
- **Email:** Resend
- **SMS:** Twilio
- **Hosting:** Netlify — https://vfit-studio.netlify.app
- **Repo:** https://github.com/vfit-studio/vfit-website

## Brand
- **Palette:** Sand `#f5f0e8`, Cream `#faf7f2`, Stone `#e8e0d4`, Clay `#c9b99a`, Bark `#8c7660`, Moss `#7a8c6e`, Deep `#3d3530`, Sage `#a8b89a`
- **Fonts:** Cormorant Garamond (serif headings), Jost (sans body)
- **Style:** Boutique luxury fitness — no emojis, no stock videos, thin-line elements over icons
- **Mobile-first:** Most users view on iPhone

## Project Structure
```
src/
  index.html          — Public website (hero, offerings, countdowns)
  admin.html          — Admin portal (events, bookings, members, CRM)
  crm.html            — CRM interface
  js/
    index.js          — Website logic
    admin.js          — Admin panel (2,166 lines)
    crm.js            — CRM logic (1,290 lines)
  styles/
    index.css, admin.css, crm.css
  assets/             — Images/media
netlify/functions/
  api.js              — Main API endpoint (61KB)
  stripe-webhook.js   — Stripe webhook handler
  utils/
    supabase.js       — Supabase client
    email.js          — Resend email helper
    sms.js            — Twilio SMS helper
supabase/migrations/  — Database schema
dist/                 — Built output (Vite)
```

## Database Tables
- events (with Glofox URL support)
- bookings (Stripe integration)
- memberships (inquiries)
- members (accepted members)
- member_slots (recurring lesson assignments)
- notifications, contacts, reviews
- schedule_slots (weekly timetable)

## Build Commands
```bash
npm run dev          # Local dev server
npm run build        # Production build
npm run preview      # Preview built output
```

## Deployment
Push to main → Netlify auto-builds and deploys. Always commit and push after changes.

## Design Branches
- `main` — Current production
- `version-b`, `version-c` — Alternative designs for A/B comparison

## Rules
1. No emojis — use typography or thin-line elements
2. "Studio Sessions" not "Memberships" — boutique language
3. Countdown widgets must have crystal clear labels (session date, bookings open date, what it's counting to)
4. Home page teases, doesn't tell everything — cards with "View Details"
5. Admin organised by business area (Run Club / Pi'lattes / Members), not data type
6. Everything must work on iPhone
7. No random stock videos — must match brand quality
8. Hero image must be client's actual brand image
9. Always commit + push after changes so Netlify deploys
10. Never use `alert()` — use inline error divs
