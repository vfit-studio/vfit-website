/*
 * VFIT Member Lounge — frontend.
 *
 * Phase 1: auth, today, schedule, profile drawer.
 * Cancel/reschedule, real messaging, payments, and challenges
 * arrive in later phases — this file wires the empty shells now.
 */

const API = '/.netlify/functions/api';
const TOKEN_KEY = 'vfit-lounge-token';
const REFRESH_KEY = 'vfit-lounge-refresh';

// ─── State ───
let state = {
  token: null,
  refresh: null,
  me: null,        // payload from /api?action=lounge_me
  route: 'today',
};

// ─── DOM helpers ───
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function showToast(msg, isError = false) {
  const el = $('#lng-toast');
  el.textContent = msg;
  el.classList.toggle('is-error', !!isError);
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function showView(id) {
  $$('.lounge-view').forEach((v) => v.classList.toggle('is-active', v.id === id));
}

// ─── API ───
async function api(action, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  const url = `${API}?action=${encodeURIComponent(action)}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ═══════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════

// On load, Supabase Auth redirects back here with tokens in the URL fragment:
//   /lounge#access_token=...&refresh_token=...&expires_in=3600&token_type=bearer
// Capture them, stash in localStorage, then clean the URL so refresh works.
function captureTokensFromHash() {
  if (!window.location.hash || window.location.hash.length < 2) return false;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const access = params.get('access_token');
  const refresh = params.get('refresh_token');
  if (!access) return false;
  localStorage.setItem(TOKEN_KEY, access);
  if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  // Clean the URL so the tokens don't linger in history
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

function loadStoredTokens() {
  state.token = localStorage.getItem(TOKEN_KEY) || null;
  state.refresh = localStorage.getItem(REFRESH_KEY) || null;
}

function clearTokens() {
  state.token = null;
  state.refresh = null;
  state.me = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

async function loadMe() {
  const data = await api('lounge_me', { auth: true });
  state.me = data;
  return data;
}

// ═══════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════

function bindLogin() {
  const form = $('#login-form');
  const sent = $('#login-sent');
  const btn = $('#login-btn');
  const err = $('#login-error');
  const emailInput = $('#login-email');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.remove('is-visible');
    const email = emailInput.value.trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      err.textContent = 'Please enter a valid email.';
      err.classList.add('is-visible');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await api('lounge_auth_send', { method: 'POST', body: { email } });
      $('#login-sent-email').textContent = email;
      form.style.display = 'none';
      sent.classList.add('is-visible');
    } catch (e2) {
      err.textContent = 'Something went wrong. Please try again.';
      err.classList.add('is-visible');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send sign-in link';
    }
  });

  $('#login-resend').addEventListener('click', () => {
    sent.classList.remove('is-visible');
    form.style.display = '';
    emailInput.value = '';
    emailInput.focus();
  });
}

// ═══════════════════════════════════════════════
// SHELL — routing, top bar, drawer
// ═══════════════════════════════════════════════

function bindShell() {
  $$('.lng-nav-btn').forEach((b) => {
    b.addEventListener('click', () => navigate(b.dataset.route));
  });

  // Profile drawer
  $('#lng-profile-btn').addEventListener('click', openDrawer);
  $('#lng-drawer-close').addEventListener('click', closeDrawer);
  $('#lng-drawer-overlay').addEventListener('click', closeDrawer);
  $('#lng-logout').addEventListener('click', () => {
    clearTokens();
    location.reload();
  });

  // Travel hold
  $('#bill-add-hold').addEventListener('click', openTravelHoldModal);

  // Concierge buttons
  $('#conc-at-home').addEventListener('click', () => openConciergeModal('at_home', 'At-home session'));
  $('#conc-travel').addEventListener('click', () => openConciergeModal('travel', 'Travel program'));
  $('#conc-nutrition').addEventListener('click', () => openConciergeModal('nutrition', 'Nutrition consult'));

  // iCal copy
  $('#ical-copy').addEventListener('click', copyIcalLink);

  // Family / partner access (sends as a concierge-style message)
  $('#family-request').addEventListener('click', () => openConciergeModal('other', 'Family / partner access'));

  // Audit log
  $('#audit-open').addEventListener('click', openAuditLog);

  // Pref toggles
  $('#pref-stealth').addEventListener('change', onStealthToggle);
  $('#pref-receipts').addEventListener('change', () => savePref({ read_receipts: $('#pref-receipts').checked }));
  $('#pref-email').addEventListener('change', () => savePref({ notify_email: $('#pref-email').checked }));
  $('#pref-handle').addEventListener('change', () => savePref({ stealth_handle: $('#pref-handle').value.trim() || null }));

  // Hash routing — if URL has e.g. #/messages we honor it
  window.addEventListener('hashchange', readHashRoute);
}

function navigate(route) {
  state.route = route;
  $$('.lng-nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.route === route));
  $$('.lng-page').forEach((p) => { p.hidden = p.dataset.page !== route; });
  if (location.hash !== `#/${route}`) {
    history.replaceState(null, '', `#/${route}`);
  }
  // Skip data-dependent renders if `state.me` hasn't loaded yet —
  // the shell shows instantly on boot and these run again after loadMe.
  if (route === 'schedule' && state.me) renderSchedule();
  if (route === 'payments' && state.me) renderBilling();
  if (route === 'challenges' && state.me) loadChallenges();
  if (route === 'messages' && state.me) openMessagesTab();
  else if (route !== 'messages') stopMessagePolling();
}

