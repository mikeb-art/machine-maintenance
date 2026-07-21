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

  /* ---------- data ---------- */
  function sheetsReady() {
    return typeof gapi !== "undefined" && gapi.client &&
           gapi.client.sheets && gapi.client.sheets.spreadsheets &&
           gapi.client.getToken && gapi.client.getToken();
  }

  function loadRows(force) {
    if (!force && cache.rows && Date.now() - cache.at < CACHE_MS) {
      return Promise.resolve(cache.rows);
    }
    return gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: CONFIG.LOG_SHEET + "!A2:H"
    }).then(function (resp) {
      var rows = (resp.result && resp.result.values) || [];
      cache = { at: Date.now(), rows: rows, err: null };
      return rows;
    });
  }

  /* Log columns: 0 Timestamp | 1 User | 2 Location | 3 Machine | 4 Serial
                  5 Task | 6 Interval | 7 Action                              */
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
      var loc = String(r[2] || "").trim().toUpperCase().slice(0, 2);
      var mach = String(r[3] || "").trim();
      var user = String(r[1] || "").trim();
      if (!LOCS[loc]) return;

      var recent = (Date.now() - ts.getTime()) <= 30 * DAY;

      var L = byLoc[loc];
      L.count++; if (recent) L.count30++;
      if (!L.last || ts > L.last) L.last = ts;

      // match the log's machine string back to a machine in LOCS
      var hit = null;
      LOCS[loc].machines.forEach(function (m) {
        if (hit) return;
        if (mach === m.n || mach.indexOf(m.n) === 0 || mach.indexOf(m.n) > -1) hit = m;
      });
      if (!hit) return;

      var M = byMachine[loc + "|" + hit.n];
      M.count++; if (recent) M.count30++;
      if (user) M.users[user] = true;
      if (!M.last || ts > M.last) M.last = ts;
    });

    return { byMachine: byMachine, byLoc: byLoc };
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
      return;
    }

    busy = true;
    draw(shell('<div style="margin-top:12px;font-size:12.5px;color:#6b7f99">Loading log data…</div>', ""));

    loadRows(force).then(function (rows) {
      var data = summarize(rows);
      var body = Object.keys(LOCS).map(function (c) { return locBlock(c, data); }).join("");
      var total = rows.length;
      draw(shell(legend() + body,
        "Updated " + esc(fmtNow()) + "<br>" + total + " log entr" + (total === 1 ? "y" : "ies") +
        ' · <a href="#" onclick="window.MM_COVERAGE.refresh(true);return false" style="color:#1f6fd6;text-decoration:none">refresh</a>'));
      stampLocationCards(data);
    }).catch(function (e) {
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

  window.MM_COVERAGE = { refresh: refresh, isDashboard: isDashboard };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", hook);
  } else {
    hook();
  }
  // re-hook shortly after load in case the app defines/renders late (e.g. after auth)
  setTimeout(hook, 800);
  setTimeout(function () { if (isDashboard()) refresh(false); }, 2500);
})();
