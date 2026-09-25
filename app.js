(function () {
  'use strict';

  var CFG = window.SIGNUP_CONFIG || {};
  var TZ = CFG.TIME_ZONE || 'America/New_York';
  var DEMO = !CFG.API_URL;

  var state = {
    sessions: [],
    allowedDomain: '',
    signupsOpen: true,
    user: null,          // { name, email }
    mine: new Set(),     // session ids
    busy: false,
    query: '',
  };

  var $ = function (id) { return document.getElementById(id); };

  // ─── API ──────────────────────────────────────────────────────────────
  var api = DEMO ? demoApi() : {
    get: function (params) {
      var qs = new URLSearchParams(params).toString();
      return fetch(CFG.API_URL + '?' + qs, { method: 'GET' }).then(parse);
    },
    post: function (body) {
      // text/plain avoids a CORS preflight, which Apps Script can't answer.
      return fetch(CFG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
      }).then(parse);
    },
  };

  function parse(res) {
    if (!res.ok) throw new Error('Network error (' + res.status + '). Please try again.');
    return res.json().then(function (data) {
      if (!data.ok) { var e = new Error(data.error || 'Request failed.'); e.code = data.code; throw e; }
      return data;
    });
  }

  // ─── FORMATTING ───────────────────────────────────────────────────────
  var fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
  var fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  function timeRange(s) {
    if (!s.start) return 'Time TBA';
    var a = fmtTime.format(new Date(s.start));
    return s.end ? a + ' – ' + fmtTime.format(new Date(s.end)) : a;
  }
  function slotKey(s) { return (s.start || 'zzz') + '|' + (s.end || ''); }
  function slotLabel(s) {
    if (!s.start) return 'Time to be announced';
    return fmtDay.format(new Date(s.start)) + ' · ' + timeRange(s);
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ─── RULES (mirror of server; server is the authority) ────────────────
  function overlaps(a, b) {
    if (!a.start || !a.end || !b.start || !b.end) return false;
    return new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end);
  }
  function conflictFor(s) {
    for (var i = 0; i < state.sessions.length; i++) {
      var o = state.sessions[i];
      if (o.id !== s.id && state.mine.has(o.id) && overlaps(s, o)) return o;
    }
    return null;
  }
  function validEmail(email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Please enter a valid email address.';
    if (state.allowedDomain && email.split('@')[1] !== state.allowedDomain.toLowerCase()) {
      return 'Please use your district email address (@' + state.allowedDomain + ').';
    }
    return '';
  }

  // ─── RENDER ───────────────────────────────────────────────────────────
  function render() {
    renderIdentity();
    renderSchedule();
    renderSessions();
  }

  function renderIdentity() {
    var hasUser = !!state.user;
    $('identity-form').hidden = hasUser;
    $('identity-summary').hidden = !hasUser;
    if (hasUser) {
      $('who-name').textContent = state.user.name;
      $('who-email').textContent = state.user.email;
    }
    $('domain-hint').textContent = state.allowedDomain ? 'Must end in @' + state.allowedDomain : '';
  }

  function renderSchedule() {
    var mine = state.sessions.filter(function (s) { return state.mine.has(s.id); })
      .sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });
    $('sched-count').textContent = mine.length;
    $('sched-empty').hidden = mine.length > 0;
    $('sched-empty').textContent = state.user
      ? 'Nothing yet. Sign up for sessions and they’ll appear here.'
      : 'Enter your info to see your schedule.';
    $('my-schedule').innerHTML = mine.map(function (s) {
      return '<li><span class="t">' + esc(slotLabel(s)) + '</span>' + esc(s.name) +
        ' <span class="t">' + esc(s.location) + '</span></li>';
    }).join('');
  }

  function matches(s, q) {
    if (!q) return true;
    return [s.name, s.description, s.presenter, s.location].join(' ').toLowerCase().indexOf(q) >= 0;
  }

  function renderSessions() {
    var q = state.query.trim().toLowerCase();
    var list = state.sessions.filter(function (s) { return matches(s, q); })
      .sort(function (a, b) { return slotKey(a).localeCompare(slotKey(b)) || a.name.localeCompare(b.name); });

    var status = $('sessions-status');
    if (!state.sessions.length) { status.textContent = 'No sessions have been posted yet. Check back soon.'; }
    else if (!list.length) { status.textContent = 'No sessions match “' + state.query + '”.'; }
    else { status.textContent = list.length + ' session' + (list.length === 1 ? '' : 's') + ' available.'; }

    var groups = [], byKey = {};
    list.forEach(function (s) {
      var k = slotKey(s);
      if (!byKey[k]) { byKey[k] = { label: slotLabel(s), items: [] }; groups.push(byKey[k]); }
      byKey[k].items.push(s);
    });

    $('session-list').innerHTML = groups.map(function (g) {
      return '<div class="slot"><h3 class="slot-h">' + esc(g.label) + '</h3><div class="slot-grid">' +
        g.items.map(sessionCard).join('') + '</div></div>';
    }).join('');
  }

  function sessionCard(s) {
    var mine = state.mine.has(s.id);
    var full = s.seatsLeft === 0;
    var conflict = !mine ? conflictFor(s) : null;

    var seats = '';
    if (s.capacity > 0) {
      var pct = Math.min(100, Math.round((s.taken / s.capacity) * 100));
      var low = s.seatsLeft <= Math.max(3, Math.ceil(s.capacity * 0.15));
      seats = '<div class="seats">' + (full ? 'Full' : s.seatsLeft + ' of ' + s.capacity + ' seats left') +
        '<div class="bar' + (low ? ' low' : '') + '" aria-hidden="true"><span style="width:' + pct + '%"></span></div></div>';
    } else {
      seats = '<div class="seats">Open seating</div>';
    }

    var action, note = '';
    if (!state.signupsOpen) {
      action = mine ? '<span class="badge badge-ok">Signed up</span>' : '';
    } else if (mine) {
      action = '<span class="badge badge-ok">✓ You’re signed up</span>' +
        '<button class="btn btn-drop" data-act="cancel" data-id="' + esc(s.id) + '">Drop session</button>';
    } else if (!state.user) {
      action = '<button class="btn btn-signup" data-act="need-id">Sign up</button>';
    } else if (full) {
      action = '<button class="btn btn-signup" disabled>Session full</button>';
    } else if (conflict) {
      action = '<button class="btn btn-signup" disabled>Time conflict</button>';
      note = '<p class="note">Overlaps with “' + esc(conflict.name) + '”. Drop that one to switch.</p>';
    } else {
      action = '<button class="btn btn-signup" data-act="register" data-id="' + esc(s.id) + '">Sign up</button>';
    }

    return '<article class="session' + (mine ? ' is-mine' : '') + '">' +
      '<h3>' + esc(s.name) + '</h3>' +
      '<ul class="meta">' +
        '<li><b>When:</b> ' + esc(timeRange(s)) + '</li>' +
        '<li><b>Where:</b> ' + esc(s.location || 'TBA') + '</li>' +
        '<li><b>Presenter:</b> ' + esc(s.presenter || 'TBA') + '</li>' +
      '</ul>' +
      (s.description ? '<p class="desc">' + esc(s.description) + '</p>' : '') +
      '<div class="session-foot">' + seats + note + action + '</div>' +
    '</article>';
  }

  var toastTimer;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isErr ? 7000 : 4000);
  }

  function setBusy(b) {
    state.busy = b;
    document.querySelectorAll('#session-list button, #identity-btn').forEach(function (el) {
      if (b) { el.dataset.wasDisabled = el.disabled ? '1' : '0'; el.disabled = true; }
      else if (el.dataset.wasDisabled) { el.disabled = el.dataset.wasDisabled === '1'; delete el.dataset.wasDisabled; }
    });
  }

  // ─── DATA FLOW ────────────────────────────────────────────────────────
  function loadSessions() {
    return api.get({ action: 'sessions' }).then(function (data) {
      state.sessions = data.sessions || [];
      state.allowedDomain = data.allowedDomain || '';
      state.signupsOpen = data.signupsOpen !== false;
      if (data.conference) { $('conf-name').textContent = data.conference; document.title = data.conference + ' Signup'; }
      $('closed-banner').hidden = state.signupsOpen;
      render();
    });
  }

  function mergeSession(updated) {
    if (!updated) return;
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === updated.id) { state.sessions[i] = updated; return; }
    }
  }

  function identify(name, email) {
    return api.get({ action: 'lookup', email: email }).then(function (data) {
      state.user = { name: name || data.name, email: data.email };
      state.mine = new Set(data.sessionIds || []);
      store.set({ name: state.user.name, email: state.user.email });
      render();
      if (state.mine.size) toast('Welcome back! Your ' + state.mine.size + ' session' + (state.mine.size === 1 ? ' is' : 's are') + ' shown.');
    });
  }

  function act(action, sessionId) {
    if (state.busy) return;
    setBusy(true);
    api.post({ action: action, email: state.user.email, name: state.user.name, sessionId: sessionId })
      .then(function (data) {
        if (action === 'register') state.mine.add(sessionId); else state.mine.delete(sessionId);
        mergeSession(data.session);
        render();
        toast(data.message + (data.emailSent ? ' A confirmation email is on its way.' : ''));
      })
      .catch(function (err) {
        toast(err.message, true);
        // Seats or schedule may have changed underneath us; resync.
        return Promise.all([loadSessions(), identify(state.user.name, state.user.email)]).catch(function () {});
      })
      .then(function () { setBusy(false); render(); });
  }

  // ─── EVENTS ───────────────────────────────────────────────────────────
  $('identity-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('name').value.replace(/\s+/g, ' ').trim();
    var email = $('email').value.trim().toLowerCase();
    var err = name.length < 2 ? 'Please enter your full name.' : validEmail(email);
    $('identity-error').textContent = err;
    if (err) { (name.length < 2 ? $('name') : $('email')).focus(); return; }
    setBusy(true);
    identify(name, email)
      .catch(function (e2) { $('identity-error').textContent = e2.message; })
      .then(function () { setBusy(false); });
  });

  $('switch-user').addEventListener('click', function () {
    state.user = null; state.mine = new Set();
    store.clear();
    $('name').value = ''; $('email').value = '';
    render();
    $('name').focus();
  });

  $('session-list').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    var a = btn.dataset.act;
    if (a === 'need-id') {
      toast('Enter your name and district email first.', true);
      $('name').focus();
      $('identity-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    act(a, btn.dataset.id);
  });

  $('search').addEventListener('input', function (e) { state.query = e.target.value; renderSessions(); });

  // ─── LOCAL CONVENIENCE STORAGE (optional; failures ignored) ───────────
  var store = {
    get: function () { try { return JSON.parse(localStorage.getItem('edtech-user') || 'null'); } catch (e) { return null; } },
    set: function (v) { try { localStorage.setItem('edtech-user', JSON.stringify(v)); } catch (e) {} },
    clear: function () { try { localStorage.removeItem('edtech-user'); } catch (e) {} },
  };

  // ─── DEMO BACKEND (used only when API_URL is empty) ───────────────────
  function demoApi() {
    function at(h, m) { return new Date(Date.UTC(2026, 9, 16, h + 4, m)).toISOString(); } // Oct 16 2026, EDT
    var sessions = [];
    var rooms = [['A', 'Room 101', 30], ['B', 'Room 102', 30], ['C', 'Library', 40]];
    [[8, 30, 9, 20], [9, 30, 10, 20], [10, 30, 11, 20]].forEach(function (t, i) {
      rooms.forEach(function (r, j) {
        sessions.push({ id: 'S0' + (i * 3 + j + 1), name: 'Session ' + (i + 1) + r[0] + ' (TBD)',
          description: 'Description coming soon.', location: r[1], start: at(t[0], t[1]), end: at(t[2], t[3]),
          presenter: 'Presenter TBD', capacity: r[2], taken: i === 0 && j === 1 ? 29 : (j * 7 + i * 4) });
      });
    });
    sessions[2].taken = sessions[2].capacity; // one full session to show the state
    var regs = {};
    function pub(s) { var c = Object.assign({}, s); c.seatsLeft = s.capacity ? Math.max(0, s.capacity - s.taken) : null; return c; }
    function fail(msg, code) { var e = new Error(msg); e.code = code; return Promise.reject(e); }
    function delay(v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 250); }); }
    function find(id) { return sessions.filter(function (s) { return s.id === id; })[0]; }
    return {
      get: function (p) {
        if (p.action === 'sessions') return delay({ ok: true, conference: CFG.CONFERENCE_NAME, signupsOpen: true,
          allowedDomain: CFG.DEMO_ALLOWED_DOMAIN || '', sessions: sessions.map(pub) });
        if (p.action === 'lookup') return delay({ ok: true, email: p.email, name: '', sessionIds: Array.from(regs[p.email] || []) });
        return fail('Unknown action');
      },
      post: function (b) {
        var mine = regs[b.email] = regs[b.email] || new Set();
        var s = find(b.sessionId);
        if (!s) return fail('That session is not available.');
        if (b.action === 'register') {
          if (mine.has(s.id)) return fail('Already signed up.');
          var c = sessions.filter(function (o) { return mine.has(o.id) && overlaps(o, s); })[0];
          if (c) return fail('"' + s.name + '" overlaps with "' + c.name + '".', 'conflict');
          if (s.capacity && s.taken >= s.capacity) return fail('Sorry, "' + s.name + '" is full.', 'full');
          mine.add(s.id); s.taken++;
          return delay({ ok: true, message: 'You are signed up for "' + s.name + '".', session: pub(s), emailSent: false });
        }
        if (!mine.has(s.id)) return fail('You are not signed up for that session.');
        mine.delete(s.id); s.taken--;
        return delay({ ok: true, message: 'Dropped "' + s.name + '".', session: pub(s), emailSent: false });
      },
    };
  }

  // ─── BOOT ─────────────────────────────────────────────────────────────
  $('demo-banner').hidden = !DEMO;
  if (CFG.CONFERENCE_TAGLINE) $('tagline').textContent = CFG.CONFERENCE_TAGLINE;
  if (CFG.CONFERENCE_NAME) $('conf-name').textContent = CFG.CONFERENCE_NAME;

  loadSessions()
    .then(function () {
      var saved = store.get();
      if (saved && saved.email) {
        $('name').value = saved.name || ''; $('email').value = saved.email;
        return identify(saved.name, saved.email).catch(function () { store.clear(); });
      }
    })
    .catch(function (err) {
      $('sessions-status').textContent = 'Could not load sessions: ' + err.message;
    });
})();
