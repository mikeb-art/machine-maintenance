/* ============================================================
   WS Display — Machine Maintenance
   Dashboard add-on: "Maintenance Coverage" neglect heatmap
   Loads live from the Log sheet every time the dashboard renders.
   Drop-in: <script src="dashboard-charts.js"></script> before </body>
   ============================================================ */
(function () {
  "use strict";

  var DAY = 86400000;
  var CACHE_MS = 5 * 60 * 1000;      // re-pull the sheet at most every 5 min
  var cache = { at: 0, rows: null, err: null };
  var busy = false;
  var hydrating = false;

  /* ---------- thresholds (days since last logged task) ---------- */
  var BANDS = [
    { max: 1,        color: "#1e9e4a", label: "Logged today" },
    { max: 3,        color: "#7cb342", label: "1–3 days" },
    { max: 7,        color: "#d98a00", label: "4–7 days" },
    { max: 30,       color: "#e2622a", label: "8–30 days" },
    { max: Infinity, color: "#d93838", label: "30+ days / never" }
  ];
  function band(days) {
    if (days === null || days === undefined) return BANDS[BANDS.length - 1];
    for (var i = 0; i < BANDS.length; i++) if (days <= BANDS[i].max) return BANDS[i];
    return BANDS[BANDS.length - 1];
  }

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function parseTs(v) {
    if (!v) return null;
    var d = new Date(v);
    if (!isNaN(d)) return d;
    // fallback: "7/9/2026, 10:14 AM"
    var m = String(v).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) { d = new Date(+m[3], +m[1] - 1, +m[2]); if (!isNaN(d)) return d; }
    return null;
  }
  function daysSince(d) {
    if (!d) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY));
  }
  function fmtDate(d) {
    return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "never";
  }
  function fmtNow() {
    return new Date().toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
  }
  function ageText(days) {
    if (days === null) return "Never logged";
    if (days === 0) return "Today";
    if (days === 1) return "1 day ago";
    return days + " days ago";
  }

  /* ---------- data ----------
     The app holds its own OAuth token in the global `accessToken` and talks to
     the Sheets REST API directly (no gapi client), so we do the same.        */
  function token() {
    try { return (typeof accessToken !== "undefined" && accessToken) || null; }
    catch (e) { return null; }
  }
  function sheetsReady() { return !!token(); }

  /* Ask Google for a token without showing any UI. Works when the user has
     already granted this app access and still has a live Google session —
     this is what stops the dashboard from looking "signed out" after F5.   */
  /* ---- keep the session alive across a page refresh ----
     The app keeps its token only in memory, so F5 looks like a sign-out.
     We stash it in sessionStorage (this tab only, expires with the token)
     and restore it on load.                                              */
  var SS_KEY = "wsd-maint-tok";
  /* localStorage, not sessionStorage: operators open the site in a fresh tab
     each time they "enter", and sessionStorage does not carry across tabs. */
  var TOK_STORE = (function () {
    try { localStorage.setItem("_t", "1"); localStorage.removeItem("_t"); return localStorage; }
    catch (e) { return sessionStorage; }
  })();
  function saveSession() {
    try {
      var t = token();
      if (!t) return;
      TOK_STORE.setItem(SS_KEY, JSON.stringify({
        t: t,
        u: (typeof user !== "undefined" && user) ? user : null,
        at: Date.now()
      }));
    } catch (e) {}
  }
  function restoreSession() {
    try {
      if (token()) return false;
      var raw = TOK_STORE.getItem(SS_KEY);
      if (!raw) return false;
      var s = JSON.parse(raw);
      if (!s || !s.t || Date.now() - s.at > 50 * 60 * 1000) {   // tokens last ~1h
        TOK_STORE.removeItem(SS_KEY);
        return false;
      }
      accessToken = s.t;                                        // eslint-disable-line
      if (s.u && typeof user !== "undefined" && !user) user = s.u; // eslint-disable-line
      try { if (typeof updateUserUI === "function") updateUserUI(); } catch (e) {}
      try { if (typeof render === "function") render(); } catch (e) {}
      // the restored token may be near-expiry or revoked (operator signed out
      // elsewhere); proactively swap in a fresh one so writes don't silently 401.
      setTimeout(function () { silentSignIn(true); }, 300);
      return true;
    } catch (e) { return false; }
  }
  setInterval(saveSession, 5000);
  window.addEventListener("beforeunload", saveSession);

  /* ---- durable pending-write queue -------------------------------------
     If a save fails (expired/stale token, transient error) we stash the exact
     append call in localStorage and replay it automatically once we have a
     valid token again — so an operator's logged task is never silently lost.
     This is what went wrong for operators whose token quietly expired.     */
  var PEND_KEY = "wsd-maint-pending";
  var flushingPending = false;
  function readPending() {
    try { return JSON.parse(TOK_STORE.getItem(PEND_KEY) || "[]") || []; }
    catch (e) { return []; }
  }
  function writePending(list) {
    try {
      if (list && list.length) TOK_STORE.setItem(PEND_KEY, JSON.stringify(list));
      else TOK_STORE.removeItem(PEND_KEY);
    } catch (e) {}
  }
  function queuePendingCall(argsArray) {
    try {
      var list = readPending(), sig = JSON.stringify(argsArray);
      for (var i = 0; i < list.length; i++) if (JSON.stringify(list[i]) === sig) return;
      list.push(argsArray);
      writePending(list);
    } catch (e) {}
  }
  function flushPending() {
    if (flushingPending || !token()) return;
    var list = readPending();
    if (!list.length || typeof window.__mmOrigAppendRows !== "function") return;
    flushingPending = true;
    var remaining = [], idx = 0, savedAny = false;
    function step() {
      if (idx >= list.length) {
        writePending(remaining);
        flushingPending = false;
        if (savedAny) {
          banner("Saved your earlier entries after reconnecting.", true);
          cache.at = 0;
          if (isDashboard()) setTimeout(function () { refresh(true); }, 300);
        }
        return;
      }
      var callArgs = list[idx++];
      Promise.resolve().then(function () { return window.__mmOrigAppendRows.apply(null, callArgs); })
        .then(function () { savedAny = true; })
        .catch(function () { remaining.push(callArgs); })
        .then(step);
    }
    step();
  }

  var silentTried = false;
  /* Ask Google for a fresh token with no UI. Pass force=true to renew even
     when a (possibly stale) token is already present — the token the app
     restores from storage can be near-expiry or revoked, and reusing it is
     exactly what makes the app look "signed in" while every save 401s.     */
  function silentSignIn(force) {
    if (!force && (silentTried || token())) return;
    silentTried = true;
    try {
      if (typeof tokenClient !== "undefined" && tokenClient &&
          typeof tokenClient.requestAccessToken === "function") {
        var hint = null;
        try {
          var raw = TOK_STORE.getItem(SS_KEY);
          var s = raw ? JSON.parse(raw) : null;
          hint = (s && s.u && s.u.email) || null;
        } catch (e) {}
        tokenClient.requestAccessToken(hint ? { prompt: "", hint: hint } : { prompt: "" });
        // once GIS calls back with a fresh token: persist it, replay any
        // unsaved rows, and repaint.
        setTimeout(function () { if (token()) { saveSession(); flushPending(); } refresh(true); }, 1400);
        setTimeout(function () { if (token()) { saveSession(); flushPending(); } refresh(true); }, 3200);
      } else {
        silentTried = false;
      }
    } catch (e) { silentTried = false; }
  }

  function loadRows(force) {
    if (!force && cache.rows && Date.now() - cache.at < CACHE_MS) {
      return Promise.resolve(cache.rows);
    }
    var url = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(CONFIG.SPREADSHEET_ID) + "/values/" +
      encodeURIComponent(CONFIG.LOG_SHEET + "!A2:H");
    return fetch(url, { headers: { Authorization: "Bearer " + token() } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          var e = new Error("session expired — click Sign in with Google again");
          e.authFail = true;
          throw e;
        }
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        var rows = j.values || [];
        cache = { at: Date.now(), rows: rows, err: null };
        return rows;
      });
  }

  /* Log columns as actually written by the app:
     0 Timestamp | 1 User | 2 User | 3 Machine | 4 Serial | 5 Task | 6 Interval | 7 Action
     There is NO Location column, and the same model name repeats across sites,
     so identify a row's machine by its globally-unique serial (col E), with an
     exact machine-name fallback. Returns {loc, m, mi} or null. */
  function locateRow(r) {
    var ser = String(r[4] || "").trim();
    var nm = String(r[3] || "").trim();
    var lc, ms, i;
    for (lc in LOCS) {
      ms = LOCS[lc].machines;
      for (i = 0; i < ms.length; i++) {
        if (ser && ms[i].s === ser) return { loc: lc, m: ms[i], mi: i };
      }
    }
    for (lc in LOCS) {
      ms = LOCS[lc].machines;
      for (i = 0; i < ms.length; i++) {
        if (nm && nm === ms[i].n) return { loc: lc, m: ms[i], mi: i };
      }
    }
    return null;
  }

  function summarize(rows) {
    var byMachine = {};   // "CA|Durst Rhotex 325" -> {last:Date, count:int, count30:int, users:Set}
    var byLoc = {};       // "CA" -> {last:Date, count:int}

    Object.keys(LOCS).forEach(function (code) {
      byLoc[code] = { last: null, count: 0, count30: 0 };
      LOCS[code].machines.forEach(function (m) {
        byMachine[code + "|" + m.n] = { last: null, count: 0, count30: 0, users: {} };
      });
    });

    rows.forEach(function (r) {
      var ts = parseTs(r[0]);
      if (!ts) return;
      var user = String(r[1] || "").trim();
      var found = locateRow(r);
      if (!found) return;
      var loc = found.loc, hit = found.m;

      var recent = (Date.now() - ts.getTime()) <= 30 * DAY;

      var L = byLoc[loc];
      L.count++; if (recent) L.count30++;
      if (!L.last || ts > L.last) L.last = ts;

      var M = byMachine[loc + "|" + hit.n];
      M.count++; if (recent) M.count30++;
      if (user) M.users[user] = true;
      if (!M.last || ts > M.last) M.last = ts;
    });

    return { byMachine: byMachine, byLoc: byLoc };
  }

  /* ================= hydrate the app's completion state from the sheet =====
     The KPI percentages at the top of every page come from `store`, which
     lived only in this browser's localStorage — so a machine that another
     operator logged on still read 0% for everyone else. We replay the log
     sheet into `store` using the app's own id/period scheme, so the
     percentages reflect what the whole team has actually logged.
     id format: "<LOC>|<machineIndex>|<taskIndex>"; store[id] = {s, p}.     */

  /* Action column values are free text ("Unchecked (was done)"), so match on
     the leading phrase rather than the whole string. */
  function actionState(v) {
    var s = String(v || "").trim().toLowerCase();
    if (!s) return null;
    if (s.indexOf("unchecked") === 0) return "open";
    if (s.indexOf("marked not") === 0 || s.indexOf("not completed") > -1) return "notdone";
    if (s.indexOf("completed") === 0) return "done";
    return null;
  }

  /* Run the app's own periodKey() as if "now" were `when`, so bucket
     boundaries (working-day counters, bi-weekly, quarters…) match exactly. */
  function periodKeyAt(iv, when) {
    var RealDate = Date, t = when.getTime();
    function Fake(a) {
      if (arguments.length === 0) return new RealDate(t);
      return new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))();
    }
    Fake.prototype = RealDate.prototype;
    Fake.now = function () { return t; };
    Fake.parse = RealDate.parse;
    Fake.UTC = RealDate.UTC;
    try {
      window.Date = Fake;
      return String(periodKey(iv));
    } catch (e) {
      return null;
    } finally {
      window.Date = RealDate;
    }
  }

  function taskIndex(machine, taskText) {
    var list = (typeof T !== "undefined" && T[machine.t]) || null;
    if (!list) return -1;
    var want = String(taskText || "").trim();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i][0]).trim() === want) return i;
    }
    return -1;
  }

  function hydrateStore(rows) {
    if (typeof store === "undefined" || !store || typeof periodKey !== "function") return false;
    var changed = false;

    // oldest first, so the most recent action for a task wins
    var ordered = rows.slice().map(function (r) { return { r: r, t: parseTs(r[0]) }; })
      .filter(function (x) { return !!x.t; })
      .sort(function (a, b) { return a.t - b.t; });

    ordered.forEach(function (x) {
      var r = x.r;
      var found = locateRow(r);
      if (!found) return;
      var loc = found.loc, mi = found.mi;

      var ti = taskIndex(found.m, r[5]);
      if (ti < 0) return;

      var iv = T[found.m.t][ti][1];
      var nowKey = String(periodKey(iv));
      if (periodKeyAt(iv, x.t) !== nowKey) return;      // logged in an earlier period

      var st = actionState(r[7]);
      if (!st) return;

      var id = loc + "|" + mi + "|" + ti;
      var prev = store[id];
      if (st === "open") {
        if (prev) { delete store[id]; changed = true; }
      } else if (!prev || prev.s !== st || prev.p !== nowKey) {
        store[id] = { s: st, p: nowKey };
        changed = true;
      }
    });

    if (changed) { try { if (typeof save === "function") save(); } catch (e) {} }
    return changed;
  }

  /* ---------- rendering ---------- */
  function shell(inner, note) {
    return '' +
      '<div id="neglectCard" style="background:#fff;border:1px solid #dbe3ee;border-radius:10px;' +
      'box-shadow:0 1px 2px rgba(20,65,126,.06);padding:16px 18px;margin-top:14px">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px">' +
          '<div>' +
            '<div style="font-weight:700;color:#14417e;font-size:15px">Maintenance Coverage</div>' +
            '<div style="font-size:12px;color:#6b7f99">Days since each machine last had a task logged</div>' +
          '</div>' +
          '<div style="font-size:11px;color:#6b7f99;text-align:right">' + (note || "") + '</div>' +
        '</div>' +
        inner +
      '</div>';
  }

  function legend() {
    return '<div style="display:flex;gap:14px;flex-wrap:wrap;margin:12px 0 4px;font-size:11px;color:#6b7f99">' +
      BANDS.map(function (b) {
        return '<span style="display:inline-flex;align-items:center;gap:5px">' +
          '<span style="width:10px;height:10px;border-radius:2px;background:' + b.color + '"></span>' +
          esc(b.label) + '</span>';
      }).join("") + '</div>';
  }

  function locBlock(code, data) {
    var loc = LOCS[code];
    var L = data.byLoc[code];
    var machines = loc.machines;
    var stale = 0, never = 0;

    var tiles = machines.map(function (m) {
      var M = data.byMachine[code + "|" + m.n];
      var d = daysSince(M.last);
      if (d === null) never++; else if (d > 7) stale++;
      var b = band(d);
      var ops = Object.keys(M.users).length;
      return '<div title="' + esc(m.n + " — " + m.s) + '" style="border:1px solid #e4eaf3;border-left:5px solid ' + b.color +
        ';border-radius:7px;padding:9px 11px;background:#fbfcfe">' +
        '<div style="font-size:12.5px;font-weight:650;color:#1b2a41;line-height:1.25">' + esc(m.n) + '</div>' +
        '<div style="font-size:16px;font-weight:700;color:' + b.color + ';margin-top:3px">' + ageText(d) + '</div>' +
        '<div style="font-size:11px;color:#6b7f99;margin-top:2px">' +
          M.count30 + ' log' + (M.count30 === 1 ? '' : 's') + ' / 30d' +
          (ops ? ' · ' + ops + ' operator' + (ops === 1 ? '' : 's') : '') +
        '</div>' +
        '<div style="font-size:10.5px;color:#93a4bb;margin-top:2px">Last: ' + esc(fmtDate(M.last)) + '</div>' +
        '</div>';
    }).join("");

    var flagged = stale + never;
    var head = '<div style="display:flex;align-items:baseline;justify-content:space-between;margin:16px 0 8px">' +
      '<div style="font-size:13px;font-weight:700;color:#14417e">' + esc(loc.name) + ' <span style="font-weight:400;color:#6b7f99">· ' + esc(loc.full) + '</span></div>' +
      '<div style="font-size:11.5px;color:' + (flagged ? "#d93838" : "#1e9e4a") + '">' +
        (flagged ? flagged + ' of ' + machines.length + ' need attention' : 'all ' + machines.length + ' current') +
        ' · <span style="color:#6b7f99">' + L.count30 + ' logs / 30d</span>' +
      '</div></div>';

    return head + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:9px">' + tiles + '</div>';
  }

  function draw(html) {
    var content = document.getElementById("content");
    if (!content) return;
    var old = document.getElementById("neglectCard");
    if (old) old.outerHTML = html; else content.insertAdjacentHTML("beforeend", html);
  }

  /* ================= Recent activity — last 7 days ========================
     A period-independent view of who logged what recently, so real logging
     stays visible even when the current-period compliance % has reset.     */
  function fmtWhen(d) {
    var diff = Date.now() - d.getTime();
    if (diff < 3600000) return Math.max(1, Math.floor(diff / 60000)) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return d.toLocaleDateString(undefined, { weekday: "short" }) + " " +
           d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function userShort(u) {
    u = String(u || "").trim();
    var at = u.indexOf("@");
    return at > 0 ? u.slice(0, at) : (u || "someone");
  }
  function actionDot(st) {
    var c = st === "done" ? "#1e9e4a" : (st === "open" ? "#93a4bb" : "#d98a00");
    return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + c + ';margin-right:6px;vertical-align:middle"></span>';
  }

  function recentActivityCard(rows) {
    var cutoff = Date.now() - 7 * DAY;
    var items = [];
    rows.forEach(function (r) {
      var ts = parseTs(r[0]);
      if (!ts || ts.getTime() < cutoff) return;
      var found = locateRow(r);
      if (!found) return;
      var loc = found.loc;
      items.push({
        ts: ts, loc: loc,
        machine: found.m.n,
        task: String(r[5] || "").trim(),
        user: String(r[1] || "").trim(),
        st: actionState(r[7])
      });
    });
    items.sort(function (a, b) { return b.ts - a.ts; });

    // per-location roll-up: operators active + entry counts
    var per = {};
    Object.keys(LOCS).forEach(function (c) { per[c] = { n: 0, users: {} }; });
    items.forEach(function (it) {
      var p = per[it.loc];
      p.n++;
      if (it.user) {
        if (!p.users[it.user]) p.users[it.user] = { n: 0, last: it.ts };
        p.users[it.user].n++;
        if (it.ts > p.users[it.user].last) p.users[it.user].last = it.ts;
      }
    });

    var summary = Object.keys(LOCS).map(function (c) {
      var loc = LOCS[c], p = per[c];
      var ops = Object.keys(p.users).sort(function (a, b) { return p.users[b].n - p.users[a].n; });
      var chips = ops.length ? ops.map(function (u) {
        return '<span style="display:inline-block;background:#eef3fa;border:1px solid #dde6f2;border-radius:999px;' +
          'padding:2px 9px;font-size:11px;color:#33465e;margin:2px 4px 2px 0">' +
          esc(userShort(u)) + ' <span style="color:#8496ad">· ' + p.users[u].n + '</span></span>';
      }).join("") : '<span style="font-size:11.5px;color:#a4b1c4">no activity in the last 7 days</span>';
      return '<div style="margin:10px 0 2px">' +
        '<div style="font-size:12.5px;font-weight:700;color:#14417e">' + esc(loc.name) +
          ' <span style="font-weight:400;color:#6b7f99">· ' + esc(loc.full) + '</span>' +
          '<span style="float:right;font-weight:600;color:' + (p.n ? "#1e9e4a" : "#a4b1c4") + '">' + p.n + ' entr' + (p.n === 1 ? 'y' : 'ies') + '</span></div>' +
        '<div style="margin-top:4px">' + chips + '</div></div>';
    }).join("");

    // most-recent feed
    var MAXN = 14;
    var feed = items.slice(0, MAXN).map(function (it) {
      var task = it.task.length > 60 ? it.task.slice(0, 58) + "…" : it.task;
      return '<div style="display:flex;gap:8px;padding:6px 0;border-top:1px solid #f0f3f8;font-size:12px;line-height:1.3">' +
        '<div style="flex:0 0 76px;color:#6b7f99;white-space:nowrap">' + esc(fmtWhen(it.ts)) + '</div>' +
        '<div style="flex:1 1 auto;color:#1b2a41">' + actionDot(it.st) +
          '<span style="color:#33465e">' + esc(it.loc) + ' · ' + esc(it.machine) + '</span> — ' + esc(task) +
          ' <span style="color:#8496ad">(' + esc(userShort(it.user)) + ')</span></div>' +
        '</div>';
    }).join("");
    var more = items.length > MAXN ? '<div style="font-size:11px;color:#8496ad;margin-top:6px">+ ' + (items.length - MAXN) + ' more in the last 7 days</div>' : '';

    var inner =
      summary +
      '<div style="font-size:11px;font-weight:700;color:#6b7f99;letter-spacing:.04em;text-transform:uppercase;margin:14px 0 2px">Latest entries</div>' +
      (feed || '<div style="font-size:12px;color:#a4b1c4;padding:8px 0">Nothing logged in the last 7 days.</div>') +
      more;

    return '' +
      '<div id="recentCard" style="background:#fff;border:1px solid #dbe3ee;border-radius:10px;' +
      'box-shadow:0 1px 2px rgba(20,65,126,.06);padding:16px 18px;margin-top:14px">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px">' +
          '<div>' +
            '<div style="font-weight:700;color:#14417e;font-size:15px">Recent activity</div>' +
            '<div style="font-size:12px;color:#6b7f99">Everything logged in the last 7 days · all operators</div>' +
          '</div>' +
          '<div style="font-size:11px;color:#6b7f99;text-align:right">Updated ' + esc(fmtNow()) + '<br>' +
            items.length + ' entr' + (items.length === 1 ? 'y' : 'ies') + ' / 7d</div>' +
        '</div>' + inner +
      '</div>';
  }

  function drawRecent(html) {
    var content = document.getElementById("content");
    if (!content) return;
    var old = document.getElementById("recentCard");
    if (old) { old.outerHTML = html; return; }
    var cov = document.getElementById("neglectCard");   // keep Recent above Coverage
    if (cov) cov.insertAdjacentHTML("beforebegin", html);
    else content.insertAdjacentHTML("beforeend", html);
  }

  function stampLocationCards(data) {
    try {
      var content = document.getElementById("content");
      if (!content) return;
      Object.keys(LOCS).forEach(function (code) {
        var L = data.byLoc[code];
        var nodes = content.querySelectorAll("div,section,article");
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (n.closest("#neglectCard")) continue;
          if (n.dataset && n.dataset.stamped === code) return;
          var t = (n.textContent || "").trim().toUpperCase();
          if (t.indexOf(code + " — ") === 0 && n.children.length === 0) {
            var card = n.parentElement;
            if (!card || card.querySelector(".mm-stamp")) return;
            var s = document.createElement("div");
            s.className = "mm-stamp";
            s.style.cssText = "font-size:11px;color:#6b7f99;margin-top:6px";
            s.textContent = "Last logged: " + (L.last ? fmtDate(L.last) : "never") +
                            "  ·  updated " + fmtNow();
            card.appendChild(s);
            card.dataset.stamped = code;
            return;
          }
        }
      });
    } catch (e) { /* cosmetic only */ }
  }

  function refresh(force) {
    if (busy) return;
    if (!document.getElementById("content")) return;

    if (!sheetsReady()) {
      draw(shell('<div style="margin-top:12px;font-size:12.5px;color:#6b7f99">' +
        'Sign in with Google to load maintenance coverage from the log sheet.</div>',
        "not signed in"));
      if (restoreSession()) { setTimeout(function () { refresh(true); }, 50); return; }
      silentSignIn();
      return;
    }

    busy = true;
    draw(shell('<div style="margin-top:12px;font-size:12.5px;color:#6b7f99">Loading log data…</div>', ""));

    loadRows(force).then(function (rows) {
      // fold the team's logged completions into the app's own state, then let
      // the app repaint its KPI percentages (guarded against a render loop)
      if (!hydrating && hydrateStore(rows)) {
        hydrating = true;
        try { if (typeof render === "function") render(); } catch (e) {}
        setTimeout(function () { hydrating = false; }, 1500);
      }

      var data = summarize(rows);
      drawRecent(recentActivityCard(rows));           // "Recent activity — last 7 days", above Coverage
      var body = Object.keys(LOCS).map(function (c) { return locBlock(c, data); }).join("");
      var total = rows.length;
      draw(shell(legend() + body,
        "Updated " + esc(fmtNow()) + "<br>" + total + " log entr" + (total === 1 ? "y" : "ies") +
        ' · <a href="#" onclick="window.MM_COVERAGE.refresh(true);return false" style="color:#1f6fd6;text-decoration:none">refresh</a>'));
      stampLocationCards(data);
    }).catch(function (e) {
      if (e && e.authFail) {
        try { TOK_STORE.removeItem(SS_KEY); accessToken = null; } catch (e2) {}
        silentTried = false;   // allow one silent renewal attempt
        draw(shell('<div style="margin-top:12px;font-size:12.5px;color:#6b7f99">' +
          'Reconnecting to Google…</div>', "reconnecting"));
        silentSignIn(true);
        return;
      }
      draw(shell('<div style="margin-top:12px;font-size:12.5px;color:#d93838">Could not read the log sheet: ' +
        esc((e && (e.message || (e.result && e.result.error && e.result.error.message))) || "unknown error") +
        '</div>', "error"));
    }).then(function () { busy = false; });
  }

  /* ---------- hook into the dashboard render ---------- */
  function isDashboard() {
    var t = document.getElementById("pageTitle");
    return !!t && /dashboard/i.test(t.textContent || "");
  }

  function hook() {
    restoreSession();
    wrapAppend();
    // always pull a fresh token on load (replaces any stale restored one), then
    // replay anything that failed to save last time.
    setTimeout(function () { silentSignIn(true); }, 500);
    setTimeout(flushPending, 1500);
    // renew well before the ~1h token expiry so a long shift never drops out,
    // and keep retrying any unsaved rows.
    setInterval(function () { silentSignIn(true); }, 30 * 60 * 1000);
    setInterval(flushPending, 60 * 1000);
    if (typeof window.renderDash === "function" && !window.renderDash.__mmWrapped) {
      var orig = window.renderDash;
      var wrapped = function () {
        var r = orig.apply(this, arguments);
        setTimeout(function () { refresh(false); }, 0);
        return r;
      };
      wrapped.__mmWrapped = true;
      window.renderDash = wrapped;
    }
    // safety net: if the dashboard is already on screen, draw now
    if (isDashboard()) setTimeout(function () { refresh(false); }, 0);
  }

  /* ---- make a failed save LOUD ----------------------------------------
     logAction() queues rows and flushQueue() appends them; if the append
     fails (e.g. the operator only has read access to the log sheet) the
     error was swallowed, so the checkbox ticked and nothing was saved.
     Wrap appendRows and show a banner that cannot be missed.            */
  function banner(msg, ok) {
    var id = "mmSaveBanner";
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);top:12px;z-index:9999;" +
        "padding:11px 16px;border-radius:8px;font-size:13px;font-weight:600;max-width:640px;" +
        "box-shadow:0 4px 14px rgba(0,0,0,.18);cursor:pointer";
      el.onclick = function () { el.remove(); };
      document.body.appendChild(el);
    }
    el.style.background = ok ? "#e6f6ec" : "#fdecec";
    el.style.color = ok ? "#12703a" : "#a11d1d";
    el.style.border = "1px solid " + (ok ? "#1e9e4a" : "#d93838");
    el.textContent = msg;
    if (ok) setTimeout(function () { if (el) el.remove(); }, 4000);
  }

  function wrapAppend() {
    if (typeof window.appendRows !== "function" || window.appendRows.__mmWrapped) return;
    var orig = window.appendRows;
    window.__mmOrigAppendRows = orig;      // used by flushPending to replay
    var wrapped = function () {
      var args = Array.prototype.slice.call(arguments), self = this;
      return Promise.resolve()
        .then(function () { return orig.apply(self, args); })
        .then(function (r) {
          cache.at = 0;                       // force the coverage card to re-read
          if (isDashboard()) setTimeout(function () { refresh(true); }, 300);
          flushPending();                     // opportunistically drain backlog
          return r;
        })
        .catch(function (e) {
          var m = String((e && e.message) || e);
          // Never lose the operator's work: stash it and recover automatically.
          queuePendingCall(args);
          if (/403/.test(m)) {
            banner("Trouble saving — retrying. If this keeps showing, ask Mike to confirm your edit access.", false);
            setTimeout(flushPending, 2500);
          } else if (/401/.test(m)) {
            banner("Reconnecting to save your entry…", false);
            silentSignIn(true);               // auto re-auth, then flushPending fires
          } else {
            banner("Couldn't save yet — will retry automatically.", false);
            setTimeout(flushPending, 3000);
          }
          // Resolve (don't re-throw): the row is safely queued and will be
          // replayed by flushPending, so the app's own queue won't double-send.
          return;
        });
    };
    wrapped.__mmWrapped = true;
    window.appendRows = wrapped;
    setTimeout(flushPending, 1200);           // catch rows left over from last visit
  }

  window.MM_COVERAGE = { refresh: refresh, isDashboard: isDashboard, banner: banner };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", hook);
  } else {
    hook();
  }
  // re-hook shortly after load in case the app defines/renders late (e.g. after auth)
  setTimeout(hook, 800);
  setTimeout(function () { if (isDashboard()) refresh(false); }, 2500);
})();
