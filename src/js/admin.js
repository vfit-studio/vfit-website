/* ═══════════════════════════════════════════
   VFIT ADMIN DASHBOARD
   Matches actual API response structures
   ═══════════════════════════════════════════ */

const API = '/.netlify/functions/api';

let currentPage = 'overview';
let eventsCache = [];
let bookingsRefreshInterval = null;
let pendingConfirmCallback = null;

// ─── HELPERS ───

function getKey() {
  return sessionStorage.getItem('vfit_admin_key') || '';
}

function apiURL(params) {
  const qs = new URLSearchParams(params);
  return API + '?' + qs.toString();
}

async function apiGet(params) {
  try {
    const res = await fetch(apiURL(params));
    if (!res.ok) throw new Error('Request failed: ' + res.status);
    const data = await res.json();
    if (data.success === false) throw new Error(data.error || 'Unknown error');
    return data;
  } catch (err) {
    throw err;
  }
}

async function apiPost(body) {
  body.admin_key = getKey();
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok || data.success === false) throw new Error(data.error || 'Request failed');
  return data;
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || '') + ' show';
  setTimeout(function() { t.classList.remove('show'); }, type === 'error' ? 8000 : 3500);
}

function formatDate(d) {
  if (!d) return '--';
  var dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  var day = dt.getDate();
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var month = months[dt.getMonth()];
  var year = dt.getFullYear();
  var hours = dt.getHours();
  var mins = dt.getMinutes();
  var ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  var minsStr = mins < 10 ? '0' + mins : '' + mins;
  return day + ' ' + month + ' ' + year + ', ' + hours + ':' + minsStr + ' ' + ampm;
}

function formatCurrency(cents) {
  if (cents == null || cents === 0) return 'Free';
  return '$' + (cents / 100).toFixed(2);
}

function statusBadge(status) {
  var s = (status || '').toLowerCase();
  var cls = s === 'confirmed' ? 'badge-confirmed'
    : s === 'held' ? 'badge-held'
    : s === 'cancelled' || s === 'expired' ? 'badge-cancelled'
    : s === 'new' ? 'badge-new'
    : s === 'contacted' ? 'badge-contacted'
    : s === 'active' ? 'badge-active'
    : s === 'inactive' ? 'badge-inactive'
    : s === 'open' ? 'badge-open'
    : s === 'archived' ? 'badge-archived'
    : 'badge-held';
  return '<span class="badge ' + cls + '">' + esc(status || 'Unknown') + '</span>';
}

function esc(str) {
  var d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

// ─── CONFIRM DIALOG ───

function showConfirm(msg, callback) {
  document.getElementById('confirm-msg').textContent = msg;
  document.getElementById('confirm-dialog').classList.add('open');
  pendingConfirmCallback = callback;
}

function closeConfirm() {
  document.getElementById('confirm-dialog').classList.remove('open');
  pendingConfirmCallback = null;
}

function confirmAction() {
  if (pendingConfirmCallback) pendingConfirmCallback();
  closeConfirm();
}

// ─── AUTH ───

async function handleLogin(e) {
  e.preventDefault();
  var pw = document.getElementById('login-password').value.trim();
  var errEl = document.getElementById('login-error');
  var btn = document.getElementById('login-btn');
  errEl.textContent = '';

  if (!pw) { errEl.textContent = 'Please enter a password'; return false; }

  btn.disabled = true;
  btn.textContent = 'Verifying...';

  try {
    var res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify_admin', admin_key: pw })
    });
    var data = await res.json();
    if (res.ok && data.success) {
      sessionStorage.setItem('vfit_admin_key', pw);
      enterDashboard();
    } else {
      errEl.textContent = data.error || 'Invalid password';
    }
  } catch (err) {
    errEl.textContent = 'Could not connect to server. Try again.';
  }

  btn.disabled = false;
  btn.textContent = 'Enter';
  return false;
}

function enterDashboard() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('dashboard-shell').classList.add('active');
  showPage('overview');
  loadNavBadges();
}

async function loadNavBadges() {
  try {
    var mresp = await apiGet({ action: 'memberships' });
    var memberships = mresp.data || mresp.memberships || [];
    var newCount = memberships.filter(function(m) { return (m.status || 'new') === 'new'; }).length;
    var badge = document.getElementById('mreq-badge');
    if (badge) { if (newCount > 0) { badge.textContent = newCount; badge.style.display = 'inline'; } else { badge.style.display = 'none'; } }
  } catch(e) {}
  try {
    var gresp = await apiGet({ action: 'contacts' });
    var msgs = gresp.data || gresp.contacts || [];
    var gbadge = document.getElementById('gmsg-badge');
    if (gbadge) { if (msgs.length > 0) { gbadge.textContent = msgs.length; gbadge.style.display = 'inline'; } else { gbadge.style.display = 'none'; } }
  } catch(e) {}
}

function logout() {
  sessionStorage.clear();
  clearInterval(bookingsRefreshInterval);
  document.getElementById('dashboard-shell').classList.remove('active');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').textContent = '';
}

// Check session on load
if (sessionStorage.getItem('vfit_admin_key')) {
  enterDashboard();
}

// ─── NAVIGATION ───

function showPage(page) {
  currentPage = page;
  clearInterval(bookingsRefreshInterval);

  document.querySelectorAll('.admin-page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-' + page).classList.add('active');

  document.querySelectorAll('.sidebar-nav button').forEach(function(b) {
    b.classList.toggle('active', b.dataset.page === page);
  });

  // Update topbar page label (mobile)
  var labelEl = document.getElementById('topbar-page-label');
  if (labelEl) {
    var pageLabels = {
      'overview': 'Dashboard', 'runclub': 'Run Club', 'pilattes': "Pi'lattes",
      'membership-requests': 'Requests', 'enquiry-schedule': 'Enquiry Schedule', 'member-list': 'Members', 'followups': 'Follow-ups',
      'general-messages': 'Messages', 'lounge-activity': 'Lounge Activity', 'plan-config': 'Plans',
      'testimonials': 'Testimonials', 'media-library': 'Media', 'calendar': 'Calendar'
    };
    labelEl.textContent = pageLabels[page] || page;
  }

  // Close mobile sidebar
  closeMobileSidebar();

  switch (page) {
    case 'overview': loadOverview(); break;
    case 'events': loadEvents(); break;
    case 'runclub': loadTypePage('rc', 'runclub'); break;
    case 'pilattes': loadTypePage('pl', 'pilattes'); break;
    case 'bookings': loadBookingsPage(); break;
    case 'memberships': loadMemberships(); break;
    case 'membership-requests': loadMembershipRequests(); break;
    case 'enquiry-schedule': loadEnquirySchedule(); break;
    case 'member-list': loadMemberList(); break;
    case 'followups': loadFollowUps(); break;
    case 'calendar': loadCalendar(); break;
    case 'general-messages': loadGeneralMessages(); break;
    case 'lounge-activity': loadLoungeActivity(); break;
    case 'contacts': loadContacts(); break;
    case 'plan-config': loadPlanConfig(); break;
    case 'testimonials': loadTestimonials(); break;
    case 'media-library': loadMediaLibrary(); break;
  }
}

function toggleMobileSidebar() {
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');
  var isOpen = sidebar.classList.toggle('mobile-open');
  if (isOpen) {
    overlay.classList.add('active');
    document.body.classList.add('body-no-scroll');
  } else {
    overlay.classList.remove('active');
    document.body.classList.remove('body-no-scroll');
  }
}

function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebar-overlay').classList.remove('active');
  document.body.classList.remove('body-no-scroll');
}

// ─── MOBILE CARD RENDERERS ───

