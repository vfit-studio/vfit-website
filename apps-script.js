// ═══════════════════════════════════════════════════════════
// VFIT BOOKING SYSTEM — Google Apps Script
//
// SETUP:
// 1. Create a Google Sheet with these tabs (exact names):
//    - Config
//    - RunClub
//    - Pilattes
//    - Memberships
//    - Notifications
//    - Contact
//
// 2. In the "Config" tab, set up these rows:
//    Row 1: Headers → Key | Value
//    Row 2: rc_tickets_open | 2026-03-22T08:00:00+10:00
//    Row 3: rc_session_date | 2026-03-24T05:15:00+10:00
//    Row 4: rc_spots_total | 20
//    Row 5: pl_tickets_open | 2026-04-12T08:00:00+10:00
//    Row 6: pl_session_date | 2026-04-19T07:00:00+10:00
//    Row 7: pl_spots_total | 15
//    Row 8: notify_email | georgie@valdalfit.com
//
// 3. In each booking tab (RunClub, Pilattes, Memberships, Contact, Notifications),
//    set Row 1 headers:
//    RunClub: Name | Email | Phone | Date | Status
//    Pilattes: Name | Email | Phone | Date | Status
//    Memberships: Name | Email | Phone | Plan | Sessions | Days | Times | Notes | Date | Status
//    Notifications: Email | Name | Interest | Date
//    Contact: Name | Email | Phone | Message | Date
//
// 4. Go to Extensions → Apps Script
// 5. Paste this entire code
// 6. Click Deploy → New Deployment → Web App
//    - Execute as: Me
//    - Who has access: Anyone
// 7. Copy the deployment URL and paste it into your website's BOOKING_API constant
// ═══════════════════════════════════════════════════════════

var SHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();

// ─── Handle GET requests (fetch config + spots) ───
function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var config = getConfigData(ss);

  // Count confirmed bookings to calculate spots remaining
  var rcBooked = countConfirmedBookings(ss, 'RunClub');
  var plBooked = countConfirmedBookings(ss, 'Pilattes');

  var response = {
    runclub: {
      ticketsOpen: config.rc_tickets_open || '',
      sessionDate: config.rc_session_date || '',
      spotsTotal: parseInt(config.rc_spots_total) || 20,
      spotsRemaining: Math.max(0, (parseInt(config.rc_spots_total) || 20) - rcBooked),
    },
    pilattes: {
      ticketsOpen: config.pl_tickets_open || '',
      sessionDate: config.pl_session_date || '',
      spotsTotal: parseInt(config.pl_spots_total) || 15,
      spotsRemaining: Math.max(0, (parseInt(config.pl_spots_total) || 15) - plBooked),
    }
  };

  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Handle POST requests (form submissions) ───
function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var config = getConfigData(ss);
  var data;

  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ success: false, error: 'Invalid JSON' });
  }

  var type = data.type || 'contact';
  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'Australia/Brisbane', 'yyyy-MM-dd HH:mm:ss');

  switch (type) {
    case 'runclub':
      return handleBooking(ss, config, 'RunClub', data, dateStr, 'rc');

    case 'pilattes':
      return handleBooking(ss, config, 'Pilattes', data, dateStr, 'pl');

    case 'membership':
      return handleMembership(ss, config, data, dateStr);

    case 'notification':
      return handleNotification(ss, config, data, dateStr);

    case 'waitlist':
      return handleNotification(ss, config, data, dateStr);

    case 'contact':
      return handleContact(ss, config, data, dateStr);

    default:
      return jsonResponse({ success: false, error: 'Unknown type' });
  }
}

