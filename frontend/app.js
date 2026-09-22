/* ==========================================================================
   Third-Party Risk Intelligence - dashboard behaviour
   No build step, no dependencies, no network: data.js defines window.TPR_DATA,
   so the page also works when opened straight from disk.
   ========================================================================== */
(function () {
  "use strict";

  var DATA = window.TPR_DATA;
  var TIERS = ["Critical", "High", "Medium", "Low"];

  var SOURCE_LABEL = {
    audit_finding: "internal audit",
    regulatory_filing: "regulatory filing",
    news_article: "press report",
    incident_ticket: "incident record",
    market_data: "market data",
    vendor_questionnaire: "vendor questionnaire"
  };
  var LINK_NOTE = {
    CONFIRMED: "publicly confirmed UBS relationship",
    REPORTED: "UBS relationship reported, not confirmed",
    INDUSTRY: "no UBS relationship claimed - industry exposure only"
  };

  /* ------------------------------------------------------------ utilities */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(n, d) { return Number(n).toFixed(d === undefined ? 1 : d); }
  function titleCase(s) { return s.charAt(0) + s.slice(1).toLowerCase(); }
  function byId(id) { return document.getElementById(id); }

  function chip(tier) {
    return '<span class="chip tier-' + esc(tier) + '"><i class="dot"></i>' + esc(tier) + "</span>";
  }
  function provTag(p) {
    return p === "REAL"
      ? '<span class="tag real" title="Public source with a link">Real source</span>'
      : '<span class="tag illus" title="Synthetic example written for the demo">Illustrative</span>';
  }
  function linkTag(l, compact) {
    return '<span class="tag' + (l === "CONFIRMED" ? " confirmed" : "") + '" title="' +
      esc(LINK_NOTE[l] || "") + '">' + (compact ? "" : "UBS link: ") + esc(titleCase(l)) + "</span>";
  }

  /* A one-line headline in the shape the brief asks for:
     "Vendor X mentioned in a breach discussion" / "Sentiment risk increasing for partner Y". */
  function headline(a) {
    var top = a.evidence[0] || {};
    var src = SOURCE_LABEL[top.source_type] || top.source_type || "a public source";
    var maturity = top.maturity && top.maturity !== "n/a" ? top.maturity + " " : "";
    var cat = a.risk_category.toLowerCase();
    var more = a.n_signals > 1 ? " and " + (a.n_signals - 1) + " further signal" + (a.n_signals > 2 ? "s" : "") : "";
    return a.vendor_name + " flagged in a " + maturity + cat + " signal from " + src + more + ".";
  }

  /* ------------------------------------------------------------ filtering */
  var state = { view: "alerts", vendor: "", category: "", tier: "", link: "", q: "" };

  function matchQuery(hay) {
    if (!state.q) return true;
    return hay.toLowerCase().indexOf(state.q.toLowerCase()) !== -1;
  }
  function filteredSignals() {
    return DATA.signals.filter(function (s) {
      return (!state.vendor || s.vendor_name === state.vendor)
        && (!state.category || s.risk_category === state.category)
        && (!state.tier || s.tier === state.tier)
        && (!state.link || s.ubs_link === state.link)
        && matchQuery(s.text + " " + s.vendor_name + " " + s.source_name + " " + s.risk_category + " " + s.signal_id);
    });
  }
  function filteredAlerts() {
    return DATA.alerts.filter(function (a) {
      return (!state.vendor || a.vendor_name === state.vendor)
        && (!state.category || a.risk_category === state.category)
        && (!state.tier || a.tier === state.tier)
        && (!state.link || a.ubs_link === state.link)
        && matchQuery(a.vendor_name + " " + a.risk_category + " " + a.owner_team + " " + a.why);
    });
  }
  function filteredVendors() {
    return DATA.vendors.filter(function (v) {
      return (!state.vendor || v.vendor_name === state.vendor)
        && (!state.tier || v.tier === state.tier)
        && (!state.link || v.ubs_link === state.link)
        && (!state.category || v.dominant_category === state.category)
        && matchQuery(v.vendor_name + " " + v.service + " " + (v.relationship_note || ""));
    });
  }

  /* -------------------------------------------------------------- tooltip */
  var tip = byId("tooltip");
  function showTip(html, ev) {
    tip.innerHTML = html;
    tip.style.opacity = "1";
    var pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    var x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  function hideTip() { tip.style.opacity = "0"; }

  /* --------------------------------------------------------------- charts */
  var TIER_VAR = {
    Critical: "var(--tier-critical)", High: "var(--tier-high)",
    Medium: "var(--tier-medium)", Low: "var(--tier-low)"
  };

  /* Likelihood x Impact matrix. Background is a single-hue wash whose depth
     tracks L x I (sequential magnitude); marks carry tier as colour and the
     UBS link as shape, so identity never rests on colour alone. */
  function matrixSVG(signals) {
    var W = 620, H = 500, mL = 54, mR = 18, mT = 14, mB = 54;
    var pw = W - mL - mR, ph = H - mT - mB;
    var x = function (v) { return mL + ((v - 1) / 4) * pw; };
    var y = function (v) { return mT + ph - ((v - 1) / 4) * ph; };
    var s = ['<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Likelihood by impact matrix of scored risk signals">'];

    for (var ci = 0; ci < 5; ci++) {
      for (var cj = 0; cj < 5; cj++) {
        var mag = ((ci + 1) * (cj + 1)) / 25;
        var op = (0.03 + 0.19 * Math.pow(mag, 1.1)).toFixed(3);
        s.push('<rect x="' + (mL + (ci / 5) * pw) + '" y="' + (mT + ((4 - cj) / 5) * ph) +
          '" width="' + (pw / 5 - 1) + '" height="' + (ph / 5 - 1) +
          '" fill="var(--accent)" opacity="' + op + '"/>');
      }
    }
    for (var t = 1; t <= 5; t++) {
      s.push('<line class="gridline" x1="' + x(t) + '" y1="' + mT + '" x2="' + x(t) + '" y2="' + (mT + ph) + '"/>');
      s.push('<line class="gridline" x1="' + mL + '" y1="' + y(t) + '" x2="' + (mL + pw) + '" y2="' + y(t) + '"/>');
      s.push('<text class="tick" x="' + x(t) + '" y="' + (mT + ph + 18) + '" text-anchor="middle">' + t + "</text>");
      s.push('<text class="tick" x="' + (mL - 10) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + t + "</text>");
    }
    s.push('<line class="axis-line" x1="' + mL + '" y1="' + (mT + ph) + '" x2="' + (mL + pw) + '" y2="' + (mT + ph) + '"/>');
    s.push('<line class="axis-line" x1="' + mL + '" y1="' + mT + '" x2="' + mL + '" y2="' + (mT + ph) + '"/>');
    s.push('<text class="axis-title" x="' + (mL + pw / 2) + '" y="' + (H - 12) + '" text-anchor="middle">Likelihood (1-5)</text>');
    s.push('<text class="axis-title" transform="translate(14,' + (mT + ph / 2) + ') rotate(-90)" text-anchor="middle">Impact (1-5)</text>');
    s.push('<text class="zone" x="' + (mL + pw - 8) + '" y="' + (mT + 16) + '" text-anchor="end">Early-warning zone</text>');

    signals.slice().sort(function (a, b) { return a.residual_risk - b.residual_risk; }).forEach(function (d, i) {
      var cx = x(d.likelihood), cy = y(d.impact), fill = TIER_VAR[d.tier], r = 5.5;
      var shape;
      if (d.ubs_link === "CONFIRMED") {
        shape = '<circle class="mark" cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + fill + '"';
      } else if (d.ubs_link === "REPORTED") {
        shape = '<rect class="mark" x="' + (cx - r) + '" y="' + (cy - r) + '" width="' + 2 * r + '" height="' + 2 * r +
          '" transform="rotate(45 ' + cx + " " + cy + ')" fill="' + fill + '"';
      } else {
        shape = '<polygon class="mark" points="' + [cx, cy - r - 1, cx + r + 1, cy + r, cx - r - 1, cy + r].join(",") +
          '" fill="' + fill + '"';
      }
      s.push(shape + ' data-sig="' + i + '" data-id="' + esc(d.signal_id) + '"><title>' +
        esc(d.vendor_name + " - " + d.risk_category + " (" + d.tier + ")") + "</title></" +
        (d.ubs_link === "CONFIRMED" ? "circle" : d.ubs_link === "REPORTED" ? "rect" : "polygon") + ">");
    });
    s.push("</svg>");
    return s.join("");
  }

  function matrixLegend() {
    var tierItems = TIERS.map(function (t) {
      return '<span class="item"><i class="dot sw-' + t + '"></i>' + t + "</span>";
    }).join("");
    return '<div class="legend">' + tierItems +
      '<span class="item"><svg class="shape" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--ink-2)"/></svg>Confirmed link</span>' +
      '<span class="item"><svg class="shape" viewBox="0 0 14 14"><rect x="3" y="3" width="8" height="8" transform="rotate(45 7 7)" fill="var(--ink-2)"/></svg>Reported</span>' +
      '<span class="item"><svg class="shape" viewBox="0 0 14 14"><polygon points="7,2 12,11 2,11" fill="var(--ink-2)"/></svg>Industry only</span>' +
      "</div>";
  }

  /* Horizontal bars for a nominal breakdown: one colour for every bar, the
     leading bar carries the accent (emphasis, not a value ramp). */
  function barsSVG(rows, opts) {
    opts = opts || {};
    var rowH = 26, mL = opts.labelWidth || 118, mR = 46, W = 480;
    var H = rows.length * rowH + 12;
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; })) || 1;
    var pw = W - mL - mR;
    var s = ['<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(opts.label || "breakdown") + '">'];
    rows.forEach(function (r, i) {
      var w = Math.max(1, (r.value / max) * pw), ty = i * rowH + 6;
      s.push('<text class="tick" x="' + (mL - 10) + '" y="' + (ty + 13) + '" text-anchor="end">' + esc(r.label) + "</text>");
      s.push('<rect class="bar" x="' + mL + '" y="' + ty + '" width="' + w +
        '" height="14" rx="2" data-bar="' + i + '"><title>' + esc(r.label + ": " + r.value) + "</title></rect>");
      s.push('<text class="bar-label" x="' + (mL + w + 8) + '" y="' + (ty + 12) + '">' + r.value + "</text>");
    });
    s.push("</svg>");
    return s.join("");
  }

  function tierStrip(counts, total) {
    var seg = TIERS.filter(function (t) { return counts[t]; }).map(function (t) {
      var pct = (counts[t] / total) * 100;
      return '<div style="flex:' + counts[t] + ';background:' + TIER_VAR[t] + '" title="' +
        t + ": " + counts[t] + ' signals (' + num(pct) + '%)"></div>';
    }).join("");
    var legend = TIERS.map(function (t) {
      return '<span class="item"><i class="dot sw-' + t + '"></i>' + t + " <b>" + (counts[t] || 0) + "</b></span>";
    }).join("");
    return '<div class="strip">' + seg + '</div><div class="strip-legend">' + legend + "</div>";
  }

  /* ----------------------------------------------------------- views */
  function viewAlerts() {
    var alerts = filteredAlerts(), signals = filteredSignals();
    var counts = {};
    TIERS.forEach(function (t) { counts[t] = 0; });
    signals.forEach(function (s) { counts[s.tier]++; });

    var crit = alerts.filter(function (a) { return a.tier === "Critical"; }).length;
    var realEv = alerts.filter(function (a) { return a.n_real_sources > 0; }).length;

    var html = '<div class="kpis">' +
      kpi("Vendors monitored", DATA.vendors.length, DATA.meta.n_confirmed + " with a confirmed UBS link") +
      kpi("Signals assessed", DATA.meta.n_scored, DATA.meta.n_positive + " positive signals offset risk") +
      kpi("Early warnings", alerts.length, "High and Critical only", true) +
      kpi("Critical", crit, "24h response deadline") +
      kpi("Backed by public sources", realEv + "/" + alerts.length,
          (alerts.length - realEv) + " rest on illustrative data") +
      "</div>";

    html += '<div class="panel"><h2>Where the portfolio sits</h2>' +
      '<p class="note">Every scored signal by tier. Medium is the watchlist; only High and Critical ' +
      'become an action item with an owner and a deadline.</p>' +
      tierStrip(counts, signals.length || 1) + "</div>";

    if (!alerts.length) {
      html += '<div class="empty">No early warnings match these filters.</div>';
      return html;
    }

    html += alerts.map(function (a, i) {
      var ev = a.evidence.map(function (e) {
        return "<li>" +
          '<div class="src"><code>' + esc(e.signal_id) + "</code><span>" + esc(e.date) + "</span>" +
          "<span>" + esc(SOURCE_LABEL[e.source_type] || e.source_type) + "</span>" +
          "<span>" + esc(e.maturity) + "</span>" + provTag(e.provenance) +
          (e.url ? ' <a href="' + esc(e.url) + '" target="_blank" rel="noopener">source &#8599;</a>' : "") +
          "</div><q>" + esc(e.text) + "</q></li>";
      }).join("");
      var steps = a.actions.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("");

      return '<article class="alert tier-' + esc(a.tier) + '">' +
        '<div class="top">' + chip(a.tier) +
        "<h3>" + esc(a.vendor_name) + "</h3>" +
        '<span class="cat">' + esc(a.risk_category) + "</span>" +
        linkTag(a.ubs_link) +
        '<span class="score">' + num(a.residual_risk) + "<span>/25</span></span></div>" +
        '<p class="headline">' + esc(headline(a)) + "</p>" +
        '<p class="why">' + esc(a.why) + "</p>" +
        '<div class="routing">' +
        "<div><span>Owner</span>" + esc(a.owner_team) + "</div>" +
        "<div><span>Inform</span>" + esc(a.inform) + "</div>" +
        '<div class="due"><span>Response due</span><b>' + esc(a.deadline) + "</b></div>" +
        "<div><span>Evidence</span>" + a.n_signals + " signal" + (a.n_signals > 1 ? "s" : "") +
        ", " + a.n_real_sources + " public</div>" +
        "<div><span>Decision</span>Human review required</div>" +
        "</div>" +
        '<details class="disclosure"' + (i === 0 ? " open" : "") + "><summary>Evidence behind the warning (" +
        a.evidence.length + ")</summary><ul class=\"evidence\">" + ev + "</ul></details>" +
        '<details class="disclosure"><summary>Recommended next steps</summary>' +
        '<p class="why">' + esc(a.response) + '</p><ol class="steps">' + steps + "</ol></details>" +
        "</article>";
    }).join("");
    return html;
  }

  function kpi(label, value, foot, accent) {
    return '<div class="kpi"><div class="label">' + esc(label) + '</div>' +
      '<div class="value' + (accent ? " accent" : "") + '">' + esc(value) + "</div>" +
      '<div class="foot">' + esc(foot) + "</div></div>";
  }

  function viewVendors() {
    var rows = filteredVendors();
    if (!rows.length) return '<div class="empty">No vendors match these filters.</div>';
    var body = rows.map(function (v) {
      return "<tr>" +
        '<td><button class="row-button" data-vendor="' + esc(v.vendor_name) + '">' + esc(v.vendor_name) +
        '</button><div class="sub">' + esc(v.service) + " &middot; " + esc(v.country) + "</div></td>" +
        "<td>" + linkTag(v.ubs_link, true) + "</td>" +
        '<td><div class="depbar" title="UBS dependency index ' + v.dependency_index + '"><i style="width:' +
        (v.dependency_index * 100) + '%"></i></div><div class="sub">' + num(v.dependency_index, 2) + "</div></td>" +
        "<td>" + esc(v.dominant_category || "-") + "</td>" +
        '<td class="num">' + num(v.residual_risk) + "</td>" +
        "<td>" + chip(v.tier) + "</td>" +
        '<td class="num">' + v.n_risk_signals + "</td>" +
        '<td class="num">' + v.n_positive + "</td>" +
        '<td class="sub">' + esc(v.next_review) + "</td>" +
        "</tr>";
    }).join("");
    return '<div class="panel"><h2>Vendor portfolio</h2>' +
      '<p class="note">Worst residual risk per vendor, with the category driving it. Dependency index ' +
      'combines data sensitivity, business criticality and how hard the vendor is to replace. ' +
      'Select a vendor for its profile and signals.</p>' +
      '<table class="grid"><thead><tr><th>Vendor</th><th>Relationship</th><th>UBS dependency</th>' +
      "<th>Dominant category</th><th class=\"num\">Residual</th><th>Tier</th>" +
      '<th class="num">Risk signals</th><th class="num">Positive</th><th>Next review</th></tr></thead><tbody>' +
      body + "</tbody></table></div>";
  }

  function viewSignals() {
    var rows = filteredSignals().slice().sort(function (a, b) { return b.residual_risk - a.residual_risk; });
    if (!rows.length) return '<div class="empty">No signals match these filters.</div>';
    var body = rows.map(function (s, i) {
      return "<tr>" +
        '<td class="sub">' + esc(s.date) + "</td>" +
        "<td>" + esc(s.vendor_name) + "</td>" +
        "<td>" + esc(s.risk_category) + "</td>" +
        "<td>" + esc(SOURCE_LABEL[s.source_type] || s.source_type) + '<div class="sub">' + esc(s.maturity) + "</div></td>" +
        "<td>" + provTag(s.provenance) + "</td>" +
        '<td class="num">' + num(s.likelihood) + "</td>" +
        '<td class="num">' + num(s.impact) + "</td>" +
        '<td class="num">' + num(s.residual_risk) + "</td>" +
        "<td>" + chip(s.tier) + "</td>" +
        '<td><button class="row-button" data-signal="' + i + '">Why?</button></td>' +
        "</tr>" +
        '<tr class="detail" hidden data-detail="' + i + '"><td colspan="10">' +
        "<q>" + esc(s.text) + "</q>" +
        '<div class="expl">' + esc(s.explanation) + "</div>" +
        (s.url ? '<div class="expl"><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url) + "</a></div>" : "") +
        "</td></tr>";
    }).join("");
    return '<div class="panel"><h2>Signal explorer</h2>' +
      '<p class="note">Every risk-bearing signal that survived the entity and direction gates, with the ' +
      'likelihood and impact that produced its score. This is the table view behind the matrix.</p>' +
      '<table class="grid"><thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th>Source</th>' +
      '<th>Provenance</th><th class="num">L</th><th class="num">I</th><th class="num">Residual</th>' +
      "<th>Tier</th><th></th></tr></thead><tbody>" + body + "</tbody></table></div>";
  }

  function viewAnalytics() {
    var sig = filteredSignals();
    if (!sig.length) return '<div class="empty">No signals match these filters.</div>';

    var byCat = tally(sig, "risk_category");
    var bySrc = tally(sig, "source_type").map(function (r) {
      return { label: SOURCE_LABEL[r.label] || r.label, value: r.value };
    });

    return '<div class="chart-row">' +
      '<div class="panel"><h2>Likelihood &times; impact</h2>' +
      '<p class="note">Each mark is one scored signal. Colour is its tier, shape is how established the ' +
      'UBS relationship is. The wash deepens with likelihood &times; impact; the top-right corner is where ' +
      'early warnings come from.</p>' +
      matrixSVG(sig) + matrixLegend() + "</div>" +
      '<div><div class="panel"><h2>Risk signals by category</h2>' +
      '<p class="note">What the classifier is actually finding across the portfolio.</p>' +
      barsSVG(byCat, { label: "signals by category" }) + "</div>" +
      '<div class="panel"><h2>Where the signals come from</h2>' +
      '<p class="note">Source type drives credibility in the likelihood score - a regulator filing ' +
      'outweighs a vendor answering its own questionnaire.</p>' +
      barsSVG(bySrc, { label: "signals by source" }) + "</div></div>" +
      "</div>";
  }

  function tally(rows, key) {
    var m = {};
    rows.forEach(function (r) { m[r[key]] = (m[r[key]] || 0) + 1; });
    return Object.keys(m).map(function (k) { return { label: k, value: m[k] }; })
      .sort(function (a, b) { return b.value - a.value; });
  }

  function viewMethod() {
    var c = DATA.meta.config;
    var w = c.evidence_weights;
    return '<div class="panel"><h2>How a signal becomes a warning</h2>' +
      '<p class="note">The language model reads each signal and labels it. Every number below is then ' +
      'computed in Python from those labels plus the vendor profile, so a score can always be traced ' +
      'back to a rule rather than to a generated sentence.</p>' +
      '<ol class="steps" style="font-size:13.5px">' +
      "<li><b>Gate.</b> Signals the classifier says are not about the vendor are dropped. Only " +
      "<i>risk</i>-direction signals are scored; <i>positive</i> ones (certifications kept, DR tests " +
      "passed, remediation verified) become control evidence instead.</li>" +
      "<li><b>Likelihood (1-5) = evidence strength &times; freshness.</b> Evidence strength weighs source " +
      "credibility " + pct(w.credibility) + ", maturity " + pct(w.maturity) + ", classifier confidence " +
      pct(w.confidence) + " and corroboration " + pct(w.corroboration) + ". Freshness halves every " +
      c.recency_half_life_days + " days down to a floor of " + c.recency_floor + ".</li>" +
      "<li><b>Impact (1-5).</b> A base impact per category, moved by the vendor's data sensitivity, " +
      "business criticality and substitutability, then scaled by how established the UBS link is " +
      "(confirmed 1.00, reported 0.85, industry-only 0.65).</li>" +
      "<li><b>Residual risk.</b> Inherent risk (L &times; I) reduced by recent positive evidence, capped at " +
      pct(c.max_control_reduction) + " - controls never take risk to zero.</li>" +
      "<li><b>Tier.</b> Critical from 16, High from 10, Medium from 5, otherwise Low.</li>" +
      "<li><b>Route.</b> High and Critical become an action item: owner team by category, deadline by tier, " +
      "evidence attached, human review always required.</li>" +
      "</ol></div>" +

      '<div class="panel"><h2>Guardrails</h2>' +
      '<p class="note">The brief asks for <i>ethical</i> early warning. These are the rules that stop the ' +
      'system amplifying rumour or implying exposure that has not been established.</p>' +
      '<ol class="steps" style="font-size:13.5px">' +
      "<li>A rumour or allegation is capped below High until a person confirms it.</li>" +
      "<li>A vendor with no publicly confirmed UBS relationship never reaches Critical - the finding may " +
      "be real for the industry, but it is not presented as a UBS exposure.</li>" +
      "<li>Self-reported vendor questionnaires carry the lowest credibility and the smallest control credit.</li>" +
      "<li>Every warning states whether its evidence is a public source or demo data, and links out where " +
      "a public source exists.</li>" +
      "<li>No automated action touches a vendor: the system proposes an owner, a deadline and steps.</li>" +
      "<li>Public, company-level signals only - no personal data and no inference about named individuals.</li>" +
      "</ol></div>" +

      '<div class="panel"><h2>Input quality</h2>' +
      '<p class="note">The scores are only as good as the labels underneath them, so the pipeline grades ' +
      'its own classifier against a held-out category that the model never sees.</p>' +
      '<div class="kpis">' +
      kpi("Classifier agreement", DATA.meta.agreement == null ? "n/a" : num(DATA.meta.agreement * 100, 1) + "%", "vs held-out seed category") +
      kpi("Signals classified", DATA.meta.n_classified, "of " + DATA.meta.n_ingested + " ingested") +
      kpi("Dropped as wrong entity", DATA.meta.n_wrong_entity, "homonym guard") +
      "</div></div>";
  }
  function pct(x) { return Math.round(x * 100) + "%"; }

  /* --------------------------------------------------------------- drawer */
  var drawer = byId("drawer"), backdrop = byId("drawer-backdrop");
  function openVendor(name) {
    var v = DATA.vendors.filter(function (d) { return d.vendor_name === name; })[0];
    if (!v) return;
    var sig = DATA.signals.filter(function (s) { return s.vendor_name === name; })
      .sort(function (a, b) { return b.residual_risk - a.residual_risk; });
    var alerts = DATA.alerts.filter(function (a) { return a.vendor_name === name; });

    drawer.innerHTML = '<button class="close" type="button" aria-label="Close">&times;</button>' +
      "<h2>" + esc(v.vendor_name) + "</h2>" +
      '<p class="sub">' + esc(v.service) + " &middot; " + esc(v.country) + "</p>" +
      '<p style="margin-top:12px">' + chip(v.tier) + " " + linkTag(v.ubs_link) + "</p>" +
      '<dl class="dl">' +
      "<dt>Relationship</dt><dd>" + esc(v.relationship_note || "-") +
      (v.ubs_link_source ? ' <a href="' + esc(v.ubs_link_source) + '" target="_blank" rel="noopener">source &#8599;</a>' : "") + "</dd>" +
      "<dt>Data sensitivity</dt><dd>" + v.data_sensitivity + " / 5</dd>" +
      "<dt>Business criticality</dt><dd>" + v.business_criticality + " / 5</dd>" +
      "<dt>Substitutability</dt><dd>" + v.substitutability + " / 5 <span class=\"sub\">(1 = hard to replace)</span></dd>" +
      "<dt>Dependency index</dt><dd>" + num(v.dependency_index, 2) + "</dd>" +
      "<dt>Worst residual</dt><dd>" + num(v.residual_risk) + " / 25 (" + esc(v.dominant_category || "-") + ")</dd>" +
      "<dt>Next review</dt><dd>" + esc(v.next_review) + "</dd>" +
      "</dl>" +
      (alerts.length ? "<h3>Open early warnings</h3>" + alerts.map(function (a) {
        return "<p>" + chip(a.tier) + " <b>" + esc(a.risk_category) + "</b> &mdash; " +
          num(a.residual_risk) + "/25<br><span class=\"sub\">" + esc(a.owner_team) + " &middot; due " +
          esc(a.deadline) + "</span></p>";
      }).join("") : "<h3>Open early warnings</h3><p class=\"sub\">None above the alert threshold.</p>") +
      "<h3>Signals (" + sig.length + ")</h3>" +
      '<ul class="evidence">' + sig.map(function (s) {
        return "<li><div class=\"src\">" + chip(s.tier) + "<span>" + esc(s.date) + "</span><span>" +
          esc(s.risk_category) + "</span><span>" + esc(SOURCE_LABEL[s.source_type] || s.source_type) +
          "</span>" + provTag(s.provenance) + "</div><q>" + esc(s.text) + "</q>" +
          (s.url ? '<div><a href="' + esc(s.url) + '" target="_blank" rel="noopener">source &#8599;</a></div>' : "") + "</li>";
      }).join("") + "</ul>";

    drawer.setAttribute("data-open", "1");
    backdrop.setAttribute("data-open", "1");
    drawer.focus();
  }
  function closeDrawer() {
    drawer.removeAttribute("data-open");
    backdrop.removeAttribute("data-open");
  }

  /* ----------------------------------------------------------------- wire */
  function render() {
    var host = byId("view");
    host.innerHTML =
      state.view === "alerts" ? viewAlerts() :
      state.view === "vendors" ? viewVendors() :
      state.view === "signals" ? viewSignals() :
      state.view === "analytics" ? viewAnalytics() : viewMethod();

    byId("c-alerts").textContent = filteredAlerts().length;
    byId("c-vendors").textContent = filteredVendors().length;
    byId("c-signals").textContent = filteredSignals().length;
    var active = state.vendor || state.category || state.tier || state.link || state.q;
    byId("f-showing").textContent = active
      ? filteredSignals().length + " of " + DATA.signals.length + " signals match"
      : DATA.signals.length + " signals assessed";
    byId("filters").style.display = state.view === "method" ? "none" : "";
  }

  function fillSelect(id, values) {
    var sel = byId(id);
    values.forEach(function (v) {
      var o = document.createElement("option");
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    });
  }

  function init() {
    byId("m-asof").textContent = DATA.meta.as_of;
    byId("m-generated").textContent = DATA.meta.generated;

    fillSelect("f-vendor", DATA.vendors.map(function (v) { return v.vendor_name; }).sort());
    fillSelect("f-category", tally(DATA.signals, "risk_category").map(function (r) { return r.label; }).sort());
    fillSelect("f-tier", TIERS);
    fillSelect("f-link", ["CONFIRMED", "REPORTED", "INDUSTRY"]);

    function selectTab(view, scroll) {
      var btn = document.querySelector('nav.tabs button[data-view="' + view + '"]');
      if (!btn) return;
      document.querySelectorAll("nav.tabs button").forEach(function (o) { o.setAttribute("aria-selected", "false"); });
      btn.setAttribute("aria-selected", "true");
      state.view = view;
      render();
      if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
    }
    document.querySelectorAll("nav.tabs button").forEach(function (b) {
      b.addEventListener("click", function () {
        location.hash = b.dataset.view;      // deep-linkable: index.html#analytics
        selectTab(b.dataset.view, true);
      });
    });
    window.addEventListener("hashchange", function () {
      selectTab((location.hash || "#alerts").slice(1), true);
    });

    [["f-vendor", "vendor"], ["f-category", "category"], ["f-tier", "tier"], ["f-link", "link"]].forEach(function (p) {
      byId(p[0]).addEventListener("change", function (e) { state[p[1]] = e.target.value; render(); });
    });
    var qTimer;
    byId("f-search").addEventListener("input", function (e) {
      clearTimeout(qTimer);
      qTimer = setTimeout(function () { state.q = e.target.value.trim(); render(); }, 140);
    });
    byId("f-reset").addEventListener("click", function () {
      state.vendor = state.category = state.tier = state.link = state.q = "";
      ["f-vendor", "f-category", "f-tier", "f-link", "f-search"].forEach(function (id) { byId(id).value = ""; });
      render();
    });

    /* Theme: follow the OS until the viewer picks one, then remember the pick.
       Storage can throw in a private window, so every access is guarded. */
    var toggle = byId("theme-toggle");
    function prefersDark() {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    function isDark() {
      var set = document.documentElement.getAttribute("data-theme");
      return set ? set === "dark" : prefersDark();
    }
    function paintToggle() { toggle.textContent = isDark() ? "Light theme" : "Dark theme"; }
    try {
      var saved = localStorage.getItem("tpr-theme");
      if (saved === "dark" || saved === "light") document.documentElement.setAttribute("data-theme", saved);
    } catch (e) { /* storage unavailable - fall back to the OS preference */ }
    paintToggle();
    toggle.addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("tpr-theme", next); } catch (e) { /* ignore */ }
      paintToggle();
    });

    /* delegated: vendor drill-down, signal "why", chart hover */
    document.addEventListener("click", function (e) {
      var vb = e.target.closest("[data-vendor]");
      if (vb) { openVendor(vb.dataset.vendor); return; }
      var sb = e.target.closest("[data-signal]");
      if (sb) {
        var row = document.querySelector('[data-detail="' + sb.dataset.signal + '"]');
        if (row) { row.hidden = !row.hidden; sb.textContent = row.hidden ? "Why?" : "Hide"; }
        return;
      }
      if (e.target.closest(".drawer .close") || e.target === backdrop) closeDrawer();
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });

    document.addEventListener("mousemove", function (e) {
      var m = e.target.closest ? e.target.closest("svg.chart .mark") : null;
      if (m) {
        var d = filteredSignals().slice().sort(function (a, b) { return a.residual_risk - b.residual_risk; })[+m.dataset.sig];
        if (d) {
          showTip("<b>" + esc(d.vendor_name) + "</b>" +
            '<span class="t-sub">' + esc(d.risk_category) + " &middot; " + esc(d.tier) + " &middot; " +
            num(d.residual_risk) + "/25</span><br>" + esc(d.text.slice(0, 130)) +
            (d.text.length > 130 ? "..." : ""), e);
        }
        return;
      }
      var bar = e.target.closest ? e.target.closest("svg.chart .bar") : null;
      if (!bar) hideTip();
    }, true);

    selectTab((location.hash || "#alerts").slice(1), false);
  }

  if (!DATA) {
    document.getElementById("view").innerHTML =
      '<div class="empty">No data loaded. Run <code>python build_dashboard.py</code> to generate ' +
      '<code>frontend/data.js</code> from the pipeline output.</div>';
  } else {
    init();
  }
})();
