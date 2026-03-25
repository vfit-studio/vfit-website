// ═══════════════════════════════════════════════
// VFIT CRM — iPhone-first client management
// ═══════════════════════════════════════════════

const API = '/.netlify/functions/api';

// ─── State ───
let _key = null;
let _members = [];
let _enquiries = [];
let _messages = [];
let _calApts = [];
let _activeTab = 'today';
let _clientFilter = 'all';
let _weekStart = getMonday(new Date());
let _selectedDay = new Date();
let _activeMemberId = null;
let _memberPickerCallback = null;
let _editAptId = null;
let _inboxTab = 'enquiries';

// ─── API Helpers ───
async function apiGet(action, params = {}) {
  const q = new URLSearchParams({ action, ...params });
  const r = await fetch(API + '?' + q);
  return r.json();
}

async function apiPost(data) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, admin_key: _key }),
  });
  return r.json();
}

function getKey() {
  return _key || sessionStorage.getItem('vfit_admin_key');
}

// ─── Utilities ───
function fmtTime(iso) {
  const d = new Date(iso);
  let h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + (m ? ':' + String(m).padStart(2, '0') : '') + '\u202f' + ampm;
}

function fmtDate(iso) {
  const d = new Date(iso);
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()];
}

function fmtDateFull(d) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()];
}

function fmtDateInput(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

function sessionLabel(type) {
  const m = { pt: 'Personal Training', runclub: 'Run Club', pilattes: "Pi'lattes", consult: 'Consult', other: 'Other' };
  return m[type] || type;
}

function sessionColor(type) {
  const m = { pt: 'var(--deep)', runclub: 'var(--moss)', pilattes: 'var(--bark)', consult: 'var(--clay)', other: 'var(--stone)' };
  return m[type] || 'var(--stone)';
}

function statusBadge(status) {
  const labels = { new: 'New', contacted: 'Contacted', active: 'Active', declined: 'Declined', inactive: 'Inactive' };
  const classes = { new: 'badge-new', contacted: 'badge-contacted', active: 'badge-active', declined: 'badge-declined', inactive: 'badge-declined' };
  return `<span class="status-badge ${classes[status] || ''}">${labels[status] || status}</span>`;
}

function aptStatusBadge(status) {
  const labels = { scheduled: 'Scheduled', attended: 'Attended', missed: 'Missed', cancelled: 'Cancelled' };
  const classes = { scheduled: 'badge-scheduled', attended: 'badge-attended', missed: 'badge-missed', cancelled: 'badge-cancelled' };
  return `<span class="status-badge ${classes[status] || ''}">${labels[status] || status}</span>`;
}

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff); date.setHours(0,0,0,0);
  return date;
}

function addDays(d, n) {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

// ─── Toast ───
let _toastTimer = null;
function toast(msg, type = 'success') {
  const el = document.getElementById('crm-toast');
  el.textContent = msg;
  el.className = 'crm-toast show' + (type === 'error' ? ' error' : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'crm-toast'; }, 3000);
}

// ═══════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════

async function crmLogin() {
  const pw = document.getElementById('crm-password').value.trim();
  const errEl = document.getElementById('crm-login-error');
  errEl.textContent = '';
  if (!pw) return;

  const btn = document.querySelector('#crm-login .login-btn');
  btn.textContent = '…'; btn.disabled = true;

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify_admin', admin_key: pw }),
    });
    const data = await res.json();
    if (data.success) {
      _key = pw;
      sessionStorage.setItem('vfit_admin_key', pw);
      document.getElementById('crm-login').style.display = 'none';
      document.getElementById('crm-app').style.display = 'flex';
      initApp();
    } else {
      errEl.textContent = 'Incorrect password';
    }
  } catch (e) {
    errEl.textContent = 'Connection error — try again';
  }
  btn.textContent = 'Enter'; btn.disabled = false;
}

function crmLogout() {
  if (!confirm('Log out?')) return;
  sessionStorage.removeItem('vfit_admin_key');
  location.reload();
}

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════

async function initApp() {
  // Set today header
  const now = new Date();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('today-date').textContent =
    days[now.getDay()].toUpperCase() + ' ' + now.getDate() + ' ' + months[now.getMonth()].toUpperCase() + ' ' + now.getFullYear();

  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('today-greeting').textContent = greeting + ', Georgie';

  // Load members (used everywhere)
  await loadMembers();

  // Load today
  await loadToday();

  // Backdrop closes sheets
  document.getElementById('sheet-backdrop').addEventListener('click', function() {
    const picker = document.getElementById('member-picker-sheet');
    if (picker.classList.contains('open')) {
      picker.classList.remove('open');
    } else {
      closeAllSheets();
    }
  });

  // Keyboard dismiss
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAllSheets();
  });
}

function switchTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.crm-tab').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('tabbtn-' + tab).classList.add('active');

  const labels = { today: 'Today', calendar: 'Calendar', clients: 'Clients', inbox: 'Inbox' };
  document.getElementById('topbar-tab-label').textContent = labels[tab] || '';

  if (tab === 'calendar') loadCalendar();
  if (tab === 'clients') renderClientList();
  if (tab === 'inbox') loadInbox();
}

// ═══════════════════════════════════════════════
// TODAY TAB
// ═══════════════════════════════════════════════