// ─── BOOKING HANDLER (Run Club / Pi'lattes) ───
function handleBooking(ss, config, sheetName, data, dateStr, prefix) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return jsonResponse({ success: false, error: 'Sheet not found' });

  // Check spots
  var total = parseInt(config[prefix + '_spots_total']) || 20;
  var booked = countConfirmedBookings(ss, sheetName);
  if (booked >= total) {
    return jsonResponse({ success: false, error: 'sold_out', message: 'Sorry, all spots are taken!' });
  }

  // Check for duplicate email for this session
  var sessionDate = config[prefix + '_session_date'] || '';
  if (isDuplicateBooking(sheet, data.email, sessionDate)) {
    return jsonResponse({ success: false, error: 'duplicate', message: 'You\'ve already booked for this session!' });
  }

  // Add booking
  sheet.appendRow([
    data.name || '',
    data.email || '',
    data.phone || '',
    dateStr,
    'Confirmed'
  ]);

  // Send confirmation email
  var eventName = sheetName === 'RunClub' ? 'Run Club (Track Tuesday)' : "Pi'lattes at The Dairy";
  var sessionInfo = sheetName === 'RunClub'
    ? 'Every Tuesday · 5:15 AM · Glennie School Track'
    : formatNiceDate(sessionDate) + ' · 7:00 AM · The Dairy, Ravensbourne';

  sendConfirmationEmail(data.email, data.name, eventName, sessionInfo);

  // Notify Georgie
  var notifyEmail = config.notify_email || '';
  if (notifyEmail) {
    sendOwnerNotification(notifyEmail, data, eventName, booked + 1, total);
  }

  // Return updated spots
  var newRemaining = Math.max(0, total - (booked + 1));
  return jsonResponse({
    success: true,
    message: 'Booking confirmed!',
    spotsRemaining: newRemaining
  });
}

// ─── MEMBERSHIP HANDLER ───
function handleMembership(ss, config, data, dateStr) {
  var sheet = ss.getSheetByName('Memberships');
  if (!sheet) return jsonResponse({ success: false, error: 'Sheet not found' });

  sheet.appendRow([
    data.name || '',
    data.email || '',
    data.phone || '',
    data.plan || '',
    data.sessions || '',
    data.days || '',
    data.times || '',
    data.notes || '',
    dateStr,
    'New Enquiry'
  ]);

  // Send confirmation
  sendMembershipConfirmation(data.email, data.name, data.plan);

  // Notify Georgie
  var notifyEmail = config.notify_email || '';
  if (notifyEmail) {
    sendMembershipNotification(notifyEmail, data);
  }

  return jsonResponse({ success: true, message: 'Enquiry sent!' });
}

// ─── NOTIFICATION HANDLER (Get Notified / Waitlist) ───
function handleNotification(ss, config, data, dateStr) {
  var sheet = ss.getSheetByName('Notifications');
  if (!sheet) return jsonResponse({ success: false, error: 'Sheet not found' });

  // Check for duplicate
  var emails = sheet.getRange(2, 1, Math.max(1, sheet.getLastRow() - 1), 1).getValues();
  var interest = data.interest || '';
  for (var i = 0; i < emails.length; i++) {
    if (emails[i][0].toString().toLowerCase() === (data.email || '').toLowerCase()) {
      // Already on the list — that's fine, just confirm
      return jsonResponse({ success: true, message: "You're on the list!" });
    }
  }

  sheet.appendRow([
    data.email || '',
    data.name || '',
    interest,
    dateStr
  ]);

  // Send confirmation
  sendNotificationConfirmation(data.email, data.name, interest);

  return jsonResponse({ success: true, message: "You're on the list! We'll notify you when bookings open." });
}

// ─── CONTACT HANDLER ───
function handleContact(ss, config, data, dateStr) {
  var sheet = ss.getSheetByName('Contact');
  if (!sheet) return jsonResponse({ success: false, error: 'Sheet not found' });

  sheet.appendRow([
    data.name || '',
    data.email || '',
    data.phone || '',
    data.message || '',
    dateStr
  ]);

  // Notify Georgie
  var notifyEmail = config.notify_email || '';
  if (notifyEmail) {
    MailApp.sendEmail({
      to: notifyEmail,
      subject: 'New VFIT Contact Message — ' + (data.name || 'Unknown'),
      htmlBody: '<h2>New Contact Message</h2>' +
        '<p><strong>Name:</strong> ' + (data.name || '') + '</p>' +
        '<p><strong>Email:</strong> ' + (data.email || '') + '</p>' +
        '<p><strong>Phone:</strong> ' + (data.phone || '') + '</p>' +
        '<p><strong>Message:</strong> ' + (data.message || 'No message') + '</p>' +
        '<br><p style="color:#999;">— VFIT Booking System</p>'
    });
  }

  return jsonResponse({ success: true, message: 'Message sent!' });
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

function getConfigData(ss) {
  var sheet = ss.getSheetByName('Config');
  if (!sheet) return {};
  var data = sheet.getDataRange().getValues();
  var config = {};
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) config[data[i][0].toString().trim()] = data[i][1].toString().trim();
  }
  return config;
}