function readHashRoute() {
  const m = (location.hash || '').match(/^#\/(today|schedule|messages|payments|challenges)/);
  if (m) navigate(m[1]);
}

function openDrawer() {
  $('#lng-drawer').hidden = false;
  $('#lng-drawer-overlay').hidden = false;
  requestAnimationFrame(() => {
    $('#lng-drawer').classList.add('is-open');
    $('#lng-drawer-overlay').classList.add('is-open');
  });
}
function closeDrawer() {
  $('#lng-drawer').classList.remove('is-open');
  $('#lng-drawer-overlay').classList.remove('is-open');
  setTimeout(() => {
    $('#lng-drawer').hidden = true;
    $('#lng-drawer-overlay').hidden = true;
  }, 250);
}

// ═══════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function greetingFor(hour) {
  if (hour < 5) return 'Still up.';
  if (hour < 12) return 'Good morning.';
  if (hour < 17) return 'Good afternoon.';
  return 'Good evening.';
}

function todayDateLine(d) {
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}

function renderAll() {
  if (!state.me) return;
  const m = state.me.member;

  // Avatar — first letter of name
  const initial = (m.name || '·').trim().charAt(0).toUpperCase();
  $('#lng-avatar').textContent = initial;

  // Today
  const now = new Date();
  $('#today-greeting').textContent = greetingFor(now.getHours()) + ' ' + (m.name || '').split(' ')[0] + '.';
  $('#today-date').textContent = todayDateLine(now);

  renderTodayFeature();
  renderThisWeek();
  renderProfile();
  renderMsgDot();

  // If the user navigated to a non-Today route while data was loading,
  // populate that route's content now.
  if (state.route === 'schedule')   renderSchedule();
  if (state.route === 'payments')   renderBilling();
  if (state.route === 'challenges') loadChallenges();
  if (state.route === 'messages')   openMessagesTab();
}

function renderTodayFeature() {
  const today = new Date().toISOString().slice(0, 10);
  const sessions = (state.me.upcoming_sessions || []).filter((s) => s.date === today && s.state === 'scheduled');
  const el = $('#today-feature');
  if (!sessions.length) {
    el.innerHTML = `
      <p class="lng-eyebrow" style="margin:0 0 8px;">Today</p>
      <h2 style="font-family:'Cormorant Garamond',serif;font-weight:300;font-size:26px;margin:0 0 8px;color:var(--deep);">A day off the floor.</h2>
      <p style="font-size:14px;line-height:1.65;color:var(--body);margin:0;">No session scheduled. Rest, recover, or move on your own terms.</p>
    `;
    return;
  }
  const s = sessions[0];
  el.innerHTML = `
    <p class="lng-eyebrow" style="margin:0 0 8px;">Today &middot; ${escapeHtml(s.time || '')}</p>
    <h2 style="font-family:'Cormorant Garamond',serif;font-weight:300;font-size:28px;margin:0 0 6px;color:var(--deep);">Studio session</h2>
    <p style="font-size:14px;line-height:1.65;color:var(--body);margin:0 0 14px;">${todayDateLine(new Date())}</p>
    <button class="lng-btn-secondary" data-action="open-session" data-slot="${s.slot_id}" data-date="${s.date}" style="margin-top:0;">Manage this session</button>
  `;
  el.querySelector('[data-action="open-session"]').addEventListener('click', () => openSessionAction(s));
}

function renderThisWeek() {
  const root = $('#today-week');
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7);
  const items = (state.me.upcoming_sessions || []).filter((s) => {
    const d = new Date(s.date + 'T00:00:00');
    return d >= now && d < weekEnd;
  });
  if (!items.length) {
    root.innerHTML = `<div class="lng-empty-soft">Nothing scheduled this week.</div>`;
    return;
  }
  root.innerHTML = items.map(sessionRowHtml).join('');
  root.querySelectorAll('[data-slot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slotId = btn.dataset.slot;
      const date = btn.dataset.date;
      const item = items.find((x) => x.slot_id === slotId && x.date === date);
      if (item) openSessionAction(item);
    });
  });
}