async function loadToday() {
  const data = await apiGet('crm_dashboard');
  if (!data.success) return;

  // Stats
  document.getElementById('today-stats').innerHTML = `
    <div class="stat-pill">
      <div class="stat-pill-num">${data.today_appointments.length}</div>
      <div class="stat-pill-label">Today</div>
    </div>
    <div class="stat-pill">
      <div class="stat-pill-num">${data.active_members}</div>
      <div class="stat-pill-label">Members</div>
    </div>
    <div class="stat-pill">
      <div class="stat-pill-num">${data.new_enquiries}</div>
      <div class="stat-pill-label">New leads</div>
    </div>
  `;

  // Update inbox badge
  if (data.new_enquiries > 0) {
    const badge = document.getElementById('inbox-tab-badge');
    badge.textContent = data.new_enquiries;
    badge.style.display = 'flex';
    document.getElementById('enq-dot').style.display = 'inline-block';
  }

  // Today's sessions
  const sessionsEl = document.getElementById('today-sessions');
  if (data.today_appointments.length === 0) {
    sessionsEl.innerHTML = '<div class="empty-state">No sessions today</div>';
  } else {
    sessionsEl.innerHTML = data.today_appointments.map(apt => renderTodayCard(apt)).join('');
  }

  // Action required
  const actions = [];
  if (data.new_enquiries > 0) {
    actions.push({ text: data.new_enquiries + ' new enquir' + (data.new_enquiries === 1 ? 'y' : 'ies'), sub: 'Tap to review', tab: 'inbox' });
  }
  data.unbooked_members.forEach(m => {
    actions.push({ text: m.name, sub: 'Active member — no sessions booked', memberId: m.id });
  });

  const actionEl = document.getElementById('action-required');
  const actionHeader = document.getElementById('action-header');
  if (actions.length > 0) {
    actionHeader.style.display = 'block';
    actionEl.innerHTML = actions.map(a => `
      <div class="action-card" onclick="${a.tab ? "switchTab('" + a.tab + "')" : "openMemberProfile('" + a.memberId + "')"}">
        <div>
          <div class="action-card-text">${a.text}</div>
          <div class="action-card-sub">${a.sub}</div>
        </div>
        <div class="action-card-arrow">›</div>
      </div>
    `).join('');
  } else {
    actionHeader.style.display = 'none';
    actionEl.innerHTML = '';
  }
}

function renderTodayCard(apt) {
  const member = apt.members || {};
  const phone = member.phone || '';
  const isAttended = apt.status === 'attended';
  return `
    <div class="session-card" onclick="openAptSheet('${apt.id}')">
      <div class="session-card-type-bar" style="background:${sessionColor(apt.session_type)}"></div>
      <div class="session-card-body">
        <div class="session-card-time">${fmtTime(apt.scheduled_at)} · ${sessionLabel(apt.session_type)}</div>
        <div class="session-card-client">${member.name || '—'}</div>
        <div class="session-card-meta">${apt.location || ''} ${apt.duration_mins ? '· ' + apt.duration_mins + ' min' : ''}</div>
      </div>
      <div class="session-card-actions" onclick="event.stopPropagation()">
        ${phone ? `<a href="tel:${phone}" class="session-action-btn call" title="Call">📞</a>` : ''}
        <button class="session-action-btn check ${isAttended ? 'done' : ''}"
                onclick="markAttended('${apt.id}', this)"
                title="${isAttended ? 'Attended' : 'Mark attended'}">
          ${isAttended ? '✅' : '☐'}
        </button>
      </div>
    </div>
  `;
}

async function markAttended(aptId, btn) {
  btn.textContent = '…';
  const res = await apiPost({ action: 'update_appointment', appointment_id: aptId, status: 'attended' });
  if (res.success) {
    btn.textContent = '✅';
    btn.classList.add('done');
    toast('Marked as attended');
  } else {
    btn.textContent = '☐';
    toast('Could not update', 'error');
  }
}

// ═══════════════════════════════════════════════
// APT DETAIL SHEET
// ═══════════════════════════════════════════════

async function openAptSheet(aptId) {
  _editAptId = aptId;
  // Find in today or calendar data
  let apt = null;
  const allApts = [..._calApts];
  apt = allApts.find(a => a.id === aptId);

  if (!apt) {
    // Fetch from API
    const res = await apiGet('appointments', { member_id: 'x' }); // fallback
    apt = (res.appointments || []).find(a => a.id === aptId);
  }

  if (!apt) { toast('Session not found', 'error'); return; }

  renderAptSheet(apt);
  openSheet('apt-sheet');
}

function renderAptSheet(apt) {
  const member = apt.members || {};
  const phone = member.phone || '';
  const email = member.email || '';

  document.getElementById('apt-sheet-body').innerHTML = `
    <div class="sheet-title" style="border-bottom:none;padding-bottom:4px">${aptStatusBadge(apt.status)}</div>
    <div class="apt-detail-client" onclick="closeThenOpenProfile('${member.id}')">${member.name || '—'} ›</div>
    <div class="apt-detail-row"><span class="apt-detail-label">When</span><span class="apt-detail-value">${fmtDate(apt.scheduled_at)} · ${fmtTime(apt.scheduled_at)}</span></div>
    <div class="apt-detail-row"><span class="apt-detail-label">Type</span><span class="apt-detail-value">${sessionLabel(apt.session_type)}</span></div>
    <div class="apt-detail-row"><span class="apt-detail-label">Duration</span><span class="apt-detail-value">${apt.duration_mins || 60} min</span></div>
    <div class="apt-detail-row"><span class="apt-detail-label">Location</span><span class="apt-detail-value">${apt.location || 'Not set'}</span></div>
    ${phone || email ? `
    <div class="apt-detail-row">
      <span class="apt-detail-label">Contact</span>
      <span class="apt-detail-value">
        ${phone ? `<a href="tel:${phone}" class="contact-link">${phone}</a>` : ''}
        ${phone && email ? ' · ' : ''}
        ${email ? `<a href="mailto:${email}" class="contact-link">${email}</a>` : ''}
      </span>
    </div>` : ''}
    <div style="padding:12px 20px 4px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:var(--stone)">Notes</div>
    <textarea class="apt-notes-area" id="apt-notes-field" placeholder="Add session notes…">${apt.notes || ''}</textarea>
    <div class="apt-actions">
      ${apt.status === 'scheduled' ? `<button class="apt-action-btn primary" onclick="updateAptStatus('${apt.id}','attended')">✓ Attended</button>` : ''}
      ${apt.status === 'scheduled' ? `<button class="apt-action-btn" onclick="updateAptStatus('${apt.id}','missed')">Missed</button>` : ''}
      <button class="apt-action-btn danger" onclick="cancelApt('${apt.id}')">Cancel</button>
    </div>
    <button class="btn-full secondary" onclick="saveAptNotes('${apt.id}')" style="margin-top:12px;margin-bottom:20px">Save Notes</button>
  `;
}

