/* ============================================================
   WS Display — Machine Maintenance
   Dashboard add-on: per-interval KPI split.
   The big number on each location card is now the DAILY rate —
   "are we on top of today's work" — instead of one figure that
   blends dailies with monthly/quarterly tasks not due yet
   (which made a site 100% on dailies still look red).
   Weekly, Monthly and Quarterly & Longer get their own smaller
   percentages, each colored by its own completion rate.
   Drop-in: <script src="kpi-daily.js"></script> after
   dashboard-charts.js, just before </body>.
   ============================================================ */
(function () {
  "use strict";

  var DAILY_KEY = "Daily / Shift";
  var MINIS = [
    ["Weekly", "Weekly"],
    ["Monthly", "Monthly"],
    ["Quarterly & Longer", "Quarterly+"]
  ];

  function pct(p) {
    if (!p || !p.a) return null;
    return Math.round(p.d / p.a * 1000) / 10;
  }
  function fmtPct(v) { return v === null ? "—" : v + "%"; }
  function cardClass(rate) {
    if (rate === null) return "assigned";
    return rate >= 85 ? "done" : rate >= 50 ? "rate" : "notdone";
  }
  function col(rate) {
    if (rate === null) return "var(--muted, #6b7f99)";
    return rate >= 85 ? "var(--green, #1e9e4a)"
         : rate >= 50 ? "var(--amber, #d98a00)"
         : "var(--red, #d93838)";
  }

  function restyle() {
    try {
      if (typeof counts !== "function" || typeof LOCS === "undefined") return;
      var content = document.getElementById("content");
      if (!content) return;

      Object.keys(LOCS).forEach(function (l) {
        var el = content.querySelector('.stat[onclick="go(\'' + l + '\')"]');
        if (!el || el.dataset.mmKpi === "1") return;

        var c = counts(l);
        var daily = c.per && c.per[DAILY_KEY] ? c.per[DAILY_KEY] : { a: 0, d: 0 };
        var dRate = pct(daily);

        var minis = MINIS.map(function (m) {
          var p = c.per && c.per[m[0]] ? c.per[m[0]] : { a: 0, d: 0 };
          var r = pct(p);
          return '<div style="min-width:62px">' +
            '<div style="font-size:15px;font-weight:800;line-height:1.15;color:' + col(r) + '">' + fmtPct(r) + '</div>' +
            '<div style="font-size:10.5px;color:var(--muted,#6b7f99)">' + m[1] +
              (p.a ? " " + p.d + "/" + p.a : "") + '</div>' +
            '</div>';
        }).join("");

        var stamp = el.querySelector(".mm-stamp");   // keep dashboard-charts' "Last logged" line
        el.className = "stat " + cardClass(dRate);
        el.innerHTML =
          '<div class="lbl">' + l + " — " + LOCS[l].full + '</div>' +
          '<div class="val">' + fmtPct(dRate) +
            ' <span style="font-size:11px;font-weight:700;letter-spacing:1px;color:var(--muted,#6b7f99)">DAILY' +
            (daily.a ? " " + daily.d + "/" + daily.a : "") + '</span></div>' +
          '<div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:7px;padding-top:7px;border-top:1px solid rgba(107,127,153,.18)">' +
            minis + '</div>' +
          '<div style="font-size:12px;color:var(--muted,#6b7f99);margin-top:6px">' +
            LOCS[l].machines.length + ' machines</div>';
        if (stamp) el.appendChild(stamp);
        el.dataset.mmKpi = "1";
      });
    } catch (e) { /* cosmetic only */ }
  }

  /* Re-run after every dashboard repaint: wrap renderDash (fresh cards carry
     no data-mm-kpi marker), plus a MutationObserver safety net for repaints
     triggered elsewhere (sign-in, hydrate, restore).                       */
  function hookRenderDash() {
    if (typeof window.renderDash === "function" && !window.renderDash.__mmKpiWrapped) {
      var orig = window.renderDash;
      var wrapped = function () {
        var r = orig.apply(this, arguments);
        setTimeout(restyle, 0);
        return r;
      };
      wrapped.__mmKpiWrapped = true;
      window.renderDash = wrapped;
    }
  }

  var observing = false;
  var mo = new MutationObserver(function () {
    if (document.querySelector('#content .stat:not([data-mm-kpi])')) restyle();
  });

  function init() {
    hookRenderDash();
    var content = document.getElementById("content");
    if (content && !observing) {
      observing = true;
      mo.observe(content, { childList: true, subtree: true });
    }
    restyle();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  setTimeout(init, 900);   // in case the app defines renderDash late
})();
