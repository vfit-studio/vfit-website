const { Resend } = require('resend');

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

// Email wrapper matching VFIT brand
function wrap(content) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#faf7f2;font-family:Arial,'Helvetica Neue',sans-serif;">
<div style="max-width:540px;margin:0 auto;background:#fefcf8;">
  <div style="text-align:center;padding:40px 24px 32px;border-bottom:1px solid #e8e0d4;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:normal;letter-spacing:0.2em;color:#3d3530;margin:0;">VFIT</h1>
    <p style="font-size:11px;letter-spacing:0.15em;color:#c9b99a;margin:8px 0 0;text-transform:uppercase;">Boutique Fitness Studio</p>
  </div>
  <div style="padding:48px 36px;">${content}</div>
  <div style="padding:28px 36px;border-top:1px solid #e8e0d4;text-align:center;">
    <p style="font-size:11px;color:#c9b99a;margin:0;letter-spacing:0.05em;">VFIT — Shop 8/203 Margaret St, Toowoomba City QLD 4350</p>
    <p style="font-size:11px;color:#e8e0d4;margin:8px 0 0;"><a href="https://www.instagram.com/valdalfit" style="color:#c9b99a;text-decoration:none;">@valdalfit</a></p>
  </div>
</div>
</body>
</html>`;
}

// ─── NOTIFICATION SIGNUP CONFIRMATION ───
async function sendNotifyConfirmation(to, name, interest) {
  const resend = getResend();
  if (!resend) return;
  const firstName = (name || 'there').split(' ')[0];
  const eventName = interest ? interest.replace(' — Notify Me', '').replace(' — Waitlist', '') : 'upcoming sessions';

  await resend.emails.send({
    from: 'VFIT Studio <notifications@valdalfit.com.au>',
    to: [to],
    subject: "You're on the list ✓",
    html: wrap(`
      <h2 style="font-family:Georgia,serif;font-size:26px;font-weight:normal;color:#3d3530;margin:0 0 16px;">You're on the list, ${firstName}.</h2>
      <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 24px;">We'll send you an email the moment bookings open for <strong>${eventName}</strong>. Spots go fast — you'll want to be ready.</p>
      <div style="background:#f5f0e8;padding:20px 28px;border-left:3px solid #c9b99a;margin:0 0 24px;">
        <p style="font-size:13px;color:#8c7660;margin:0;line-height:1.7;">Keep an eye on your inbox. When you get the email, click the link and book before spots fill up.</p>
      </div>
      <p style="font-size:13px;color:#8c7660;margin:0;">See you soon,<br><em>The VFIT Team</em></p>
    `)
  }).catch(err => console.error('Email error:', err));
}

// ─── BOOKINGS ARE OPEN NOTIFICATION ───
async function sendBookingsOpenEmail(to, name, eventName, siteUrl) {
  const resend = getResend();
  if (!resend) return;
  const firstName = (name || 'there').split(' ')[0];

  await resend.emails.send({
    from: 'VFIT Studio <notifications@valdalfit.com.au>',
    to: [to],
    subject: `${eventName} — Bookings Now Open!`,
    html: wrap(`
      <h2 style="font-family:Georgia,serif;font-size:26px;font-weight:normal;color:#3d3530;margin:0 0 16px;">Bookings are open, ${firstName}!</h2>
      <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 28px;"><strong>${eventName}</strong> bookings are now live. Spots are limited and fill up fast — don't miss out.</p>
      <div style="text-align:center;margin:0 0 32px;">
        <a href="${siteUrl}" style="display:inline-block;padding:16px 44px;background:#3d3530;color:#fefcf8;text-decoration:none;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;font-family:Arial,sans-serif;">Book Now</a>
      </div>
      <p style="font-size:13px;color:#8c7660;margin:0;text-align:center;">Be quick — once they're gone, they're gone.</p>
    `)
  }).catch(err => console.error('Email error:', err));
}

// ─── BOOKING CONFIRMATION ───
async function sendBookingConfirmation(to, name, eventName, sessionInfo) {
  const resend = getResend();
  if (!resend) return;
  const firstName = (name || 'there').split(' ')[0];

  await resend.emails.send({
    from: 'VFIT Studio <bookings@valdalfit.com.au>',
    to: [to],
    subject: `Booking Confirmed — ${eventName} ✓`,
    html: wrap(`
      <h2 style="font-family:Georgia,serif;font-size:26px;font-weight:normal;color:#3d3530;margin:0 0 16px;">You're booked, ${firstName}.</h2>
      <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 24px;">Your spot for <strong>${eventName}</strong> is confirmed.</p>
      <div style="background:#f5f0e8;padding:20px 28px;border-left:3px solid #c9b99a;margin:0 0 24px;">
        <p style="font-size:13px;color:#8c7660;margin:0;line-height:1.7;">${sessionInfo}</p>
      </div>
      <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 24px;">See you there! If you need to cancel or have questions, just reply to this email.</p>
      <p style="font-size:13px;color:#8c7660;margin:0;">— <em>The VFIT Team</em></p>
    `)
  }).catch(err => console.error('Email error:', err));
}

// ─── MEMBERSHIP ENQUIRY CONFIRMATION ───
async function sendMembershipConfirmation(to, name, plan) {
  const resend = getResend();
  if (!resend) return;
  const firstName = (name || 'there').split(' ')[0];

  await resend.emails.send({
    from: 'VFIT Studio <memberships@valdalfit.com.au>',
    to: [to],
    subject: 'VFIT Membership Enquiry Received ✓',
    html: wrap(`
      <h2 style="font-family:Georgia,serif;font-size:26px;font-weight:normal;color:#3d3530;margin:0 0 16px;">Thanks, ${firstName}.</h2>
      <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 24px;">We've received your enquiry for the <strong>${plan}</strong>.</p>
      <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 24px;">Georgie will be in touch within 24 hours to discuss your placement and get you started.</p>
      <div style="background:#f5f0e8;padding:20px 28px;border-left:3px solid #c9b99a;margin:0 0 24px;">
        <p style="font-size:13px;color:#8c7660;margin:0;line-height:1.7;">VFIT Private Studio<br>Shop 8/203 Margaret St, Toowoomba City QLD 4350</p>
      </div>
      <p style="font-size:13px;color:#8c7660;margin:0;">— <em>The VFIT Team</em></p>
    `)
  }).catch(err => console.error('Email error:', err));
}

// ─── WAITLIST SPOT OPENED NOTIFICATION ───
async function sendWaitlistSpotEmail(to, name, eventName, siteUrl) {
  const resend = getResend();
  if (!resend) return;
  const firstName = (name || 'there').split(' ')[0];

  await resend.emails.send({
    from: 'VFIT Studio <notifications@valdalfit.com.au>',
    to: [to],
    subject: `A spot just opened up — ${eventName}!`,
    html: wrap(`
      <h2 style="font-family:Georgia,serif;font-size:26px;font-weight:normal;color:#3d3530;margin:0 0 16px;">Good news, ${firstName}!</h2>
      <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 28px;">A spot just opened up for <strong>${eventName}</strong>! Book now before it's gone.</p>
      <div style="text-align:center;margin:0 0 32px;">
        <a href="${siteUrl}" style="display:inline-block;padding:16px 44px;background:#3d3530;color:#fefcf8;text-decoration:none;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;font-family:Arial,sans-serif;">Book Now</a>
      </div>
      <p style="font-size:13px;color:#8c7660;margin:0;text-align:center;">Be quick — once it's gone, it's gone.</p>
    `)
  }).catch(err => console.error('Email error:', err));
}

// ─── POST-SESSION REVIEW REQUEST ───
async function sendReviewRequestEmail(to, name, eventName, reviewBaseUrl) {
  const resend = getResend();
  if (!resend) return;
  const firstName = (name || 'there').split(' ')[0];

  // Build star links as simple styled buttons
  const starButtons = [1, 2, 3, 4, 5].map(n => {
    const url = `${reviewBaseUrl}&rating=${n}&email=${encodeURIComponent(to)}`;
    return `<a href="${url}" style="display:inline-block;padding:10px 14px;margin:4px;background:${n >= 4 ? '#3d3530' : '#f5f0e8'};color:${n >= 4 ? '#fefcf8' : '#6b5e52'};text-decoration:none;font-size:12px;border-radius:4px;">${n}</a>`;
  }).join('');

  await resend.emails.send({
    from: 'VFIT Studio <feedback@valdalfit.com.au>',
    to: [to],
    subject: `How was ${eventName}?`,
    html: wrap(`
      <h2 style="font-family:Georgia,serif;font-size:26px;font-weight:normal;color:#3d3530;margin:0 0 16px;">How was your session, ${firstName}?</h2>
      <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 24px;">We'd love your feedback on <strong>${eventName}</strong>. Tap a rating below:</p>
      <div style="text-align:center;margin:0 0 32px;">
        ${starButtons}
      </div>
      <p style="font-size:13px;color:#8c7660;margin:0;text-align:center;">Thanks for being part of VFIT.</p>
    `)
  }).catch(err => console.error('Email error:', err));
}

// ─── MEMBER WELCOME + AGREEMENT LINK ───
async function sendWelcomeEmail(to, name, plan, slotLines, agreementUrl, ownerPhone) {
  const resend = getResend();
  if (!resend) return;
  const firstName = (name || 'there').split(' ')[0];
  const phoneDisplay = ownerPhone || '0417 645 924';
  const phoneTel = phoneDisplay.replace(/\s+/g, '');

  const slotsHtml = (slotLines && slotLines.length)
    ? `<ul style="margin:0;padding-left:18px;color:#6b5e52;font-size:14px;line-height:2;">${slotLines.map((s) => `<li>${s}</li>`).join('')}</ul>`
    : `<p style="font-size:13px;color:#8c7660;margin:0;font-style:italic;">I'll confirm your exact weekly slots shortly.</p>`;

  await resend.emails.send({
    from: 'VFIT Studio <memberships@valdalfit.com.au>',
    to: [to],
    subject: `Welcome to VFIT, ${firstName} ✦`,
    html: wrap(`
      <h2 style="font-family:Georgia,serif;font-size:26px;font-weight:normal;color:#3d3530;margin:0 0 16px;">Welcome, ${firstName}.</h2>
      <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 20px;">I'm so glad to have you joining VFIT. Your placement on the <strong>${plan}</strong> is confirmed, and here are your weekly sessions:</p>
      <div style="background:#f5f0e8;padding:22px 28px;border-left:3px solid #c9b99a;margin:0 0 28px;">
        ${slotsHtml}
      </div>
      <p style="font-size:14px;line-height:1.8;color:#6b5e52;margin:0 0 20px;">Before your first session, please take a moment to read through and confirm our liability waiver and cancellation policy. It takes less than a minute.</p>
      <div style="text-align:center;margin:0 0 32px;">
        <a href="${agreementUrl}" style="display:inline-block;padding:16px 44px;background:#3d3530;color:#fefcf8;text-decoration:none;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;font-family:Arial,sans-serif;">Review &amp; Confirm</a>
      </div>
      <p style="font-size:13px;color:#8c7660;margin:0 0 8px;line-height:1.7;">Any questions at all — reply to this email or text me directly on <a href="tel:${phoneTel}" style="color:#8c7660;">${phoneDisplay}</a>.</p>
      <p style="font-size:13px;color:#8c7660;margin:18px 0 0;">&mdash; <em>Georgie</em></p>
    `)
  }).catch(err => console.error('Welcome email error:', err));
}

// ─── OWNER NOTIFICATION (Georgie gets this) ───
async function sendOwnerAlert(subject, bodyHtml) {
  const resend = getResend();
  if (!resend || !process.env.OWNER_EMAIL) return;

  await resend.emails.send({
    from: 'VFIT System <alerts@valdalfit.com.au>',
    to: [process.env.OWNER_EMAIL],
    subject: subject,
    html: wrap(bodyHtml)
  }).catch(err => console.error('Owner email error:', err));
}

module.exports = {
  sendNotifyConfirmation,
  sendBookingsOpenEmail,
  sendBookingConfirmation,
  sendMembershipConfirmation,
  sendWelcomeEmail,
  sendOwnerAlert,
  sendWaitlistSpotEmail,
  sendReviewRequestEmail,
};