async function saveAptNotes(aptId) {
  const notes = document.getElementById('apt-notes-field').value;
  const res = await apiPost({ action: 'update_appointment', appointment_id: aptId, notes });
  if (res.success) { toast('Notes saved'); }
  else { toast('Could not save', 'error'); }
}

async function updateAptStatus(aptId, status) {
  const res = await apiPost({ action: 'update_appointment', appointment_id: aptId, status });
  if (res.success) {
    toast('Updated');
    closeAllSheets();
    if (_activeTab === 'today') loadToday();
    if (_activeTab === 'calendar') loadCalDay(_selectedDay);
    if (_activeMemberId) loadMemberApts(_activeMemberId);
  } else {
    toast('Could not update', 'error');
  }
}

async function cancelApt(aptId) {
  if (!confirm('Cancel this session?')) return;
  const res = await apiPost({ action: 'delete_appointment', appointment_id: aptId });
  if (res.success) {
    toast('Session cancelled');
    closeAllSheets();
    if (_activeTab === 'today') loadToday();
    if (_activeTab === 'calendar') loadCalDay(_selectedDay);
    if (_activeMemberId) loadMemberApts(_activeMemberId);
  } else {
    toast('Could not cancel', 'error');
  }
}

function closeThenOpenProfile(memberId) {
  closeAllSheets();
  setTimeout(() => openMemberProfile(memberId), 300);
}

// ═══════════════════════════════════════════════
// CALENDAR TAB
// ═══════════════════════════════════════════════

async function loadCalendar() {
  renderWeekStrip();
  await loadCalDay(_selectedDay);
}

function renderWeekStrip() {
  const today = new Date();
  const strip = document.getElementById('week-strip');
  const dayNames = ['M','T','W','T','F','S','S'];
  let html = '';
  for (let i = 0; i < 7; i++) {
    const day = addDays(_weekStart, i);
    const isToday = isSameDay(day, today);
    const isSelected = isSameDay(day, _selectedDay);
    const hasDot = _calApts.some(a => isSameDay(new Date(a.scheduled_at), day));
    html += `
      <div class="week-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}"
           onclick="selectCalDay(${day.getTime()})">
        <span class="week-day-name">${dayNames[i]}</span>
        <span class="week-day-num">${day.getDate()}</span>
        ${hasDot ? '<span class="week-day-dot"></span>' : '<span style="width:5px;height:5px"></span>'}
      </div>
    `;
  }
  strip.innerHTML = html;

  // Month label
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const endOfWeek = addDays(_weekStart, 6);
  const label = _weekStart.getMonth() === endOfWeek.getMonth()
    ? months[_weekStart.getMonth()] + ' ' + _weekStart.getFullYear()
    : months[_weekStart.getMonth()] + ' / ' + months[endOfWeek.getMonth()] + ' ' + endOfWeek.getFullYear();
  document.getElementById('cal-month-label').textContent = label;
}

async function selectCalDay(timestamp) {
  _selectedDay = new Date(timestamp);
  renderWeekStrip();
  await loadCalDay(_selectedDay);
}

function shiftWeek(dir) {
  _weekStart = addDays(_weekStart, dir * 7);
  renderWeekStrip();
  loadCalDay(_selectedDay);
}

async function loadCalDay(day) {
  document.getElementById('cal-day-header').textContent = fmtDateFull(day).toUpperCase();

  // Fetch week range for dots
  const weekEnd = addDays(_weekStart, 7);
  const res = await apiGet('appointments', {
    from: _weekStart.toISOString(),
    to: weekEnd.toISOString(),
  });
  _calApts = res.appointments || [];
  renderWeekStrip(); // refresh dots

  // Day appointments
  const dayApts = _calApts.filter(a => isSameDay(new Date(a.scheduled_at), day));
  renderDayTimeline(dayApts);
}