function sessionRowHtml(s) {
  const d = new Date(s.date + 'T00:00:00');
  const dateLbl = `${DAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
  const stateLbl = s.state === 'scheduled' ? '' :
    s.state === 'cancelled_in_time' ? ' &middot; Cancelled' :
    s.state === 'cancelled_late' ? ' &middot; Cancelled (late)' :
    s.state === 'paused' ? ' &middot; Travel hold' :
    ` &middot; ${s.state}`;
  const dim = s.state !== 'scheduled' ? 'opacity:0.55;' : '';
  return `
    <button class="lng-card" data-slot="${s.slot_id}" data-date="${s.date}" style="text-align:left;display:block;width:100%;cursor:pointer;border-left:3px solid var(--clay);${dim}background:var(--cream);">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div>
          <div style="font-family:'Cormorant Garamond',serif;font-size:20px;color:var(--deep);">${escapeHtml(s.time || '')}</div>
          <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:var(--bark);margin-top:4px;">${dateLbl}${stateLbl}</div>
        </div>
        <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:var(--clay);">Manage &rsaquo;</div>
      </div>
    </button>
  `;
}

function renderSchedule() {
  const root = $('#schedule-month');
  const items = state.me.upcoming_sessions || [];
  if (!items.length) {
    root.innerHTML = `<div class="lng-empty-soft">No upcoming sessions in the next four weeks.</div>`;
    return;
  }
  root.innerHTML = items.map(sessionRowHtml).join('');
  root.querySelectorAll('[data-slot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = items.find((x) => x.slot_id === btn.dataset.slot && x.date === btn.dataset.date);
      if (item) openSessionAction(item);
    });
  });
}

function renderBilling() {
  const m = state.me.member;
  const b = state.me.billing || {};
  $('#bill-plan').textContent = m.plan || '—';

  // Card on file / next charge — depends on Stripe state
  let cardLine = '—';
  let nextLine = '—';
  if (!b.stripe_configured) {
    cardLine = 'Billed manually by Georgie';
    nextLine = 'Outside the app for now';
  } else if (!b.customer_linked) {
    cardLine = 'Not yet set up';
    nextLine = 'Georgie will send you a link';
  } else {
    cardLine = 'Tap "Manage card" to view';
    nextLine = 'Tap "Manage card" to view';
  }
  $('#bill-card').textContent = cardLine;
  $('#bill-next').textContent = nextLine;

  // Wire / re-label the Manage Card button based on Stripe state
  const portalBtn = $('#bill-portal-btn');
  if (portalBtn && !portalBtn._bound) {
    portalBtn._bound = true;
    portalBtn.addEventListener('click', openBillingPortal);
  }
  if (portalBtn) {
    if (!b.stripe_configured || !b.customer_linked) {
      portalBtn.textContent = 'Set up payment with Georgie';
    } else {
      portalBtn.textContent = 'Manage card & invoices';
    }
  }

  // Holds list
  const root = $('#bill-holds');
  const holds = state.me.travel_holds || [];
  if (!holds.length) {
    root.innerHTML = `<div class="lng-empty-soft">No holds set.</div>`;
  } else {
    root.innerHTML = holds.map(holdRowHtml).join('');
    root.querySelectorAll('[data-cancel-hold]').forEach((btn) => {
      btn.addEventListener('click', () => cancelTravelHold(btn.dataset.cancelHold));
    });
  }
}

function holdRowHtml(h) {
  return `
    <div class="lng-card" style="border-left:3px solid var(--moss);">
      <div class="lng-card-row">
        <div class="lng-card-lbl">From</div>
        <div class="lng-card-val">${formatDate(h.start_date)}</div>
      </div>
      <div class="lng-card-row">
        <div class="lng-card-lbl">To</div>
        <div class="lng-card-val">${formatDate(h.end_date)}</div>
      </div>
      ${h.reason ? `<div class="lng-card-row"><div class="lng-card-lbl">Note</div><div class="lng-card-val">${escapeHtml(h.reason)}</div></div>` : ''}
      <div style="text-align:right;margin-top:6px;">
        <button class="lng-link-btn" data-cancel-hold="${escapeHtml(h.id)}" style="color:var(--error);">Remove hold</button>
      </div>
    </div>
  `;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return `${DAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}

function renderProfile() {
  const m = state.me.member;
  const p = state.me.preferences || {};
  $('#prof-name').textContent = m.name || '—';
  $('#prof-email').textContent = m.email || '—';
  $('#prof-plan').textContent = m.plan || '—';
  $('#prof-since').textContent = m.start_date ? formatDate(m.start_date) : '—';
  $('#pref-stealth').checked = !!p.stealth_handle;
  $('#pref-handle').hidden = !p.stealth_handle;
  $('#pref-handle').value = p.stealth_handle || '';
  $('#pref-receipts').checked = p.read_receipts !== false;
  $('#pref-email').checked = p.notify_email !== false;
}

function renderMsgDot() {
  $('#lng-msg-dot').hidden = !(state.me.unread_messages > 0);
}

// ─── Session-action sheet ──────────────────────
const NOTICE_HOURS = { signature: 48, flexible: 168, vip: 48 };
function planKey(p) {
  const s = String(p || '').toLowerCase();
  if (s.indexOf('vip') >= 0) return 'vip';
  if (s.indexOf('flex') >= 0) return 'flexible';
  return 'signature';
}

function openSessionAction(item) {
  if (item.state !== 'scheduled') {
    showToast('This session is already ' + item.state.replace('_', ' ') + '.');
    return;
  }
  const plan = state.me.member.plan;
  const tier = planKey(plan);
  const required = NOTICE_HOURS[tier];
  const start = parseSessionStart(item.date, item.time);
  const noticeHours = (start.getTime() - Date.now()) / (1000 * 60 * 60);
  const inTime = noticeHours >= required;
  const niceDate = formatDate(item.date) + ' · ' + (item.time || '');

  const sheet = document.createElement('div');
  sheet.className = 'lng-sheet';
  sheet.innerHTML = `
    <div class="lng-sheet-overlay" data-sheet-close></div>
    <div class="lng-sheet-card">
      <p class="lng-eyebrow" style="margin:0 0 8px;">Session</p>
      <h2 style="font-family:'Cormorant Garamond',serif;font-weight:300;font-size:26px;margin:0 0 4px;color:var(--deep);">${escapeHtml(niceDate)}</h2>
      <p style="font-size:13px;color:var(--body);margin:0 0 22px;">
        ${inTime
          ? `Cancelling now is <strong>within policy</strong> (${required}hr notice). No charge.`
          : `Cancelling now is <strong style="color:var(--error);">late</strong>. Required notice is ${required}hr — full session fee applies.`}
      </p>
      <textarea class="lng-sheet-note" id="sheet-note" rows="2" placeholder="Add a note for Georgie (optional)"></textarea>
      <button class="lng-btn-primary" style="width:100%;margin-top:12px;${inTime ? '' : 'background:var(--error);'}" id="sheet-cancel">Confirm cancellation</button>
      <button class="lng-link-btn" style="display:block;margin:14px auto 0;" data-sheet-close>Keep this session</button>
    </div>
  `;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('is-open'));

  sheet.querySelectorAll('[data-sheet-close]').forEach((el) => {
    el.addEventListener('click', () => closeSheet(sheet));
  });
  sheet.querySelector('#sheet-cancel').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Cancelling…';
    const reason = sheet.querySelector('#sheet-note').value.trim();
    try {
      const res = await api('lounge_cancel_session', {
        method: 'POST',
        auth: true,
        body: { slot_id: item.slot_id, session_date: item.date, reason },
      });
      const target = state.me.upcoming_sessions.find((s) => s.slot_id === item.slot_id && s.date === item.date);
      if (target) {
        target.state = res.state;
        target.charge_required = res.charge_required;
      }
      closeSheet(sheet);
      renderAll();
      showToast(res.charge_required ? 'Cancelled — Georgie will be in touch about the late fee.' : 'Cancelled. No charge.');
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Confirm cancellation';
      showToast('Couldn’t cancel — try again or message Georgie.', true);
    }
  });
}

