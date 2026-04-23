// VFIT Member Agreement — loads member details via token, collects liability + cancellation confirmation.
var API = '/.netlify/functions/api';

var DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getToken() {
  var p = new URLSearchParams(window.location.search);
  return p.get('token') || '';
}

function planKey(plan) {
  var p = String(plan || '').toLowerCase();
  if (p.indexOf('vip') >= 0) return 'vip';
  if (p.indexOf('flex') >= 0) return 'flexible';
  if (p.indexOf('signature') >= 0) return 'signature';
  return 'signature';
}

function cancellationHtml(plan) {
  var k = planKey(plan);
  if (k === 'flexible') {
    return '' +
      '<p><strong>Flexible Membership</strong> operates on a no lock-in basis.</p>' +
      '<p><strong>Session cancellations:</strong> a minimum of <strong>4 weeks written notice</strong> is required to cancel or reschedule a scheduled session. Where notice of less than 4 weeks is provided, the full session fee of $70 will be charged regardless of attendance.</p>' +
      '<p><strong>Membership termination:</strong> you may terminate your Flexible Membership at any time without penalty. There is no minimum commitment period. Termination takes effect immediately upon written notice to Georgie, and no further sessions will be charged from that date.</p>';
  }
  // Signature & VIP share the same commitment terms
  var label = k === 'vip' ? 'VIP Membership' : 'Signature Membership';
  return '' +
    '<p><strong>' + label + '</strong> is subject to a minimum 3-month commitment.</p>' +
    '<p><strong>Session cancellations:</strong> a minimum of <strong>1 week&rsquo;s written notice</strong> is required to cancel or reschedule a scheduled session. Where less notice is provided, the full session fee will be charged regardless of attendance.</p>' +
    '<p><strong>Minimum term:</strong> you are committed to a minimum period of 3 months from your membership start date. Sessions will continue to be billed throughout this period regardless of attendance.</p>' +
    '<p><strong>Membership termination:</strong> following the completion of your 3-month minimum term, you may terminate by providing a minimum of <strong>1 month&rsquo;s written notice</strong>. Early termination within the minimum term is not permitted, except in the case of a medical condition supported by a valid doctor&rsquo;s certificate.</p>';
}

var WAIVER_HTML = '' +
  '<h4>Liability Waiver</h4>' +
  '<p>By ticking the box (marked &lsquo;I Agree&rsquo;) you hereby acknowledge and agree to the terms and conditions below in consideration of your participation in a session of personal training, stretch therapy, pilates, running or other physical activity (referred to as &ldquo;the Session&rdquo;) with Georgie Valdal, her employees, agents, guides, contractors, and affiliates (referred to as &ldquo;VFit&rdquo;).</p>' +
  '<h4>1. Assumption of risks</h4>' +
  '<p>a. You understand and acknowledge that the Session may involve certain inherent risks and dangers, including but not limited to:</p>' +
  '<ol type="i"><li>High levels of physical exertion, including cardiovascular exertion, and other activities that require a high level of fitness; and/or</li>' +
  '<li>Potential accidents, injuries, illnesses, or property damage caused by unpredictable factors or third parties.</li></ol>' +
  '<p>b. You assume full responsibility for any injury, loss, or damage that you may sustain as a result of participating in the Session.</p>' +
  '<h4>2. Medical conditions</h4>' +
  '<p>a. You understand that it is your responsibility, and not VFit&rsquo;s, to:</p>' +
  '<ol type="i"><li>Ensure that you have an adequate understanding of your own health and physical condition before participating in the Session, and that if you are unsure in that regard, to seek medical advice before participating in the Session;</li>' +
  '<li>Ensure that you have appropriate medical insurance coverage to cover any medical treatment or emergencies that may arise during the Session; and</li>' +
  '<li>Disclose any physical limitations, disabilities, ailments or impairments which may affect your ability to participate in the Session.</li></ol>' +
  '<p>b. You hereby represent and warrant that:</p>' +
  '<ol type="i"><li>You are fully aware of your own health and physical condition;</li>' +
  '<li>If you have any physical limitations, disabilities, ailments or impairments, you have disclosed those matters to VFit prior to entering into this agreement;</li>' +
  '<li>Save for any physical limitations, disabilities, ailments or impairments you have already disclosed to VFit, you are in good health and physical condition;</li>' +
  '<li>You are voluntarily participating in the Session; and</li>' +
  '<li>You are aware that your participation in the Session may be injurious to your health.</li></ol>' +
  '<h4>3. Release, waiver and indemnity</h4>' +
  '<p>a. To the fullest extent permitted by law, you hereby release, discharge, and waive any and all claims, actions, liabilities, demands, or suits of any nature whatsoever (including but not limited to those arising from negligence or any other fault) against VFit as may arise from or in connection with the Session;</p>' +
  '<p>b. To the fullest extent permitted by law, you release, indemnify and hold harmless VFit:</p>' +
  '<ol type="i"><li>From any and all claims, actions, liabilities, costs or expenses (including legal fees) arising from or in connection with your participation in the Session or in relation to this agreement; and</li>' +
  '<li>From any and all liability (save for that which is caused by the reckless conduct of VFit) for:' +
  '<ol><li>Death;</li><li>Physical or mental injury (including the aggravation, acceleration or recurrence of an existing injury); and</li><li>The contraction, aggravation or acceleration of any disease.</li></ol></li></ol>' +
  '<h4>4. Governing law and jurisdiction</h4>' +
  '<p>a. This agreement will be governed by and construed in accordance with the laws of Australia.</p>' +
  '<p>b. Any disputes arising from or in connection with this agreement will be subject to the exclusive jurisdiction of the courts of Queensland.</p>' +
  '<h4>5. Acknowledgment</h4>' +
  '<p>a. You:</p>' +
  '<ol type="i"><li>Acknowledge that you have carefully read and understood this agreement;</li>' +
  '<li>Voluntarily agree to be bound by the terms of this agreement; and</li>' +
  '<li>Understand that this agreement applies to any Session that you undertake with VFit either before or after agreeing to the above terms.</li></ol>';

