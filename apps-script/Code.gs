/**
 * Tecumseh Local Schools — Ed Tech Conference signup backend
 * Google Apps Script web app, bound to the conference Google Sheet.
 *
 * Sheet tabs (created by setupSheet()):
 *   Sessions       SessionID | Name | Description | Location | Start | End | Presenter | Capacity | Active
 *   Registrations  Timestamp | Email | Name | SessionID | Status | Updated
 *
 * Deploy: Extensions > Apps Script > Deploy > New deployment > Web app
 *         Execute as: Me   |   Who has access: Anyone
 */

// ─── CONFIG ────────────────────────────────────────────────────────────────
var CONFIG = {
  // The Google Sheet that stores sessions and registrations.
  SHEET_ID: '1Kp42lQ-boNmbL4PI4Hl5YbruwlIE--Hcx7_53jGLiaI',
  CONFERENCE_NAME: 'Tecumseh Ed Tech Conference',
  // Only emails ending in @<ALLOWED_DOMAIN> may sign up. Lowercase, no "@".
  // Staff domain per district administrative directory (tecumseh.k12.oh.us site).
  ALLOWED_DOMAIN: 'tecumsehlocal.org',
  SIGNUPS_OPEN: true,          // flip to false to freeze signups
  SEND_CONFIRMATION_EMAIL: true,
  TIME_ZONE: 'America/New_York',
  CONTACT_EMAIL: '',           // optional reply-to address shown in emails
};

var SESSIONS_SHEET = 'Sessions';
var REG_SHEET = 'Registrations';
var SESSION_HEADERS = ['SessionID', 'Name', 'Description', 'Location', 'Start', 'End', 'Presenter', 'Capacity', 'Active'];
var REG_HEADERS = ['Timestamp', 'Email', 'Name', 'SessionID', 'Status', 'Updated'];

// ─── HTTP ENTRY POINTS ────────────────────────────────────────────────────
function doGet(e) {
  return handle_(function () {
    var p = (e && e.parameter) || {};
    switch (p.action) {
      case 'sessions': return getSessions_();
      case 'lookup':   return lookup_(p.email);
      default:         return { ok: true, service: CONFIG.CONFERENCE_NAME };
    }
  });
}

function doPost(e) {
  return handle_(function () {
    var body = {};
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
    catch (err) { throw userError_('Malformed request.'); }
    switch (body.action) {
      case 'register': return register_(body);
      case 'cancel':   return cancel_(body);
      default: throw userError_('Unknown action.');
    }
  });
}