function closeSheet(sheet) {
  sheet.classList.remove('is-open');
  setTimeout(() => sheet.remove(), 220);
}

function parseSessionStart(dateStr, timeStr) {
  if (!timeStr) return new Date(dateStr + 'T00:00:00');
  const m = String(timeStr).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return new Date(dateStr + 'T00:00:00');
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  return new Date(dateStr + 'T' + String(h).padStart(2, '0') + ':' + String(mn).padStart(2, '0') + ':00');
}

// ─── Travel hold modal ─────────────────────────
function openTravelHoldModal() {
  const today = new Date().toISOString().slice(0, 10);
  const sheet = document.createElement('div');
  sheet.className = 'lng-sheet';
  sheet.innerHTML = `
    <div class="lng-sheet-overlay" data-sheet-close></div>
    <div class="lng-sheet-card">
      <p class="lng-eyebrow" style="margin:0 0 8px;">Travel hold</p>
      <h2 style="font-family:'Cormorant Garamond',serif;font-weight:300;font-size:26px;margin:0 0 4px;color:var(--deep);">When are you <em>away</em>?</h2>
      <p style="font-size:13px;color:var(--body);margin:0 0 22px;">Sessions in this range will be paused. Up to one month of holds per year is included.</p>

      <label class="lng-label">From</label>
      <input type="date" id="hold-from" class="lng-input" min="${today}" value="${today}">
      <label class="lng-label" style="margin-top:12px;">To</label>
      <input type="date" id="hold-to"   class="lng-input" min="${today}" value="${today}">
      <label class="lng-label" style="margin-top:12px;">Note (optional)</label>
      <input type="text" id="hold-reason" class="lng-input" placeholder="e.g. Aspen 14–28">

      <div class="lng-sheet-err" id="hold-err" hidden></div>
      <button class="lng-btn-primary" style="width:100%;margin-top:18px;" id="hold-save">Save hold</button>
      <button class="lng-link-btn" style="display:block;margin:14px auto 0;" data-sheet-close>Cancel</button>
    </div>
  `;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('is-open'));

  sheet.querySelectorAll('[data-sheet-close]').forEach((el) =>
    el.addEventListener('click', () => closeSheet(sheet))
  );
  sheet.querySelector('#hold-save').addEventListener('click', async (e) => {
    const start = sheet.querySelector('#hold-from').value;
    const end = sheet.querySelector('#hold-to').value;
    const reason = sheet.querySelector('#hold-reason').value.trim();
    const errEl = sheet.querySelector('#hold-err');
    errEl.hidden = true;
    if (!start || !end || end < start) {
      errEl.textContent = 'Pick a valid date range.';
      errEl.hidden = false;
      return;
    }
    e.target.disabled = true;
    e.target.textContent = 'Saving…';
    try {
      const res = await api('lounge_create_travel_hold', {
        method: 'POST',
        auth: true,
        body: { start_date: start, end_date: end, reason },
      });
      // Refresh
      await loadMe();
      renderAll();
      if (state.route === 'payments') renderBilling();
      closeSheet(sheet);
      showToast('Hold saved. Georgie has been notified.');
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Save hold';
      let msg = 'Couldn’t save the hold.';
      if (err.status === 400 && err.data?.error === 'pause_cap_exceeded') {
        msg = err.data.message;
      }
      errEl.textContent = msg;
      errEl.hidden = false;
    }
  });
}

