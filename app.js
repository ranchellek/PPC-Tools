/* Amazon PPC Bulk File Duplicator Tool
 * All parsing/analysis happens client-side in the browser. Nothing leaves the page.
 */
(function () {
  "use strict";

  /* ---------------------------------------------------------------------
   * Constants
   * ------------------------------------------------------------------- */
  const NEG_KEYWORD_ENTITIES = new Set(["Negative Keyword", "Campaign Negative Keyword"]);
  const NEG_PT_ENTITIES = new Set(["Negative Product Targeting", "Campaign Negative Product Targeting"]);
  const AUTO_DEFAULT_CLAUSES = new Set(["close-match", "loose-match", "substitutes", "complements"]);
  const ASIN_RE = /^b0[a-z0-9]{8}$/i;

  /* ---------------------------------------------------------------------
   * Generic helpers
   * ------------------------------------------------------------------- */
  function pick(row, keys) {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return null;
  }

  function toNum(v) {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return isFinite(v) ? v : 0;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? 0 : n;
  }

  function normText(s) {
    if (s === null || s === undefined) return "";
    return String(s).trim().toLowerCase().replace(/\s+/g, " ");
  }

  function isEnabled(r) {
    return (r.state || "").toLowerCase() === "enabled";
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtInt(v) {
    return Math.round(toNum(v)).toLocaleString();
  }

  function fmtMoney(v) {
    const n = toNum(v);
    const symbol = state.currencySymbol || "";
    return symbol + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPct(v) {
    return (toNum(v) * 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
  }

  function fmtDec(v, digits) {
    return toNum(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function downloadCsv(filename, rows) {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const escapeCell = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const lines = [headers.join(",")];
    rows.forEach((r) => lines.push(headers.map((h) => escapeCell(r[h])).join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function currencySymbolFor(code) {
    const map = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CAD: "CA$", AUD: "A$", MXN: "MX$", BRL: "R$", INR: "₹" };
    return map[code] || (code ? code + " " : "");
  }

  /* ---------------------------------------------------------------------
   * App state
   * ------------------------------------------------------------------- */
  const state = {
    fileName: null,
    allRows: [],
    sheetSummaries: [],
    currencySymbol: "",
    checkerIndex: null,
    duplicateGroups: [],
    checkerResults: [],
  };

  /* ---------------------------------------------------------------------
   * Parsing & normalization
   * ------------------------------------------------------------------- */
  function normalizeRow(sheetName, row) {
    const entity = row["Entity"] ? String(row["Entity"]).trim() : "";
    const product = row["Product"] ? String(row["Product"]).trim() : "";

    let kind = "other";
    if (entity === "Keyword") kind = "keyword";
    else if (NEG_KEYWORD_ENTITIES.has(entity)) kind = "negativeKeyword";
    else if (entity === "Product Targeting") kind = "productTargeting";
    else if (NEG_PT_ENTITIES.has(entity)) kind = "negativeProductTargeting";

    const keywordText = pick(row, ["Keyword Text"]);
    const matchType = pick(row, ["Match Type"]);
    const targetingExpr = pick(row, ["Product Targeting Expression", "Targeting Expression"]);
    const resolvedExpr = pick(row, [
      "Resolved Product Targeting Expression (Informational only)",
      "Resolved Targeting Expression (Informational only)",
    ]);

    let targetText = null;
    let targetLabel = null;
    let effectiveMatchType = null;
    if (kind === "keyword" || kind === "negativeKeyword") {
      targetText = keywordText;
      targetLabel = targetText;
      effectiveMatchType = matchType;
    } else if (kind === "productTargeting" || kind === "negativeProductTargeting") {
      targetText = targetingExpr;
      targetLabel = resolvedExpr || targetingExpr;
      effectiveMatchType = null;
    }

    const campaignId = pick(row, ["Campaign ID"]);
    const adGroupId = pick(row, ["Ad Group ID"]);
    const normTargetText = normText(targetText);

    return {
      sheet: sheetName,
      product,
      entity,
      kind,
      campaignId,
      campaignName: pick(row, ["Campaign Name", "Campaign Name (Informational only)"]),
      adGroupId,
      adGroupName: pick(row, ["Ad Group Name", "Ad Group Name (Informational only)"]),
      scopeId: adGroupId || campaignId,
      targetId: pick(row, ["Keyword ID", "Product Targeting ID", "Targeting ID"]),
      targetText,
      targetLabel,
      matchType: effectiveMatchType,
      normTargetText,
      isAutoDefaultClause: kind === "productTargeting" && AUTO_DEFAULT_CLAUSES.has(normTargetText),
      bid: pick(row, ["Bid"]),
      state: pick(row, ["State"]),
      campaignState: pick(row, ["Campaign State (Informational only)"]),
      adGroupState: pick(row, ["Ad Group State (Informational only)"]),
      impressions: toNum(row["Impressions"]),
      clicks: toNum(row["Clicks"]),
      ctr: toNum(row["Click-through Rate"]),
      spend: toNum(row["Spend"]),
      sales: toNum(row["Sales"]),
      orders: toNum(row["Orders"]),
      units: toNum(row["Units"]),
      cvr: toNum(row["Conversion Rate"]),
      acos: toNum(row["ACOS"]),
      cpc: toNum(row["CPC"]),
      roas: toNum(row["ROAS"]),
      raw: row,
    };
  }

  function parseWorkbook(wb) {
    const allRows = [];
    const sheetSummaries = [];

    wb.SheetNames.forEach((name) => {
      const ws = wb.Sheets[name];
      const json = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
      const hasEntityCol = json.length > 0 && Object.prototype.hasOwnProperty.call(json[0], "Entity");
      if (!hasEntityCol) {
        sheetSummaries.push({ name, rows: json.length, skipped: true });
        return;
      }
      const normalized = json.map((r) => normalizeRow(name, r));
      allRows.push(...normalized);
      sheetSummaries.push({ name, rows: json.length, skipped: false });
    });

    return { allRows, sheetSummaries };
  }

  function detectCurrency(allRows) {
    const codes = allRows
      .filter((r) => r.sheet === "Portfolios")
      .map((r) => r.raw["Budget Currency Code"])
      .filter(Boolean);
    if (!codes.length) return "";
    const counts = {};
    codes.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    return currencySymbolFor(top);
  }

  /* ---------------------------------------------------------------------
   * Tab navigation
   * ------------------------------------------------------------------- */
  function initTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
      });
    });
  }

  /* ---------------------------------------------------------------------
   * Bulk File Upload tab
   * ------------------------------------------------------------------- */
  function initUploadTab() {
    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("file-input");
    const clearBtn = document.getElementById("clear-file-btn");

    dropZone.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", (e) => {
      if (e.target.files.length) handleFile(e.target.files[0]);
    });
    clearBtn.addEventListener("click", resetState);
  }

  function showUploadError(msg) {
    const box = document.getElementById("upload-error");
    box.textContent = msg;
    box.classList.remove("hidden");
  }

  function hideUploadError() {
    document.getElementById("upload-error").classList.add("hidden");
  }

  function handleFile(file) {
    hideUploadError();
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });
        const { allRows, sheetSummaries } = parseWorkbook(wb);
        if (!allRows.length) {
          showUploadError(
            "No recognizable Amazon Ads bulk data found. Make sure you're uploading the bulk sheet export (.xlsx) with sheets like 'Sponsored Products Campaigns'."
          );
          return;
        }
        state.fileName = file.name;
        state.allRows = allRows;
        state.sheetSummaries = sheetSummaries;
        state.currencySymbol = detectCurrency(allRows);
        state.checkerIndex = buildCheckerIndex(allRows);
        state.duplicateGroups = [];
        state.checkerResults = [];

        renderUploadSummary();
        updateFileStatus();
        renderDuplicator();
        resetCheckerUI();
      } catch (err) {
        console.error(err);
        showUploadError("Could not parse this file. Make sure it's a valid Amazon Ads bulk .xlsx export.\n\n" + err.message);
      }
    };
    reader.onerror = () => showUploadError("Could not read the file.");
    reader.readAsArrayBuffer(file);
  }

  function updateFileStatus() {
    const el = document.getElementById("file-status");
    if (state.fileName) {
      el.textContent = "Loaded: " + state.fileName + " (" + state.allRows.length.toLocaleString() + " rows)";
      el.classList.add("loaded");
    } else {
      el.textContent = "No bulk file loaded";
      el.classList.remove("loaded");
    }
  }

  function renderUploadSummary() {
    document.getElementById("sum-filename").textContent = state.fileName;
    const parsedSheets = state.sheetSummaries.filter((s) => !s.skipped).length;
    document.getElementById("sum-sheets").textContent = parsedSheets + " / " + state.sheetSummaries.length;
    document.getElementById("sum-rows").textContent = state.allRows.length.toLocaleString();
    document.getElementById("sum-currency").textContent = state.currencySymbol || "Unknown";

    const kindCounts = {};
    state.allRows.forEach((r) => {
      const label = r.product ? r.product + " — " + r.entity : r.entity || "(unknown)";
      kindCounts[label] = (kindCounts[label] || 0) + 1;
    });
    const entityRows = Object.keys(kindCounts)
      .sort((a, b) => kindCounts[b] - kindCounts[a])
      .map((label) => `<tr><td>${escapeHtml(label)}</td><td>${kindCounts[label].toLocaleString()}</td></tr>`)
      .join("");
    document.getElementById("entity-breakdown").innerHTML = `
      <table><thead><tr><th>Product — Entity</th><th>Rows</th></tr></thead><tbody>${entityRows}</tbody></table>`;

    const sheetRows = state.sheetSummaries
      .map(
        (s) =>
          `<tr><td>${escapeHtml(s.name)}</td><td>${s.rows.toLocaleString()}</td><td>${
            s.skipped ? '<span class="pill pill-neutral">skipped (no data)</span>' : '<span class="pill pill-enabled">parsed</span>'
          }</td></tr>`
      )
      .join("");
    document.getElementById("sheet-breakdown").innerHTML = `
      <table><thead><tr><th>Sheet</th><th>Rows</th><th>Status</th></tr></thead><tbody>${sheetRows}</tbody></table>`;

    document.getElementById("upload-summary").classList.remove("hidden");
  }

  function resetState() {
    state.fileName = null;
    state.allRows = [];
    state.sheetSummaries = [];
    state.currencySymbol = "";
    state.checkerIndex = null;
    state.duplicateGroups = [];
    state.checkerResults = [];

    document.getElementById("upload-summary").classList.add("hidden");
    document.getElementById("file-input").value = "";
    hideUploadError();
    updateFileStatus();

    document.getElementById("duplicator-content").classList.add("hidden");
    document.getElementById("duplicator-empty").classList.remove("hidden");

    document.getElementById("checker-content").classList.add("hidden");
    document.getElementById("checker-empty").classList.remove("hidden");
  }

  /* ---------------------------------------------------------------------
   * Duplicator tab
   * ------------------------------------------------------------------- */
  function computeDuplicateGroups(rows, opts) {
    const map = new Map();
    rows.forEach((r) => {
      if (r.kind !== "keyword" && r.kind !== "productTargeting") return;
      if (!r.normTargetText) return;
      if (r.kind === "productTargeting" && !opts.includeAutoClauses && r.isAutoDefaultClause) return;
      if (!r.scopeId) return;
      const matchKey = r.kind === "keyword" ? (r.matchType || "").trim().toLowerCase() : "pt";
      const key = r.kind + "|" + r.normTargetText + "|" + matchKey;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });

    const groups = [];
    map.forEach((instances, key) => {
      const scopeSet = new Set(instances.map((i) => i.scopeId));
      if (scopeSet.size < 2) return;
      groups.push(buildGroup(key, instances));
    });
    groups.sort((a, b) => b.totals.spend - a.totals.spend);
    return groups;
  }

  function rankInstances(instances) {
    const arr = instances.slice();
    arr.sort((a, b) => {
      const aEnabled = isEnabled(a),
        bEnabled = isEnabled(b);
      if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
      if (b.orders !== a.orders) return b.orders - a.orders;
      if (b.sales !== a.sales) return b.sales - a.sales;
      const aAcos = a.orders > 0 ? a.acos : Infinity;
      const bAcos = b.orders > 0 ? b.acos : Infinity;
      if (aAcos !== bAcos) return aAcos - bAcos;
      return a.spend - b.spend;
    });
    return arr;
  }

  function computeAction(inst, idx) {
    if (!isEnabled(inst)) return "paused";
    if (idx === 0) return "keep";
    if (inst.spend > 0 && inst.orders === 0) return "pause";
    return "review";
  }

  function buildGroup(key, instances) {
    const [kind] = key.split("|");
    const totals = instances.reduce(
      (acc, i) => {
        acc.impressions += i.impressions;
        acc.clicks += i.clicks;
        acc.spend += i.spend;
        acc.sales += i.sales;
        acc.orders += i.orders;
        acc.units += i.units;
        return acc;
      },
      { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 }
    );

    const ranked = rankInstances(instances);
    ranked.forEach((inst, idx) => {
      inst.__action = computeAction(inst, idx);
    });

    const wastedSpend = ranked.filter((i) => i.__action === "pause").reduce((s, i) => s + i.spend, 0);

    return {
      key,
      kind,
      targetText: instances[0].targetLabel || instances[0].targetText,
      matchType: kind === "keyword" ? instances[0].matchType : "Product Targeting",
      products: Array.from(new Set(instances.map((i) => i.product))),
      instances: ranked,
      totals,
      wastedSpend,
    };
  }

  function initDuplicatorTab() {
    ["dup-search", "dup-product-filter", "dup-matchtype-filter"].forEach((id) => {
      document.getElementById(id).addEventListener("input", renderDuplicator);
      document.getElementById(id).addEventListener("change", renderDuplicator);
    });
    document.getElementById("dup-include-auto").addEventListener("change", () => {
      recomputeDuplicateGroups();
      renderDuplicator();
    });
    document.getElementById("dup-export-btn").addEventListener("click", exportDuplicatorCsv);
  }

  function recomputeDuplicateGroups() {
    const includeAutoClauses = document.getElementById("dup-include-auto").checked;
    state.duplicateGroups = computeDuplicateGroups(state.allRows, { includeAutoClauses });
  }

  function filteredDuplicateGroups() {
    const search = document.getElementById("dup-search").value.trim().toLowerCase();
    const productFilter = document.getElementById("dup-product-filter").value;
    const matchFilter = document.getElementById("dup-matchtype-filter").value;

    return state.duplicateGroups.filter((g) => {
      if (search && !normText(g.targetText).includes(search)) return false;
      if (productFilter !== "all" && !g.products.includes(productFilter)) return false;
      if (matchFilter !== "all") {
        if (matchFilter === "pt") {
          if (g.kind !== "productTargeting") return false;
        } else {
          if (g.kind !== "keyword" || (g.matchType || "") !== matchFilter) return false;
        }
      }
      return true;
    });
  }

  function renderDuplicator() {
    if (!state.allRows.length) return;
    document.getElementById("duplicator-empty").classList.add("hidden");
    document.getElementById("duplicator-content").classList.remove("hidden");

    if (state.duplicateGroups.length === 0 && state.allRows.length) {
      recomputeDuplicateGroups();
    }

    const groups = filteredDuplicateGroups();

    const totalInstances = groups.reduce((s, g) => s + g.instances.length, 0);
    const totalSpend = groups.reduce((s, g) => s + g.totals.spend, 0);
    const totalWaste = groups.reduce((s, g) => s + g.wastedSpend, 0);

    document.getElementById("dup-stat-groups").textContent = groups.length.toLocaleString();
    document.getElementById("dup-stat-instances").textContent = totalInstances.toLocaleString();
    document.getElementById("dup-stat-spend").textContent = fmtMoney(totalSpend);
    document.getElementById("dup-stat-waste").textContent = fmtMoney(totalWaste);

    renderDuplicatorTable(groups);
  }

  const ACTION_LABEL = {
    keep: '<span class="action-keep">Keep — top performer</span>',
    review: '<span class="action-review">Review</span>',
    pause: '<span class="action-pause">Pause — no conversions</span>',
    paused: '<span class="action-paused">Already paused</span>',
  };

  function statePill(s) {
    const cls = (s || "").toLowerCase() === "enabled" ? "pill-enabled" : (s || "").toLowerCase() === "paused" ? "pill-paused" : "pill-neutral";
    return `<span class="pill ${cls}">${escapeHtml(s || "—")}</span>`;
  }

  function renderDuplicatorTable(groups) {
    const container = document.getElementById("dup-groups-table");
    if (!groups.length) {
      container.innerHTML = '<div class="empty-state">No duplicate targets found for the current filters.</div>';
      return;
    }

    let html = `<table><thead><tr>
      <th></th><th>Target</th><th>Match Type</th><th>Ad Type(s)</th><th># Instances</th>
      <th>Impr.</th><th>Clicks</th><th>Spend</th><th>Sales</th><th>Orders</th><th>Wasted Spend</th>
    </tr></thead><tbody>`;

    groups.forEach((g, gi) => {
      html += `<tr class="group-row" data-idx="${gi}">
        <td><span class="expand-arrow">▶</span></td>
        <td>${escapeHtml(g.targetText)}</td>
        <td>${escapeHtml(g.matchType || "—")}</td>
        <td>${g.products.map(escapeHtml).join(", ")}</td>
        <td>${g.instances.length}</td>
        <td>${fmtInt(g.totals.impressions)}</td>
        <td>${fmtInt(g.totals.clicks)}</td>
        <td>${fmtMoney(g.totals.spend)}</td>
        <td>${fmtMoney(g.totals.sales)}</td>
        <td>${fmtInt(g.totals.orders)}</td>
        <td>${fmtMoney(g.wastedSpend)}</td>
      </tr>`;
      html += `<tr class="detail-row hidden" data-detail-idx="${gi}"><td colspan="11">${renderInstanceTable(g.instances)}</td></tr>`;
    });

    html += "</tbody></table>";
    container.innerHTML = html;

    container.querySelectorAll(".group-row").forEach((row) => {
      row.addEventListener("click", () => {
        const idx = row.dataset.idx;
        const detail = container.querySelector(`[data-detail-idx="${idx}"]`);
        const arrow = row.querySelector(".expand-arrow");
        detail.classList.toggle("hidden");
        arrow.classList.toggle("open");
      });
    });
  }

  function renderInstanceTable(instances) {
    let html = `<table class="detail-inner-table"><thead><tr>
      <th>Action</th><th>Ad Type</th><th>Campaign</th><th>Ad Group</th><th>State</th><th>Bid</th>
      <th>Impr.</th><th>Clicks</th><th>CTR</th><th>Spend</th><th>Sales</th><th>Orders</th><th>Units</th>
      <th>CVR</th><th>ACOS</th><th>CPC</th><th>ROAS</th>
    </tr></thead><tbody>`;
    instances.forEach((i) => {
      html += `<tr>
        <td>${ACTION_LABEL[i.__action]}</td>
        <td>${escapeHtml(i.product)}</td>
        <td>${escapeHtml(i.campaignName || "—")}</td>
        <td>${escapeHtml(i.adGroupName || "—")}</td>
        <td>${statePill(i.state)}</td>
        <td>${i.bid !== null ? fmtDec(i.bid, 2) : "—"}</td>
        <td>${fmtInt(i.impressions)}</td>
        <td>${fmtInt(i.clicks)}</td>
        <td>${fmtPct(i.ctr)}</td>
        <td>${fmtMoney(i.spend)}</td>
        <td>${fmtMoney(i.sales)}</td>
        <td>${fmtInt(i.orders)}</td>
        <td>${fmtInt(i.units)}</td>
        <td>${fmtPct(i.cvr)}</td>
        <td>${fmtPct(i.acos)}</td>
        <td>${fmtDec(i.cpc, 2)}</td>
        <td>${fmtDec(i.roas, 2)}</td>
      </tr>`;
    });
    html += "</tbody></table>";
    return html;
  }

  function exportDuplicatorCsv() {
    const groups = filteredDuplicateGroups();
    const rows = [];
    groups.forEach((g) => {
      g.instances.forEach((i) => {
        rows.push({
          "Target Text": g.targetText,
          "Match Type": g.matchType || "",
          Action: i.__action,
          "Ad Type": i.product,
          "Campaign Name": i.campaignName || "",
          "Ad Group Name": i.adGroupName || "",
          State: i.state || "",
          Bid: i.bid !== null ? i.bid : "",
          Impressions: i.impressions,
          Clicks: i.clicks,
          "CTR %": (i.ctr * 100).toFixed(2),
          Spend: i.spend.toFixed(2),
          Sales: i.sales.toFixed(2),
          Orders: i.orders,
          Units: i.units,
          "CVR %": (i.cvr * 100).toFixed(2),
          "ACOS %": (i.acos * 100).toFixed(2),
          CPC: i.cpc.toFixed(2),
          ROAS: i.roas.toFixed(2),
        });
      });
    });
    if (!rows.length) return;
    downloadCsv("duplicator_results.csv", rows);
  }

  /* ---------------------------------------------------------------------
   * Duplicate Checker tab
   * ------------------------------------------------------------------- */
  function buildCheckerIndex(rows) {
    const index = new Map();
    rows.forEach((r) => {
      if (!["keyword", "negativeKeyword", "productTargeting", "negativeProductTargeting"].includes(r.kind)) return;
      if (!r.normTargetText) return;
      if (!index.has(r.normTargetText)) index.set(r.normTargetText, { positive: [], negative: [] });
      const bucket = r.kind === "negativeKeyword" || r.kind === "negativeProductTargeting" ? "negative" : "positive";
      index.get(r.normTargetText)[bucket].push(r);
    });
    return index;
  }

  function checkTerms(terms, index) {
    return terms.map((term) => {
      const norm = normText(term);
      let entry = index.get(norm) || { positive: [], negative: [] };

      // If the term looks like an ASIN, also match against product targeting expressions like asin="b0xxxxxxxx"
      if (ASIN_RE.test(term.trim())) {
        const ptNorm = `asin="${norm}"`;
        const ptEntry = index.get(ptNorm);
        if (ptEntry) {
          entry = {
            positive: entry.positive.concat(ptEntry.positive),
            negative: entry.negative.concat(ptEntry.negative),
          };
        }
      }

      let status;
      if (entry.positive.length === 0 && entry.negative.length === 0) status = "new";
      else if (entry.positive.length > 0 && entry.negative.length > 0) status = "mixed";
      else if (entry.positive.length > 0) status = "existing";
      else status = "negative";

      return { term, norm, status, positive: entry.positive, negative: entry.negative };
    });
  }

  function recommendationFor(result) {
    if (result.status === "new") return "New — not currently targeted. Safe to add.";
    if (result.status === "negative")
      return "Blocked by a negative match elsewhere — adding as a positive target may conflict with that negative.";
    if (result.status === "mixed")
      return "Already targeted AND blocked by a negative elsewhere — review placements before adding again.";
    const allPaused = result.positive.every((r) => !isEnabled(r));
    if (allPaused) return "Previously targeted but currently paused everywhere — safe to reactivate or re-add.";
    return "Already actively targeted — adding again may create internal competition.";
  }

  function parseTerms(text) {
    const seen = new Set();
    const out = [];
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => {
        const term = line.split(",")[0].replace(/^["']|["']$/g, "").trim();
        if (!term) return;
        const key = term.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(term);
      });
    return out;
  }

  function initCheckerTab() {
    const fileBtn = document.getElementById("checker-file-btn");
    const fileInput = document.getElementById("checker-file-input");
    const runBtn = document.getElementById("checker-run-btn");
    const clearBtn = document.getElementById("checker-clear-btn");
    const exportBtn = document.getElementById("checker-export-btn");

    fileBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const textarea = document.getElementById("checker-textarea");
        textarea.value = textarea.value ? textarea.value + "\n" + ev.target.result : ev.target.result;
      };
      reader.readAsText(file);
    });

    runBtn.addEventListener("click", runChecker);
    clearBtn.addEventListener("click", () => {
      document.getElementById("checker-textarea").value = "";
      document.getElementById("checker-results-wrap").classList.add("hidden");
      state.checkerResults = [];
    });
    exportBtn.addEventListener("click", exportCheckerCsv);
  }

  function runChecker() {
    if (!state.checkerIndex) return;
    const text = document.getElementById("checker-textarea").value;
    const terms = parseTerms(text);
    if (!terms.length) return;
    state.checkerResults = checkTerms(terms, state.checkerIndex);
    renderCheckerResults();
  }

  function renderCheckerResults() {
    const results = state.checkerResults;
    document.getElementById("checker-results-wrap").classList.remove("hidden");

    const newCount = results.filter((r) => r.status === "new").length;
    const existingCount = results.filter((r) => r.status === "existing" || r.status === "mixed").length;
    const negativeCount = results.filter((r) => r.status === "negative" || r.status === "mixed").length;

    document.getElementById("chk-stat-total").textContent = results.length.toLocaleString();
    document.getElementById("chk-stat-new").textContent = newCount.toLocaleString();
    document.getElementById("chk-stat-existing").textContent = existingCount.toLocaleString();
    document.getElementById("chk-stat-negative").textContent = negativeCount.toLocaleString();

    const STATUS_LABEL = {
      new: '<span class="status-new">New</span>',
      existing: '<span class="status-existing">Already Targeted</span>',
      negative: '<span class="status-negative">Blocked by Negative</span>',
      mixed: '<span class="status-mixed">Targeted + Negated</span>',
    };

    let html = `<table><thead><tr>
      <th>Term</th><th>Status</th><th>Existing Targeting</th><th>Negative Matches</th><th>Recommendation</th>
    </tr></thead><tbody>`;

    results.forEach((r) => {
      const posList = dedupeInstanceLabels(r.positive)
        .slice(0, 6)
        .map(
          (i) =>
            `<div>${escapeHtml(i.matchTypeLabel)} · ${escapeHtml(i.campaignName)} / ${escapeHtml(i.adGroupName)} ${statePill(i.state)}</div>`
        )
        .join("");
      const negList = dedupeInstanceLabels(r.negative)
        .slice(0, 6)
        .map(
          (i) =>
            `<div>${escapeHtml(i.matchTypeLabel)} · ${escapeHtml(i.campaignName)} / ${escapeHtml(i.adGroupName)} ${statePill(i.state)}</div>`
        )
        .join("");

      html += `<tr>
        <td>${escapeHtml(r.term)}</td>
        <td>${STATUS_LABEL[r.status]}</td>
        <td>${posList || "—"}</td>
        <td>${negList || "—"}</td>
        <td class="small-muted">${escapeHtml(recommendationFor(r))}</td>
      </tr>`;
    });

    html += "</tbody></table>";
    document.getElementById("checker-results-table").innerHTML = html;
  }

  function dedupeInstanceLabels(instances) {
    const map = new Map();
    instances.forEach((i) => {
      const matchTypeLabel = i.kind === "keyword" || i.kind === "negativeKeyword" ? i.matchType || "—" : "Product Targeting";
      const key = matchTypeLabel + "|" + (i.campaignName || "") + "|" + (i.adGroupName || "") + "|" + i.state;
      if (!map.has(key)) map.set(key, { matchTypeLabel, campaignName: i.campaignName || "—", adGroupName: i.adGroupName || "—", state: i.state });
    });
    return Array.from(map.values());
  }

  function exportCheckerCsv() {
    const rows = state.checkerResults.map((r) => {
      const pos = dedupeInstanceLabels(r.positive)
        .map((i) => `${i.matchTypeLabel}: ${i.campaignName} / ${i.adGroupName} (${i.state})`)
        .join(" | ");
      const neg = dedupeInstanceLabels(r.negative)
        .map((i) => `${i.matchTypeLabel}: ${i.campaignName} / ${i.adGroupName} (${i.state})`)
        .join(" | ");
      return {
        Term: r.term,
        Status: r.status,
        "Existing Targeting": pos,
        "Negative Matches": neg,
        Recommendation: recommendationFor(r),
      };
    });
    if (!rows.length) return;
    downloadCsv("duplicate_checker_results.csv", rows);
  }

  function resetCheckerUI() {
    document.getElementById("checker-empty").classList.add("hidden");
    document.getElementById("checker-content").classList.remove("hidden");
    document.getElementById("checker-results-wrap").classList.add("hidden");
    document.getElementById("checker-textarea").value = "";
  }

  /* ---------------------------------------------------------------------
   * Init
   * ------------------------------------------------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initUploadTab();
    initDuplicatorTab();
    initCheckerTab();
    updateFileStatus();
  });
})();