function renderDayTimeline(apts) {
  const hours = [];
  for (let h = 5; h <= 20; h++) hours.push(h);

  const tl = document.getElementById('day-timeline');
  if (apts.length === 0) {
    tl.innerHTML = `<div class="timeline-empty">No sessions — tap <strong>+ Add Session</strong> to book one</div>`;
    return;
  }

  let html = '';
  hours.forEach(h => {
    const hourApts = apts.filter(a => new Date(a.scheduled_at).getHours() === h);
    const timeStr = (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
    html += `<div class="timeline-row">
      <div class="timeline-time">${timeStr}</div>
      <div class="timeline-slot">
        ${hourApts.map(a => {
          const m = a.members || {};
          return `<div class="timeline-apt" style="background:${sessionColor(a.session_type)}"
                      onclick="openAptSheetFromCal('${a.id}')">
            <div class="timeline-apt-time">${fmtTime(a.scheduled_at)}</div>
            <div class="timeline-apt-client">${m.name || '—'}</div>
            <div class="timeline-apt-meta">${sessionLabel(a.session_type)} · ${a.duration_mins || 60}min</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  });
  tl.innerHTML = html;
}

function openAptSheetFromCal(aptId) {
  const apt = _calApts.find(a => a.id === aptId);
  if (!apt) return;
  renderAptSheet(apt);
  openSheet('apt-sheet');
}

// ═══════════════════════════════════════════════
// NEW SESSION SHEET
// ═══════════════════════════════════════════════

function openNewSession(date, time, memberId) {
  // Reset form
  document.getElementById('session-member-id').value = memberId || '';
  document.getElementById('session-client-btn').textContent = memberId
    ? (_members.find(m => m.id === memberId)?.name || 'Client selected')
    : 'Select client…';
  document.getElementById('session-client-btn').className = 'picker-btn' + (memberId ? ' selected' : '');
  document.getElementById('session-type').value = 'pt';
  document.querySelectorAll('#new-session-sheet .chip-group:nth-of-type(1) .chip').forEach((c,i) => c.classList.toggle('active', i===0));
  document.getElementById('session-date').value = date ? fmtDateInput(new Date(date)) : fmtDateInput(_selectedDay);
  document.getElementById('session-time').value = time || '05:15';
  document.getElementById('session-duration').value = '60';
  document.querySelectorAll('#new-session-sheet .form-group:nth-of-type(4) .chip').forEach((c,i) => c.classList.toggle('active', i===1));
  document.getElementById('session-location').value = 'Studio';
  document.querySelectorAll('#new-session-sheet .form-group:nth-of-type(5) .chip').forEach((c,i) => c.classList.toggle('active', i===0));
  document.getElementById('session-notes').value = '';
  document.getElementById('session-error').style.display = 'none';
  document.getElementById('save-session-btn').disabled = false;
  document.getElementById('save-session-btn').textContent = 'Save Session';
  openSheet('new-session-sheet');
}

function closeNewSession() {
  document.getElementById('new-session-sheet').classList.remove('open');
  document.getElementById('sheet-backdrop').classList.remove('open');
}

function selectSessionType(type, btn) {
  btn.closest('.chip-group').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('session-type').value = type;
}

function selectDuration(mins, btn) {
  btn.closest('.chip-group').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('session-duration').value = String(mins);
}

function selectLocation(loc, btn) {
  btn.closest('.chip-group').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('session-location').value = loc;
}

async function saveSession() {
  const memberId = document.getElementById('session-member-id').value;
  const dateVal = document.getElementById('session-date').value;
  const timeVal = document.getElementById('session-time').value;
  const errEl = document.getElementById('session-error');

  if (!memberId) { errEl.textContent = 'Please select a client'; errEl.style.display = 'block'; return; }
  if (!dateVal || !timeVal) { errEl.textContent = 'Date and time are required'; errEl.style.display = 'block'; return; }

  errEl.style.display = 'none';
  const btn = document.getElementById('save-session-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const scheduledAt = new Date(dateVal + 'T' + timeVal).toISOString();

  const res = await apiPost({
    action: 'create_appointment',
    member_id: memberId,
    session_type: document.getElementById('session-type').value,
    scheduled_at: scheduledAt,
    duration_mins: parseInt(document.getElementById('session-duration').value),
    location: document.getElementById('session-location').value,
    notes: document.getElementById('session-notes').value.trim() || null,
  });

  if (res.conflict) {
    errEl.textContent = `Time conflict with ${res.conflict_with} at ${fmtTime(res.conflict_time)}. Adjust the time.`;
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Save Session';
    return;
  }

  if (res.success) {
    toast('Session saved');
    closeAllSheets();
    if (_activeTab === 'today') loadToday();
    if (_activeTab === 'calendar') loadCalDay(_selectedDay);
    if (_activeMemberId) loadMemberApts(_activeMemberId);
  } else {
    errEl.textContent = res.error || 'Could not save. Try again.';
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Save Session';
  }
}

// ═══════════════════════════════════════════════
// MEMBER PICKER
// ═══════════════════════════════════════════════

function openMemberPicker() {
  document.getElementById('picker-search').value = '';
  renderPickerList('');
  document.getElementById('member-picker-sheet').classList.add('open');
  // Don't touch backdrop — it stays open from parent sheet
  setTimeout(() => document.getElementById('picker-search').focus(), 350);
}

function filterPickerList() {
  renderPickerList(document.getElementById('picker-search').value);
}

function renderPickerList(q) {
  const filtered = _members.filter(m =>
    m.status === 'active' &&
    (!q || m.name.toLowerCase().includes(q.toLowerCase()))
  );
  document.getElementById('picker-list').innerHTML = filtered.length
    ? filtered.map(m => `
        <div class="picker-item" onclick="selectMember('${m.id}','${m.name.replace(/'/g,'\\&#39;')}')">
          <div class="picker-avatar">${initials(m.name)}</div>
          <div>
            <div class="picker-name">${m.name}</div>
            <div class="picker-plan">${m.plan || ''} · ${m.sessions_per_week || 1}×/wk</div>
          </div>
        </div>
      `).join('')
    : '<div class="empty-state" style="padding:32px 0">No clients found</div>';
}

function selectMember(id, name) {
  document.getElementById('session-member-id').value = id;
  const btn = document.getElementById('session-client-btn');
  btn.textContent = name;
  btn.className = 'picker-btn selected';
  document.getElementById('member-picker-sheet').classList.remove('open');
}

// ═══════════════════════════════════════════════
// CLIENTS TAB
// ═══════════════════════════════════════════════

async function loadMembers() {
  const res = await apiGet('members');
  _members = res.members || [];
}

function renderClientList() {
  const q = document.getElementById('client-search').value.toLowerCase();
  const filtered = _members.filter(m => {
    if (_clientFilter !== 'all' && m.status !== _clientFilter) return false;
    if (q && !m.name.toLowerCase().includes(q)) return false;
    return true;
  });

  const el = document.getElementById('client-list');
  if (filtered.length === 0) {
    el.innerHTML = '<div class="empty-state">No clients found</div>';
    return;
  }

  el.innerHTML = filtered.map(m => {
    const nextSlot = m.slots && m.slots.length > 0
      ? ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][m.slots[0].day_of_week - 1] + ' · ' + m.slots[0].time
      : '';
    return `
      <div class="client-card" data-status="${m.status}" onclick="openMemberProfile('${m.id}')">
        <div class="client-avatar">${initials(m.name)}</div>
        <div class="client-info">
          <div class="client-name">${m.name}</div>
          <div class="client-plan">${m.plan || ''} · ${m.sessions_per_week || 1}×/wk</div>
          ${nextSlot ? `<div class="client-next">Recurring: ${nextSlot}</div>` : ''}
        </div>
        <div class="client-arrow">›</div>
      </div>
    `;
  }).join('');
}

function setClientFilter(status, btn) {
  _clientFilter = status;
  document.querySelectorAll('#client-filter-chips .chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  renderClientList();
}

function filterClients() {
  renderClientList();
}

// ═══════════════════════════════════════════════
// MEMBER PROFILE
// ═══════════════════════════════════════════════

async function openMemberProfile(id) {
  _activeMemberId = id;
  document.getElementById('member-profile-body').innerHTML =
    '<div class="loading-pulse" style="margin:24px"></div>';
  document.getElementById('member-profile-screen').classList.add('open');
  await loadMemberProfile(id);
}

function closeMemberProfile() {
  document.getElementById('member-profile-screen').classList.remove('open');
  _activeMemberId = null;
}

async function loadMemberProfile(id) {
  const [memberRes, aptsRes] = await Promise.all([
    apiGet('member', { id }),
    apiGet('appointments', { member_id: id }),
  ]);

  const m = memberRes.member;
  if (!m) { toast('Client not found', 'error'); return; }

  const apts = aptsRes.appointments || [];
  // Merge into _calApts so apt sheet can find them
  apts.forEach(a => { if (!_calApts.find(c => c.id === a.id)) _calApts.push(a); });
  const now = new Date();
  const upcoming = apts.filter(a => new Date(a.scheduled_at) >= now && a.status !== 'cancelled').slice(0, 5);
  const past = apts.filter(a => new Date(a.scheduled_at) < now).slice(0, 10);
  const attended = past.filter(a => a.status === 'attended').length;

  const el = document.getElementById('member-profile-body');
  el.innerHTML = `
    <!-- Header -->
    <div class="profile-header">
      <div class="profile-avatar">${initials(m.name)}</div>
      <div class="profile-name">${m.name}</div>
      <div class="profile-plan">${m.plan || 'No plan'} · ${m.sessions_per_week || 1}×/wk · ${statusBadge(m.status)}</div>
      ${m.start_date ? `<div style="font-size:12px;color:var(--stone);margin-top:4px">Member since ${fmtDate(m.start_date)}</div>` : ''}
    </div>

    <!-- Quick actions -->
    <div style="display:flex;gap:8px;margin-bottom:20px">
      <button class="notes-save-btn" style="flex:1;text-align:center" onclick="openNewSession(null,null,'${m.id}')">+ Schedule</button>
      ${m.phone ? `<a href="tel:${m.phone}" class="notes-save-btn" style="flex:1;text-align:center;display:flex;align-items:center;justify-content:center">📞 Call</a>` : ''}
      ${m.email ? `<a href="mailto:${m.email}" class="notes-save-btn" style="flex:1;text-align:center;display:flex;align-items:center;justify-content:center">✉️ Email</a>` : ''}
    </div>

    <!-- Stats -->
    <div class="profile-stats" style="margin-bottom:20px">
      <div class="profile-stat">
        <div class="profile-stat-num">${apts.length}</div>
        <div class="profile-stat-label">Sessions</div>
      </div>
      <div class="profile-stat">
        <div class="profile-stat-num">${attended}</div>
        <div class="profile-stat-label">Attended</div>
      </div>
      <div class="profile-stat">
        <div class="profile-stat-num">${upcoming.length}</div>
        <div class="profile-stat-label">Upcoming</div>
      </div>
    </div>

    <!-- Notes (top — most used) -->
    <div class="profile-section">
      <div class="profile-section-title">Session Notes</div>
      <textarea class="notes-textarea" id="profile-notes" rows="4"
                placeholder="Add session notes, progress, anything relevant…"
                onblur="saveMemberNotes('${m.id}')">${m.notes || ''}</textarea>
      <div style="font-size:11px;color:var(--stone);margin-top:4px">Auto-saves when you tap away</div>
    </div>

    <div class="profile-section">
      <div class="profile-section-title">Goals</div>
      <textarea class="notes-textarea" id="profile-goals" rows="2"
                placeholder="Client's goals, e.g. lose 10kg, run a half marathon…"
                onblur="saveMemberNotes('${m.id}')">${m.goals || ''}</textarea>
    </div>

    <div class="profile-section">
      <div class="profile-section-title">Health & Injuries</div>
      <textarea class="notes-textarea" id="profile-health" rows="2"
                placeholder="Injuries, limitations, medical notes…"
                onblur="saveMemberNotes('${m.id}')">${m.health_notes || ''}</textarea>
    </div>

    <!-- Upcoming sessions -->
    <div class="profile-section">
      <div class="profile-section-title">Upcoming Sessions</div>
      ${upcoming.length > 0
        ? upcoming.map(a => `
          <div class="profile-apt-card" onclick="openAptSheetFromCal('${a.id}')">
            <div class="profile-apt-left">
              <div class="profile-apt-time">${fmtDate(a.scheduled_at)} · ${fmtTime(a.scheduled_at)}</div>
              <div class="profile-apt-client">${sessionLabel(a.session_type)}${a.location ? ' · ' + a.location : ''}</div>
            </div>
            ${aptStatusBadge(a.status)}
          </div>
        `).join('')
        : '<div style="font-size:13px;color:var(--stone);padding:8px 0">No upcoming sessions — tap Schedule above</div>'
      }
    </div>

    <!-- Recurring slots -->
    ${m.slots && m.slots.length > 0 ? `
    <div class="profile-section">
      <div class="profile-section-title">Recurring Slots</div>
      <div>${m.slots.map(s => {
        const dayName = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][s.day_of_week - 1] || s.day_of_week;
        return `<span class="slot-chip">${dayName} · ${s.time}</span>`;
      }).join('')}</div>
    </div>` : ''}

    <!-- Session history -->
    ${past.length > 0 ? `
    <div class="profile-section">
      <div class="profile-section-title">Session History</div>
      ${past.slice(0, 8).map(a => `
        <div class="profile-apt-card">
          <div class="profile-apt-left">
            <div class="profile-apt-time">${fmtDate(a.scheduled_at)} · ${fmtTime(a.scheduled_at)}</div>
            <div class="profile-apt-client">${sessionLabel(a.session_type)}${a.notes ? ' · ' + a.notes.slice(0,50) : ''}</div>
          </div>
          ${aptStatusBadge(a.status)}
        </div>
      `).join('')}
    </div>` : ''}
  `;
}

async function loadMemberApts(id) {
  // Refresh profile if open
  if (_activeMemberId === id) {
    await loadMemberProfile(id);
  }
}

function openAptSheetFromProfile(aptId) {
  const allApts = document.querySelectorAll('[data-apt-id]');
  // Just use calendar apts or re-fetch
  openAptSheet(aptId);
}

let _notesSaveTimer = null;
async function saveMemberNotes(memberId) {
  const notes = document.getElementById('profile-notes')?.value ?? '';
  const goals = document.getElementById('profile-goals')?.value ?? '';
  const healthNotes = document.getElementById('profile-health')?.value ?? '';

  // Only save if something actually changed
  const cached = _members.find(m => m.id === memberId) || {};
  if (notes === (cached.notes || '') && goals === (cached.goals || '') && healthNotes === (cached.health_notes || '')) return;

  clearTimeout(_notesSaveTimer);
  _notesSaveTimer = setTimeout(async () => {
    const res = await apiPost({ action: 'update_member_notes', member_id: memberId, notes, goals, health_notes: healthNotes });
    if (res.success) {
      const idx = _members.findIndex(m => m.id === memberId);
      if (idx >= 0) { _members[idx].notes = notes; _members[idx].goals = goals; _members[idx].health_notes = healthNotes; }
      toast('Notes saved');
    }
  }, 300);
}

function editCurrentMember() {
  const m = _members.find(m => m.id === _activeMemberId);
  if (m) openAddMemberSheet(m);
}

// ═══════════════════════════════════════════════
// ADD / EDIT MEMBER SHEET
// ═══════════════════════════════════════════════

function openAddMemberSheet(member) {
  document.getElementById('add-member-title').textContent = member ? 'Edit Client' : 'Add Client';
  document.getElementById('edit-member-id').value = member ? member.id : '';
  document.getElementById('add-member-name').value = member ? member.name : '';
  document.getElementById('add-member-email').value = member ? (member.email || '') : '';
  document.getElementById('add-member-phone').value = member ? (member.phone || '') : '';
  document.getElementById('add-member-plan').value = member ? (member.plan || '') : '';
  document.getElementById('add-member-sessions').value = member ? (member.sessions_per_week || 3) : 3;
  document.getElementById('add-member-error').style.display = 'none';
  document.getElementById('save-member-btn').disabled = false;
  document.getElementById('save-member-btn').textContent = 'Save Client';
  openSheet('add-member-sheet');
}

function closeAddMemberSheet() {
  document.getElementById('add-member-sheet').classList.remove('open');
  document.getElementById('sheet-backdrop').classList.remove('open');
}

async function saveMember() {
  const id = document.getElementById('edit-member-id').value;
  const name = document.getElementById('add-member-name').value.trim();
  const email = document.getElementById('add-member-email').value.trim();
  const phone = document.getElementById('add-member-phone').value.trim();
  const plan = document.getElementById('add-member-plan').value.trim();
  const sessions = parseInt(document.getElementById('add-member-sessions').value) || 3;
  const errEl = document.getElementById('add-member-error');

  if (!name || !plan) { errEl.textContent = 'Name and plan are required'; errEl.style.display = 'block'; return; }

  errEl.style.display = 'none';
  const btn = document.getElementById('save-member-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const action = id ? 'update_member' : 'create_member';
  const payload = id
    ? { action, member_id: id, name, email, phone, plan, sessions_per_week: sessions }
    : { action, name, email, phone, plan, sessions_per_week: sessions };

  const res = await apiPost(payload);
  if (res.success) {
    toast(id ? 'Client updated' : 'Client added');
    await loadMembers();
    closeAddMemberSheet();
    if (_activeMemberId === id) await loadMemberProfile(id);
    if (_activeTab === 'clients') renderClientList();
  } else {
    errEl.textContent = res.error || 'Could not save. Try again.';
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Save Client';
  }
}

// ═══════════════════════════════════════════════
// INBOX TAB
// ═══════════════════════════════════════════════

async function loadInbox() {
  const [enqRes, msgRes] = await Promise.all([
    apiGet('memberships'),
    apiGet('contacts'),
  ]);
  _enquiries = enqRes.data || [];
  _messages = msgRes.data || [];

  renderEnquiries();
  renderMessages();

  // Badge
  const newCount = _enquiries.filter(e => e.status === 'new').length;
  const dot = document.getElementById('enq-dot');
  dot.style.display = newCount > 0 ? 'inline-block' : 'none';
  const badge = document.getElementById('inbox-tab-badge');
  if (newCount > 0) { badge.textContent = newCount; badge.style.display = 'flex'; }
}

function switchInboxTab(tab) {
  _inboxTab = tab;
  document.getElementById('inbox-enq-btn').classList.toggle('active', tab === 'enquiries');
  document.getElementById('inbox-msg-btn').classList.toggle('active', tab === 'messages');
  document.getElementById('inbox-enquiries').style.display = tab === 'enquiries' ? 'block' : 'none';
  document.getElementById('inbox-messages').style.display = tab === 'messages' ? 'block' : 'none';
}

function renderEnquiries() {
  const el = document.getElementById('inbox-enquiries');
  if (_enquiries.length === 0) {
    el.innerHTML = '<div class="empty-state">No enquiries yet</div>'; return;
  }
  el.innerHTML = _enquiries.map(e => `
    <div class="enquiry-card" onclick="openEnquirySheet('${e.id}')">
      <div class="enquiry-card-top">
        <span class="enquiry-name">${e.name}</span>
        <span class="enquiry-time">${timeAgo(e.created_at)}</span>
      </div>
      ${statusBadge(e.status)}
      <div class="enquiry-plan">${e.plan || ''}</div>
      <div class="enquiry-meta">${[e.sessions, e.days, e.times].filter(Boolean).join(' · ')}</div>
    </div>
  `).join('');
}

function renderMessages() {
  const el = document.getElementById('inbox-messages');
  if (_messages.length === 0) {
    el.innerHTML = '<div class="empty-state">No messages</div>'; return;
  }
  el.innerHTML = _messages.map(m => `
    <div class="message-card" onclick="openMessageSheet('${m.id}')">
      <div class="message-card-top">
        <span class="message-name">${m.name}</span>
        <span class="message-time">${timeAgo(m.created_at)}</span>
      </div>
      <div class="message-preview">${(m.message || '').slice(0, 80)}${m.message && m.message.length > 80 ? '…' : ''}</div>
    </div>
  `).join('');
}

// ─── Enquiry detail ───

function openEnquirySheet(id) {
  const e = _enquiries.find(e => e.id === id);
  if (!e) return;

  const statusBtns = ['new','contacted','active','declined'].map(s => `
    <button class="status-btn ${e.status === s ? 'active-btn' : ''}"
            onclick="setEnquiryStatus('${id}','${s}',this)">${s.charAt(0).toUpperCase()+s.slice(1)}</button>
  `).join('');

  document.getElementById('enquiry-sheet-body').innerHTML = `
    <div style="padding:16px 20px 0">
      <div style="font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:var(--stone);margin-bottom:6px">${fmtDate(e.created_at)}</div>
      <div style="font-family:'Cormorant Garamond',serif;font-size:30px;font-weight:300;color:var(--deep);margin-bottom:12px">${e.name}</div>
      ${e.status !== 'active' ? `
      <button class="btn-full" id="accept-btn-${id}" onclick="acceptEnquiry('${id}')"
              style="margin:0 0 16px;width:100%;background:var(--moss)">
        ✓ Accept as Member
      </button>` : `<div style="margin-bottom:12px">${statusBadge('active')}</div>`}
    </div>

    <div class="enquiry-status-row" style="border-top:1px solid var(--sand);padding-top:14px">${statusBtns}</div>

    <div class="apt-detail-row"><span class="apt-detail-label">Plan</span><span class="apt-detail-value">${e.plan || '—'}</span></div>
    <div class="apt-detail-row"><span class="apt-detail-label">Sessions</span><span class="apt-detail-value">${e.sessions || '—'}</span></div>
    <div class="apt-detail-row"><span class="apt-detail-label">Days</span><span class="apt-detail-value">${e.days || '—'}</span></div>
    <div class="apt-detail-row"><span class="apt-detail-label">Times</span><span class="apt-detail-value">${e.times || '—'}</span></div>
    ${e.notes ? `<div class="apt-detail-row"><span class="apt-detail-label">Notes</span><span class="apt-detail-value">${e.notes}</span></div>` : ''}

    <div class="enq-quick-actions">
      ${e.phone ? `<a href="tel:${e.phone}" class="enq-quick-btn">📞 Call</a>` : ''}
      ${e.email ? `<a href="mailto:${e.email}" class="enq-quick-btn">✉️ Email</a>` : ''}
    </div>

    <div style="padding:0 20px 8px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:var(--stone)">Your Notes</div>
    <textarea class="apt-notes-area" id="enq-notes-field"
              placeholder="Add internal notes…"
              onblur="saveEnquiryNotes('${id}')">${e.admin_notes || ''}</textarea>
    <div style="padding:6px 20px 24px;font-size:11px;color:var(--stone)">Auto-saves when you tap away</div>
  `;
  openSheet('enquiry-sheet');
}

async function setEnquiryStatus(id, status, btn) {
  const res = await apiPost({ action: 'update_enquiry_notes', membership_id: id, status });
  if (res.success) {
    const e = _enquiries.find(e => e.id === id);
    if (e) e.status = status;
    btn.closest('.enquiry-status-row').querySelectorAll('.status-btn').forEach(b => b.classList.remove('active-btn'));
    btn.classList.add('active-btn');
    toast('Status updated');
  } else {
    toast('Could not update', 'error');
  }
}

async function saveEnquiryNotes(id) {
  const field = document.getElementById('enq-notes-field');
  if (!field) return;
  const notes = field.value;
  const e = _enquiries.find(e => e.id === id);
  if (e && notes === (e.admin_notes || '')) return; // no change
  const res = await apiPost({ action: 'update_enquiry_notes', membership_id: id, admin_notes: notes, last_contacted_at: new Date().toISOString() });
  if (res.success) {
    if (e) e.admin_notes = notes;
    toast('Notes saved');
  }
}

async function acceptEnquiry(id) {
  const e = _enquiries.find(e => e.id === id);
  if (!e) return;

  const btn = document.getElementById('accept-btn-' + id);
  if (btn) { btn.disabled = true; btn.textContent = 'Accepting…'; }

  const res = await apiPost({
    action: 'accept_membership',
    membership_id: id,
    name: e.name, email: e.email, phone: e.phone,
    plan: e.plan, sessions_per_week: parseInt(e.sessions) || 3,
  });

  if (res.success) {
    closeAllSheets();
    // Parallel reload — don't wait on each other
    await Promise.all([loadMembers(), loadInbox()]);
    toast(e.name + ' added as a member!');
    // Navigate straight to their profile
    if (res.member && res.member.id) {
      setTimeout(() => openMemberProfile(res.member.id), 200);
    } else {
      switchTab('clients');
    }
  } else {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Accept as Member'; }
    toast(res.error || 'Could not accept', 'error');
  }
}

// ─── Message detail ───

function openMessageSheet(id) {
  const m = _messages.find(m => m.id === id);
  if (!m) return;

  document.getElementById('message-sheet-body').innerHTML = `
    <div class="sheet-title">${m.name}</div>
    <div class="apt-detail-row"><span class="apt-detail-label">Date</span><span class="apt-detail-value">${fmtDate(m.created_at)}</span></div>
    ${m.phone ? `<div class="apt-detail-row"><span class="apt-detail-label">Phone</span><a href="tel:${m.phone}" class="apt-detail-value contact-link">${m.phone}</a></div>` : ''}
    ${m.email ? `<div class="apt-detail-row"><span class="apt-detail-label">Email</span><a href="mailto:${m.email}" class="apt-detail-value contact-link">${m.email}</a></div>` : ''}
    <div style="padding:16px 20px;font-size:15px;color:var(--deep);line-height:1.7;border-top:1px solid var(--sand);margin-top:4px">${(m.message || '').replace(/\n/g,'<br>')}</div>
    <div class="enq-quick-actions">
      ${m.email ? `<a href="mailto:${m.email}" class="enq-quick-btn">✉️ Reply</a>` : ''}
      ${m.phone ? `<a href="tel:${m.phone}" class="enq-quick-btn">📞 Call</a>` : ''}
    </div>
    <button class="btn-full danger" onclick="deleteMessage('${id}')" style="margin-top:8px;margin-bottom:20px">Delete Message</button>
  `;
  openSheet('message-sheet');
}

async function deleteMessage(id) {
  if (!confirm('Delete this message?')) return;
  const res = await apiPost({ action: 'delete_contact', contact_id: id });
  if (res.success) {
    _messages = _messages.filter(m => m.id !== id);
    renderMessages();
    closeAllSheets();
    toast('Message deleted');
  } else {
    toast('Could not delete', 'error');
  }
}

// ═══════════════════════════════════════════════
// SHEET MANAGEMENT
// ═══════════════════════════════════════════════

function openSheet(id) {
  document.getElementById(id).classList.add('open');
  document.getElementById('sheet-backdrop').classList.add('open');
}

function closeAllSheets() {
  document.querySelectorAll('.bottom-sheet.open').forEach(s => s.classList.remove('open'));
  document.getElementById('sheet-backdrop').classList.remove('open');
  _editAptId = null;
}

// ═══════════════════════════════════════════════
// BOOTSTRAP — check existing session
// ═══════════════════════════════════════════════
(function() {
  const saved = sessionStorage.getItem('vfit_admin_key');
  if (saved) {
    _key = saved;
    document.getElementById('crm-login').style.display = 'none';
    document.getElementById('crm-app').style.display = 'flex';
    initApp();
  } else {
    document.getElementById('crm-login').style.display = 'flex';
  }
})();

// ═══════════════════════════════════════════════
// WINDOW EXPORTS (for inline onclick handlers)
// ═══════════════════════════════════════════════
window.crmLogin           = crmLogin;
window.crmLogout          = crmLogout;
window.switchTab          = switchTab;
window.switchInboxTab     = switchInboxTab;
window.shiftWeek          = shiftWeek;
window.selectCalDay       = selectCalDay;
window.openNewSession     = openNewSession;
window.closeNewSession    = closeNewSession;
window.selectSessionType  = selectSessionType;
window.selectDuration     = selectDuration;
window.selectLocation     = selectLocation;
window.saveSession        = saveSession;
window.openMemberPicker   = openMemberPicker;
window.filterPickerList   = filterPickerList;
window.selectMember       = selectMember;
window.filterClients      = filterClients;
window.setClientFilter    = setClientFilter;
window.openMemberProfile  = openMemberProfile;
window.closeMemberProfile = closeMemberProfile;
window.editCurrentMember  = editCurrentMember;
window.saveMemberNotes    = saveMemberNotes;
window.openAddMemberSheet = openAddMemberSheet;
window.closeAddMemberSheet= closeAddMemberSheet;
window.saveMember         = saveMember;
window.markAttended       = markAttended;
window.openAptSheet       = openAptSheet;
window.openAptSheetFromCal= openAptSheetFromCal;
window.saveAptNotes       = saveAptNotes;
window.updateAptStatus    = updateAptStatus;
window.cancelApt          = cancelApt;
window.closeThenOpenProfile = closeThenOpenProfile;
window.closeAllSheets     = closeAllSheets;
window.openEnquirySheet   = openEnquirySheet;
window.setEnquiryStatus   = setEnquiryStatus;
window.saveEnquiryNotes   = saveEnquiryNotes;
window.acceptEnquiry      = acceptEnquiry;
window.openMessageSheet   = openMessageSheet;
window.deleteMessage      = deleteMessage;
