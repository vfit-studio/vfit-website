/*
 * Lounge auth helpers — magic-link via Supabase Auth Admin + Resend.
 *
 * Flow:
 *   1. Member submits email on /lounge.
 *   2. Server checks `members` for a matching, agreed row.
 *   3. Server calls supabase.auth.admin.generateLink({type:'magiclink'})
 *      which returns an `action_link` without sending email itself.
 *   4. Server emails that link via Resend with VFIT branding.
 *   5. Member clicks → Supabase verifies, redirects to /lounge with
 *      access_token + refresh_token in the URL fragment.
 *   6. Frontend stores tokens, calls /api?action=lounge_me with
 *      Authorization: Bearer <access_token>.
 *   7. requireMember() verifies the token and returns the linked member.
 */

const { supabase } = require('./supabase');
const { Resend } = require('resend');

const SITE_URL = process.env.SITE_URL || 'https://vfit-studio.netlify.app';
const LOUNGE_URL = `${SITE_URL}/lounge`;

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

// Resolve the auth token from the request — either an Authorization
// header or, as a fallback, an `access_token` query param.
function extractToken(event) {
  const auth = event.headers && (event.headers.authorization || event.headers.Authorization);
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const params = event.queryStringParameters || {};
  return params.access_token || null;
}

// Verify the bearer token and return { user, member }. Lazily creates
// the member_auth link the first time a member signs in.
async function requireMember(event) {
  const token = extractToken(event);
  if (!token) {
    const err = new Error('unauthorized');
    err.statusCode = 401;
    throw err;
  }

  const { data: userResult, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userResult?.user) {
    const err = new Error('unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const user = userResult.user;

  const { data: link } = await supabase
    .from('member_auth')
    .select('member_id')
    .eq('user_id', user.id)
    .maybeSingle();

  let memberId = link?.member_id;

  if (!memberId) {
    // First sign-in for this auth user — find the matching member by email
    // and create the link. Members must already be agreed to use the lounge.
    const email = (user.email || '').toLowerCase();
    if (!email) {
      const err = new Error('forbidden');
      err.statusCode = 403;
      throw err;
    }
    const { data: member } = await supabase
      .from('members')
      .select('id, agreed_at')
      .ilike('email', email)
      .not('agreed_at', 'is', null)
      .maybeSingle();
    if (!member) {
      const err = new Error('forbidden');
      err.statusCode = 403;
      throw err;
    }
    await supabase.from('member_auth').insert({
      user_id: user.id,
      member_id: member.id,
    });
    memberId = member.id;
  } else {
    await supabase.from('member_auth').update({ last_login_at: new Date().toISOString() }).eq('user_id', user.id);
  }

  const { data: member, error: memberErr } = await supabase
    .from('members')
    .select('*')
    .eq('id', memberId)
    .single();
  if (memberErr || !member) {
    const err = new Error('forbidden');
    err.statusCode = 403;
    throw err;
  }

  return { user, member };
}

// Generate a magic-link via Supabase Auth admin and email it via Resend.
// Always resolves (silent on missing-member) so the response can't be
// used to enumerate emails.
async function sendMagicLink(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, reason: 'invalid_email' };
  }

  // Only members who've agreed to the contract can sign in to the lounge.
  const { data: member } = await supabase
    .from('members')
    .select('id, name, email, last_link_sent_at')
    .ilike('email', email)
    .not('agreed_at', 'is', null)
    .maybeSingle();
  if (!member) return { ok: true, sent: false };

  // Rate limit: 60-second cooldown per member. Silent (no info leak)
  // — we still return ok:true so anyone replaying the form can't tell
  // a member from a non-member or a quick retry from a slow one.
  if (member.last_link_sent_at) {
    const last = new Date(member.last_link_sent_at).getTime();
    if (Date.now() - last < 60_000) return { ok: true, sent: false };
  }

  const { data: link, error: linkErr } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: member.email,
    options: { redirectTo: LOUNGE_URL },
  });
  if (linkErr || !link?.properties?.action_link) {
    console.error('generateLink failed:', linkErr);
    return { ok: false, reason: 'link_failed' };
  }
  const actionLink = link.properties.action_link;

  const resend = getResend();
  if (!resend) {
    console.error('Resend not configured — cannot send magic link');
    return { ok: false, reason: 'resend_missing' };
  }

  const firstName = (member.name || 'there').split(' ')[0];
  await resend.emails.send({
    from: 'VFIT Studio <lounge@valdalfit.com.au>',
    to: [member.email],
    subject: 'Your VFIT Lounge sign-in link',
    html: magicLinkEmailHtml(firstName, actionLink),
  }).catch((err) => console.error('Magic-link email failed:', err));

  // Stamp the cooldown so the next call within 60s is a no-op.
  await supabase.from('members')
    .update({ last_link_sent_at: new Date().toISOString() })
    .eq('id', member.id);

  return { ok: true, sent: true };
}

function magicLinkEmailHtml(firstName, actionLink) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:Arial,'Helvetica Neue',sans-serif;">
<div style="max-width:540px;margin:0 auto;background:#fefcf8;">
  <div style="text-align:center;padding:44px 24px 28px;border-bottom:1px solid #e8e0d4;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:300;font-size:30px;letter-spacing:0.22em;color:#3d3530;margin:0;">VFIT</h1>
    <p style="font-size:11px;letter-spacing:0.28em;color:#c9b99a;margin:10px 0 0;text-transform:uppercase;">Member Lounge</p>
  </div>
  <div style="padding:48px 36px;">
    <h2 style="font-family:Georgia,serif;font-weight:300;font-size:26px;color:#3d3530;margin:0 0 14px;">Welcome back, ${escapeHtml(firstName)}.</h2>
    <p style="font-size:14px;line-height:1.75;color:#6b5e52;margin:0 0 28px;">Tap the button below to sign in to your member lounge. This link is good for the next fifteen minutes and can only be used once.</p>
    <div style="text-align:center;margin:0 0 32px;">
      <a href="${actionLink}" style="display:inline-block;padding:16px 44px;background:#3d3530;color:#fefcf8;text-decoration:none;font-size:11px;letter-spacing:0.24em;text-transform:uppercase;font-family:Arial,sans-serif;">Sign in to the lounge</a>
    </div>
    <p style="font-size:12px;line-height:1.7;color:#8c7660;margin:0 0 8px;">If you didn&rsquo;t request this email, you can ignore it &mdash; nothing will change.</p>
    <p style="font-size:13px;color:#8c7660;margin:24px 0 0;">&mdash; <em style="color:#8c7660;">Georgie</em></p>
  </div>
  <div style="padding:24px 36px;border-top:1px solid #e8e0d4;text-align:center;">
    <p style="font-size:11px;color:#c9b99a;margin:0;letter-spacing:0.05em;">VFIT &middot; Shop 8/203 Margaret St, Toowoomba City QLD 4350</p>
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

module.exports = {
  requireMember,
  sendMagicLink,
  extractToken,
};
