---
name: VFIT project context
description: Building a full booking system for VFIT boutique fitness studio in Toowoomba, run by Georgie Valdal
type: project
---

VFIT is a boutique fitness studio in Toowoomba run by Georgie Valdal. The user (Fred) is building this for her as a showcase.

**Why:** The goal is to show Georgie a fully-functional website with booking, payments, and admin portal all working — to demonstrate the power of what can be built. Small changes come after.

**Current state:**
- Website live at vfit-studio.netlify.app
- GitHub repo: vfit-studio/vfit-website
- Currently using Formspree for form submissions (fallback)
- Google Apps Script backend code written but not yet deployed
- No payments yet

**What's being built now (Phase 2):**
- Supabase for database + auth + real-time
- Stripe for payments with checkout sessions (Ticketek-style hold system)
- Netlify Functions for serverless API
- Admin portal for Georgie (create events, manage bookings, send notifications)
- Spot reservation system (10-min hold on checkout, auto-release if abandoned)
- Real-time spot counts on the website

**How to apply:** This is an active build — Fred wants everything built now to present as a complete package to Georgie before making small tweaks.