async function openBillingPortal() {
  const b = state.me.billing || {};
  if (!b.stripe_configured || !b.customer_linked) {
    // Fall back to opening a message thread with Georgie, pre-filled
    showToast('Send Georgie a message and she’ll get you set up.');
    navigate('messages');
    setTimeout(() => {
      const inp = $('#msg-input');
      if (inp && !inp.value) inp.value = 'Hi Georgie — can you set me up for billing through the lounge?';
    }, 300);
    return;
  }
  try {
    const res = await api('lounge_billing_portal', { auth: true });
    if (res.url) window.location.href = res.url;
    else showToast('Couldn’t open the billing portal — try again later.', true);
  } catch (err) {
    showToast('Couldn’t open the billing portal.', true);
  }
}

async function cancelTravelHold(holdId) {
  try {
    await api('lounge_cancel_travel_hold', {
      method: 'POST',
      auth: true,
      body: { hold_id: holdId },
    });
    await loadMe();
    renderAll();
    if (state.route === 'payments') renderBilling();
    showToast('Hold cancelled.');
  } catch (err) {
    showToast('Couldn’t cancel hold.', true);
  }
}

function onStealthToggle() {
  const on = $('#pref-stealth').checked;
  $('#pref-handle').hidden = !on;
  if (!on) {
    savePref({ stealth_handle: null });
    $('#pref-handle').value = '';
  } else {
    $('#pref-handle').focus();
  }
}

let savePrefTimer = null;
async function savePref(patch) {
  if (!state.me) return;
  // Optimistic local update so the UI feels instant
  state.me.preferences = { ...(state.me.preferences || {}), ...patch };
  // Debounce text changes (handle), but fire toggles immediately
  clearTimeout(savePrefTimer);
  const fire = async () => {
    try {
      const res = await api('lounge_save_preferences', {
        method: 'POST', auth: true, body: patch,
      });
      state.me.preferences = res.preferences;
    } catch (err) {
      showToast('Couldn’t save preference.', true);
    }
  };
  if ('stealth_handle' in patch) {
    savePrefTimer = setTimeout(fire, 400);
  } else {
    fire();
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// ─── Concierge requests ────────────────────────
function openConciergeModal(type, label) {
  const sheet = document.createElement('div');
  sheet.className = 'lng-sheet';
  const placeholders = {
    at_home: 'When and where would suit? Any preferred days/times?',
    travel: 'Where will you be, for how long, and what gear/space do you have?',
    nutrition: 'What would you like to focus on? (recovery, body comp, performance…)',
  };
  sheet.innerHTML = `
    <div class="lng-sheet-overlay" data-sheet-close></div>
    <div class="lng-sheet-card">
      <p class="lng-eyebrow" style="margin:0 0 8px;">Concierge</p>
      <h2 style="font-family:'Cormorant Garamond',serif;font-weight:300;font-size:24px;margin:0 0 14px;color:var(--deep);">${escapeHtml(label)}</h2>
      <p style="font-size:13px;line-height:1.6;color:var(--body);margin:0 0 14px;">Send Georgie the details and she'll be in touch within a day. No commitment.</p>
      <textarea class="lng-sheet-note" id="conc-details" rows="4" placeholder="${escapeHtml(placeholders[type] || 'Anything she should know?')}"></textarea>
      <button class="lng-btn-primary" style="width:100%;margin-top:14px;" id="conc-send">Send request</button>
      <button class="lng-link-btn" style="display:block;margin:14px auto 0;" data-sheet-close>Cancel</button>
    </div>
  `;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('is-open'));
  sheet.querySelectorAll('[data-sheet-close]').forEach((el) =>
    el.addEventListener('click', () => closeSheet(sheet))
  );
  sheet.querySelector('#conc-send').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Sending…';
    try {
      const details = sheet.querySelector('#conc-details').value.trim();
      await api('lounge_concierge', {
        method: 'POST', auth: true,
        body: { request_type: type, details },
      });
      closeSheet(sheet);
      showToast('Sent. Georgie has been notified.');
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Send request';
      showToast('Couldn’t send.', true);
    }
  });
}