function handle_(fn) {
  var out;
  try {
    out = fn();
  } catch (err) {
    if (err && err.userFacing) {
      out = { ok: false, error: err.message, code: err.code || 'error' };
    } else {
      console.error(err && err.stack ? err.stack : err);
      out = { ok: false, error: 'Something went wrong on the server. Please try again.', code: 'server' };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function userError_(msg, code) {
  var e = new Error(msg);
  e.userFacing = true;
  e.code = code;
  return e;
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────
function getSessions_() {
  var sessions = readSessions_();
  var counts = countActive_(readRegs_());
  return {
    ok: true,
    conference: CONFIG.CONFERENCE_NAME,
    signupsOpen: CONFIG.SIGNUPS_OPEN,
    allowedDomain: CONFIG.ALLOWED_DOMAIN,
    sessions: sessions.filter(function (s) { return s.active; }).map(function (s) {
      return publicSession_(s, counts[s.id] || 0);
    }),
  };
}

function lookup_(email) {
  email = validateEmail_(email);
  var regs = readRegs_();
  var mine = regs.filter(function (r) { return r.email === email && r.status === 'Active'; });
  var name = '';
  for (var i = regs.length - 1; i >= 0; i--) {
    if (regs[i].email === email && regs[i].name) { name = regs[i].name; break; }
  }
  return { ok: true, email: email, name: name, sessionIds: mine.map(function (r) { return r.sessionId; }) };
}

function register_(body) {
  if (!CONFIG.SIGNUPS_OPEN) throw userError_('Signups are closed.', 'closed');
  var email = validateEmail_(body.email);
  var name = validateName_(body.name);
  var sessionId = String(body.sessionId || '').trim();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw userError_('The server is busy. Please try again in a moment.', 'busy');
  var result;
  try {
    var sessions = readSessions_();
    var byId = indexById_(sessions);
    var target = byId[sessionId];
    if (!target || !target.active) throw userError_('That session is not available.', 'not_found');

    var regs = readRegs_();
    var mine = regs.filter(function (r) { return r.email === email && r.status === 'Active'; });

    if (mine.some(function (r) { return r.sessionId === sessionId; })) {
      throw userError_('You are already signed up for "' + target.name + '".', 'duplicate');
    }

    var conflict = findConflict_(target, mine.map(function (r) { return byId[r.sessionId]; }));
    if (conflict) {
      throw userError_('"' + target.name + '" overlaps with "' + conflict.name +
        '", which you are already signed up for. Drop that one first to switch.', 'conflict');
    }

    var taken = countActive_(regs)[sessionId] || 0;
    if (target.capacity > 0 && taken >= target.capacity) {
      throw userError_('Sorry, "' + target.name + '" is full.', 'full');
    }

    var now = new Date();
    getSheet_(REG_SHEET).appendRow([now, email, safeCell_(name), sessionId, 'Active', now]);
    SpreadsheetApp.flush();

    var mySessions = mine.map(function (r) { return byId[r.sessionId]; }).concat([target]);
    result = {
      ok: true,
      message: 'You are signed up for "' + target.name + '".',
      session: publicSession_(target, taken + 1),
      _email: { email: email, name: name, schedule: mySessions, change: 'Added: ' + target.name },
    };
  } finally {
    lock.releaseLock();
  }
  result.emailSent = sendConfirmation_(result._email);
  delete result._email;
  return result;
}

function cancel_(body) {
  if (!CONFIG.SIGNUPS_OPEN) throw userError_('Signups are closed, so changes are locked.', 'closed');
  var email = validateEmail_(body.email);
  var sessionId = String(body.sessionId || '').trim();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw userError_('The server is busy. Please try again in a moment.', 'busy');
  var result;
  try {
    var sheet = getSheet_(REG_SHEET);
    var values = sheet.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < values.length; i++) {
      if (normEmail_(values[i][1]) === email && String(values[i][3]).trim() === sessionId && values[i][4] === 'Active') {
        rowIndex = i; break;
      }
    }
    if (rowIndex < 0) throw userError_('You are not signed up for that session.', 'not_registered');

    sheet.getRange(rowIndex + 1, 5, 1, 2).setValues([['Cancelled', new Date()]]);
    SpreadsheetApp.flush();

    var sessions = readSessions_();
    var byId = indexById_(sessions);
    var regs = readRegs_();
    var mine = regs.filter(function (r) { return r.email === email && r.status === 'Active'; });
    var target = byId[sessionId];
    var name = String(values[rowIndex][2] || '');
    result = {
      ok: true,
      message: 'Dropped "' + (target ? target.name : sessionId) + '".',
      session: target ? publicSession_(target, countActive_(regs)[sessionId] || 0) : null,
      _email: {
        email: email, name: name,
        schedule: mine.map(function (r) { return byId[r.sessionId]; }).filter(Boolean),
        change: 'Dropped: ' + (target ? target.name : sessionId),
      },
    };
  } finally {
    lock.releaseLock();
  }
  result.emailSent = sendConfirmation_(result._email);
  delete result._email;
  return result;
}

// ─── DATA ACCESS ──────────────────────────────────────────────────────────
function ss_() {
  return CONFIG.SHEET_ID ? SpreadsheetApp.openById(CONFIG.SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet tab "' + name + '". Run setupSheet() first.');
  return sh;
}

function readSessions_() {
  var values = getSheet_(SESSIONS_SHEET).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var id = String(r[0] || '').trim();
    if (!id) continue;
    out.push({
      id: id,
      name: String(r[1] || ''),
      description: String(r[2] || ''),
      location: String(r[3] || ''),
      start: toDate_(r[4]),
      end: toDate_(r[5]),
      presenter: String(r[6] || ''),
      capacity: Number(r[7]) || 0,             // 0 or blank = unlimited
      active: !(r[8] === false || String(r[8]).toUpperCase() === 'FALSE' || String(r[8]).toUpperCase() === 'NO'),
    });
  }
  return out;
}

function readRegs_() {
  var values = getSheet_(REG_SHEET).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[1]) continue;
    out.push({
      email: normEmail_(r[1]),
      name: String(r[2] || ''),
      sessionId: String(r[3] || '').trim(),
      status: String(r[4] || ''),
    });
  }
  return out;
}

function countActive_(regs) {
  var c = {};
  regs.forEach(function (r) { if (r.status === 'Active') c[r.sessionId] = (c[r.sessionId] || 0) + 1; });
  return c;
}

function indexById_(sessions) {
  var m = {};
  sessions.forEach(function (s) { m[s.id] = s; });
  return m;
}

// ─── RULES ────────────────────────────────────────────────────────────────
function findConflict_(target, mine) {
  if (!target.start || !target.end) return null;
  for (var i = 0; i < mine.length; i++) {
    var s = mine[i];
    if (!s || !s.start || !s.end || s.id === target.id) continue;
    if (target.start < s.end && s.start < target.end) return s;
  }
  return null;
}

function normEmail_(v) { return String(v || '').trim().toLowerCase(); }

function validateEmail_(v) {
  var email = normEmail_(v);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw userError_('Please enter a valid email address.', 'bad_email');
  }
  var domain = CONFIG.ALLOWED_DOMAIN.toLowerCase().replace(/^@/, '');
  if (email.split('@')[1] !== domain) {
    throw userError_('Please use your district email address (@' + domain + ').', 'bad_domain');
  }
  return email;
}

