---
name: VFIT Supabase project
description: Live Supabase project ref for VFIT — needed before any db push, link, or env-var work
type: project
---

VFIT runs on Supabase project `wmhthnfnjzmdocmufkjr` (Fred's account, not Georgie's). Netlify env vars and live data live here.

**Why:** On 2026-05-02 Fred briefly considered migrating to a Georgie-owned project (`qkcrrhbwqysubdjaffza`, owned by `georgieovett@hotmail.com`) for cleaner handover, but decided to keep things on the existing project to avoid data migration and Netlify env-var swap. The Georgie-owned project (`qkcrrhbwqysubdjaffza`) had the lounge migration accidentally applied to it during this exploration — it's effectively a vestigial empty project now and can be ignored or deleted.

**How to apply:**
- Before any `supabase link`, `supabase db push`, or schema-related work, confirm the linked project ref matches `wmhthnfnjzmdocmufkjr`. If `.temp/project-ref` shows a different ref (e.g. `qkcrrhbwqysubdjaffza`), re-link with `supabase link --project-ref wmhthnfnjzmdocmufkjr` first.
- Linking requires being logged into the Supabase CLI as the account that owns `wmhthnfnjzmdocmufkjr` (not Georgie's account).
- Netlify env vars (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`) point to this project — do not change them without a migration plan.