// ─── Audit log ─────────────────────────────────
const AUDIT_LABEL = {
  view_lounge:        ['You',     'opened the Lounge'],
  cancel_session:     ['You',     'cancelled a session'],
  create_travel_hold: ['You',     'added a travel hold'],
  cancel_travel_hold: ['You',     'removed a travel hold'],
};

async function openAuditLog() {
  const sheet = document.createElement('div');
  sheet.className = 'lng-sheet';
  sheet.innerHTML = `
    <div class="lng-sheet-overlay" data-sheet-close></div>
    <div class="lng-sheet-card">
      <p class="lng-eyebrow" style="margin:0 0 8px;">Access log</p>
      <h2 style="font-family:'Cormorant Garamond',serif;font-weight:300;font-size:24px;margin:0 0 6px;color:var(--deep);">Who has seen <em>your data</em></h2>
      <p style="font-size:12px;color:var(--bark);margin:0 0 14px;">Most recent first. Goes back 90 days.</p>
      <div id="audit-body" style="max-height:55vh;overflow-y:auto;"></div>
      <button class="lng-link-btn" style="display:block;margin:14px auto 0;" data-sheet-close>Close</button>
    </div>
  `;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('is-open'));
  sheet.querySelectorAll('[data-sheet-close]').forEach((el) =>
    el.addEventListener('click', () => closeSheet(sheet))
  );
  try {
    const res = await api('lounge_audit_log', { auth: true });
    const body = sheet.querySelector('#audit-body');
    if (!res.entries.length) {
      body.innerHTML = `<div class="lng-empty-soft">No activity yet.</div>`;
    } else {
      body.innerHTML = res.entries.map((e) => {
        const t = new Date(e.occurred_at);
        const ago = relativeTimeStr(t);
        const label = AUDIT_LABEL[e.action];
        const who = e.actor_role === 'member' ? (label?.[0] || 'You') : (e.actor_role === 'trainer' ? 'Georgie' : 'System');
        const what = label?.[1] || e.action.replace(/_/g, ' ');
        return `
          <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--stone);">
            <div>
              <div style="font-size:14px;color:var(--deep);"><strong>${escapeHtml(who)}</strong> ${escapeHtml(what)}</div>
            </div>
            <div style="font-size:11px;color:var(--clay);white-space:nowrap;">${escapeHtml(ago)}</div>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    sheet.querySelector('#audit-body').innerHTML = `<div class="lng-empty-soft">Couldn’t load access log.</div>`;
  }
}

function relativeTimeStr(d) {
  const diff = Date.now() - d.getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  const days = Math.round(h / 24); if (days < 7) return days + 'd ago';
  return d.toLocaleDateString();
}

// ─── iCal copy ─────────────────────────────────
async function copyIcalLink() {
  const url = state.me?.member?.ical_url;
  if (!url) { showToast('No calendar link available yet.'); return; }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Calendar link copied. Paste into Apple Calendar or Google Calendar.');
  } catch (err) {
    // Fallback — show in a prompt
    window.prompt('Copy this URL into your calendar app:', url);
  }
}

// ─── Challenges ────────────────────────────────
let challengesCache = null;
async function loadChallenges() {
  const root = $('#challenges-list');
  root.innerHTML = '<div class="lng-loading">Loading…</div>';
  try {
    const res = await api('lounge_challenges', { auth: true });
    challengesCache = res.challenges || [];
    renderChallenges();
  } catch (err) {
    root.innerHTML = `<div class="lng-empty-soft">Couldn’t load challenges.</div>`;
  }
}

function renderChallenges() {
  const root = $('#challenges-list');
  const list = challengesCache || [];
  if (!list.length) {
    root.innerHTML = `<div class="lng-empty-soft">No active challenges. Georgie will post when one opens.</div>`;
    return;
  }
  root.innerHTML = list.map(challengeCardHtml).join('');
  root.querySelectorAll('[data-challenge-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.challengeId;
      const action = btn.dataset.challengeAction;
      if (action === 'join') joinChallenge(id, btn.dataset.stealth === '1');
      else if (action === 'leave') leaveChallenge(id);
      else if (action === 'log') openLogEntryModal(id);
      else if (action === 'leaderboard') openLeaderboard(id);
    });
  });
}

function challengeCardHtml(c) {
  const d1 = formatDate(c.start_date);
  const d2 = formatDate(c.end_date);
  const isActive = c.status === 'active';
  const stealthDefault = state.me?.preferences?.stealth_handle ? '1' : '0';
  const typeLabel = { solo: 'Solo', squad: 'Squad', studio: 'Studio' }[c.challenge_type] || c.challenge_type;

  return `
    <div class="lng-card" style="border-left:3px solid var(--sage);">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;">
        <div>
          <p class="lng-eyebrow" style="margin:0 0 4px;">${escapeHtml(typeLabel)}${isActive ? '' : ' · finished'}</p>
          <h3 style="font-family:'Cormorant Garamond',serif;font-weight:300;font-size:22px;margin:0 0 4px;color:var(--deep);">${escapeHtml(c.title)}</h3>
          <p style="font-size:12px;color:var(--bark);margin:0;">${d1} → ${d2}</p>
        </div>
      </div>
      ${c.description ? `<p style="font-size:13px;line-height:1.6;color:var(--body);margin:12px 0 0;">${escapeHtml(c.description)}</p>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;">
        ${c.joined
          ? `<button class="lng-btn-secondary" style="margin:0;flex:1;min-width:140px;" data-challenge-action="log" data-challenge-id="${escapeHtml(c.id)}">Log progress</button>
             <button class="lng-btn-secondary" style="margin:0;flex:1;min-width:140px;" data-challenge-action="leaderboard" data-challenge-id="${escapeHtml(c.id)}">Leaderboard</button>
             ${isActive ? `<button class="lng-link-btn" style="color:var(--bark);" data-challenge-action="leave" data-challenge-id="${escapeHtml(c.id)}">Leave</button>` : ''}`
          : `${isActive ? `<button class="lng-btn-secondary" style="margin:0;flex:1;" data-challenge-action="join" data-challenge-id="${escapeHtml(c.id)}" data-stealth="${stealthDefault}">Join</button>` : ''}`
        }
      </div>
    </div>
  `;
}

async function joinChallenge(id, useStealthHandle) {
  try {
    await api('lounge_challenge_join', {
      method: 'POST', auth: true,
      body: { challenge_id: id, use_stealth_handle: useStealthHandle },
    });
    await loadChallenges();
    showToast('You’re in.');
  } catch (err) {
    showToast('Couldn’t join.', true);
  }
}

async function leaveChallenge(id) {
  try {
    await api('lounge_challenge_leave', {
      method: 'POST', auth: true,
      body: { challenge_id: id },
    });
    await loadChallenges();
  } catch (err) {
    showToast('Couldn’t leave.', true);
  }
}

function openLogEntryModal(challengeId) {
  const sheet = document.createElement('div');
  sheet.className = 'lng-sheet';
  sheet.innerHTML = `
    <div class="lng-sheet-overlay" data-sheet-close></div>
    <div class="lng-sheet-card">
      <p class="lng-eyebrow" style="margin:0 0 8px;">Log progress</p>
      <h2 style="font-family:'Cormorant Garamond',serif;font-weight:300;font-size:24px;margin:0 0 18px;color:var(--deep);">Today's <em>entry</em></h2>
      <label class="lng-label">Value (optional — for lifts/distances)</label>
      <input type="number" inputmode="decimal" id="entry-value" class="lng-input" placeholder="e.g. 80">
      <label class="lng-label" style="margin-top:12px;">Note</label>
      <input type="text" id="entry-note" class="lng-input" placeholder="How did it feel?">
      <button class="lng-btn-primary" style="width:100%;margin-top:18px;" id="entry-save">Log entry</button>
      <button class="lng-link-btn" style="display:block;margin:14px auto 0;" data-sheet-close>Cancel</button>
    </div>
  `;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('is-open'));
  sheet.querySelectorAll('[data-sheet-close]').forEach((el) =>
    el.addEventListener('click', () => closeSheet(sheet))
  );
  sheet.querySelector('#entry-save').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Saving…';
    try {
      const val = sheet.querySelector('#entry-value').value;
      const note = sheet.querySelector('#entry-note').value.trim();
      await api('lounge_challenge_log', {
        method: 'POST', auth: true,
        body: { challenge_id: challengeId, value: val ? Number(val) : null, note: note || null },
      });
      closeSheet(sheet);
      showToast('Logged.');
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Log entry';
      showToast('Couldn’t log.', true);
    }
  });
}

async function openLeaderboard(challengeId) {
  const sheet = document.createElement('div');
  sheet.className = 'lng-sheet';
  sheet.innerHTML = `
    <div class="lng-sheet-overlay" data-sheet-close></div>
    <div class="lng-sheet-card">
      <p class="lng-eyebrow" style="margin:0 0 8px;">Leaderboard</p>
      <h2 style="font-family:'Cormorant Garamond',serif;font-weight:300;font-size:24px;margin:0 0 18px;color:var(--deep);" id="lb-title">Loading…</h2>
      <div id="lb-body" style="max-height:55vh;overflow-y:auto;"></div>
      <button class="lng-link-btn" style="display:block;margin:14px auto 0;" data-sheet-close>Close</button>
    </div>
  `;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('is-open'));
  sheet.querySelectorAll('[data-sheet-close]').forEach((el) =>
    el.addEventListener('click', () => closeSheet(sheet))
  );

  try {
    const data = await fetch(API + '?action=lounge_challenge_leaderboard&challenge_id=' + encodeURIComponent(challengeId), {
      headers: { Authorization: 'Bearer ' + state.token },
    }).then((r) => r.json());
    if (!data.success) throw new Error(data.error || 'failed');
    sheet.querySelector('#lb-title').innerHTML = escapeHtml(data.challenge.title);
    const body = sheet.querySelector('#lb-body');
    if (!data.leaderboard.length) {
      body.innerHTML = `<div class="lng-empty-soft">No entries yet.</div>`;
    } else {
      body.innerHTML = data.leaderboard.map((row, i) => `
        <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--stone);${row.isMe ? 'background:var(--sand);margin:0 -16px;padding-left:16px;padding-right:16px;' : ''}">
          <div style="display:flex;gap:12px;align-items:baseline;">
            <span style="font-family:'Cormorant Garamond',serif;font-size:18px;color:var(--clay);">${i + 1}</span>
            <span style="color:var(--deep);font-size:14px;">${escapeHtml(row.handle)}${row.isMe ? ' <em style="color:var(--bark);">(you)</em>' : ''}</span>
          </div>
          <div style="font-family:'Cormorant Garamond',serif;font-size:18px;color:var(--bark);">${data.is_count_metric ? row.score : (row.score % 1 === 0 ? row.score : row.score.toFixed(1))}</div>
        </div>
      `).join('');
    }
  } catch (err) {
    sheet.querySelector('#lb-title').textContent = 'Couldn’t load.';
  }
}