function validateName_(v) {
  var name = String(v || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2) throw userError_('Please enter your full name.', 'bad_name');
  if (name.length > 100) throw userError_('Name is too long.', 'bad_name');
  return name;
}

// Stop user text from being interpreted as a spreadsheet formula.
function safeCell_(v) {
  var s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function toDate_(v) {
  if (v instanceof Date) return v;
  if (!v) return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function publicSession_(s, taken) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    location: s.location,
    start: s.start ? s.start.toISOString() : null,
    end: s.end ? s.end.toISOString() : null,
    presenter: s.presenter,
    capacity: s.capacity,
    taken: taken,
    seatsLeft: s.capacity > 0 ? Math.max(0, s.capacity - taken) : null,
  };
}

// ─── EMAIL ────────────────────────────────────────────────────────────────
function sendConfirmation_(info) {
  if (!CONFIG.SEND_CONFIRMATION_EMAIL || !info) return false;
  try {
    if (MailApp.getRemainingDailyQuota() < 1) {
      console.warn('Mail quota exhausted; skipped confirmation to ' + info.email);
      return false;
    }
    var schedule = info.schedule.filter(Boolean).sort(function (a, b) {
      return (a.start ? a.start.getTime() : 0) - (b.start ? b.start.getTime() : 0);
    });
    var rows = schedule.map(function (s) {
      return '<tr>' +
        '<td style="padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top">' + esc_(fmtRange_(s)) + '</td>' +
        '<td style="padding:6px 0;vertical-align:top"><b>' + esc_(s.name) + '</b><br>' +
        '<span style="color:#555">' + esc_(s.location) + (s.presenter ? ' &middot; ' + esc_(s.presenter) : '') + '</span></td>' +
        '</tr>';
    }).join('');
    var html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#201F24">' +
      '<p>Hi ' + esc_(info.name || 'there') + ',</p>' +
      '<p><b>' + esc_(info.change) + '</b></p>' +
      '<p>Your current ' + esc_(CONFIG.CONFERENCE_NAME) + ' schedule:</p>' +
      (rows ? '<table style="border-collapse:collapse">' + rows + '</table>'
            : '<p><i>You are not signed up for any sessions.</i></p>') +
      '<p style="color:#555;font-size:12px;margin-top:24px">To make changes, return to the signup page and enter this email address.</p>' +
      '</div>';
    var opts = { htmlBody: html, name: CONFIG.CONFERENCE_NAME };
    if (CONFIG.CONTACT_EMAIL) opts.replyTo = CONFIG.CONTACT_EMAIL;
    MailApp.sendEmail(info.email, CONFIG.CONFERENCE_NAME + ' — ' + info.change, stripHtml_(html), opts);
    return true;
  } catch (err) {
    console.error('Confirmation email failed: ' + err);
    return false;
  }
}