function renderEventCards(events) {
  if (!events.length) return '<div class="empty-state">No sessions yet.</div>';
  return '<div class="card-list">' + events.map(function(ev) {
    var bookBtn = ev.glofox_url
      ? '<a href="' + esc(ev.glofox_url) + '" target="_blank" class="btn-primary" style="display:inline-block;text-decoration:none;margin-bottom:8px;width:100%;text-align:center;">Book Now ↗</a>'
      : '<span style="background:#f5a623;color:#fff;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:600;">⚠ Add Glofox link</span>';
    return '<div class="data-card">' +
      '<div class="data-card-header">' +
        '<div class="data-card-name"><strong>' + esc(ev.name) + '</strong></div>' +
        statusBadge(ev.status || 'active') +
      '</div>' +
      '<div class="data-card-meta">' + formatDate(ev.session_date) + '</div>' +
      '<div class="data-card-meta" style="margin-top:8px;">' + bookBtn + '</div>' +
      '<div class="data-card-actions">' +
        '<button class="btn-outline" onclick="editEvent(\'' + esc(ev.id) + '\')">Edit</button>' +
        '<button class="btn-outline btn-danger" onclick="deleteEvent(\'' + esc(ev.id) + '\')">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function planKey(plan) {
  var p = String(plan || '').toLowerCase();
  if (p.indexOf('vip') >= 0) return 'vip';
  if (p.indexOf('flex') >= 0) return 'flexible';
  if (p.indexOf('signature') >= 0) return 'signature';
  return 'other';
}

function renderMembershipRequestColumns(members) {
  if (!members.length) return '<div class="empty-state">No enquiries yet.</div>';

  var groups = { signature: [], flexible: [], vip: [], other: [] };
  members.forEach(function(m) { (groups[planKey(m.plan)] || groups.other).push(m); });

  var columnDefs = [
    { key: 'signature', label: 'Signature' },
    { key: 'flexible',  label: 'Flexible'  },
    { key: 'vip',       label: 'VIP'       }
  ];
  // Show 'other' column only if there's anything in it
  if (groups.other.length) columnDefs.push({ key: 'other', label: 'Other' });

  var html = '<div class="mreq-columns">';
  columnDefs.forEach(function(col) {
    var rows = groups[col.key];
    html += '<div class="mreq-col">' +
      '<div class="mreq-col-head"><span class="mreq-col-title">' + esc(col.label) + '</span><span class="mreq-col-count">' + rows.length + '</span></div>' +
      (rows.length ? renderMembershipRequestCards(rows) : '<div class="mreq-col-empty">No ' + esc(col.label) + ' enquiries</div>') +
    '</div>';
  });
  html += '</div>';
  return html;
}

function renderMembershipRequestCards(members) {
  if (!members.length) return '<div class="empty-state">No enquiries yet.</div>';
  return '<div class="card-list">' + members.map(function(m) {
    var status = (m.status || 'new').toLowerCase();
    var showAccept = (status === 'new' || status === 'contacted');
    return '<div class="data-card">' +
      '<div class="data-card-header">' +
        '<div class="data-card-name"><strong>' + esc(m.name || '') + '</strong></div>' +
        statusBadge(m.status || 'new') +
      '</div>' +
      '<div class="data-card-meta">' + esc(m.email || '') + (m.phone ? ' · ' + esc(m.phone) : '') + '</div>' +
      (m.plan ? '<div class="data-card-meta">Plan: ' + esc(m.plan) + '</div>' : '') +
      ((m.days || m.times) ? '<div class="data-card-meta">' + esc(m.days || '') + (m.times ? ' — ' + esc(m.times) : '') + '</div>' : '') +
      (function(){ var p = parseNotes(m.notes); var fu = p.date ? '<div class="data-card-meta" style="color:var(--moss);font-weight:600;">Follow-up: ' + esc(p.date) + '</div>' : ''; var nb = p.text ? '<div class="data-card-body">' + esc(truncate(p.text, 120)) + '</div>' : ''; return fu + nb; })() +
      '<div class="data-card-meta" style="font-size:11px;color:var(--clay);">' + formatDate(m.created_at) + '</div>' +
      '<div class="data-card-actions">' +
        (showAccept ? '<button class="btn-outline" onclick="openAcceptModal(\'' + esc(m.id) + '\')">Accept</button>' : '') +
        (status === 'new' ? '<button class="btn-outline" onclick="markContacted(\'' + esc(m.id) + '\')">Contacted</button>' : '') +
        (status === 'contacted' ? '<button class="btn-outline" onclick="markNew(\'' + esc(m.id) + '\')">Back to New</button>' : '') +
        '<button class="btn-outline" onclick="openNotesModal(\'' + esc(m.id) + '\')">' + (m.notes ? 'Edit Notes' : 'Add Notes') + '</button>' +
        '<button class="btn-outline btn-danger" onclick="deleteMembershipRequest(\'' + esc(m.id) + '\')">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function renderMemberListCards(members) {
  if (!members.length) return '<div class="empty-state">No members yet.</div>';
  return '<div class="card-list">' + members.map(function(m) {
    var status = (m.status || 'active').toLowerCase();
    var statusCls = status === 'active' ? 'badge-active' : status === 'paused' ? 'badge-paused' : status === 'cancelled' ? 'badge-cancelled' : 'badge-held';
    var slots = (m.slots || []).map(function(s) {
      var dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat'];
      return (dayNames[s.day_of_week] || '?') + ' ' + esc(s.time || '');
    }).join(', ') || 'No slots assigned';

    var agreedTag = m.agreed_at ? '<span class="badge badge-active" style="margin-left:6px;font-size:9px;">Agreed &#x2713;</span>' : '';
    var loungeTag = m.lounge_active ? '<span class="badge" style="margin-left:6px;font-size:9px;background:#3d3530;color:#fefcf8;letter-spacing:0.12em;">Lounge</span>' : '';

    return '<div class="data-card">' +
      '<div class="data-card-header">' +
        '<div class="data-card-name"><strong>' + esc(m.name || '') + '</strong>' + agreedTag + loungeTag + '</div>' +
        '<span class="badge ' + statusCls + '">' + esc(status) + '</span>' +
      '</div>' +
      '<div class="data-card-meta">' + esc(m.email || '') + (m.phone && m.phone !== '--' ? ' · ' + esc(m.phone) : '') + '</div>' +
      (m.plan ? '<div class="data-card-meta">Plan: ' + esc(m.plan) + ' · ' + (m.sessions_per_week || 1) + 'x/wk</div>' : '') +
      '<div class="data-card-meta">Slots: ' + slots + '</div>' +
      (function(){ var p = parseNotes(m.notes); var fu = p.date ? '<div class="data-card-meta" style="color:var(--moss);font-weight:600;">Follow-up: ' + esc(p.date) + '</div>' : ''; var nb = p.text ? '<div class="data-card-body">' + esc(truncate(p.text, 140)) + '</div>' : ''; return fu + nb; })() +
      '<div class="data-card-actions">' +
        '<button class="btn-outline" onclick="openNotesModal(\'' + esc(m.id) + '\', \'member\')">' + (m.notes ? 'Edit Notes' : 'Add Notes') + '</button>' +
        '<button class="btn-outline" onclick="openEditMemberModal(\'' + esc(m.id) + '\')">Edit</button>' +
        '<button class="btn-outline btn-danger" onclick="deleteMember(\'' + esc(m.id) + '\')">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

async function sendWelcome(memberId, isResend) {
  var prompt = isResend
    ? 'Resend the welcome email to this member?'
    : 'Send the welcome email with the agreement link now?';
  if (!confirm(prompt)) return;
  try {
    var resp = await apiPost({ action: 'send_welcome', member_id: memberId });
    if (resp.email_configured) {
      showToast('Welcome email sent', 'success');
    } else {
      showToast('Email SKIPPED — Resend not configured on Netlify', 'error');
    }
    loadMemberList();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function renderMessageCards(messages) {
  if (!messages.length) return '<div class="empty-state">No messages yet.</div>';
  return '<div class="card-list">' + messages.map(function(m) {
    return '<div class="data-card">' +
      '<div class="data-card-header">' +
        '<div class="data-card-name"><strong>' + esc(m.name || '') + '</strong></div>' +
        '<span style="font-size:11px;color:var(--clay);white-space:nowrap;">' + formatDate(m.created_at) + '</span>' +
      '</div>' +
      '<div class="data-card-meta">' + esc(m.email || '') + (m.phone ? ' · ' + esc(m.phone) : '') + '</div>' +
      (m.message ? '<div class="data-card-body">' + esc(m.message) + '</div>' : '') +
      '<div class="data-card-actions">' +
        '<button class="btn-outline btn-danger" onclick="deleteContact(\'' + m.id + '\')">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function renderOverviewEventCards(events) {
  if (!events.length) return '<div class="empty-state">No upcoming events.</div>';
  return '<div class="card-list">' + events.map(function(ev) {
    return '<div class="data-card">' +
      '<div class="data-card-header">' +
        '<div class="data-card-name"><strong>' + esc(ev.name) + '</strong></div>' +
        statusBadge(ev.status || 'open') +
      '</div>' +
      '<div class="data-card-meta">' + esc(ev.type || '') + ' · ' + formatDate(ev.session_date) + '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function renderPlanCards(plans) {
  if (!plans.length) return '<div class="empty-state">No plans yet.</div>';
  return '<div class="card-list">' + plans.map(function(p) {
    var price = '$' + (p.price_cents / 100).toFixed(0);
    var featureList = (p.features || []).join(', ');
    if (featureList.length > 80) featureList = featureList.substring(0, 77) + '...';
    return '<div class="data-card">' +
      '<div class="data-card-header">' +
        '<div class="data-card-name"><strong>' + esc(p.name) + '</strong></div>' +
        statusBadge(p.status) +
      '</div>' +
      '<div class="data-card-meta">' + price + ' / ' + esc(p.period_label) + (p.badge_text ? ' · ' + esc(p.badge_text) : '') + '</div>' +
      (featureList ? '<div class="data-card-meta" style="font-size:12px;">' + esc(featureList) + '</div>' : '') +
      '<div class="data-card-actions">' +
        '<button class="btn-outline" onclick="editPlan(\'' + p.id + '\')">Edit</button>' +
        '<button class="btn-outline btn-danger" onclick="deletePlan(\'' + p.id + '\',\'' + esc(p.name).replace(/'/g, "\\'") + '\')">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function renderTestimonialCards(testimonials) {
  if (!testimonials.length) return '<div class="empty-state">No testimonials yet.</div>';
  return '<div class="card-list">' + testimonials.map(function(t) {
    return '<div class="data-card">' +
      '<div class="data-card-header">' +
        '<div class="data-card-name"><strong>' + esc(t.attribution) + '</strong></div>' +
        statusBadge(t.status) +
      '</div>' +
      '<div class="data-card-meta" style="font-size:11px;">Page: ' + esc(t.page) + '</div>' +
      (t.quote ? '<div class="data-card-body">' + esc(truncate(t.quote, 140)) + '</div>' : '') +
      '<div class="data-card-actions">' +
        '<button class="btn-outline" onclick="editTestimonial(\'' + t.id + '\')">Edit</button>' +
        '<button class="btn-outline btn-danger" onclick="deleteTestimonial(\'' + t.id + '\')">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

// ─── OVERVIEW ───
// API: { success: true, dashboard: { total_bookings, total_revenue_cents, upcoming_events, total_memberships, total_contacts } }

async function loadOverview() {
  var loading = document.getElementById('overview-loading');
  var content = document.getElementById('overview-content');
  loading.style.display = 'block';
  content.style.display = 'none';

  try {
    var data = await apiGet({ action: 'dashboard' });
    var db = data.dashboard || {};

    var stats = document.getElementById('overview-stats');
    var upcomingEvents = db.upcoming_events || [];
    var nextEvent = upcomingEvents[0];
    var nextEventHtml = nextEvent
      ? esc(nextEvent.name) + '<div class="stat-sub">' + formatDate(nextEvent.session_date) + '</div>'
      : '<span style="font-size:14px;color:var(--bark);">None scheduled</span>';

    stats.innerHTML =
      '<div class="stat-card">' +
        '<div class="stat-label">Next Upcoming Event</div>' +
        '<div class="stat-value" style="font-size:22px;">' + nextEventHtml + '</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-label">Enquiries</div>' +
        '<div class="stat-value">' + (db.total_memberships || 0) + '</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-label">Members</div>' +
        '<div class="stat-value">' + (db.total_members || 0) + '</div>' +
      '</div>';

    // Upcoming events list
    var upcomingEl = document.getElementById('overview-upcoming');
    if (upcomingEvents.length === 0) {
      upcomingEl.innerHTML = '<div class="empty-state">No upcoming events</div>';
    } else {
      upcomingEl.innerHTML = renderOverviewEventCards(upcomingEvents);
    }

    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load dashboard. ' + esc(err.message) + '</div>';
  }
}

// ─── EVENTS ───
// API: { success: true, events: [...] }
// Each event: id, name, type, tickets_open, session_date, spots_total, price_cents, status, created_at

async function loadEvents() {
  var loading = document.getElementById('events-loading');
  var content = document.getElementById('events-content');
  var empty = document.getElementById('events-empty');
  loading.style.display = 'block';
  content.style.display = 'none';
  empty.style.display = 'none';

  try {
    var data = await apiGet({ action: 'events' });
    eventsCache = data.events || [];

    if (eventsCache.length === 0) {
      loading.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    var tbody = document.getElementById('events-tbody');
    tbody.innerHTML = eventsCache.map(function(ev) {
      var spotsTotal = ev.spots_total || 0;
      return '<tr>' +
        '<td><strong>' + esc(ev.name) + '</strong></td>' +
        '<td>' + esc(ev.type || '') + '</td>' +
        '<td>' + formatDate(ev.session_date) + '</td>' +
        '<td>' + spotsTotal + '</td>' +
        '<td>' + formatCurrency(ev.price_cents) + '</td>' +
        '<td>' + statusBadge(ev.status || 'open') + '</td>' +
        '<td>' +
          (ev.glofox_url ? '<a href="' + esc(ev.glofox_url) + '" target="_blank" class="btn-outline btn-sm" style="text-decoration:none;">Book Now ↗</a> ' : '') +
          '<button class="btn-outline btn-sm" onclick="editEvent(\'' + esc(ev.id) + '\')">Edit</button> <button class="btn-outline btn-sm btn-danger" onclick="deleteEvent(\'' + esc(ev.id) + '\')">Delete</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load events. ' + esc(err.message) + '</div>';
  }
}

function openEventModal(eventData, presetType) {
  var modal = document.getElementById('event-modal');
  var title = document.getElementById('event-modal-title');
  var btn = document.getElementById('event-submit-btn');

  document.getElementById('event-form').reset();
  document.getElementById('event-edit-id').value = '';

  // Pre-set type if coming from Run Club or Pi'lattes page
  if (presetType) {
    document.getElementById('event-type').value = presetType;
  }

  if (eventData) {
    title.innerHTML = 'Edit <em>Event</em>';
    btn.textContent = 'Update Event';
    document.getElementById('event-edit-id').value = eventData.id || '';
    document.getElementById('event-name').value = eventData.name || '';
    document.getElementById('event-type').value = eventData.type || '';
    if (eventData.session_date) {
      document.getElementById('event-session-date').value = toLocalDatetime(eventData.session_date);
    }

    document.getElementById('event-glofox-url').value = eventData.glofox_url || '';
  } else {
    document.getElementById('event-glofox-url').value = '';
    title.innerHTML = 'Create <em>Event</em>';
    btn.textContent = 'Create Event';
    // Set default times: 5:15 AM for run club / studio sessions, 7:00 AM for pi'lattes
    var now = new Date();
    now.setDate(now.getDate() + 1);
    now.setSeconds(0); now.setMilliseconds(0);
    if (presetType === 'pilattes') {
      now.setHours(7, 0);
    } else {
      now.setHours(5, 15);
    }
    document.getElementById('event-session-date').value = toLocalDatetime(now.toISOString());
  }

  modal.classList.add('open');
}

function closeEventModal() {
  document.getElementById('event-modal').classList.remove('open');
}

function toLocalDatetime(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  var pad = function(n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function localDatetimeToISO(val) {
  if (!val) return null;
  // Parse datetime-local value "YYYY-MM-DDTHH:MM" as local time explicitly
  var parts = val.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!parts) return null;
  var d = new Date(+parts[1], +parts[2]-1, +parts[3], +parts[4], +parts[5]);
  return d.toISOString();
}

async function handleEventSubmit(e) {
  e.preventDefault();
  var editId = document.getElementById('event-edit-id').value;

  var payload = {
    action: editId ? 'update_event' : 'create_event',
    name: document.getElementById('event-name').value.trim(),
    type: document.getElementById('event-type').value,
    session_date: localDatetimeToISO(document.getElementById('event-session-date').value),

    spots_total: 0,
    price_cents: 0,
    glofox_url: (function() {
      var raw = document.getElementById('event-glofox-url').value.trim();
      if (!raw) return null;
      // If someone pastes iframe embed code, extract the src URL
      var match = raw.match(/src=["']([^"']+)["']/);
      return match ? match[1] : raw;
    })()
  };
  if (editId) payload.event_id = editId;

  var btn = document.getElementById('event-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await apiPost(payload);
    showToast(editId ? 'Event updated' : 'Event created', 'success');
    closeEventModal();
    // Refresh the current page
    if (currentPage === 'events') loadEvents();
    else if (currentPage === 'runclub') loadTypePage('rc', 'runclub');
    else if (currentPage === 'pilattes') loadTypePage('pl', 'pilattes');
    else loadEvents();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
  btn.disabled = false;
  btn.textContent = editId ? 'Update Event' : 'Create Event';
  return false;
}

function editEvent(id) {
  var ev = eventsCache.find(function(e) { return e.id === id; });
  if (ev) openEventModal(ev);
}

function deleteEvent(id) {
  showConfirm('Delete this event? This cannot be undone.', async function() {
    try {
      await apiPost({ action: 'delete_event', event_id: id });
      showToast('Event deleted', 'success');
      // Refresh whichever page we're on
      if (currentPage === 'events') loadEvents();
      else if (currentPage === 'runclub') loadTypePage('rc', 'runclub');
      else if (currentPage === 'pilattes') loadTypePage('pl', 'pilattes');
      else loadOverview();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });
}

// ─── RUN CLUB / PI'LATTES PAGES ───

async function loadTypePage(pre, type) {
  var loading = document.getElementById(pre + '-loading');
  var content = document.getElementById(pre + '-content');
  var empty = document.getElementById(pre + '-empty');
  loading.style.display = 'block';
  content.style.display = 'none';
  if (empty) empty.style.display = 'none';

  try {
    var data = await apiGet({ action: 'events' });
    var allEvents = data.events || [];
    var typeEvents = allEvents.filter(function(e) { var t = (e.type || '').replace(/[_' ]/g, '').toLowerCase(); var target = type.replace(/[_' ]/g, '').toLowerCase(); return t === target; });
    eventsCache = allEvents;

    if (typeEvents.length === 0) {
      loading.style.display = 'none';
      if (empty) empty.style.display = 'block';
      return;
    }

    content.innerHTML = renderEventCards(typeEvents);
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load. ' + esc(err.message) + '</div>';
  }
}

async function loadTypeBookings(pre) {
  var eventId = document.getElementById(pre + '-event-select').value;
  var tbody = document.getElementById(pre + '-bookings-tbody');
  if (!eventId) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--bark);padding:20px;">Select a session above</td></tr>';
    return;
  }
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--bark);padding:20px;">Loading...</td></tr>';
  try {
    var data = await apiGet({ action: 'bookings', event_id: eventId });
    var bookings = data.bookings || [];
    if (bookings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--bark);padding:20px;">No bookings yet</td></tr>';
    } else {
      tbody.innerHTML = bookings.map(function(b) {
        var canCancel = b.status !== 'cancelled' && b.status !== 'expired';
        return '<tr>' +
          '<td>' + esc(b.name || '') + '</td>' +
          '<td>' + esc(b.email || '') + '</td>' +
          '<td>' + esc(b.phone || '--') + '</td>' +
          '<td>' + statusBadge(b.status) + '</td>' +
          '<td>' + formatCurrency(b.amount_cents) + '</td>' +
          '<td>' + formatDate(b.created_at) + '</td>' +
          '<td>' + (canCancel ? '<button class="btn-outline btn-sm btn-danger" onclick="cancelBooking(\'' + esc(b.id) + '\')">Cancel</button>' : '') + '</td>' +
        '</tr>';
      }).join('');
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--red);padding:20px;">Error: ' + esc(err.message) + '</td></tr>';
  }
}

// ─── BOOKINGS ───
// API: { success: true, bookings: [...] }
// Each booking: id, event_id, name, email, phone, status, stripe_session_id, stripe_payment_id, amount_cents, held_at, confirmed_at, created_at

async function loadBookingsPage() {
  // Populate event filter dropdown
  try {
    if (eventsCache.length === 0) {
      var data = await apiGet({ action: 'events' });
      eventsCache = data.events || [];
    }
    var sel = document.getElementById('bookings-event-filter');
    var current = sel.value;
    sel.innerHTML = '<option value="">Select an event...</option>';
    eventsCache.forEach(function(ev) {
      sel.innerHTML += '<option value="' + esc(ev.id) + '">' + esc(ev.name) + '</option>';
    });
    if (current) sel.value = current;
  } catch (err) {
    // silently fail, filter just won't have events
  }

  loadBookings();

  // Auto-refresh every 30s
  bookingsRefreshInterval = setInterval(function() {
    if (currentPage === 'bookings') loadBookings();
  }, 30000);
}

async function loadBookings() {
  var loading = document.getElementById('bookings-loading');
  var content = document.getElementById('bookings-content');
  var summary = document.getElementById('bookings-summary');

  var eventId = document.getElementById('bookings-event-filter').value;

  if (!eventId) {
    loading.style.display = 'none';
    content.style.display = 'none';
    summary.style.display = 'none';
    // Show a message to select an event
    var tbody = document.getElementById('bookings-tbody');
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Select an event to view bookings</td></tr>';
    content.style.display = 'block';
    return;
  }

  loading.style.display = 'block';
  content.style.display = 'none';
  summary.style.display = 'none';

  var params = { action: 'bookings', event_id: eventId };

  try {
    var data = await apiGet(params);
    var bookings = data.bookings || [];

    // Summary
    var totalCount = bookings.length;
    var totalRevenue = bookings.reduce(function(sum, b) { return sum + (b.amount_cents || 0); }, 0);
    summary.innerHTML =
      '<div class="summary-item"><strong>' + totalCount + '</strong> bookings</div>' +
      '<div class="summary-item"><strong>' + formatCurrency(totalRevenue) + '</strong> revenue</div>';
    summary.style.display = 'flex';

    var tbody = document.getElementById('bookings-tbody');
    if (bookings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No bookings yet</td></tr>';
    } else {
      tbody.innerHTML = bookings.map(function(b) {
        var canCancel = b.status !== 'cancelled' && b.status !== 'expired';
        return '<tr>' +
          '<td>' + esc(b.name || '') + '</td>' +
          '<td>' + esc(b.email || '') + '</td>' +
          '<td>' + esc(b.phone || '--') + '</td>' +
          '<td>' + statusBadge(b.status) + '</td>' +
          '<td>' + formatCurrency(b.amount_cents) + '</td>' +
          '<td>' + formatDate(b.created_at) + '</td>' +
          '<td>' + (canCancel ? '<button class="btn-outline btn-sm btn-danger" onclick="cancelBooking(\'' + esc(b.id) + '\')">Cancel</button>' : '') + '</td>' +
        '</tr>';
      }).join('');
    }

    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load bookings. ' + esc(err.message) + '</div>';
  }
}

function cancelBooking(id) {
  showConfirm('Cancel this booking? This cannot be undone.', async function() {
    try {
      await apiPost({ action: 'cancel_booking', booking_id: id });
      showToast('Booking cancelled', 'success');
      loadBookings();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });
}

// ─── MEMBERSHIPS ───
// API: { success: true, data: [...] }
// Each: id, name, email, phone, plan, sessions, days, times, notes, status, created_at

async function loadMemberships() {
  var loading = document.getElementById('memberships-loading');
  var content = document.getElementById('memberships-content');
  loading.style.display = 'block';
  content.style.display = 'none';

  try {
    var resp = await apiGet({ action: 'memberships' });
    var members = resp.data || [];

    var tbody = document.getElementById('memberships-tbody');
    if (members.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No enquiries yet</td></tr>';
    } else {
      tbody.innerHTML = members.map(function(m) {
        var id = m.id;
        var status = (m.status || 'new').toLowerCase();
        return '<tr>' +
          '<td>' + esc(m.name || '') + '</td>' +
          '<td>' + esc(m.email || '') + '</td>' +
          '<td>' + esc(m.phone || '--') + '</td>' +
          '<td>' + esc(m.plan || '') + '</td>' +
          '<td>' + esc(m.sessions || '') + '</td>' +
          '<td>' + esc(m.days || '') + '</td>' +
          '<td>' + esc(m.times || '') + '</td>' +
          (function(){ var p = parseNotes(m.notes); var disp = (p.date ? '[FU ' + p.date + '] ' : '') + (p.text || ''); return '<td title="' + esc(disp) + '">' + esc(truncate(disp, 40)) + '</td>'; })() +
          '<td>' +
            '<select class="status-select" onchange="updateMembershipStatus(\'' + esc(id) + '\', this.value)">' +
              '<option value="new"' + (status === 'new' ? ' selected' : '') + '>New</option>' +
              '<option value="contacted"' + (status === 'contacted' ? ' selected' : '') + '>Contacted</option>' +
              '<option value="active"' + (status === 'active' ? ' selected' : '') + '>Active</option>' +
              '<option value="inactive"' + (status === 'inactive' ? ' selected' : '') + '>Inactive</option>' +
            '</select>' +
          '</td>' +
          '<td>' + formatDate(m.created_at) + '</td>' +
        '</tr>';
      }).join('');
    }

    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load memberships. ' + esc(err.message) + '</div>';
  }
}

async function updateMembershipStatus(id, status) {
  try {
    await apiPost({ action: 'update_membership', id: id, status: status });
    showToast('Status updated', 'success');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
    loadMemberships(); // revert UI on error
  }
}

// ─── MEMBERSHIP REQUESTS ───

var _loadedMembershipRequests = [];
var _loadedMembers = [];
var _mreqTab = 'new';

function mreqSetTab(tab) {
  _mreqTab = tab;
  var tabs = document.querySelectorAll('.esched-tab[data-mreqtab]');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].dataset.mreqtab === tab);
  }
  loadMembershipRequests();
}

async function markContacted(id) {
  try {
    await apiPost({ action: 'update_membership', id: id, status: 'contacted' });
    showToast('Marked as contacted', 'success');
    loadMembershipRequests();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function markNew(id) {
  try {
    await apiPost({ action: 'update_membership', id: id, status: 'new' });
    showToast('Moved back to New', 'success');
    loadMembershipRequests();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

var _notesEntityType = 'enquiry'; // 'enquiry' or 'member'

// Encode/decode a follow-up date inside the notes field as a [FU:YYYY-MM-DD] prefix.
// Lets us add follow-ups without needing a follow_up_at column on the DB.
function parseNotes(notesRaw) {
  if (!notesRaw) return { date: null, text: '' };
  var m = String(notesRaw).match(/^\[FU:(\d{4}-\d{2}-\d{2})\]\s*\n?\s*/);
  if (m) return { date: m[1], text: notesRaw.substring(m[0].length) };
  return { date: null, text: notesRaw };
}
function buildNotes(date, text) {
  var t = text || '';
  return date ? '[FU:' + date + ']\n' + t : t;
}

function openNotesModal(id, type) {
  _notesEntityType = type === 'member' ? 'member' : 'enquiry';
  var record;
  if (_notesEntityType === 'member') {
    record = (_loadedMembers || []).find(function(r) { return r.id === id; }) || {};
  } else {
    record = (_loadedMembershipRequests || []).find(function(r) { return r.id === id; }) || {};
  }
  var parsed = parseNotes(record.notes);
  document.getElementById('mreq-notes-id').value = id;
  document.getElementById('mreq-notes-name').textContent = record.name || (_notesEntityType === 'member' ? 'member' : 'enquiry');
  document.getElementById('mreq-notes-text').value = parsed.text;
  document.getElementById('mreq-notes-followup').value = parsed.date || '';
  document.getElementById('mreq-notes-modal').classList.add('open');
  setTimeout(function() { document.getElementById('mreq-notes-text').focus(); }, 100);
}

function closeNotesModal() {
  document.getElementById('mreq-notes-modal').classList.remove('open');
}

async function saveNotes() {
  var id = document.getElementById('mreq-notes-id').value;
  var notes = document.getElementById('mreq-notes-text').value;
  var followUp = document.getElementById('mreq-notes-followup').value || null;
  var combined = buildNotes(followUp, notes);
  try {
    if (_notesEntityType === 'member') {
      await apiPost({ action: 'update_member', member_id: id, notes: combined });
      showToast('Saved', 'success');
      closeNotesModal();
      loadMemberList();
    } else {
      await apiPost({ action: 'update_membership', id: id, notes: combined });
      showToast('Saved', 'success');
      closeNotesModal();
      loadMembershipRequests();
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function loadMembershipRequests() {
  var loading = document.getElementById('mreq-loading');
  var content = document.getElementById('mreq-content');
  loading.style.display = 'block';
  content.style.display = 'none';

  try {
    var resp = await apiGet({ action: 'memberships' });
    var allMembers = resp.data || [];

    var newOnes = allMembers.filter(function(m) { return (m.status || 'new').toLowerCase() === 'new'; });
    var contactedOnes = allMembers.filter(function(m) { return (m.status || '').toLowerCase() === 'contacted'; });

    // Update tab count badges
    var newCountEl = document.getElementById('mreq-tab-new-count');
    var contactedCountEl = document.getElementById('mreq-tab-contacted-count');
    if (newCountEl) newCountEl.textContent = newOnes.length ? newOnes.length : '';
    if (contactedCountEl) contactedCountEl.textContent = contactedOnes.length ? contactedOnes.length : '';

    var members = (_mreqTab === 'contacted') ? contactedOnes : newOnes;
    _loadedMembershipRequests = members;

    // Update sidebar nav badge with unread (new) count
    var badge = document.getElementById('mreq-badge');
    if (newOnes.length > 0) { badge.textContent = newOnes.length; badge.style.display = 'inline'; }
    else { badge.style.display = 'none'; }

    content.innerHTML = renderMembershipRequestColumns(members);
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load requests. ' + esc(err.message) + '</div>';
  }
}

async function deleteMembershipRequest(id) {
  if (!confirm('Delete this request?')) return;
  try {
    await apiPost({ action: 'delete_membership_request', membership_id: id });
    showToast('Request deleted', 'success');
    loadMembershipRequests();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ─── ENQUIRY SCHEDULE (day × time grid) ───

var _loadedEnquiries = [];
var _loadedMembersForGrid = [];
var _selectedSlotKey = null;
var _eschedMode = 'enquiries';

function eschedSetMode(mode) {
  _eschedMode = mode;
  _selectedSlotKey = null;
  // Toggle active tab
  var tabs = document.querySelectorAll('.esched-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].dataset.mode === mode);
  }
  // Show filter only in enquiries mode
  var fw = document.getElementById('esched-filter-wrap');
  if (fw) fw.style.display = (mode === 'enquiries') ? 'flex' : 'none';
  loadEnquirySchedule();
}

var ESCHED_DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','any'];
var ESCHED_DAY_LABELS = { Mon:'Mon', Tue:'Tue', Wed:'Wed', Thu:'Thu', Fri:'Fri', Sat:'Sat', any:'Any Day' };
var ESCHED_DAY_FULL = { Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday', Fri:'Friday', Sat:'Saturday', any:'Any Day' };
// Canonical time slots offered by the public wizard (keep in sync with src/js/index.js morningSlots/afternoonSlots).
var ESCHED_CANONICAL_TIMES = ['5:15 AM','6:15 AM','7:15 AM','8:15 AM','9:15 AM','10:15 AM','11:15 AM','12:15 PM','4:15 PM','5:15 PM','6:15 PM'];

function parseEnquiryDays(s) {
  if (!s) return ['any'];
  var trimmed = String(s).trim();
  if (!trimmed || trimmed.toLowerCase() === 'not specified') return ['any'];
  var MAP = {
    mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun',
    monday:'Mon', tuesday:'Tue', wednesday:'Wed', thursday:'Thu', friday:'Fri', saturday:'Sat', sunday:'Sun'
  };
  var out = [];
  trimmed.split(/[,;/]+/).forEach(function(part) {
    var k = part.trim().toLowerCase();
    if (MAP[k] && out.indexOf(MAP[k]) < 0) out.push(MAP[k]);
  });
  return out.length ? out : ['any'];
}

function parseEnquiryTimes(s) {
  if (!s) return ['any'];
  var trimmed = String(s).trim();
  if (!trimmed || trimmed.toLowerCase() === 'not specified') return ['any'];
  var out = [];
  function push(v) { if (out.indexOf(v) < 0) out.push(v); }
  trimmed.split(/[,;/]+/).forEach(function(part) {
    var p = part.trim();
    if (!p) return;
    var lower = p.toLowerCase();
    if (lower === 'afternoon' || lower.indexOf('afternoon') >= 0) return push('Afternoon');
    if (lower === 'evening' || lower === 'night') return push('Afternoon');
    if (lower === 'morning') return push('any'); // unspecified morning → Any Time row
    var m = p.match(/(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)/);
    if (m) {
      var hr = parseInt(m[1], 10);
      var mn = m[2];
      var ampm = m[3].toUpperCase();
      return push(hr + ':' + mn + ' ' + ampm);
    }
    push('any');
  });
  return out.length ? out : ['any'];
}

function eschedTimeToMinutes(t) {
  if (t === 'any') return 99999;
  if (t === 'Afternoon') return 13 * 60; // group after morning slots
  var m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return 99998;
  var h = parseInt(m[1], 10);
  var mn = parseInt(m[2], 10);
  var ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + mn;
}

function computeEschedTimeRows(enquiries) {
  var seen = {};
  ESCHED_CANONICAL_TIMES.forEach(function(t) { seen[t] = true; });
  enquiries.forEach(function(m) {
    parseEnquiryTimes(m.times).forEach(function(t) {
      if (t !== 'any') seen[t] = true;
    });
  });
  var rows = Object.keys(seen);
  rows.sort(function(a, b) { return eschedTimeToMinutes(a) - eschedTimeToMinutes(b); });
  rows.push('any');
  return rows;
}

function eschedTimeLabel(t) { return t === 'any' ? 'Any Time' : t; }

async function loadEnquirySchedule() {
  var loading = document.getElementById('esched-loading');
  var content = document.getElementById('esched-content');
  var empty = document.getElementById('esched-empty');
  loading.textContent = _eschedMode === 'members' ? 'Loading members...' : 'Loading enquiries...';
  loading.style.display = 'block';
  content.style.display = 'none';
  empty.style.display = 'none';

  try {
    if (_eschedMode === 'members') {
      var mresp = await apiGet({ action: 'members' });
      var all = mresp.members || [];
      var active = all.filter(function(m) { return (m.status || 'active').toLowerCase() === 'active'; });
      _loadedMembersForGrid = active;
      _selectedSlotKey = null;

      loading.style.display = 'none';
      if (all.length === 0) {
        empty.textContent = 'No accepted members yet. Accept an enquiry and assign their weekly slots to see them here.';
        empty.style.display = 'block';
        return;
      }
      content.style.display = 'block';
      renderEnquiryGrid();
      document.getElementById('esched-detail').innerHTML = '';

      var slotted = active.filter(function(m) { return m.slots && m.slots.length > 0; });
      var unslotted = active.length - slotted.length;
      var hint = active.length === 0
        ? 'No active members.'
        : 'Showing ' + slotted.length + ' slotted member' + (slotted.length === 1 ? '' : 's') +
          (unslotted > 0 ? ' · ' + unslotted + ' active member' + (unslotted === 1 ? '' : 's') + ' without assigned slots yet' : '') +
          '. Tap a slot to see who’s in it.';
      document.getElementById('esched-hint').textContent = hint;
      return;
    }

    // Enquiries mode (default)
    var resp = await apiGet({ action: 'memberships' });
    var all = resp.data || [];

    var filterEl = document.getElementById('esched-filter');
    var filter = filterEl ? filterEl.value : 'new';
    var filtered = all.filter(function(m) {
      var s = (m.status || 'new').toLowerCase();
      if (filter === 'new') return s === 'new';
      if (filter === 'open') return s === 'new' || s === 'contacted';
      return true;
    });

    _loadedEnquiries = filtered;
    _selectedSlotKey = null;

    loading.style.display = 'none';
    if (all.length === 0) {
      empty.textContent = 'No enquiries yet. When new membership requests come in, you’ll see them grouped here by preferred day and time.';
      empty.style.display = 'block';
      return;
    }

    content.style.display = 'block';
    renderEnquiryGrid();
    document.getElementById('esched-detail').innerHTML = '';

    var enqHint = filtered.length === 0
      ? 'No enquiries match this filter.'
      : 'Showing ' + filtered.length + ' enquir' + (filtered.length === 1 ? 'y' : 'ies') + '. Tap a slot to see who wants it.';
    document.getElementById('esched-hint').textContent = enqHint;
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load. ' + esc(err.message) + '</div>';
  }
}

var DAY_ABBR = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

function eschedBuildBuckets() {
  var buckets = {};
  function push(key, item) { (buckets[key] = buckets[key] || []).push(item); }

  if (_eschedMode === 'members') {
    _loadedMembersForGrid.forEach(function(m) {
      (m.slots || []).forEach(function(s) {
        var dayKey = DAY_ABBR[s.day_of_week] || 'any';
        var timeKey = s.time || 'any';
        push(dayKey + '|' + timeKey, m);
      });
    });
  } else {
    _loadedEnquiries.forEach(function(m) {
      var days = parseEnquiryDays(m.days);
      var times = parseEnquiryTimes(m.times);
      days.forEach(function(d) {
        times.forEach(function(t) {
          push(d + '|' + t, m);
        });
      });
    });
  }
  return buckets;
}

function eschedComputeTimes() {
  if (_eschedMode === 'members') {
    // Derive from actual slot times in use
    var seen = {};
    ESCHED_CANONICAL_TIMES.forEach(function(t) { seen[t] = true; });
    _loadedMembersForGrid.forEach(function(m) {
      (m.slots || []).forEach(function(s) { if (s.time) seen[s.time] = true; });
    });
    var rows = Object.keys(seen);
    rows.sort(function(a, b) { return eschedTimeToMinutes(a) - eschedTimeToMinutes(b); });
    return rows; // no 'any' row in members mode (members are always on specific slots)
  }
  return computeEschedTimeRows(_loadedEnquiries);
}

function eschedComputeDays() {
  if (_eschedMode === 'members') {
    return ['Mon','Tue','Wed','Thu','Fri','Sat']; // no 'any' column in members mode
  }
  return ESCHED_DAYS;
}

function renderEnquiryGrid() {
  var buckets = eschedBuildBuckets();
  var days = eschedComputeDays();
  var times = eschedComputeTimes();

  var html = '<table class="esched-grid"><thead><tr><th></th>';
  days.forEach(function(d) {
    var cls = d === 'any' ? 'esched-th-any' : '';
    html += '<th class="' + cls + '">' + (ESCHED_DAY_LABELS[d] || d) + '</th>';
  });
  html += '</tr></thead><tbody>';

  times.forEach(function(t) {
    html += '<tr><th class="esched-row-th' + (t === 'any' ? ' esched-th-any' : '') + '">' + esc(eschedTimeLabel(t)) + '</th>';
    days.forEach(function(d) {
      var key = d + '|' + t;
      var items = buckets[key] || [];
      var count = items.length;
      var cls = 'esched-cell';
      if (count > 0) cls += ' has-count';
      if (_selectedSlotKey === key) cls += ' selected';
      if (d === 'any' || t === 'any') cls += ' esched-cell-any';
      var handler = count > 0 ? ' onclick="eschedShow(\'' + key.replace(/'/g, "\\'") + '\')"' : '';

      var cellInner;
      if (count === 0) {
        cellInner = '<span class="esched-dash">—</span>';
      } else if (_eschedMode === 'members') {
        cls += ' has-names';
        cellInner = '<div class="esched-names">' + items.map(function(m) {
          var first = (m.name || '').split(' ')[0] || '?';
          return '<span class="esched-name">' + esc(first) + '</span>';
        }).join('') + '</div>' +
        '<span class="esched-count-mini">' + count + '/4</span>';
      } else {
        cellInner = '<span class="esched-count">' + count + '</span>';
      }
      html += '<td class="' + cls + '"' + handler + '>' + cellInner + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('esched-grid-wrap').innerHTML = html;
}

function eschedShow(key) {
  _selectedSlotKey = key;
  renderEnquiryGrid();

  var parts = key.split('|');
  var dayKey = parts[0], timeKey = parts[1];
  var title = (ESCHED_DAY_FULL[dayKey] || dayKey) + ' · ' + eschedTimeLabel(timeKey);

  var html, matches;
  if (_eschedMode === 'members') {
    matches = _loadedMembersForGrid.filter(function(m) {
      return (m.slots || []).some(function(s) {
        return (DAY_ABBR[s.day_of_week] === dayKey) && s.time === timeKey;
      });
    });
    var countLabel = matches.length + ' member' + (matches.length === 1 ? '' : 's');
    html = '<div class="esched-detail-card">' +
      '<div class="esched-detail-head">' +
        '<h3 class="esched-detail-title"><em>' + esc(title) + '</em> <span>— ' + countLabel + '</span></h3>' +
        '<button class="btn-outline" onclick="eschedClose()">Close</button>' +
      '</div>' +
      renderMemberListCards(matches) +
    '</div>';
  } else {
    matches = _loadedEnquiries.filter(function(m) {
      var days = parseEnquiryDays(m.days);
      var times = parseEnquiryTimes(m.times);
      return days.indexOf(dayKey) >= 0 && times.indexOf(timeKey) >= 0;
    });
    var enqCount = matches.length + ' enquir' + (matches.length === 1 ? 'y' : 'ies');
    html = '<div class="esched-detail-card">' +
      '<div class="esched-detail-head">' +
        '<h3 class="esched-detail-title"><em>' + esc(title) + '</em> <span>— ' + enqCount + '</span></h3>' +
        '<button class="btn-outline" onclick="eschedClose()">Close</button>' +
      '</div>' +
      renderMembershipRequestCards(matches) +
    '</div>';
  }
  document.getElementById('esched-detail').innerHTML = html;

  var detail = document.getElementById('esched-detail');
  if (detail && detail.scrollIntoView) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function eschedClose() {
  _selectedSlotKey = null;
  renderEnquiryGrid();
  document.getElementById('esched-detail').innerHTML = '';
}

function openAcceptModal(membershipId) {
  var m = _loadedMembershipRequests.find(function(r) { return r.id === membershipId; }) || {};
  document.getElementById('accept-membership-id').value = membershipId;
  document.getElementById('accept-name').value = m.name || '';
  document.getElementById('accept-email').value = m.email || '';
  document.getElementById('accept-phone').value = m.phone || '';
  document.getElementById('accept-plan').value = m.plan || '';
  document.getElementById('accept-sessions').value = m.sessions || m.sessions_per_week || 1;

  // Render their preferences
  var prefBlock = document.getElementById('accept-pref-block');
  var prefText = document.getElementById('accept-prefs');
  var parts = [];
  if (m.days && m.days !== 'Not specified') parts.push(esc(m.days));
  if (m.times && m.times !== 'Not specified') parts.push(esc(m.times));
  if (m.sessions && m.sessions !== 'Not specified') parts.push(esc(m.sessions) + 'x per week');
  if (parts.length) {
    prefText.innerHTML = parts.join(' &middot; ');
    prefBlock.style.display = 'block';
  } else {
    prefText.textContent = 'They didn’t specify preferred times.';
    prefBlock.style.display = 'block';
  }

  // Load slot picker
  _acceptCheckedSlots = {};
  loadAcceptSlots(m);

  document.getElementById('accept-submit-btn').textContent = 'Accept Member';
  document.getElementById('accept-modal').classList.add('open');
}

function closeAcceptModal() {
  document.getElementById('accept-modal').classList.remove('open');
}

var _acceptCheckedSlots = {};
var _acceptSlotsCache = [];

async function loadAcceptSlots(enquiry) {
  var loading = document.getElementById('accept-slots-loading');
  var empty = document.getElementById('accept-slots-empty');
  var grid = document.getElementById('accept-slots-grid');
  loading.style.display = 'block';
  empty.style.display = 'none';
  grid.style.display = 'none';
  grid.innerHTML = '';

  try {
    var resp = await apiGet({ action: 'schedule' });
    var byDay = {};
    for (var d = 0; d < 6; d++) byDay[d] = [];
    if (resp.schedule && typeof resp.schedule === 'object' && !Array.isArray(resp.schedule)) {
      for (var key in resp.schedule) {
        var di = parseInt(key, 10);
        if (di >= 0 && di <= 5) byDay[di] = resp.schedule[key] || [];
      }
    }

    // Flatten + cache
    var all = [];
    for (var dd = 0; dd < 6; dd++) { (byDay[dd] || []).forEach(function(s) { all.push(s); }); }
    _acceptSlotsCache = all;

    if (all.length === 0) {
      loading.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    // Parse preferences to highlight matches
    var prefDays = parseEnquiryDays(enquiry.days);      // ['Mon','Wed'] or ['any']
    var prefTimes = parseEnquiryTimes(enquiry.times);   // ['6:15 AM'] or ['any']

    var DAY_FULL = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var DAY_ABBR_LOCAL = ['Mon','Tue','Wed','Thu','Fri','Sat'];

    var html = '';
    for (var d2 = 0; d2 < 6; d2++) {
      var daySlots = byDay[d2] || [];
      if (daySlots.length === 0) continue;
      var dayMatches = prefDays.indexOf('any') >= 0 || prefDays.indexOf(DAY_ABBR_LOCAL[d2]) >= 0;
      html += '<div class="accept-day-col"><h4 class="accept-day-head' + (dayMatches ? ' matched' : '') + '">' + DAY_FULL[d2] + '</h4>';
      daySlots.forEach(function(s) {
        var count = (s.members || []).length;
        var max = s.max_capacity || 4;
        var isFull = count >= max;
        var timeMatches = prefTimes.indexOf('any') >= 0 || prefTimes.indexOf(s.time) >= 0;
        var matched = dayMatches && timeMatches;
        var cls = 'accept-slot-pill' + (matched ? ' matched' : '') + (isFull ? ' full' : '');
        var disabled = isFull ? ' disabled' : '';
        var checked = _acceptCheckedSlots[s.id] ? ' checked' : '';
        html += '<label class="' + cls + '">' +
          '<input type="checkbox" value="' + esc(s.id) + '"' + checked + disabled + ' onchange="eschedAcceptToggle(this)">' +
          '<span class="accept-slot-time">' + esc(s.time) + '</span>' +
          '<span class="accept-slot-cap">' + count + '/' + max + (isFull ? ' · full' : '') + '</span>' +
        '</label>';
      });
      html += '</div>';
    }

    grid.innerHTML = html;
    loading.style.display = 'none';
    grid.style.display = 'grid';
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load slots. ' + esc(err.message) + '</div>';
  }
}

function eschedAcceptToggle(el) {
  if (el.checked) _acceptCheckedSlots[el.value] = true;
  else delete _acceptCheckedSlots[el.value];

  var tickedCount = Object.keys(_acceptCheckedSlots).length;
  var btn = document.getElementById('accept-submit-btn');
  btn.textContent = tickedCount > 0
    ? 'Accept & Assign ' + tickedCount + ' Slot' + (tickedCount === 1 ? '' : 's')
    : 'Accept Member';
}

async function acceptMembership() {
  var membershipId = document.getElementById('accept-membership-id').value;
  var name = document.getElementById('accept-name').value.trim();
  var email = document.getElementById('accept-email').value.trim();
  if (!name || !email) { showToast('Name and email are required', 'error'); return; }

  var slotIds = Object.keys(_acceptCheckedSlots);

  try {
    var resp = await apiPost({
      action: 'accept_membership',
      membership_id: membershipId,
      name: name,
      email: email,
      phone: document.getElementById('accept-phone').value.trim(),
      plan: document.getElementById('accept-plan').value.trim(),
      sessions_per_week: parseInt(document.getElementById('accept-sessions').value) || 1,
      slot_ids: slotIds
    });

    var assigned = (resp && resp.assigned_slots) ? resp.assigned_slots.length : 0;
    var errs = (resp && resp.slot_errors) ? resp.slot_errors : [];
    var msg = 'Member created' + (assigned > 0 ? ' · ' + assigned + ' slot' + (assigned === 1 ? '' : 's') + ' assigned' : '');
    if (errs.length) {
      var fullCount = errs.filter(function(e) { return e.error === 'full'; }).length;
      if (fullCount > 0) msg += ' (' + fullCount + ' slot' + (fullCount === 1 ? '' : 's') + ' were full — skipped)';
    }
    showToast(msg, errs.length ? 'error' : 'success');
    closeAcceptModal();
    loadMembershipRequests();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ─── MEMBER LIST ───

async function loadMemberList() {
  var loading = document.getElementById('mlist-loading');
  var content = document.getElementById('mlist-content');
  loading.style.display = 'block';
  content.style.display = 'none';

  try {
    var resp = await apiGet({ action: 'members' });
    var members = resp.data || resp.members || [];

    _loadedMembers = members;
    content.innerHTML = renderMemberListCards(members);
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load members. ' + esc(err.message) + '</div>';
  }
}

async function deleteMember(id) {
  if (!confirm('Delete this member?')) return;
  try {
    await apiPost({ action: 'delete_member', member_id: id });
    showToast('Member deleted', 'success');
    loadMemberList();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function openEditMemberModal(id) {
  var m = _loadedMembers.find(function(x) { return x.id === id; }) || {};
  document.getElementById('editmember-id').value = id;
  document.getElementById('editmember-name').value = m.name || '';
  document.getElementById('editmember-email').value = m.email || '';
  document.getElementById('editmember-phone').value = m.phone || '';
  document.getElementById('editmember-plan').value = m.plan || '';
  document.getElementById('editmember-sessions').value = m.sessions_per_week || 1;
  document.getElementById('editmember-status').value = m.status || 'active';
  document.getElementById('editmember-modal').classList.add('open');
}

function closeEditMemberModal() {
  document.getElementById('editmember-modal').classList.remove('open');
}

async function saveEditMember() {
  var id = document.getElementById('editmember-id').value;
  var name = document.getElementById('editmember-name').value.trim();
  var email = document.getElementById('editmember-email').value.trim();
  if (!name || !email) { showToast('Name and email are required', 'error'); return; }

  try {
    await apiPost({
      action: 'update_member',
      member_id: id,
      name: name,
      email: email,
      phone: document.getElementById('editmember-phone').value.trim() || null,
      plan: document.getElementById('editmember-plan').value.trim(),
      sessions_per_week: parseInt(document.getElementById('editmember-sessions').value) || 1,
      status: document.getElementById('editmember-status').value
    });
    showToast('Member updated', 'success');
    closeEditMemberModal();
    loadMemberList();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function openAddMemberModal() {
  document.getElementById('addmember-name').value = '';
  document.getElementById('addmember-email').value = '';
  document.getElementById('addmember-phone').value = '';
  document.getElementById('addmember-plan').value = '';
  document.getElementById('addmember-sessions').value = 3;
  document.getElementById('addmember-modal').classList.add('open');
}

function closeAddMemberModal() {
  document.getElementById('addmember-modal').classList.remove('open');
}

async function createMemberManual() {
  var name = document.getElementById('addmember-name').value.trim();
  var email = document.getElementById('addmember-email').value.trim();
  if (!name || !email) { showToast('Name and email are required', 'error'); return; }

  try {
    await apiPost({
      action: 'create_member',
      name: name,
      email: email,
      phone: document.getElementById('addmember-phone').value.trim(),
      plan: document.getElementById('addmember-plan').value.trim(),
      sessions_per_week: parseInt(document.getElementById('addmember-sessions').value) || 3
    });
    showToast('Member created', 'success');
    closeAddMemberModal();
    loadMemberList();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ─── ASSIGN SLOT MODAL ───

function openAssignModal(memberId, memberName) {
  document.getElementById('assign-member-id').value = memberId;
  document.getElementById('assign-member-name').textContent = memberName;
  document.getElementById('assign-slots-loading').style.display = 'block';
  document.getElementById('assign-slots-content').style.display = 'none';
  document.getElementById('assign-modal').classList.add('open');
  loadSlotsForAssign(memberId);
}

function closeAssignModal() {
  document.getElementById('assign-modal').classList.remove('open');
}

async function loadSlotsForAssign(memberId) {
  var loading = document.getElementById('assign-slots-loading');
  var content = document.getElementById('assign-slots-content');

  try {
    var resp = await apiGet({ action: 'schedule' });
    var dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    // API returns { schedule: { "0": [...], "1": [...] } } keyed by day_of_week
    var byDay = {};
    for (var d = 0; d < 6; d++) byDay[d] = [];
    if (resp.schedule && typeof resp.schedule === 'object' && !Array.isArray(resp.schedule)) {
      for (var key in resp.schedule) {
        var dayIdx = parseInt(key, 10);
        if (dayIdx >= 0 && dayIdx <= 5) byDay[dayIdx] = resp.schedule[key] || [];
      }
    } else {
      var slots = resp.data || resp.slots || [];
      slots.forEach(function(s) {
        var day = s.day_of_week;
        if (day >= 0 && day <= 5) byDay[day].push(s);
      });
    }

    var html = '<div class="assign-day-grid">';
    dayNames.forEach(function(dayName, idx) {
      var daySlots = byDay[idx] || [];
      if (daySlots.length === 0) return;
      html += '<div class="assign-day-col"><h4>' + dayName + '</h4>';
      daySlots.forEach(function(s) {
        var memberIds = (s.members || []).map(function(m) { return m.id || m.member_id; });
        var isAssigned = memberIds.indexOf(memberId) !== -1;
        var count = (s.members || []).length;
        var max = s.max_capacity || 4;
        var isFull = count >= max && !isAssigned;
        var cls = 'assign-slot-item' + (isAssigned ? ' assigned' : '') + (isFull ? ' slot-full' : '');
        html += '<div class="' + cls + '">' +
          '<span>' + esc(s.time || '') + ' <span style="font-size:11px;color:var(--bark);">(' + count + '/' + max + ')</span></span>';
        if (isAssigned) {
          html += '<button class="btn-outline btn-sm btn-danger" onclick="unassignSlot(\'' + esc(memberId) + '\',\'' + esc(s.id) + '\')">Remove</button>';
        } else if (!isFull) {
          html += '<button class="btn-outline btn-sm" onclick="assignSlot(\'' + esc(memberId) + '\',\'' + esc(s.id) + '\')">Assign</button>';
        } else {
          html += '<span style="font-size:10px;color:var(--bark);text-transform:uppercase;letter-spacing:0.1em;">Full</span>';
        }
        html += '</div>';
      });
      html += '</div>';
    });
    html += '</div>';

    content.innerHTML = html;
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load slots. ' + esc(err.message) + '</div>';
  }
}

async function assignSlot(memberId, slotId) {
  try {
    await apiPost({ action: 'assign_slot', member_id: memberId, slot_id: slotId });
    showToast('Slot assigned', 'success');
    loadSlotsForAssign(memberId);
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function unassignSlot(memberId, slotId) {
  try {
    await apiPost({ action: 'unassign_slot', member_id: memberId, slot_id: slotId });
    showToast('Slot removed', 'success');
    loadSlotsForAssign(memberId);
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ─── CALENDAR ───

var calView = 'week';
var calCurrentDate = new Date();
var calScheduleData = {};
var calUseDemo = false;

var CAL_DEMO_DATA = {
  '0': [
    { id:'d1', time:'5:15 AM', max_capacity:4, members:[
      { id:'dm1', name:'Sarah Chen', email:'sarah@example.com', phone:'0412 345 678', plan:'VIP' },
      { id:'dm2', name:'Marcus Webb', email:'marcus@example.com', phone:'0423 456 789', plan:'Signature' }
    ]},
    { id:'d2', time:'6:15 AM', max_capacity:4, members:[
      { id:'dm3', name:'Olivia Hart', email:'olivia@example.com', phone:'0434 567 890', plan:'Signature' },
      { id:'dm4', name:'Tom Richards', email:'tom@example.com', phone:'0445 678 901', plan:'Flexible' },
      { id:'dm5', name:'Emma Blake', email:'emma@example.com', phone:'0456 789 012', plan:'Signature' }
    ]},
    { id:'d3', time:'7:15 AM', max_capacity:4, members:[] }
  ],
  '1': [
    { id:'d4', time:'5:15 AM', max_capacity:4, members:[
      { id:'dm6', name:'James Patel', email:'james@example.com', phone:'0467 890 123', plan:'VIP' }
    ]},
    { id:'d5', time:'6:15 AM', max_capacity:4, members:[] }
  ],
  '2': [
    { id:'d6', time:'5:15 AM', max_capacity:4, members:[
      { id:'dm1', name:'Sarah Chen', email:'sarah@example.com', phone:'0412 345 678', plan:'VIP' },
      { id:'dm3', name:'Olivia Hart', email:'olivia@example.com', phone:'0434 567 890', plan:'Signature' },
      { id:'dm7', name:'Lisa Murray', email:'lisa@example.com', phone:'0478 901 234', plan:'Signature' },
      { id:'dm8', name:'Kate Wong', email:'kate@example.com', phone:'0489 012 345', plan:'Flexible' }
    ]}
  ],
  '3': [
    { id:'d7', time:'6:15 AM', max_capacity:4, members:[
      { id:'dm2', name:'Marcus Webb', email:'marcus@example.com', phone:'0423 456 789', plan:'Signature' },
      { id:'dm4', name:'Tom Richards', email:'tom@example.com', phone:'0445 678 901', plan:'Flexible' }
    ]}
  ],
  '4': [
    { id:'d8', time:'5:15 AM', max_capacity:4, members:[
      { id:'dm5', name:'Emma Blake', email:'emma@example.com', phone:'0456 789 012', plan:'Signature' },
      { id:'dm6', name:'James Patel', email:'james@example.com', phone:'0467 890 123', plan:'VIP' }
    ]}
  ],
  '5': []
};

function calGetDayNames() { return ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']; }
function calGetDayNamesShort() { return ['Mon','Tue','Wed','Thu','Fri','Sat']; }
var CAL_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function calGetMonday(d) {
  var dt = new Date(d);
  var day = dt.getDay();
  var diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  dt.setHours(0,0,0,0);
  return dt;
}

function calFormatShortDate(d) {
  return d.getDate() + ' ' + CAL_MONTH_NAMES[d.getMonth()].slice(0,3);
}

function calPlanBadge(plan) {
  if (!plan) return '';
  var p = plan.toLowerCase();
  var cls = p === 'vip' ? 'plan-vip' : p === 'signature' ? 'plan-signature' : p === 'flexible' ? 'plan-flexible' : '';
  return '<span class="plan-badge ' + cls + '">' + esc(plan) + '</span>';
}

function calSpotsFill(count, max) {
  var pct = max > 0 ? Math.round((count / max) * 100) : 0;
  var cls = pct >= 100 ? 'fill-full' : pct >= 50 ? 'fill-med' : 'fill-low';
  return '<div class="cal-spots-bar"><div class="cal-spots-fill ' + cls + '" style="width:' + pct + '%"></div></div>';
}

function calGetEffectiveData() {
  var data = calScheduleData;
  var hasData = false;
  for (var k in data) {
    if (data[k] && data[k].length > 0) { hasData = true; break; }
  }
  if (!hasData && calUseDemo) return CAL_DEMO_DATA;
  if (calUseDemo) {
    // Merge demo into real - only for days with no real data
    var merged = {};
    for (var d = 0; d < 6; d++) {
      merged[d] = (data[d] && data[d].length > 0) ? data[d] : (CAL_DEMO_DATA[d] || []);
    }
    return merged;
  }
  return data;
}

function calSetView(view) {
  calView = view;
  document.querySelectorAll('.cal-view-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.view === view);
  });
  calRender();
}

function calNav(dir) {
  if (calView === 'day') {
    calCurrentDate.setDate(calCurrentDate.getDate() + dir);
  } else if (calView === 'week') {
    calCurrentDate.setDate(calCurrentDate.getDate() + (dir * 7));
  } else {
    calCurrentDate.setMonth(calCurrentDate.getMonth() + dir);
  }
  calRender();
}

function calGoToday() {
  calCurrentDate = new Date();
  calRender();
}

function calToggleDemo() {
  calUseDemo = document.getElementById('cal-demo-check').checked;
  calRender();
}

// Click empty cell — create a slot there
function calClickEmpty(dayIndex, time) {
  // Pre-fill the add slot modal with this day and time
  document.getElementById('slot-day').value = dayIndex;
  document.getElementById('slot-time').value = time;
  document.getElementById('slot-capacity').value = 4;
  openAddSlotModal();
}

// Click an existing slot — open a manage modal showing members + assign option
function calClickSlot(slotId, dayIndex, time, maxCap) {
  if (!slotId || calUseDemo) return;
  openCalSlotModal(slotId, dayIndex, time, maxCap);
}

var calCurrentSlotId = null;
function openCalSlotModal(slotId, dayIndex, time, maxCap) {
  calCurrentSlotId = slotId;
  var dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var modal = document.getElementById('cal-slot-modal');
  document.getElementById('cal-slot-title').innerHTML = dayNames[dayIndex] + ' <em>' + esc(time) + '</em>';
  modal.classList.add('open');
  loadCalSlotMembers(slotId, maxCap);
}
function closeCalSlotModal() {
  document.getElementById('cal-slot-modal').classList.remove('open');
  calCurrentSlotId = null;
}

async function loadCalSlotMembers(slotId, maxCap) {
  var content = document.getElementById('cal-slot-content');
  content.innerHTML = '<div class="loading">Loading...</div>';
  try {
    // Get all members to show who's assignable
    var membersData = await apiGet({ action: 'members' });
    var allMembers = membersData.members || [];

    // Get current schedule to find who's in this slot
    var schedData = await apiGet({ action: 'schedule' });
    var schedule = schedData.schedule || {};
    var slotMembers = [];
    for (var d in schedule) {
      (schedule[d] || []).forEach(function(s) {
        if (s.id === slotId) slotMembers = s.members || [];
      });
    }

    var assignedIds = slotMembers.map(function(m) { return m.id; });
    var count = slotMembers.length;
    maxCap = maxCap || 4;

    var html = '<div style="margin-bottom:20px;"><strong>' + count + '/' + maxCap + '</strong> booked</div>';

    // Current members
    if (slotMembers.length > 0) {
      html += '<h4 style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:var(--bark);margin-bottom:10px;">Currently Assigned</h4>';
      slotMembers.forEach(function(m) {
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--stone);">';
        html += '<span>' + esc(m.name) + ' ' + calPlanBadge(m.plan) + '</span>';
        html += '<button class="btn-outline btn-sm btn-danger" onclick="calUnassign(\'' + esc(m.id) + '\',\'' + esc(slotId) + '\')">Remove</button>';
        html += '</div>';
      });
    }

    // Available members to add
    var available = allMembers.filter(function(m) { return assignedIds.indexOf(m.id) === -1 && m.status === 'active'; });
    if (available.length > 0 && count < maxCap) {
      html += '<h4 style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:var(--bark);margin:20px 0 10px;">Add Member</h4>';
      available.forEach(function(m) {
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--stone);">';
        html += '<span>' + esc(m.name) + ' ' + calPlanBadge(m.plan) + ' <span style="color:var(--clay);font-size:11px;">' + (m.sessions_per_week || 1) + 'x/wk</span></span>';
        html += '<button class="btn-outline btn-sm" onclick="calAssign(\'' + esc(m.id) + '\',\'' + esc(slotId) + '\')">Assign</button>';
        html += '</div>';
      });
    } else if (count >= maxCap) {
      html += '<p style="color:var(--red);font-size:12px;margin-top:16px;">This slot is full.</p>';
    }

    content.innerHTML = html;
  } catch (err) {
    content.innerHTML = '<div class="empty-state">Error: ' + esc(err.message) + '</div>';
  }
}

async function calAssign(memberId, slotId) {
  try {
    await apiPost({ action: 'assign_slot', member_id: memberId, slot_id: slotId });
    showToast('Member assigned', 'success');
    loadCalSlotMembers(slotId);
    loadCalendar(); // refresh calendar in background
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function calUnassign(memberId, slotId) {
  try {
    await apiPost({ action: 'unassign_slot', member_id: memberId, slot_id: slotId });
    showToast('Member removed', 'success');
    loadCalSlotMembers(slotId);
    loadCalendar();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function calSwitchToDay(dateStr) {
  calCurrentDate = new Date(dateStr);
  calSetView('day');
}

async function loadCalendar() {
  var loading = document.getElementById('cal-loading');
  var content = document.getElementById('cal-content');
  loading.style.display = 'block';
  content.style.display = 'none';

  try {
    var resp = await apiGet({ action: 'schedule' });
    // Support both { schedule: { "0": [...] } } and { data/slots: [...] }
    if (resp.schedule && typeof resp.schedule === 'object' && !Array.isArray(resp.schedule)) {
      calScheduleData = resp.schedule;
    } else {
      var slots = resp.data || resp.slots || [];
      var byDay = {};
      for (var d = 0; d < 6; d++) byDay[d] = [];
      slots.forEach(function(s) {
        var day = s.day_of_week;
        if (day >= 0 && day <= 5) byDay[day].push(s);
      });
      calScheduleData = byDay;
    }
    // Ensure all days exist
    for (var d = 0; d < 6; d++) {
      if (!calScheduleData[d]) calScheduleData[d] = [];
    }

    loading.style.display = 'none';
    content.style.display = 'block';
    calRender();
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load schedule. ' + esc(err.message) + '</div>';
  }
}

function calRender() {
  var container = document.getElementById('cal-render');
  var label = document.getElementById('cal-period-label');

  if (calView === 'week') {
    calRenderWeek(container, label);
  } else if (calView === 'day') {
    calRenderDay(container, label);
  } else {
    calRenderMonth(container, label);
  }
}

function calRenderWeek(container, label) {
  var monday = calGetMonday(calCurrentDate);
  var saturday = new Date(monday);
  saturday.setDate(saturday.getDate() + 5);
  label.textContent = calFormatShortDate(monday) + ' — ' + calFormatShortDate(saturday);

  var data = calGetEffectiveData();
  var dayNamesShort = calGetDayNamesShort();
  var today = new Date();
  today.setHours(0,0,0,0);

  // Collect all unique times across all days, sorted
  var allTimes = {};
  for (var d = 0; d < 6; d++) {
    (data[d] || []).forEach(function(slot) {
      allTimes[slot.time] = calTimeToMinutes(slot.time);
    });
  }
  var sortedTimes = Object.keys(allTimes).sort(function(a, b) {
    return allTimes[a] - allTimes[b];
  });

  if (sortedTimes.length === 0) {
    container.innerHTML = '<div class="empty-state">No time slots this week. Add your first slot to get started.</div>';
    return;
  }

  var html = '<div class="cal-week-grid">';

  // Header row: empty corner + 6 day headers
  html += '<div class="cal-week-header" style="background:var(--sand);"></div>';
  for (var d = 0; d < 6; d++) {
    var dayDate = new Date(monday);
    dayDate.setDate(dayDate.getDate() + d);
    var isToday = dayDate.getTime() === today.getTime();
    html += '<div class="cal-week-header' + (isToday ? ' today-col' : '') + '">';
    html += dayNamesShort[d];
    html += '<div class="cal-week-header-date">' + dayDate.getDate() + '</div>';
    html += '</div>';
  }

  // Time rows
  sortedTimes.forEach(function(time) {
    html += '<div class="cal-time-label">' + esc(time) + '</div>';
    for (var d = 0; d < 6; d++) {
      var slot = calFindSlot(data[d] || [], time);
      if (!slot) {
        html += '<div class="cal-week-cell cell-empty" onclick="calClickEmpty(' + d + ',\'' + esc(time) + '\')" style="cursor:pointer;" title="Add time slot"></div>';
      } else {
        var members = slot.members || [];
        var count = members.length;
        var max = slot.max_capacity || 4;
        var isFull = count >= max;
        var cls = 'cal-week-cell';
        if (isFull) cls += ' cell-full';
        else if (count > 0) cls += ' cell-has-spots';
        else cls += ' cell-empty';

        var slotId = slot.id || '';
        html += '<div class="' + cls + '" onclick="calClickSlot(\'' + esc(slotId) + '\',' + d + ',\'' + esc(time) + '\',' + max + ')" style="cursor:pointer;">';
        if (members.length > 0) {
          html += '<div class="cal-cell-members">';
          members.forEach(function(m) {
            html += '<div class="cal-cell-member" onclick="event.stopPropagation()" title="' + esc(m.email || '') + '">';
            html += esc(m.name || 'Unknown') + ' ' + calPlanBadge(m.plan);
            html += '</div>';
          });
          html += '</div>';
        }
        html += '<div class="cal-cell-spots">' + count + '/' + max + ' ' + calSpotsFill(count, max) + '</div>';
        html += '</div>';
      }
    }
  });

  html += '</div>';
  container.innerHTML = html;
}

function calRenderDay(container, label) {
  var dayOfWeek = calCurrentDate.getDay();
  // Convert JS day (0=Sun) to our index (0=Mon)
  var calDayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  var dayNames = calGetDayNames();

  label.textContent = dayNames[calDayIndex < 6 ? calDayIndex : 0] + ', ' + calCurrentDate.getDate() + ' ' + CAL_MONTH_NAMES[calCurrentDate.getMonth()] + ' ' + calCurrentDate.getFullYear();

  if (calDayIndex >= 6) {
    container.innerHTML = '<div class="empty-state">Sunday — no sessions scheduled.</div>';
    return;
  }

  var data = calGetEffectiveData();
  var daySlots = data[calDayIndex] || [];

  if (daySlots.length === 0) {
    container.innerHTML = '<div class="empty-state">No time slots for this day.</div>';
    return;
  }

  // Sort by time
  daySlots.sort(function(a, b) {
    return calTimeToMinutes(a.time) - calTimeToMinutes(b.time);
  });

  var html = '<div class="cal-day-timeline">';
  daySlots.forEach(function(slot) {
    var members = slot.members || [];
    var count = members.length;
    var max = slot.max_capacity || 4;
    var isFull = count >= max;
    var pct = max > 0 ? Math.round((count / max) * 100) : 0;
    var fillCls = pct >= 100 ? 'fill-full' : pct >= 50 ? 'fill-med' : 'fill-low';
    var cardCls = 'cal-day-card' + (isFull ? ' card-full' : count > 0 ? ' card-has-spots' : '');

    html += '<div class="' + cardCls + '">';
    html += '<div class="cal-day-card-time">' + esc(slot.time) + '</div>';
    html += '<div class="cal-day-card-capacity">';
    html += '<span>' + count + ' / ' + max + ' booked</span>';
    html += '<div class="cal-day-cap-bar"><div class="cal-day-cap-fill ' + fillCls + '" style="width:' + pct + '%"></div></div>';
    html += '</div>';

    if (members.length > 0) {
      html += '<div class="cal-day-members-list">';
      members.forEach(function(m) {
        html += '<div class="cal-day-member-row">';
        html += '<span class="cal-day-member-name">' + esc(m.name || 'Unknown') + '</span>';
        html += ' ' + calPlanBadge(m.plan);
        if (m.email) html += '<span class="cal-day-member-detail">' + esc(m.email) + '</span>';
        if (m.phone) html += '<span class="cal-day-member-detail">' + esc(m.phone) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }

    if (!isFull) {
      html += '<button class="cal-day-add-btn" onclick="openAddSlotModal()">+ Add Member</button>';
    }
    html += '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

function calRenderMonth(container, label) {
  var year = calCurrentDate.getFullYear();
  var month = calCurrentDate.getMonth();
  label.textContent = CAL_MONTH_NAMES[month] + ' ' + year;

  var firstDay = new Date(year, month, 1);
  var lastDay = new Date(year, month + 1, 0);
  // Monday-based: 0=Mon
  var startDow = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1;

  var today = new Date();
  today.setHours(0,0,0,0);

  var data = calGetEffectiveData();

  // Precompute session counts per day-of-week
  var daySummary = {};
  for (var d = 0; d < 6; d++) {
    var slots = data[d] || [];
    var totalSessions = slots.length;
    var totalBookings = 0;
    slots.forEach(function(s) { totalBookings += (s.members || []).length; });
    daySummary[d] = { sessions: totalSessions, bookings: totalBookings };
  }

  var allDayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var html = '<div class="cal-month-grid">';
  allDayNames.forEach(function(n) {
    html += '<div class="cal-month-header">' + n + '</div>';
  });

  // Fill leading blanks
  var prevMonth = new Date(year, month, 0);
  for (var i = startDow - 1; i >= 0; i--) {
    var pd = prevMonth.getDate() - i;
    html += '<div class="cal-month-cell other-month"><div class="cal-month-day-num">' + pd + '</div></div>';
  }

  // Days of month
  for (var day = 1; day <= lastDay.getDate(); day++) {
    var dt = new Date(year, month, day);
    var dow = dt.getDay() === 0 ? 6 : dt.getDay() - 1;
    var isToday = dt.getTime() === today.getTime();
    var info = dow < 6 ? daySummary[dow] : { sessions: 0, bookings: 0 };
    var hasSess = info.sessions > 0;
    var cls = 'cal-month-cell' + (hasSess ? ' has-sessions' : '') + (isToday ? ' today-cell' : '');
    var dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');

    html += '<div class="' + cls + '" onclick="calSwitchToDay(\'' + dateStr + '\')">';
    html += '<div class="cal-month-day-num">' + day + '</div>';
    if (hasSess) {
      html += '<div class="cal-month-info">' + info.sessions + ' session' + (info.sessions > 1 ? 's' : '') + '<br>' + info.bookings + ' booked</div>';
    }
    html += '</div>';
  }

  // Trailing blanks
  var totalCells = startDow + lastDay.getDate();
  var trailing = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (var i = 1; i <= trailing; i++) {
    html += '<div class="cal-month-cell other-month"><div class="cal-month-day-num">' + i + '</div></div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

function calFindSlot(daySlots, time) {
  for (var i = 0; i < daySlots.length; i++) {
    if (daySlots[i].time === time) return daySlots[i];
  }
  return null;
}

function calTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  var match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return 0;
  var h = parseInt(match[1]);
  var m = parseInt(match[2]);
  var ampm = match[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}

function openAddSlotModal() {
  document.getElementById('addslot-day').value = '0';
  document.getElementById('addslot-time').value = '';
  document.getElementById('addslot-capacity').value = 4;
  document.getElementById('addslot-modal').classList.add('open');
}

function closeAddSlotModal() {
  document.getElementById('addslot-modal').classList.remove('open');
}

async function createSlot() {
  var day = parseInt(document.getElementById('addslot-day').value);
  var time = document.getElementById('addslot-time').value.trim();
  var capacity = parseInt(document.getElementById('addslot-capacity').value) || 4;

  if (!time) { showToast('Please enter a time', 'error'); return; }

  try {
    await apiPost({
      action: 'create_slot',
      day_of_week: day,
      time: time,
      max_capacity: capacity
    });
    showToast('Time slot created', 'success');
    closeAddSlotModal();
    loadCalendar();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ─── GENERAL MESSAGES ───

async function loadGeneralMessages() {
  var loading = document.getElementById('gmsg-loading');
  var content = document.getElementById('gmsg-content');
  loading.style.display = 'block';
  content.style.display = 'none';

  try {
    var resp = await apiGet({ action: 'contacts' });
    var messages = resp.data || resp.contacts || [];

    // Update nav badge
    var badge = document.getElementById('gmsg-badge');
    if (badge) { if (messages.length > 0) { badge.textContent = messages.length; badge.style.display = 'inline'; } else { badge.style.display = 'none'; } }

    content.innerHTML = renderMessageCards(messages);
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load messages. ' + esc(err.message) + '</div>';
  }
}

function deleteContact(id) {
  showConfirm('Delete this message?', async function() {
    try {
      await apiPost({ action: 'delete_contact', contact_id: id });
      showToast('Message deleted', 'success');
      loadGeneralMessages();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });
}

// ─── CONTACTS ───
// API: { success: true, data: [...] }
// Each: id, name, email, phone, message, created_at

async function loadContacts() {
  var loading = document.getElementById('contacts-loading');
  var content = document.getElementById('contacts-content');
  loading.style.display = 'block';
  content.style.display = 'none';

  try {
    var resp = await apiGet({ action: 'contacts' });
    var contacts = resp.data || [];

    var tbody = document.getElementById('contacts-tbody');
    if (contacts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No messages yet</td></tr>';
    } else {
      tbody.innerHTML = contacts.map(function(c) {
        return '<tr>' +
          '<td>' + esc(c.name || '') + '</td>' +
          '<td>' + esc(c.email || '') + '</td>' +
          '<td>' + esc(c.phone || '--') + '</td>' +
          '<td title="' + esc(c.message || '') + '">' + esc(truncate(c.message || '', 80)) + '</td>' +
          '<td>' + formatDate(c.created_at) + '</td>' +
        '</tr>';
      }).join('');
    }

    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load messages. ' + esc(err.message) + '</div>';
  }
}

// ─── MODAL CLOSE ON BACKDROP CLICK (ignore drags) ───
var modalMouseDownTarget = null;
document.getElementById('event-modal').addEventListener('mousedown', function(e) {
  modalMouseDownTarget = e.target;
});
document.getElementById('event-modal').addEventListener('mouseup', function(e) {
  if (e.target === this && modalMouseDownTarget === this) closeEventModal();
  modalMouseDownTarget = null;
});
document.getElementById('confirm-dialog').addEventListener('mousedown', function(e) {
  modalMouseDownTarget = e.target;
});
document.getElementById('confirm-dialog').addEventListener('mouseup', function(e) {
  if (e.target === this && modalMouseDownTarget === this) closeConfirm();
  modalMouseDownTarget = null;
});

// ─── NEW MODAL BACKDROP CLOSE ───
['accept-modal','assign-modal','addslot-modal','addmember-modal','editmember-modal','cal-slot-modal','mreq-notes-modal'].forEach(function(id) {
  var el = document.getElementById(id);
  if (!el) return;
  var downTarget = null;
  el.addEventListener('mousedown', function(e) { downTarget = e.target; });
  el.addEventListener('mouseup', function(e) {
    if (e.target === el && downTarget === el) {
      el.classList.remove('open');
    }
    downTarget = null;
  });
});

// ─── KEYBOARD ───
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeEventModal();
    closeConfirm();
    closeAcceptModal();
    closeAssignModal();
    closeAddSlotModal();
    closeAddMemberModal();
    closeEditMemberModal();
    closePlanModal();
    closeTestimonialModal();
  }
});

// ═══════════════════════════════════════════════
// CMS — PLAN CONFIG
// ═══════════════════════════════════════════════

var cachedPlans = [];

async function loadPlanConfig() {
  var loading = document.getElementById('planconfig-loading');
  var content = document.getElementById('planconfig-content');
  loading.style.display = 'block';
  content.style.display = 'none';
  try {
    var data = await apiGet({ action: 'all_plans' });
    cachedPlans = data.plans || [];

    content.innerHTML = renderPlanCards(cachedPlans);
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.textContent = 'Error: ' + err.message;
  }
}

function openPlanModal() {
  document.getElementById('plan-edit-id').value = '';
  document.getElementById('plan-name').value = '';
  document.getElementById('plan-price').value = '';
  document.getElementById('plan-period').value = 'session';
  document.getElementById('plan-badge-text').value = '';
  document.getElementById('plan-badge-style').value = 'pop';
  document.getElementById('plan-description').value = '';
  document.getElementById('plan-features').value = '';
  document.getElementById('plan-order').value = '0';
  document.getElementById('plan-status').value = 'active';
  document.getElementById('plan-modal-title').innerHTML = 'Add <em>Plan</em>';
  document.getElementById('plan-save-btn').textContent = 'Create Plan';
  document.getElementById('plan-modal').classList.add('open');
}

function closePlanModal() {
  document.getElementById('plan-modal').classList.remove('open');
}

function editPlan(id) {
  var plan = cachedPlans.find(function(p) { return p.id === id; });
  if (!plan) return;
  document.getElementById('plan-edit-id').value = plan.id;
  document.getElementById('plan-name').value = plan.name || '';
  document.getElementById('plan-price').value = plan.price_cents ? (plan.price_cents / 100).toFixed(0) : '';
  document.getElementById('plan-period').value = plan.period_label || 'session';
  document.getElementById('plan-badge-text').value = plan.badge_text || '';
  document.getElementById('plan-badge-style').value = plan.badge_style || 'pop';
  document.getElementById('plan-description').value = plan.description || '';
  document.getElementById('plan-features').value = (plan.features || []).join('\n');
  document.getElementById('plan-order').value = plan.display_order || 0;
  document.getElementById('plan-status').value = plan.status || 'active';
  document.getElementById('plan-modal-title').innerHTML = 'Edit <em>Plan</em>';
  document.getElementById('plan-save-btn').textContent = 'Save Changes';
  document.getElementById('plan-modal').classList.add('open');
}

async function savePlan() {
  var editId = document.getElementById('plan-edit-id').value;
  var priceDollars = parseFloat(document.getElementById('plan-price').value);
  var featuresRaw = document.getElementById('plan-features').value;
  var features = featuresRaw.split('\n').map(function(f) { return f.trim(); }).filter(function(f) { return f; });

  var payload = {
    name: document.getElementById('plan-name').value.trim(),
    price_cents: Math.round(priceDollars * 100),
    period_label: document.getElementById('plan-period').value.trim() || 'session',
    badge_text: document.getElementById('plan-badge-text').value.trim() || null,
    badge_style: document.getElementById('plan-badge-style').value,
    description: document.getElementById('plan-description').value.trim() || null,
    features: features,
    display_order: parseInt(document.getElementById('plan-order').value) || 0,
    status: document.getElementById('plan-status').value,
  };

  if (!payload.name || isNaN(payload.price_cents)) {
    showToast('Name and price are required', 'error');
    return;
  }

  try {
    if (editId) {
      payload.action = 'update_plan';
      payload.plan_id = editId;
    } else {
      payload.action = 'create_plan';
    }
    await apiPost(payload);
    closePlanModal();
    showToast(editId ? 'Plan updated' : 'Plan created', 'success');
    loadPlanConfig();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function deletePlan(id, name) {
  showConfirm('Delete plan "' + name + '"?', async function() {
    try {
      await apiPost({ action: 'delete_plan', plan_id: id });
      showToast('Plan deleted', 'success');
      loadPlanConfig();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });
}

// ═══════════════════════════════════════════════
// CMS — BOOKING LINKS
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// CMS — TESTIMONIALS
// ═══════════════════════════════════════════════

var cachedTestimonials = [];

async function loadTestimonials() {
  var loading = document.getElementById('testimonials-loading');
  var content = document.getElementById('testimonials-content');
  loading.style.display = 'block';
  content.style.display = 'none';
  try {
    var data = await apiGet({ action: 'all_testimonials' });
    cachedTestimonials = data.testimonials || [];

    content.innerHTML = renderTestimonialCards(cachedTestimonials);
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.textContent = 'Error: ' + err.message;
  }
}

function openTestimonialModal() {
  document.getElementById('testimonial-edit-id').value = '';
  document.getElementById('testimonial-quote').value = '';
  document.getElementById('testimonial-attribution').value = 'Client Testimonial · Toowoomba';
  document.getElementById('testimonial-page').value = 'home';
  document.getElementById('testimonial-order').value = '0';
  document.getElementById('testimonial-status').value = 'active';
  document.getElementById('testimonial-modal-title').innerHTML = 'Add <em>Testimonial</em>';
  document.getElementById('testimonial-save-btn').textContent = 'Create Testimonial';
  document.getElementById('testimonial-modal').classList.add('open');
}

function closeTestimonialModal() {
  document.getElementById('testimonial-modal').classList.remove('open');
}

function editTestimonial(id) {
  var t = cachedTestimonials.find(function(x) { return x.id === id; });
  if (!t) return;
  document.getElementById('testimonial-edit-id').value = t.id;
  document.getElementById('testimonial-quote').value = t.quote || '';
  document.getElementById('testimonial-attribution').value = t.attribution || '';
  document.getElementById('testimonial-page').value = t.page || 'home';
  document.getElementById('testimonial-order').value = t.display_order || 0;
  document.getElementById('testimonial-status').value = t.status || 'active';
  document.getElementById('testimonial-modal-title').innerHTML = 'Edit <em>Testimonial</em>';
  document.getElementById('testimonial-save-btn').textContent = 'Save Changes';
  document.getElementById('testimonial-modal').classList.add('open');
}

async function saveTestimonial() {
  var editId = document.getElementById('testimonial-edit-id').value;
  var payload = {
    quote: document.getElementById('testimonial-quote').value.trim(),
    attribution: document.getElementById('testimonial-attribution').value.trim() || 'Client Testimonial · Toowoomba',
    page: document.getElementById('testimonial-page').value,
    display_order: parseInt(document.getElementById('testimonial-order').value) || 0,
    status: document.getElementById('testimonial-status').value,
  };
  if (!payload.quote) {
    showToast('Quote is required', 'error');
    return;
  }
  try {
    if (editId) {
      payload.action = 'update_testimonial';
      payload.testimonial_id = editId;
    } else {
      payload.action = 'create_testimonial';
    }
    await apiPost(payload);
    closeTestimonialModal();
    showToast(editId ? 'Testimonial updated' : 'Testimonial created', 'success');
    loadTestimonials();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function deleteTestimonial(id) {
  showConfirm('Delete this testimonial?', async function() {
    try {
      await apiPost({ action: 'delete_testimonial', testimonial_id: id });
      showToast('Testimonial deleted', 'success');
      loadTestimonials();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });
}

// ═══════════════════════════════════════════════
// CMS — MEDIA LIBRARY
// ═══════════════════════════════════════════════

async function loadMediaLibrary() {
  var loading = document.getElementById('media-loading');
  var content = document.getElementById('media-content');
  loading.style.display = 'block';
  content.style.display = 'none';
  try {
    var data = await apiGet({ action: 'media' });
    var files = data.files || [];
    var grid = document.getElementById('media-grid');
    if (files.length === 0) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--bark);">No media uploaded yet.</div>';
    } else {
      grid.innerHTML = '';
      files.forEach(function(f) {
        var isVideo = /\.(mp4|mov|webm|avi)$/i.test(f.name);
        var card = document.createElement('div');
        card.style.cssText = 'border:1px solid var(--stone);background:var(--warm-white);overflow:hidden;';
        var preview = '';
        if (isVideo) {
          preview = '<div style="height:120px;background:var(--sand);display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--bark);">&#9654;</div>';
        } else {
          preview = '<img src="' + esc(f.url) + '" style="width:100%;height:120px;object-fit:cover;display:block;">';
        }
        card.innerHTML = preview +
          '<div style="padding:10px;">' +
          '<div style="font-size:11px;color:var(--deep);word-break:break-all;margin-bottom:8px;" title="' + esc(f.name) + '">' + esc(truncate(f.name, 25)) + '</div>' +
          '<div style="display:flex;gap:6px;">' +
          '<button class="btn-outline btn-sm" onclick="copyMediaUrl(\'' + esc(f.url).replace(/'/g, "\\'") + '\')">Copy URL</button>' +
          '<button class="btn-outline btn-sm btn-danger" onclick="deleteMediaFile(\'' + esc(f.name).replace(/'/g, "\\'") + '\')">Delete</button>' +
          '</div></div>';
        grid.appendChild(card);
      });
    }
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.textContent = 'Error: ' + err.message;
  }
}

function triggerMediaUpload() {
  document.getElementById('media-upload-input').click();
}

async function handleMediaUpload(input) {
  var file = input.files[0];
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) {
    showToast('File too large (max 50MB)', 'error');
    return;
  }
  showToast('Uploading...', '');
  var reader = new FileReader();
  reader.onload = async function() {
    try {
      var base64 = reader.result.split(',')[1];
      await apiPost({
        action: 'upload_media',
        file_data: base64,
        file_name: file.name,
        content_type: file.type,
      });
      showToast('File uploaded', 'success');
      input.value = '';
      loadMediaLibrary();
    } catch (err) {
      showToast('Upload failed: ' + err.message, 'error');
    }
  };
  reader.readAsDataURL(file);
}

function copyMediaUrl(url) {
  navigator.clipboard.writeText(url).then(function() {
    showToast('URL copied', 'success');
  }).catch(function() {
    // Fallback
    var ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('URL copied', 'success');
  });
}

function deleteMediaFile(path) {
  showConfirm('Delete this file?', async function() {
    try {
      await apiPost({ action: 'delete_media', path: path });
      showToast('File deleted', 'success');
      loadMediaLibrary();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });
}

// ─── FOLLOW-UPS CALENDAR ───

var _fuMonth = new Date(); // current viewed month
var _fuItems = [];          // all follow-ups loaded
var _fuSelectedDay = null;  // YYYY-MM-DD

function fuToday() {
  _fuMonth = new Date();
  _fuSelectedDay = ymdLocal(new Date());
  loadFollowUps();
}

function fuNav(delta) {
  var d = new Date(_fuMonth);
  d.setMonth(d.getMonth() + delta);
  _fuMonth = d;
  renderFollowUps();
}

function ymdLocal(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

async function loadFollowUps() {
  var loading = document.getElementById('fu-loading');
  var content = document.getElementById('fu-content');
  loading.style.display = 'block';
  content.style.display = 'none';

  try {
    var rEnq = await apiGet({ action: 'memberships' });
    var rMem = await apiGet({ action: 'members' });
    var enqs = (rEnq.data || []).map(function(m) {
      var p = parseNotes(m.notes);
      return p.date ? { id: m.id, name: m.name, type: 'enquiry', status: m.status || 'new', plan: m.plan, notes: p.text, follow_up_at: p.date } : null;
    }).filter(Boolean);
    var mems = (rMem.members || []).map(function(m) {
      var p = parseNotes(m.notes);
      return p.date ? { id: m.id, name: m.name, type: 'member', status: m.status || 'active', plan: m.plan, notes: p.text, follow_up_at: p.date } : null;
    }).filter(Boolean);
    _fuItems = enqs.concat(mems);

    // Update sidebar badge with overdue + today count
    var todayKey = ymdLocal(new Date());
    var dueCount = _fuItems.filter(function(it) { return it.follow_up_at <= todayKey; }).length;
    var badge = document.getElementById('fu-badge');
    if (dueCount > 0) { badge.textContent = dueCount; badge.style.display = 'inline'; }
    else { badge.style.display = 'none'; }

    loading.style.display = 'none';
    content.style.display = 'block';
    renderFollowUps();
  } catch (err) {
    loading.innerHTML = '<div class="empty-state">Could not load follow-ups. ' + esc(err.message) + '</div>';
  }
}

function renderFollowUps() {
  // Month label
  var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('fu-month-label').textContent = monthNames[_fuMonth.getMonth()] + ' ' + _fuMonth.getFullYear();

  // Bucket items by date string
  var byDate = {};
  _fuItems.forEach(function(it) { (byDate[it.follow_up_at] = byDate[it.follow_up_at] || []).push(it); });

  // Compute overdue + today + week summary
  var todayKey = ymdLocal(new Date());
  var weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);
  var weekEndKey = ymdLocal(weekEnd);
  var overdue = _fuItems.filter(function(it) { return it.follow_up_at < todayKey; }).length;
  var today = _fuItems.filter(function(it) { return it.follow_up_at === todayKey; }).length;
  var thisWeek = _fuItems.filter(function(it) { return it.follow_up_at > todayKey && it.follow_up_at <= weekEndKey; }).length;

  var summary = '';
  summary += '<div class="fu-summary-item' + (overdue ? ' urgent' : '') + '"><span class="fu-summary-num">' + overdue + '</span><span class="fu-summary-label">Overdue</span></div>';
  summary += '<div class="fu-summary-item' + (today ? ' active' : '') + '"><span class="fu-summary-num">' + today + '</span><span class="fu-summary-label">Today</span></div>';
  summary += '<div class="fu-summary-item"><span class="fu-summary-num">' + thisWeek + '</span><span class="fu-summary-label">Next 7 days</span></div>';
  document.getElementById('fu-summary').innerHTML = summary;

  // Build calendar grid
  var year = _fuMonth.getFullYear();
  var month = _fuMonth.getMonth();
  var firstDay = new Date(year, month, 1);
  var lastDay = new Date(year, month + 1, 0);
  var startOffset = (firstDay.getDay() + 6) % 7; // Mon=0, Sun=6
  var totalCells = Math.ceil((startOffset + lastDay.getDate()) / 7) * 7;

  var grid = '<div class="fu-grid">';
  ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(function(d) {
    grid += '<div class="fu-grid-head">' + d + '</div>';
  });
  for (var i = 0; i < totalCells; i++) {
    var dayNum = i - startOffset + 1;
    var inMonth = dayNum >= 1 && dayNum <= lastDay.getDate();
    if (!inMonth) {
      grid += '<div class="fu-grid-cell out"></div>';
      continue;
    }
    var d = new Date(year, month, dayNum);
    var key = ymdLocal(d);
    var items = byDate[key] || [];
    var cls = 'fu-grid-cell';
    if (key === todayKey) cls += ' today';
    if (key < todayKey && items.length) cls += ' overdue';
    if (key === _fuSelectedDay) cls += ' selected';
    if (items.length) cls += ' has-items';
    var handler = items.length ? ' onclick="fuSelectDay(\'' + key + '\')"' : '';
    grid += '<div class="' + cls + '"' + handler + '>' +
      '<span class="fu-day-num">' + dayNum + '</span>' +
      (items.length ? '<span class="fu-day-count">' + items.length + '</span>' : '') +
    '</div>';
  }
  grid += '</div>';
  document.getElementById('fu-calendar').innerHTML = grid;

  // If a day was previously selected and still in view, render its list
  if (_fuSelectedDay && byDate[_fuSelectedDay]) {
    renderFollowUpDay(_fuSelectedDay);
  } else {
    document.getElementById('fu-day-detail').innerHTML = '';
  }
}

function fuSelectDay(key) {
  _fuSelectedDay = key;
  renderFollowUps();
  renderFollowUpDay(key);
  var detail = document.getElementById('fu-day-detail');
  if (detail && detail.scrollIntoView) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderFollowUpDay(key) {
  var items = _fuItems.filter(function(it) { return it.follow_up_at === key; });
  var dateLabel = new Date(key + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  var html = '<div class="fu-detail-card">' +
    '<div class="fu-detail-head"><h3>' + esc(dateLabel) + ' &middot; ' + items.length + ' follow-up' + (items.length === 1 ? '' : 's') + '</h3>' +
    '<button class="btn-outline" onclick="fuCloseDay()">Close</button></div>';
  if (items.length === 0) {
    html += '<div class="empty-state">No follow-ups on this day.</div>';
  } else {
    html += '<div class="card-list">' + items.map(function(it) {
      var typeBadge = it.type === 'member' ? 'Member' : 'Enquiry';
      return '<div class="data-card">' +
        '<div class="data-card-header">' +
          '<div class="data-card-name"><strong>' + esc(it.name || '') + '</strong> <span class="badge" style="margin-left:6px;">' + typeBadge + '</span></div>' +
          statusBadge(it.status) +
        '</div>' +
        (it.plan ? '<div class="data-card-meta">' + esc(it.plan) + '</div>' : '') +
        (it.notes ? '<div class="data-card-body">' + esc(truncate(it.notes, 200)) + '</div>' : '<div class="data-card-meta" style="font-style:italic;color:var(--clay);">No notes yet</div>') +
        '<div class="data-card-actions">' +
          '<button class="btn-outline" onclick="openNotesModal(\'' + esc(it.id) + '\', \'' + (it.type === 'member' ? 'member' : 'enquiry') + '\')">Open / Edit</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }
  html += '</div>';
  document.getElementById('fu-day-detail').innerHTML = html;
}

function fuCloseDay() {
  _fuSelectedDay = null;
  document.getElementById('fu-day-detail').innerHTML = '';
  renderFollowUps();
}

// ─── WINDOW EXPORTS for inline event handlers ───
window.handleLogin = handleLogin;
window.toggleMobileSidebar = toggleMobileSidebar;
window.logout = logout;
window.showPage = showPage;
window.closeMobileSidebar = closeMobileSidebar;
window.openEventModal = openEventModal;
window.closeEventModal = closeEventModal;
window.handleEventSubmit = handleEventSubmit;
window.editEvent = editEvent;
window.deleteEvent = deleteEvent;
window.loadBookings = loadBookings;
window.cancelBooking = cancelBooking;
window.updateMembershipStatus = updateMembershipStatus;
window.openAcceptModal = openAcceptModal;
window.closeAcceptModal = closeAcceptModal;
window.acceptMembership = acceptMembership;
window.eschedAcceptToggle = eschedAcceptToggle;
window.deleteMembershipRequest = deleteMembershipRequest;
window.mreqSetTab = mreqSetTab;
window.markContacted = markContacted;
window.markNew = markNew;
window.openNotesModal = openNotesModal;
window.closeNotesModal = closeNotesModal;
window.saveNotes = saveNotes;
window.fuToday = fuToday;
window.fuNav = fuNav;
window.fuSelectDay = fuSelectDay;
window.fuCloseDay = fuCloseDay;
window.loadFollowUps = loadFollowUps;
window.loadEnquirySchedule = loadEnquirySchedule;
window.eschedShow = eschedShow;
window.eschedClose = eschedClose;
window.eschedSetMode = eschedSetMode;
window.openAddMemberModal = openAddMemberModal;
window.closeAddMemberModal = closeAddMemberModal;
window.createMemberManual = createMemberManual;
window.deleteMember = deleteMember;
window.sendWelcome = sendWelcome;
window.openEditMemberModal = openEditMemberModal;
window.closeEditMemberModal = closeEditMemberModal;
window.saveEditMember = saveEditMember;
window.openAssignModal = openAssignModal;
window.closeAssignModal = closeAssignModal;
window.assignSlot = assignSlot;
window.unassignSlot = unassignSlot;
window.closeConfirm = closeConfirm;
window.confirmAction = confirmAction;
window.openPlanModal = openPlanModal;
window.closePlanModal = closePlanModal;
window.editPlan = editPlan;
window.savePlan = savePlan;
window.deletePlan = deletePlan;
window.openTestimonialModal = openTestimonialModal;
window.closeTestimonialModal = closeTestimonialModal;
window.editTestimonial = editTestimonial;
window.saveTestimonial = saveTestimonial;
window.deleteContact = deleteContact;
window.deleteTestimonial = deleteTestimonial;
window.triggerMediaUpload = triggerMediaUpload;
window.handleMediaUpload = handleMediaUpload;
window.copyMediaUrl = copyMediaUrl;
window.deleteMediaFile = deleteMediaFile;
window.calSetView = calSetView;
window.calNav = calNav;
window.calGoToday = calGoToday;
window.calToggleDemo = calToggleDemo;
window.calClickEmpty = calClickEmpty;
window.calClickSlot = calClickSlot;
window.calSwitchToDay = calSwitchToDay;
window.closeCalSlotModal = closeCalSlotModal;
window.calAssign = calAssign;
window.calUnassign = calUnassign;
window.openAddSlotModal = openAddSlotModal;
window.closeAddSlotModal = closeAddSlotModal;
window.createSlot = createSlot;

// ─── Lounge Activity ────────────────────────────
async function loadLoungeActivity() {
  var loading = document.getElementById('lng-act-loading');
  var content = document.getElementById('lng-act-content');
  loading.style.display = 'block';
  content.style.display = 'none';
  try {
    var data = await apiGet({ action: 'lounge_admin_activity' });
    var late = (data.cancellations || []).filter(function(c){ return c.state === 'cancelled_late'; });
    var inTime = (data.cancellations || []).filter(function(c){ return c.state === 'cancelled_in_time'; });
    var holds = data.travel_holds || [];
    var activeHolds = holds.filter(function(h){ return h.status === 'active'; });
    var pastHolds = holds.filter(function(h){ return h.status !== 'active'; });

    document.getElementById('lng-act-late').innerHTML       = renderLoungeCancellations(late, true);
    document.getElementById('lng-act-intime').innerHTML     = renderLoungeCancellations(inTime, false);
    document.getElementById('lng-act-holds').innerHTML      = renderLoungeHolds(activeHolds);
    document.getElementById('lng-act-pastholds').innerHTML  = renderLoungeHolds(pastHolds);

    // Sidebar badge — count of late cancellations needing attention
    var badge = document.getElementById('lng-badge');
    if (badge) {
      if (late.length > 0) { badge.style.display = ''; badge.textContent = String(late.length); }
      else                 { badge.style.display = 'none'; }
    }

    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    loading.textContent = 'Failed to load: ' + err.message;
  }
}

function renderLoungeCancellations(rows, late) {
  if (!rows.length) return '<div class="empty-state" style="padding:14px;">None.</div>';
  return '<div class="card-list">' + rows.map(function(c){
    var d = new Date(c.session_date + 'T00:00:00');
    var dateLbl = d.toDateString();
    var notice = (c.notice_hours == null) ? '' : Math.round(c.notice_hours) + 'h notice';
    var planTag = c.member_plan ? '<span class="badge badge-held" style="margin-left:6px;font-size:9px;">' + esc(c.member_plan) + '</span>' : '';
    var chargeTag = late ? '<span class="badge" style="margin-left:6px;font-size:9px;background:#b85c5c;color:#fff;">Charge required</span>' : '';
    return '<div class="data-card">' +
      '<div class="data-card-header"><div class="data-card-name"><strong>' + esc(c.member_name) + '</strong>' + planTag + chargeTag + '</div></div>' +
      '<div class="data-card-meta">' + esc(dateLbl) + (c.session_time ? ' · ' + esc(c.session_time) : '') + (notice ? ' · ' + esc(notice) : '') + '</div>' +
      (c.reason ? '<div class="data-card-body">' + esc(c.reason) + '</div>' : '') +
    '</div>';
  }).join('') + '</div>';
}

function renderLoungeHolds(rows) {
  if (!rows.length) return '<div class="empty-state" style="padding:14px;">None.</div>';
  return '<div class="card-list">' + rows.map(function(h){
    var s = new Date(h.start_date + 'T00:00:00');
    var e = new Date(h.end_date + 'T00:00:00');
    var planTag = h.member_plan ? '<span class="badge badge-held" style="margin-left:6px;font-size:9px;">' + esc(h.member_plan) + '</span>' : '';
    var statusCls = h.status === 'active' ? 'badge-active' : h.status === 'cancelled' ? 'badge-cancelled' : 'badge-held';
    return '<div class="data-card">' +
      '<div class="data-card-header"><div class="data-card-name"><strong>' + esc(h.member_name) + '</strong>' + planTag + '</div>' +
        '<span class="badge ' + statusCls + '">' + esc(h.status) + '</span>' +
      '</div>' +
      '<div class="data-card-meta">' + esc(s.toDateString()) + ' &mdash; ' + esc(e.toDateString()) + '</div>' +
      (h.reason ? '<div class="data-card-body">' + esc(h.reason) + '</div>' : '') +
    '</div>';
  }).join('') + '</div>';
}
