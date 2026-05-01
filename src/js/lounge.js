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

  // Pref toggles
  $('#pref-stealth').addEventListener('change', onStealthToggle);
  $('#pref-receipts').addEventListener('change', () => savePref({ read_receipts: $('#pref-receipts').checked }));
  $('#pref-email').addEventListener('change', () => savePref({ notify_email: $('#pref-email').checked }));
  $('#pref-handle').addEventListener('change', () => savePref({ stealth_handle: $('#pref-handle').value.trim() }));

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
  if (route === 'schedule') renderSchedule();
  if (route === 'payments') renderBilling();
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
  $('#bill-plan').textContent = m.plan || '—';
  $('#bill-card').textContent = '— (set up in next phase)';
  $('#bill-next').textContent = '— (set up in next phase)';

  // Holds list
  const root = $('#bill-holds');
  const holds = state.me.travel_holds || [];
  if (!holds.length) {
    root.innerHTML = `<div class="lng-empty-soft">No holds set.</div>`;
  } else {
    root.innerHTML = holds.map(holdRowHtml).join('');
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

// Placeholder for Phase 2 — for now, just toast.
function openSessionAction(item) {
  showToast('Session controls arrive in the next phase.');
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

async function savePref(_patch) {
  // Wire to server in Phase 2 alongside session actions.
  showToast('Preferences saved locally — server sync arrives next phase.');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
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

  try {
    await loadMe();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      clearTokens();
      showView('lounge-login');
      return;
    }
    showToast('Couldn’t load your lounge. Please try again.', true);
    showView('lounge-login');
    return;
  }

  showView('lounge-shell');
  renderAll();
  readHashRoute();
  if (!state.route || state.route === 'today') navigate('today');
}

document.addEventListener('DOMContentLoaded', boot);