// ─── Messages ────────────────────────────────────
let msgPollTimer = null;
let lastMsgCount = 0;

async function openMessagesTab() {
  await refreshMessages();
  startMessagePolling();
  // Wire send form (idempotent — bind once)
  const form = $('#msg-form');
  if (form && !form._bound) {
    form._bound = true;
    form.addEventListener('submit', sendMessage);
    $('#msg-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendMessage(e);
      }
    });
  }
}

function startMessagePolling() {
  stopMessagePolling();
  msgPollTimer = setInterval(refreshMessages, 6000);
}
function stopMessagePolling() {
  if (msgPollTimer) clearInterval(msgPollTimer);
  msgPollTimer = null;
}

async function refreshMessages() {
  if (state.route !== 'messages') return;
  try {
    const res = await api('lounge_messages', { auth: true });
    renderMessages(res.messages || []);
    // Refresh dot if any unread (but messages page reads-on-fetch, so dot will clear)
    state.me.unread_messages = 0;
    renderMsgDot();
  } catch (err) {
    if (err.status === 401) { clearTokens(); location.reload(); }
  }
}

function renderMessages(messages) {
  const root = $('#msg-thread');
  if (!messages.length) {
    root.innerHTML = `<div class="lng-empty-soft">No messages yet. Say hello.</div>`;
    return;
  }
  // Group by day
  const days = {};
  for (const m of messages) {
    const day = m.sent_at.slice(0, 10);
    if (!days[day]) days[day] = [];
    days[day].push(m);
  }
  const html = Object.keys(days).map((day) => {
    const d = new Date(day + 'T00:00:00');
    const lbl = `${DAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
    const bubbles = days[day].map(msgBubbleHtml).join('');
    return `<div style="text-align:center;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:var(--clay);margin:8px 0 4px;">${lbl}</div>${bubbles}`;
  }).join('');
  root.innerHTML = html;
  // Scroll to bottom on new messages
  if (messages.length !== lastMsgCount) {
    requestAnimationFrame(() => { root.scrollTop = root.scrollHeight; });
    lastMsgCount = messages.length;
  }
}

function msgBubbleHtml(m) {
  const time = new Date(m.sent_at);
  const hh = time.getHours();
  const mm = String(time.getMinutes()).padStart(2, '0');
  const ampm = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const timeLbl = `${h12}:${mm}${ampm}`;
  const cls = m.direction === 'in' ? 'is-mine' : 'is-theirs';
  return `<div class="lng-msg-bubble ${cls}">${escapeHtml(m.body)}</div><div class="lng-msg-meta" style="text-align:${m.direction === 'in' ? 'right' : 'left'};">${timeLbl}</div>`;
}

async function sendMessage(e) {
  e.preventDefault();
  const input = $('#msg-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await api('lounge_send_message', {
      method: 'POST', auth: true, body: { body: text },
    });
    await refreshMessages();
  } catch (err) {
    showToast('Couldn’t send message — try again.', true);
    input.value = text;
  }
}

// ═══════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════

async function boot() {
  bindLogin();
  bindShell();

  captureTokensFromHash();
  loadStoredTokens();

  if (!state.token) {
    showView('lounge-login');
    return;
  }

  // Show the shell instantly — don't make the user stare at a blank page
  // while the lounge_me round-trip happens. Render skeleton state, then
  // fill in when data arrives.
  showView('lounge-shell');
  readHashRoute();
  if (!state.route) navigate('today');
  else navigate(state.route);

  try {
    await loadMe();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      clearTokens();
      showView('lounge-login');
      return;
    }
    showToast('Couldn’t load your lounge. Please try again.', true);
    return;
  }

  renderAll();
}

document.addEventListener('DOMContentLoaded', boot);