function fmtRange_(s) {
  if (!s.start) return 'TBA';
  var tz = CONFIG.TIME_ZONE;
  var day = Utilities.formatDate(s.start, tz, 'EEE, MMM d');
  var a = Utilities.formatDate(s.start, tz, 'h:mm a');
  var b = s.end ? Utilities.formatDate(s.end, tz, 'h:mm a') : '';
  return day + ', ' + a + (b ? '–' + b : '');
}

function esc_(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function stripHtml_(h) {
  return h.replace(/<br>/g, '\n').replace(/<\/(p|tr)>/g, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').trim();
}

// ─── ONE-TIME SETUP (run manually from the Apps Script editor) ────────────
function setupSheet() {
  var ss = ss_();
  ss.setSpreadsheetTimeZone(CONFIG.TIME_ZONE);

  var s = ss.getSheetByName(SESSIONS_SHEET) || ss.insertSheet(SESSIONS_SHEET);
  if (s.getLastRow() === 0) {
    s.appendRow(SESSION_HEADERS);
    var d = function (h, m) { return new Date(2026, 9, 16, h, m); }; // placeholder: Fri Oct 16 2026
    var sample = [
      ['S01', 'Session 1A (TBD)', 'Description coming soon.', 'Room 101', d(8, 30), d(9, 20), 'Presenter TBD', 30, true],
      ['S02', 'Session 1B (TBD)', 'Description coming soon.', 'Room 102', d(8, 30), d(9, 20), 'Presenter TBD', 30, true],
      ['S03', 'Session 1C (TBD)', 'Description coming soon.', 'Library',  d(8, 30), d(9, 20), 'Presenter TBD', 40, true],
      ['S04', 'Session 2A (TBD)', 'Description coming soon.', 'Room 101', d(9, 30), d(10, 20), 'Presenter TBD', 30, true],
      ['S05', 'Session 2B (TBD)', 'Description coming soon.', 'Room 102', d(9, 30), d(10, 20), 'Presenter TBD', 30, true],
      ['S06', 'Session 2C (TBD)', 'Description coming soon.', 'Library',  d(9, 30), d(10, 20), 'Presenter TBD', 40, true],
      ['S07', 'Session 3A (TBD)', 'Description coming soon.', 'Room 101', d(10, 30), d(11, 20), 'Presenter TBD', 30, true],
      ['S08', 'Session 3B (TBD)', 'Description coming soon.', 'Room 102', d(10, 30), d(11, 20), 'Presenter TBD', 30, true],
      ['S09', 'Session 3C (TBD)', 'Description coming soon.', 'Library',  d(10, 30), d(11, 20), 'Presenter TBD', 40, true],
    ];
    s.getRange(2, 1, sample.length, sample[0].length).setValues(sample);
    s.getRange('E:F').setNumberFormat('ddd m/d/yyyy h:mm am/pm');
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, SESSION_HEADERS.length).setFontWeight('bold').setBackground('#201F24').setFontColor('#FFFFFF');
    s.autoResizeColumns(1, SESSION_HEADERS.length);
  }

  var r = ss.getSheetByName(REG_SHEET) || ss.insertSheet(REG_SHEET);
  if (r.getLastRow() === 0) {
    r.appendRow(REG_HEADERS);
    r.setFrozenRows(1);
    r.getRange(1, 1, 1, REG_HEADERS.length).setFontWeight('bold').setBackground('#D52033').setFontColor('#FFFFFF');
    r.getRange('A:A').setNumberFormat('m/d/yyyy h:mm:ss');
    r.getRange('F:F').setNumberFormat('m/d/yyyy h:mm:ss');
  }

  // Roster tab: live counts per session, handy for organizers.
  var roster = ss.getSheetByName('Roster') || ss.insertSheet('Roster');
  roster.clear();
  roster.getRange('A1').setFormula(
    '=QUERY(Registrations!A:E,"select D, count(B) where E = \'Active\' group by D label D \'SessionID\', count(B) \'Signed up\'",1)');
  roster.getRange('D1').setValue('Tip: filter the Registrations tab by SessionID + Status=Active for names.');

  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
}