function renderBody(data) {
  var firstName = (data.name || 'there').split(' ')[0];
  var slotsHtml;
  if (data.slots && data.slots.length) {
    slotsHtml = '<ul>' + data.slots.map(function(s) {
      return '<li>' + esc(DAY_NAMES[s.day_of_week] || 'Day') + ' &middot; ' + esc(s.time) + '</li>';
    }).join('') + '</ul>';
  } else {
    slotsHtml = '<p class="a-slots-note">Your exact weekly sessions will be confirmed with you directly.</p>';
  }

  var html = '' +
    '<h2 class="a-greeting">Welcome, <em>' + esc(firstName) + '.</em></h2>' +
    '<p class="a-intro">You&rsquo;re in. Before your first session, please review your weekly sessions and confirm the agreement below.</p>' +
    '<div class="a-section">' +
      '<h3>Your sessions</h3>' +
      '<p style="font-size:13px;color:var(--bark);margin:0 0 8px;">' + esc(data.plan || 'Membership') + (data.sessions_per_week ? ' &middot; ' + data.sessions_per_week + 'x per week' : '') + '</p>' +
      '<div class="a-slots">' + slotsHtml + '</div>' +
    '</div>' +
    '<div class="a-section">' +
      '<h3>Cancellation &amp; commitment policy</h3>' +
      '<div class="a-legal">' + cancellationHtml(data.plan) + '</div>' +
    '</div>' +
    '<div class="a-section">' +
      '<h3>Liability waiver &amp; terms</h3>' +
      '<div class="a-legal">' + WAIVER_HTML + '</div>' +
    '</div>' +
    '<div id="a-err" class="a-err"></div>' +
    '<div class="a-confirm-row">' +
      '<input type="checkbox" id="a-chk-cancel"><label for="a-chk-cancel">I have read and agree to the cancellation and commitment policy above.</label>' +
    '</div>' +
    '<div class="a-confirm-row">' +
      '<input type="checkbox" id="a-chk-waiver"><label for="a-chk-waiver">I have read and agree to the liability waiver and terms above.</label>' +
    '</div>' +
    '<button class="a-btn" id="a-confirm-btn" disabled>Confirm &amp; Agree</button>';

  document.getElementById('a-body').innerHTML = html;
  document.getElementById('a-body').style.display = 'block';

  var chk1 = document.getElementById('a-chk-cancel');
  var chk2 = document.getElementById('a-chk-waiver');
  var btn = document.getElementById('a-confirm-btn');
  function updateBtn() { btn.disabled = !(chk1.checked && chk2.checked); }
  chk1.addEventListener('change', updateBtn);
  chk2.addEventListener('change', updateBtn);
  btn.addEventListener('click', confirmAgreement);
}

function showError(msg) {
  document.getElementById('a-loading').style.display = 'none';
  document.getElementById('a-body').style.display = 'none';
  var e = document.getElementById('a-error');
  e.textContent = msg;
  e.style.display = 'block';
}

function showDone(alreadyAgreed) {
  document.getElementById('a-body').style.display = 'none';
  document.getElementById('a-loading').style.display = 'none';
  var done = document.getElementById('a-done');
  if (alreadyAgreed) {
    document.getElementById('a-done-msg').textContent = 'Your agreement was already on file. Thanks for confirming.';
  }
  done.style.display = 'block';
}

async function loadAgreement() {
  var token = getToken();
  if (!token) { showError('No agreement token provided. If you received a link by email, please use that link directly.'); return; }

  try {
    var r = await fetch(API + '?action=agreement&token=' + encodeURIComponent(token));
    var data = await r.json();
    if (!r.ok || !data.success) {
      showError(data && data.error === 'invalid_token' ? 'This link is invalid or has expired. Please contact Georgie for a new link.' : 'Could not load your agreement. Please try again or contact Georgie.');
      return;
    }

    document.getElementById('a-loading').style.display = 'none';

    if (data.agreed_at) { showDone(true); return; }

    renderBody(data);
  } catch (err) {
    showError('Could not connect. Please check your internet and try again.');
  }
}

async function confirmAgreement() {
  var btn = document.getElementById('a-confirm-btn');
  var err = document.getElementById('a-err');
  err.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Confirming...';

  try {
    var r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'confirm_agreement', token: getToken() })
    });
    var data = await r.json();
    if (!r.ok || !data.success) {
      err.textContent = 'Could not save your confirmation. Please try again or contact Georgie.';
      err.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Confirm & Agree';
      return;
    }
    showDone(!!data.already_agreed);
  } catch (e) {
    err.textContent = 'Could not connect. Please check your internet and try again.';
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Confirm & Agree';
  }
}

loadAgreement();