function countConfirmedBookings(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() <= 1) return 0;
  var statuses = sheet.getRange(2, 5, sheet.getLastRow() - 1, 1).getValues();
  var count = 0;
  for (var i = 0; i < statuses.length; i++) {
    if (statuses[i][0] === 'Confirmed') count++;
  }
  return count;
}

function isDuplicateBooking(sheet, email, sessionDate) {
  if (!email || sheet.getLastRow() <= 1) return false;
  var data = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0].toString().toLowerCase() === email.toLowerCase()) return true;
  }
  return false;
}

function formatNiceDate(dateStr) {
  try {
    var d = new Date(dateStr);
    var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()];
  } catch(e) {
    return dateStr;
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════
// EMAIL TEMPLATES
// ═══════════════════════════════════════════════════════════

function emailWrapper(content) {
  return '<div style="max-width:520px;margin:0 auto;font-family:Arial,sans-serif;color:#3d3530;">' +
    '<div style="text-align:center;padding:32px 0;border-bottom:1px solid #e8e0d4;">' +
      '<h1 style="font-family:Georgia,serif;font-size:28px;font-weight:normal;letter-spacing:0.15em;color:#3d3530;margin:0;">VFIT</h1>' +
    '</div>' +
    '<div style="padding:40px 24px;">' + content + '</div>' +
    '<div style="padding:24px;border-top:1px solid #e8e0d4;text-align:center;color:#c9b99a;font-size:12px;">' +
      '<p>VFIT — Boutique Fitness Studio</p>' +
      '<p>Shop 8/203 Margaret St, Toowoomba City QLD 4350</p>' +
    '</div>' +
  '</div>';
}

function sendConfirmationEmail(to, name, eventName, sessionInfo) {
  var firstName = (name || 'there').split(' ')[0];
  var html = emailWrapper(
    '<h2 style="font-family:Georgia,serif;font-size:24px;font-weight:normal;color:#3d3530;">You\'re booked, ' + firstName + '.</h2>' +
    '<p style="font-size:14px;line-height:1.8;color:#6b5e52;">Your spot for <strong>' + eventName + '</strong> is confirmed.</p>' +
    '<div style="background:#f5f0e8;padding:20px 24px;margin:24px 0;border-left:3px solid #c9b99a;">' +
      '<p style="font-size:13px;color:#8c7660;margin:0;">' + sessionInfo + '</p>' +
    '</div>' +
    '<p style="font-size:14px;line-height:1.8;color:#6b5e52;">See you there! If you need to cancel or have questions, just reply to this email.</p>'
  );

  MailApp.sendEmail({
    to: to,
    subject: 'Booking Confirmed — ' + eventName + ' ✓',
    htmlBody: html
  });
}

function sendMembershipConfirmation(to, name, plan) {
  var firstName = (name || 'there').split(' ')[0];
  var html = emailWrapper(
    '<h2 style="font-family:Georgia,serif;font-size:24px;font-weight:normal;color:#3d3530;">Thanks, ' + firstName + '.</h2>' +
    '<p style="font-size:14px;line-height:1.8;color:#6b5e52;">We\'ve received your enquiry for the <strong>' + (plan || 'VFIT') + '</strong>.</p>' +
    '<p style="font-size:14px;line-height:1.8;color:#6b5e52;">Georgie will be in touch within 24 hours to discuss your placement and get you started.</p>' +
    '<div style="background:#f5f0e8;padding:20px 24px;margin:24px 0;border-left:3px solid #c9b99a;">' +
      '<p style="font-size:13px;color:#8c7660;margin:0;">VFIT Private Studio<br>Shop 8/203 Margaret St, Toowoomba City QLD 4350</p>' +
    '</div>'
  );

  MailApp.sendEmail({
    to: to,
    subject: 'VFIT Membership Enquiry Received',
    htmlBody: html
  });
}

function sendNotificationConfirmation(to, name, interest) {
  var firstName = (name || 'there').split(' ')[0];
  var html = emailWrapper(
    '<h2 style="font-family:Georgia,serif;font-size:24px;font-weight:normal;color:#3d3530;">You\'re on the list, ' + firstName + '.</h2>' +
    '<p style="font-size:14px;line-height:1.8;color:#6b5e52;">We\'ll let you know as soon as bookings open' + (interest ? ' for <strong>' + interest.replace(' — Notify Me','').replace(' — Waitlist','') + '</strong>' : '') + '.</p>' +
    '<p style="font-size:14px;line-height:1.8;color:#6b5e52;">Keep an eye on your inbox — spots go fast!</p>'
  );

  MailApp.sendEmail({
    to: to,
    subject: 'VFIT — You\'re on the notification list',
    htmlBody: html
  });
}

function sendOwnerNotification(to, data, eventName, bookedCount, totalSpots) {
  MailApp.sendEmail({
    to: to,
    subject: 'New Booking — ' + eventName + ' (' + bookedCount + '/' + totalSpots + ')',
    htmlBody: '<h2>New Booking</h2>' +
      '<p><strong>Event:</strong> ' + eventName + '</p>' +
      '<p><strong>Name:</strong> ' + (data.name || '') + '</p>' +
      '<p><strong>Email:</strong> ' + (data.email || '') + '</p>' +
      '<p><strong>Phone:</strong> ' + (data.phone || '') + '</p>' +
      '<p><strong>Spots:</strong> ' + bookedCount + ' / ' + totalSpots + ' booked</p>' +
      '<br><p style="color:#999;">— VFIT Booking System</p>'
  });
}

function sendMembershipNotification(to, data) {
  MailApp.sendEmail({
    to: to,
    subject: 'New Membership Enquiry — ' + (data.plan || 'Unknown Plan'),
    htmlBody: '<h2>New Membership Enquiry</h2>' +
      '<p><strong>Plan:</strong> ' + (data.plan || '') + '</p>' +
      '<p><strong>Name:</strong> ' + (data.name || '') + '</p>' +
      '<p><strong>Email:</strong> ' + (data.email || '') + '</p>' +
      '<p><strong>Phone:</strong> ' + (data.phone || '') + '</p>' +
      '<p><strong>Sessions/wk:</strong> ' + (data.sessions || '') + '</p>' +
      '<p><strong>Days:</strong> ' + (data.days || '') + '</p>' +
      '<p><strong>Times:</strong> ' + (data.times || '') + '</p>' +
      '<p><strong>Notes:</strong> ' + (data.notes || 'None') + '</p>' +
      '<br><p style="color:#999;">— VFIT Booking System</p>'
  });
}

// ═══════════════════════════════════════════════════════════
// BULK NOTIFICATION SENDER
// Run this manually from Apps Script when you want to notify
// everyone that bookings are open
// ═══════════════════════════════════════════════════════════

function sendBookingOpenNotifications(eventType) {
  // eventType: 'Run Club' or "Pi'lattes"
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Notifications');
  if (!sheet || sheet.getLastRow() <= 1) return;

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var sent = 0;

  for (var i = 0; i < data.length; i++) {
    var email = data[i][0];
    var name = data[i][1];
    var interest = data[i][2];

    if (!email) continue;
    if (interest && interest.indexOf(eventType) === -1 && interest.indexOf('Notify') === -1) continue;

    var firstName = (name || 'there').split(' ')[0];
    var html = emailWrapper(
      '<h2 style="font-family:Georgia,serif;font-size:24px;font-weight:normal;color:#3d3530;">Bookings are open, ' + firstName + '!</h2>' +
      '<p style="font-size:14px;line-height:1.8;color:#6b5e52;"><strong>' + eventType + '</strong> bookings are now live. Spots are limited — book yours before they\'re gone.</p>' +
      '<div style="text-align:center;margin:32px 0;">' +
        '<a href="https://vfit-studio.netlify.app" style="display:inline-block;padding:14px 40px;background:#3d3530;color:#fefcf8;text-decoration:none;font-size:12px;letter-spacing:0.2em;text-transform:uppercase;">Book Now</a>' +
      '</div>'
    );

    try {
      MailApp.sendEmail({
        to: email,
        subject: eventType + ' — Bookings Now Open!',
        htmlBody: html
      });
      sent++;
    } catch(e) {
      // Skip failed emails
    }
  }

  Logger.log('Sent ' + sent + ' notification emails for ' + eventType);
}

// Quick functions to run from Apps Script menu
function notifyRunClub() { sendBookingOpenNotifications('Run Club'); }
function notifyPilattes() { sendBookingOpenNotifications("Pi'lattes"); }
