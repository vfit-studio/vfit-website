/*
 * Cancellation & pause policy — mirrors src/js/agreement.js POLICY_TIERS.
 *
 * Plan tiers:
 *   Signature  — 48 hrs notice, full session fee if late
 *   Flexible   — 1 week notice, full session fee if late
 *   VIP        — 48 hrs notice, full session fee if late
 *
 * Pause cap: 1 month per rolling year, all tiers.
 */

const NOTICE_HOURS = {
  signature: 48,
  flexible: 168, // 7 days × 24
  vip: 48,
};

const PAUSE_CAP_DAYS_PER_YEAR = 31;

function planKey(plan) {
  const p = String(plan || '').toLowerCase();
  if (p.indexOf('vip') >= 0) return 'vip';
  if (p.indexOf('flex') >= 0) return 'flexible';
  return 'signature';
}

// Given (memberPlan, sessionDate (YYYY-MM-DD), sessionTime ("6:15 AM"), nowMs)
// returns { chargeRequired, noticeHours, policyTier, sessionStartIso }
function evaluateCancellation({ plan, sessionDate, sessionTime, now = new Date() }) {
  const tier = planKey(plan);
  const requiredHours = NOTICE_HOURS[tier];
  const sessionStart = parseSessionStart(sessionDate, sessionTime);
  const noticeMs = sessionStart.getTime() - now.getTime();
  const noticeHours = noticeMs / (1000 * 60 * 60);

  return {
    policyTier: tier,
    requiredHours,
    noticeHours,
    sessionStartIso: sessionStart.toISOString(),
    chargeRequired: noticeHours < requiredHours,
    inTime: noticeHours >= requiredHours,
  };
}

// "6:15 AM" + "2026-05-04" → Date (local studio time, treated as Toowoomba/AEST)
// We approximate by assuming the member's session_time string is local; we don't
// store timezone, so we treat dates as naive local. This matches how
// schedule_slots are displayed today.
function parseSessionStart(dateStr, timeStr) {
  if (!timeStr) {
    return new Date(`${dateStr}T00:00:00`);
  }
  const m = String(timeStr).trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return new Date(`${dateStr}T00:00:00`);
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  const hh = String(h).padStart(2, '0');
  const mm = String(mn).padStart(2, '0');
  return new Date(`${dateStr}T${hh}:${mm}:00`);
}

// Returns the running pause-day total across the rolling 12 months
// for a given member, including a hypothetical new range.
function pauseDaysUsed(holds) {
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  let total = 0;
  for (const h of holds) {
    if (h.status !== 'active' && h.status !== 'completed') continue;
    const start = new Date(h.start_date + 'T00:00:00');
    const end = new Date(h.end_date + 'T00:00:00');
    // Only count the portion of the hold within the last 12 months
    const effectiveStart = start < oneYearAgo ? oneYearAgo : start;
    if (end < effectiveStart) continue;
    const ms = end.getTime() - effectiveStart.getTime();
    const days = Math.floor(ms / (1000 * 60 * 60 * 24)) + 1; // inclusive
    total += days;
  }
  return total;
}

function pauseDaysInRange(startDate, endDate) {
  const s = new Date(startDate + 'T00:00:00');
  const e = new Date(endDate + 'T00:00:00');
  return Math.floor((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

module.exports = {
  NOTICE_HOURS,
  PAUSE_CAP_DAYS_PER_YEAR,
  planKey,
  evaluateCancellation,
  pauseDaysUsed,
  pauseDaysInRange,
  parseSessionStart,
};
