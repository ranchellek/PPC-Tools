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
  const ASIN_TOKEN_RE = /B0[A-Z0-9]{8}/gi;
  const PLACEMENT_LABELS = {
    "placement top": "Top of Search",
    "placement rest of search": "Rest of Search",
    "placement product page": "Product Pages",
    other: "Other",
    "detail page": "Detail Page",
    home: "Home",
  };
  const TARGETS_PAGE_SIZE = 100;

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

  function extractAsins(str) {
    if (!str) return [];
    const matches = String(str).match(ASIN_TOKEN_RE) || [];
    return Array.from(new Set(matches.map((s) => s.toUpperCase())));
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

  function statePill(s) {
    const cls = (s || "").toLowerCase() === "enabled" ? "pill-enabled" : (s || "").toLowerCase() === "paused" ? "pill-paused" : "pill-neutral";
    return `<span class="pill ${cls}">${escapeHtml(s || "—")}</span>`;
  }

  function sumMetrics(rows) {
    const t = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };
    rows.forEach((r) => {
      t.impressions += r.impressions;
      t.clicks += r.clicks;
      t.spend += r.spend;
      t.sales += r.sales;
      t.orders += r.orders;
      t.units += r.units;
    });
    t.ctr = t.impressions > 0 ? t.clicks / t.impressions : 0;
    t.cvr = t.clicks > 0 ? t.orders / t.clicks : 0;
    t.acos = t.sales > 0 ? t.spend / t.sales : 0;
    t.cpc = t.clicks > 0 ? t.spend / t.clicks : 0;
    t.roas = t.spend > 0 ? t.sales / t.spend : 0;
    return t;
  }

  function sortRows(rows, columns, sortKey, sortDir) {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col || !col.sortValue) return rows;
    return rows.slice().sort((a, b) => {
      const av = col.sortValue(a);
      const bv = col.sortValue(b);
      if (av === null || av === undefined || av === "") return 1;
      if (bv === null || bv === undefined || bv === "") return -1;
      if (typeof av === "string" || typeof bv === "string") {
        return sortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }

  function setSort(stateObj, columns, key) {
    if (stateObj.sortKey === key) {
      stateObj.sortDir = stateObj.sortDir === "asc" ? "desc" : "asc";
      return;
    }
    const col = columns.find((c) => c.key === key);
    stateObj.sortKey = key;
    stateObj.sortDir = col && col.type === "text" ? "asc" : "desc";
  }

  function renderDataTable(container, columns, rows, sortKey, sortDir, onSortChange) {
    if (!rows.length) {
      container.innerHTML = '<div class="empty-state">No rows match the current filters.</div>';
      return;
    }
    const theadCells = columns
      .map((c) => {
        if (!onSortChange || !c.sortValue) return `<th>${escapeHtml(c.label)}</th>`;
        const active = c.key === sortKey;
        const arrow = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
        return `<th class="sortable-th${active ? " sorted" : ""}" data-key="${c.key}">${escapeHtml(c.label)}${arrow}</th>`;
      })
      .join("");
    const bodyRows = rows.map((r) => "<tr>" + columns.map((c) => `<td>${c.render(r)}</td>`).join("") + "</tr>").join("");
    container.innerHTML = `<table><thead><tr>${theadCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
    if (onSortChange) {
      container.querySelectorAll("th.sortable-th").forEach((th) => {
        th.addEventListener("click", () => onSortChange(th.dataset.key));
      });
    }
  }

  function toggleEmptyContent(prefix) {
    const hasFile = state.allRows.length > 0;
    const emptyEl = document.getElementById(prefix + "-empty");
    const contentEl = document.getElementById(prefix + "-content");
    if (emptyEl) emptyEl.classList.toggle("hidden", hasFile);
    if (contentEl) contentEl.classList.toggle("hidden", !hasFile);
    return hasFile;
  }

  const METRIC_COLUMNS = [
    { key: "impressions", label: "Impr.", sortValue: (r) => r.impressions, render: (r) => fmtInt(r.impressions) },
    { key: "clicks", label: "Clicks", sortValue: (r) => r.clicks, render: (r) => fmtInt(r.clicks) },
    { key: "ctr", label: "CTR", sortValue: (r) => r.ctr, render: (r) => fmtPct(r.ctr) },
    { key: "spend", label: "Spend", sortValue: (r) => r.spend, render: (r) => fmtMoney(r.spend) },
    { key: "sales", label: "Sales", sortValue: (r) => r.sales, render: (r) => fmtMoney(r.sales) },
    { key: "orders", label: "Orders", sortValue: (r) => r.orders, render: (r) => fmtInt(r.orders) },
    { key: "units", label: "Units", sortValue: (r) => r.units, render: (r) => fmtInt(r.units) },
    { key: "cvr", label: "CVR", sortValue: (r) => r.cvr, render: (r) => fmtPct(r.cvr) },
    { key: "acos", label: "ACOS", sortValue: (r) => r.acos, render: (r) => fmtPct(r.acos) },
    { key: "cpc", label: "CPC", sortValue: (r) => r.cpc, render: (r) => fmtDec(r.cpc, 2) },
    { key: "roas", label: "ROAS", sortValue: (r) => r.roas, render: (r) => fmtDec(r.roas, 2) },
  ];

  /* ---------------------------------------------------------------------
   * App state
   * ------------------------------------------------------------------- */
  const state = {
    fileName: null,
    allRows: [],
    sheetSummaries: [],
    currencySymbol: "",
    checkerIndex: null,
    scopeAsinMap: new Map(),
    campaignRows: [],
    asinRows: [],
    targetRows: [],
    duplicateGroups: [],
    dupUnknownAsinCount: 0,
    checkerResults: [],
    activeTab: "campaigns",
    lastRealTab: "campaigns",
  };

  function getAsinsForRow(r) {
    const set = state.scopeAsinMap.get(r.scopeId);
    return set ? Array.from(set) : [];
  }

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
    else if (entity === "Campaign") kind = "campaign";
    else if (entity === "Product Ad") kind = "productAd";

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
      sku: pick(row, ["SKU"]),
      asin: pick(row, ["ASIN (Informational only)"]),
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

  function buildScopeAsinMap(allRows) {
    const map = new Map();
    allRows.forEach((r) => {
      if (!r.scopeId) return;
      const asins = extractAsins(pick(r.raw, ["ASIN (Informational only)", "Creative ASINs", "Landing Page ASINs"]));
      if (!asins.length) return;
      if (!map.has(r.scopeId)) map.set(r.scopeId, new Set());
      asins.forEach((a) => map.get(r.scopeId).add(a));
    });
    return map;
  }

  /* ---------------------------------------------------------------------
   * Sidebar nav / tab switching
   * ------------------------------------------------------------------- */
  const TAB_TITLES = {
    campaigns: "Campaigns",
    matchtype: "Match Type",
    placements: "Bid Placements",
    asin: "ASIN",
    targets: "Keywords & Targets",
    duplicator: "Duplicator",
    checker: "Duplicates Checker",
    search: "Search Results",
  };

  function showTabPanel(tabName) {
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    document.getElementById("tab-" + tabName).classList.add("active");
  }

  function refreshExportButtonVisibility() {
    const btn = document.getElementById("export-current-btn");
    const show = state.allRows.length > 0 && !!EXPORT_HANDLERS[state.activeTab];
    btn.classList.toggle("hidden", !show);
  }

  function activateTab(tabName) {
    state.activeTab = tabName;
    if (tabName !== "search") state.lastRealTab = tabName;
    showTabPanel(tabName);
    document.getElementById("active-tab-title").textContent = TAB_TITLES[tabName] || "";
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
    refreshExportButtonVisibility();
    if (TAB_RENDER[tabName]) TAB_RENDER[tabName]();
  }

  function initSideNav() {
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById("global-search").value = "";
        activateTab(btn.dataset.tab);
      });
    });
  }

  /* ---------------------------------------------------------------------
   * File menu (upload / status / clear / export)
   * ------------------------------------------------------------------- */
  function initFileMenu() {
    const menuBtn = document.getElementById("file-menu-btn");
    const dropdown = document.getElementById("file-dropdown");
    const dropZone = document.getElementById("file-drop-zone");
    const fileInput = document.getElementById("file-input");

    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!dropdown.classList.contains("hidden") && !dropdown.contains(e.target) && e.target !== menuBtn) {
        dropdown.classList.add("hidden");
      }
    });

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

    document.getElementById("clear-file-btn").addEventListener("click", () => {
      resetState();
      dropdown.classList.add("hidden");
    });
    document.getElementById("export-current-btn").addEventListener("click", () => {
      const handler = EXPORT_HANDLERS[state.activeTab];
      if (handler) handler();
    });
  }

  function showUploadError(msg) {
    const box = document.getElementById("upload-error");
    box.textContent = msg;
    box.classList.remove("hidden");
  }

  function hideUploadError() {
    document.getElementById("upload-error").classList.add("hidden");
  }

  function updateFileMenuStatus() {
    const dot = document.getElementById("file-menu-dot");
    const label = document.getElementById("file-menu-label");
    const info = document.getElementById("file-info");
    const clearBtn = document.getElementById("clear-file-btn");

    if (state.fileName) {
      dot.classList.add("loaded");
      label.textContent = "File Loaded";
      info.classList.remove("hidden");
      document.getElementById("file-info-name").textContent = state.fileName;
      document.getElementById("file-info-meta").textContent =
        state.allRows.length.toLocaleString() + " rows · " + (state.currencySymbol ? "currency " + state.currencySymbol : "currency unknown");
      clearBtn.classList.remove("hidden");
    } else {
      dot.classList.remove("loaded");
      label.textContent = "Upload File";
      info.classList.add("hidden");
      clearBtn.classList.add("hidden");
    }
    refreshExportButtonVisibility();
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
        state.scopeAsinMap = buildScopeAsinMap(allRows);
        state.campaignRows = computeCampaignRows(allRows);
        state.asinRows = computeAsinRows(allRows);
        state.targetRows = computeTargetRows(allRows);
        state.checkerIndex = buildCheckerIndex(allRows);
        state.duplicateGroups = [];
        state.dupUnknownAsinCount = 0;
        state.checkerResults = [];

        updateFileMenuStatus();
        resetCheckerUI();
        activateTab(state.activeTab === "search" ? "campaigns" : state.activeTab);
        document.getElementById("file-dropdown").classList.add("hidden");
      } catch (err) {
        console.error(err);
        showUploadError("Could not parse this file. Make sure it's a valid Amazon Ads bulk .xlsx export.\n\n" + err.message);
      }
    };
    reader.onerror = () => showUploadError("Could not read the file.");
    reader.readAsArrayBuffer(file);
  }

  function resetState() {
    state.fileName = null;
    state.allRows = [];
    state.sheetSummaries = [];
    state.currencySymbol = "";
    state.checkerIndex = null;
    state.scopeAsinMap = new Map();
    state.campaignRows = [];
    state.asinRows = [];
    state.targetRows = [];
    state.duplicateGroups = [];
    state.dupUnknownAsinCount = 0;
    state.checkerResults = [];

    document.getElementById("file-input").value = "";
    hideUploadError();
    updateFileMenuStatus();
    resetCheckerUI();
    activateTab(state.activeTab === "search" ? "campaigns" : state.activeTab);
  }

  /* ---------------------------------------------------------------------
   * Campaigns tab
   * ------------------------------------------------------------------- */
  function computeCampaignRows(allRows) {
    return allRows
      .filter((r) => r.kind === "campaign")
      .map((r) => ({
        name: r.campaignName || "(unnamed)",
        product: r.product,
        portfolioName: pick(r.raw, ["Portfolio Name (Informational only)"]) || "",
        targetingType: pick(r.raw, ["Targeting Type"]) || "",
        budget: pick(r.raw, ["Daily Budget", "Budget"]),
        state: r.state,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.ctr,
        spend: r.spend,
        sales: r.sales,
        orders: r.orders,
        units: r.units,
        cvr: r.cvr,
        acos: r.acos,
        cpc: r.cpc,
        roas: r.roas,
      }));
  }

  const CAMPAIGN_COLUMNS = [
    { key: "name", label: "Campaign", type: "text", sortValue: (r) => normText(r.name), render: (r) => escapeHtml(r.name) },
    { key: "product", label: "Ad Type", type: "text", sortValue: (r) => r.product, render: (r) => escapeHtml(r.product) },
    { key: "portfolioName", label: "Portfolio", type: "text", sortValue: (r) => r.portfolioName, render: (r) => escapeHtml(r.portfolioName || "—") },
    { key: "targetingType", label: "Targeting", type: "text", sortValue: (r) => r.targetingType, render: (r) => escapeHtml(r.targetingType || "—") },
    { key: "state", label: "State", type: "text", sortValue: (r) => r.state || "", render: (r) => statePill(r.state) },
    {
      key: "budget",
      label: "Budget",
      sortValue: (r) => toNum(r.budget),
      render: (r) => (r.budget !== null && r.budget !== undefined && r.budget !== "" ? fmtMoney(r.budget) : "—"),
    },
    ...METRIC_COLUMNS,
  ];

  const campState = { sortKey: "spend", sortDir: "desc" };

  function initCampaignsTab() {
    ["camp-search", "camp-product-filter", "camp-state-filter"].forEach((id) => {
      document.getElementById(id).addEventListener("input", renderCampaigns);
      document.getElementById(id).addEventListener("change", renderCampaigns);
    });
  }

  function filteredCampaignRows() {
    const search = normText(document.getElementById("camp-search").value);
    const product = document.getElementById("camp-product-filter").value;
    const stateFilter = document.getElementById("camp-state-filter").value;
    return state.campaignRows.filter((r) => {
      if (search && !normText(r.name).includes(search)) return false;
      if (product !== "all" && r.product !== product) return false;
      if (stateFilter !== "all" && (r.state || "").toLowerCase() !== stateFilter) return false;
      return true;
    });
  }

  function renderCampaigns() {
    if (!toggleEmptyContent("campaigns")) return;
    let rows = filteredCampaignRows();
    rows = sortRows(rows, CAMPAIGN_COLUMNS, campState.sortKey, campState.sortDir);

    document.getElementById("camp-stat-count").textContent = rows.length.toLocaleString();
    const totals = sumMetrics(rows);
    document.getElementById("camp-stat-spend").textContent = fmtMoney(totals.spend);
    document.getElementById("camp-stat-sales").textContent = fmtMoney(totals.sales);
    document.getElementById("camp-stat-acos").textContent = fmtPct(totals.acos);

    renderDataTable(document.getElementById("campaigns-table"), CAMPAIGN_COLUMNS, rows, campState.sortKey, campState.sortDir, (key) => {
      setSort(campState, CAMPAIGN_COLUMNS, key);
      renderCampaigns();
    });
  }

  function exportCampaignsCsv() {
    const rows = sortRows(filteredCampaignRows(), CAMPAIGN_COLUMNS, campState.sortKey, campState.sortDir);
    downloadCsv(
      "campaigns.csv",
      rows.map((r) => ({
        Campaign: r.name,
        "Ad Type": r.product,
        Portfolio: r.portfolioName,
        Targeting: r.targetingType,
        State: r.state || "",
        Budget: r.budget || "",
        Impressions: r.impressions,
        Clicks: r.clicks,
        "CTR %": (r.ctr * 100).toFixed(2),
        Spend: r.spend.toFixed(2),
        Sales: r.sales.toFixed(2),
        Orders: r.orders,
        Units: r.units,
        "CVR %": (r.cvr * 100).toFixed(2),
        "ACOS %": (r.acos * 100).toFixed(2),
        CPC: r.cpc.toFixed(2),
        ROAS: r.roas.toFixed(2),
      }))
    );
  }

  /* ---------------------------------------------------------------------
   * Match Type tab
   * ------------------------------------------------------------------- */
  function computeMatchTypeBuckets(allRows) {
    const buckets = { Auto: [], Exact: [], Phrase: [], Broad: [] };
    allRows.forEach((r) => {
      if (r.kind === "keyword") {
        const mt = (r.matchType || "").trim();
        if (buckets[mt]) buckets[mt].push(r);
      } else if (r.kind === "productTargeting") {
        buckets.Auto.push(r);
      }
    });
    return Object.keys(buckets).map((name) => ({ name, rows: buckets[name], count: buckets[name].length, ...sumMetrics(buckets[name]) }));
  }

  function renderMatchType() {
    if (!toggleEmptyContent("matchtype")) return;
    const buckets = computeMatchTypeBuckets(state.allRows);

    let html = `<table><thead><tr><th>Match Type</th><th># Targets</th>${METRIC_COLUMNS.map((c) => `<th>${escapeHtml(c.label)}</th>`).join(
      ""
    )}</tr></thead><tbody>`;
    buckets.forEach((b) => {
      html += `<tr><td><strong>${escapeHtml(b.name)}</strong></td><td>${b.count.toLocaleString()}</td>${METRIC_COLUMNS.map(
        (c) => `<td>${c.render(b)}</td>`
      ).join("")}</tr>`;
    });
    html += "</tbody></table>";
    document.getElementById("matchtype-table").innerHTML = html;

    const byProduct = new Map();
    buckets.forEach((b) => {
      b.rows.forEach((r) => {
        const key = b.name + "|" + r.product;
        if (!byProduct.has(key)) byProduct.set(key, { bucket: b.name, product: r.product, rows: [] });
        byProduct.get(key).rows.push(r);
      });
    });
    const breakdownRows = Array.from(byProduct.values())
      .map((g) => ({ bucket: g.bucket, product: g.product, count: g.rows.length, ...sumMetrics(g.rows) }))
      .sort((a, b) => b.spend - a.spend);

    let html2 = `<table><thead><tr><th>Match Type</th><th>Ad Type</th><th># Targets</th>${METRIC_COLUMNS.map(
      (c) => `<th>${escapeHtml(c.label)}</th>`
    ).join("")}</tr></thead><tbody>`;
    breakdownRows.forEach((g) => {
      html2 += `<tr><td>${escapeHtml(g.bucket)}</td><td>${escapeHtml(g.product)}</td><td>${g.count.toLocaleString()}</td>${METRIC_COLUMNS.map(
        (c) => `<td>${c.render(g)}</td>`
      ).join("")}</tr>`;
    });
    html2 += "</tbody></table>";
    document.getElementById("matchtype-breakdown").innerHTML = html2;
  }

  function exportMatchTypeCsv() {
    const buckets = computeMatchTypeBuckets(state.allRows);
    downloadCsv(
      "match_type_performance.csv",
      buckets.map((b) => ({
        "Match Type": b.name,
        "# Targets": b.count,
        Impressions: b.impressions,
        Clicks: b.clicks,
        "CTR %": (b.ctr * 100).toFixed(2),
        Spend: b.spend.toFixed(2),
        Sales: b.sales.toFixed(2),
        Orders: b.orders,
        Units: b.units,
        "CVR %": (b.cvr * 100).toFixed(2),
        "ACOS %": (b.acos * 100).toFixed(2),
        CPC: b.cpc.toFixed(2),
        ROAS: b.roas.toFixed(2),
      }))
    );
  }

  /* ---------------------------------------------------------------------
   * Bid Placements tab
   * ------------------------------------------------------------------- */
  function placementLabel(raw) {
    const norm = normText(raw);
    return PLACEMENT_LABELS[norm] || raw || "(unspecified)";
  }

  function computePlacementRows(allRows) {
    const map = new Map();
    allRows.forEach((r) => {
      if (r.entity !== "Bidding Adjustment" && r.entity !== "Bidding Adjustment by Placement") return;
      const label = placementLabel(pick(r.raw, ["Placement"]));
      const key = r.product + "|" + label;
      if (!map.has(key)) map.set(key, { product: r.product, placement: label, rows: [], campaigns: new Set() });
      const b = map.get(key);
      b.rows.push(r);
      if (r.campaignId) b.campaigns.add(r.campaignId);
    });
    return Array.from(map.values()).map((b) => ({
      product: b.product,
      placement: b.placement,
      campaignCount: b.campaigns.size,
      ...sumMetrics(b.rows),
    }));
  }

  const PLACEMENT_COLUMNS = [
    { key: "product", label: "Ad Type", type: "text", sortValue: (r) => r.product, render: (r) => escapeHtml(r.product) },
    { key: "placement", label: "Placement", type: "text", sortValue: (r) => r.placement, render: (r) => escapeHtml(r.placement) },
    { key: "campaignCount", label: "# Campaigns", sortValue: (r) => r.campaignCount, render: (r) => r.campaignCount.toLocaleString() },
    ...METRIC_COLUMNS,
  ];

  const placeState = { sortKey: "spend", sortDir: "desc" };

  function initPlacementsTab() {
    document.getElementById("place-product-filter").addEventListener("change", renderPlacements);
  }

  function filteredPlacementRows() {
    const product = document.getElementById("place-product-filter").value;
    let rows = computePlacementRows(state.allRows);
    if (product !== "all") rows = rows.filter((r) => r.product === product);
    return rows;
  }

  function renderPlacements() {
    if (!toggleEmptyContent("placements")) return;
    const rows = sortRows(filteredPlacementRows(), PLACEMENT_COLUMNS, placeState.sortKey, placeState.sortDir);
    renderDataTable(document.getElementById("placements-table"), PLACEMENT_COLUMNS, rows, placeState.sortKey, placeState.sortDir, (key) => {
      setSort(placeState, PLACEMENT_COLUMNS, key);
      renderPlacements();
    });
  }

  function exportPlacementsCsv() {
    const rows = sortRows(filteredPlacementRows(), PLACEMENT_COLUMNS, placeState.sortKey, placeState.sortDir);
    downloadCsv(
      "bid_placements.csv",
      rows.map((r) => ({
        "Ad Type": r.product,
        Placement: r.placement,
        "# Campaigns": r.campaignCount,
        Impressions: r.impressions,
        Clicks: r.clicks,
        "CTR %": (r.ctr * 100).toFixed(2),
        Spend: r.spend.toFixed(2),
        Sales: r.sales.toFixed(2),
        Orders: r.orders,
        Units: r.units,
        "CVR %": (r.cvr * 100).toFixed(2),
        "ACOS %": (r.acos * 100).toFixed(2),
        CPC: r.cpc.toFixed(2),
        ROAS: r.roas.toFixed(2),
      }))
    );
  }

  /* ---------------------------------------------------------------------
   * ASIN tab
   * ------------------------------------------------------------------- */
  function computeAsinRows(allRows) {
    const map = new Map();
    allRows.forEach((r) => {
      if (r.kind !== "productAd") return;
      const asin = r.asin || r.sku;
      if (!asin) return;
      if (!map.has(asin)) map.set(asin, { asin, skus: new Set(), rows: [] });
      const b = map.get(asin);
      if (r.sku) b.skus.add(r.sku);
      b.rows.push(r);
    });
    return Array.from(map.values()).map((b) => ({
      asin: b.asin,
      sku: Array.from(b.skus).join(", "),
      products: Array.from(new Set(b.rows.map((r) => r.product))),
      campaignCount: new Set(b.rows.map((r) => r.campaignId)).size,
      anyEnabled: b.rows.some((r) => isEnabled(r)),
      instances: b.rows,
      ...sumMetrics(b.rows),
    }));
  }

  const ASIN_COLUMNS = [
    { key: "asin", label: "ASIN", type: "text", sortValue: (r) => r.asin, render: (r) => `<span class="pill pill-asin">${escapeHtml(r.asin)}</span>` },
    { key: "sku", label: "SKU", type: "text", sortValue: (r) => r.sku, render: (r) => escapeHtml(r.sku || "—") },
    {
      key: "products",
      label: "Ad Type(s)",
      type: "text",
      sortValue: (r) => r.products.join(","),
      render: (r) => r.products.map(escapeHtml).join(", "),
    },
    { key: "campaignCount", label: "# Campaigns", sortValue: (r) => r.campaignCount, render: (r) => r.campaignCount.toLocaleString() },
    ...METRIC_COLUMNS,
  ];

  const asinState = { sortKey: "spend", sortDir: "desc" };

  function initAsinTab() {
    document.getElementById("asin-search").addEventListener("input", renderAsin);
    document.getElementById("asin-state-filter").addEventListener("change", renderAsin);
  }

  function filteredAsinRows() {
    const search = normText(document.getElementById("asin-search").value);
    const stateFilter = document.getElementById("asin-state-filter").value;
    return state.asinRows.filter((r) => {
      if (search && !normText(r.asin).includes(search) && !normText(r.sku).includes(search)) return false;
      if (stateFilter === "enabled" && !r.anyEnabled) return false;
      if (stateFilter === "paused" && r.anyEnabled) return false;
      return true;
    });
  }

  function renderAsin() {
    if (!toggleEmptyContent("asin")) return;
    const rows = sortRows(filteredAsinRows(), ASIN_COLUMNS, asinState.sortKey, asinState.sortDir);
    renderAsinTable(rows);
  }

  function renderAsinTable(rows) {
    const container = document.getElementById("asin-table");
    if (!rows.length) {
      container.innerHTML = '<div class="empty-state">No ASIN data found for the current filters.</div>';
      return;
    }
    const theadCells = ASIN_COLUMNS.map((c) => {
      const active = c.key === asinState.sortKey;
      const arrow = active ? (asinState.sortDir === "asc" ? " ▲" : " ▼") : "";
      return `<th class="sortable-th${active ? " sorted" : ""}" data-key="${c.key}">${escapeHtml(c.label)}${arrow}</th>`;
    }).join("");

    let html = `<table><thead><tr><th></th>${theadCells}</tr></thead><tbody>`;
    rows.forEach((r, idx) => {
      html += `<tr class="group-row" data-idx="${idx}"><td><span class="expand-arrow">▶</span></td>${ASIN_COLUMNS.map(
        (c) => `<td>${c.render(r)}</td>`
      ).join("")}</tr>`;
      html += `<tr class="detail-row hidden" data-detail-idx="${idx}"><td colspan="${ASIN_COLUMNS.length + 1}">${renderAsinInstanceTable(
        r.instances
      )}</td></tr>`;
    });
    html += "</tbody></table>";
    container.innerHTML = html;

    container.querySelectorAll("th.sortable-th").forEach((th) => {
      th.addEventListener("click", () => {
        setSort(asinState, ASIN_COLUMNS, th.dataset.key);
        renderAsin();
      });
    });
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

  function renderAsinInstanceTable(instances) {
    let html = `<table class="detail-inner-table"><thead><tr>
      <th>Ad Type</th><th>Campaign</th><th>Ad Group</th><th>State</th>
      <th>Impr.</th><th>Clicks</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACOS</th><th>ROAS</th>
    </tr></thead><tbody>`;
    instances.forEach((i) => {
      html += `<tr>
        <td>${escapeHtml(i.product)}</td>
        <td>${escapeHtml(i.campaignName || "—")}</td>
        <td>${escapeHtml(i.adGroupName || "—")}</td>
        <td>${statePill(i.state)}</td>
        <td>${fmtInt(i.impressions)}</td>
        <td>${fmtInt(i.clicks)}</td>
        <td>${fmtMoney(i.spend)}</td>
        <td>${fmtMoney(i.sales)}</td>
        <td>${fmtInt(i.orders)}</td>
        <td>${fmtPct(i.acos)}</td>
        <td>${fmtDec(i.roas, 2)}</td>
      </tr>`;
    });
    html += "</tbody></table>";
    return html;
  }

  function exportAsinCsv() {
    const rows = sortRows(filteredAsinRows(), ASIN_COLUMNS, asinState.sortKey, asinState.sortDir);
    downloadCsv(
      "asin_performance.csv",
      rows.map((r) => ({
        ASIN: r.asin,
        SKU: r.sku,
        "Ad Type(s)": r.products.join(", "),
        "# Campaigns": r.campaignCount,
        Impressions: r.impressions,
        Clicks: r.clicks,
        "CTR %": (r.ctr * 100).toFixed(2),
        Spend: r.spend.toFixed(2),
        Sales: r.sales.toFixed(2),
        Orders: r.orders,
        Units: r.units,
        "CVR %": (r.cvr * 100).toFixed(2),
        "ACOS %": (r.acos * 100).toFixed(2),
        CPC: r.cpc.toFixed(2),
        ROAS: r.roas.toFixed(2),
      }))
    );
  }

  /* ---------------------------------------------------------------------
   * Keywords & Product Targets performance tab
   * ------------------------------------------------------------------- */
  function computeTargetRows(allRows) {
    return allRows.filter((r) => r.kind === "keyword" || r.kind === "productTargeting");
  }

  const TARGET_COLUMNS = [
    {
      key: "targetText",
      label: "Target",
      type: "text",
      sortValue: (r) => normText(r.targetLabel || r.targetText),
      render: (r) => escapeHtml(r.targetLabel || r.targetText || "—"),
    },
    { key: "kind", label: "Type", type: "text", sortValue: (r) => r.kind, render: (r) => (r.kind === "keyword" ? "Keyword" : "Product Targeting") },
    { key: "matchType", label: "Match Type", type: "text", sortValue: (r) => r.matchType || "", render: (r) => escapeHtml(r.matchType || "—") },
    { key: "product", label: "Ad Type", type: "text", sortValue: (r) => r.product, render: (r) => escapeHtml(r.product) },
    { key: "campaignName", label: "Campaign", type: "text", sortValue: (r) => normText(r.campaignName), render: (r) => escapeHtml(r.campaignName || "—") },
    { key: "adGroupName", label: "Ad Group", type: "text", sortValue: (r) => normText(r.adGroupName), render: (r) => escapeHtml(r.adGroupName || "—") },
    {
      key: "asins",
      label: "ASIN(s)",
      type: "text",
      sortValue: (r) => getAsinsForRow(r).join(","),
      render: (r) => {
        const a = getAsinsForRow(r);
        return a.length ? a.map((x) => `<span class="pill pill-asin">${escapeHtml(x)}</span>`).join("") : "—";
      },
    },
    { key: "state", label: "State", type: "text", sortValue: (r) => r.state || "", render: (r) => statePill(r.state) },
    { key: "bid", label: "Bid", sortValue: (r) => toNum(r.bid), render: (r) => (r.bid !== null ? fmtDec(r.bid, 2) : "—") },
    ...METRIC_COLUMNS,
  ];

  const tgtState = { sortKey: "spend", sortDir: "desc", page: 1 };

  function initTargetsTab() {
    ["tgt-search", "tgt-product-filter", "tgt-entity-filter", "tgt-matchtype-filter", "tgt-state-filter"].forEach((id) => {
      const handler = () => {
        tgtState.page = 1;
        renderTargets();
      };
      document.getElementById(id).addEventListener("input", handler);
      document.getElementById(id).addEventListener("change", handler);
    });
  }

  function filteredTargetRows() {
    const search = normText(document.getElementById("tgt-search").value);
    const product = document.getElementById("tgt-product-filter").value;
    const entityFilter = document.getElementById("tgt-entity-filter").value;
    const matchFilter = document.getElementById("tgt-matchtype-filter").value;
    const stateFilter = document.getElementById("tgt-state-filter").value;

    return state.targetRows.filter((r) => {
      if (search && !normText(r.targetLabel || r.targetText).includes(search)) return false;
      if (product !== "all" && r.product !== product) return false;
      if (entityFilter !== "all" && r.kind !== entityFilter) return false;
      if (matchFilter !== "all" && (r.matchType || "") !== matchFilter) return false;
      if (stateFilter !== "all" && (r.state || "").toLowerCase() !== stateFilter) return false;
      return true;
    });
  }

  function renderTargets() {
    if (!toggleEmptyContent("targets")) return;
    let rows = filteredTargetRows();
    rows = sortRows(rows, TARGET_COLUMNS, tgtState.sortKey, tgtState.sortDir);

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / TARGETS_PAGE_SIZE));
    if (tgtState.page > totalPages) tgtState.page = totalPages;
    const startIdx = (tgtState.page - 1) * TARGETS_PAGE_SIZE;
    const pageRows = rows.slice(startIdx, startIdx + TARGETS_PAGE_SIZE);

    renderDataTable(document.getElementById("targets-table"), TARGET_COLUMNS, pageRows, tgtState.sortKey, tgtState.sortDir, (key) => {
      setSort(tgtState, TARGET_COLUMNS, key);
      renderTargets();
    });

    const pager = document.getElementById("targets-pager");
    if (total === 0) {
      pager.innerHTML = "";
      return;
    }
    pager.innerHTML = `
      <button class="btn btn-secondary" id="tgt-prev-btn" ${tgtState.page <= 1 ? "disabled" : ""}>Prev</button>
      <span>Page ${tgtState.page} of ${totalPages} &middot; ${total.toLocaleString()} targets</span>
      <button class="btn btn-secondary" id="tgt-next-btn" ${tgtState.page >= totalPages ? "disabled" : ""}>Next</button>
    `;
    document.getElementById("tgt-prev-btn").addEventListener("click", () => {
      tgtState.page--;
      renderTargets();
    });
    document.getElementById("tgt-next-btn").addEventListener("click", () => {
      tgtState.page++;
      renderTargets();
    });
  }

  function exportTargetsCsv() {
    const rows = sortRows(filteredTargetRows(), TARGET_COLUMNS, tgtState.sortKey, tgtState.sortDir);
    downloadCsv(
      "keywords_and_targets.csv",
      rows.map((r) => ({
        Target: r.targetLabel || r.targetText || "",
        Type: r.kind === "keyword" ? "Keyword" : "Product Targeting",
        "Match Type": r.matchType || "",
        "Ad Type": r.product,
        Campaign: r.campaignName || "",
        "Ad Group": r.adGroupName || "",
        "ASIN(s)": getAsinsForRow(r).join(", "),
        State: r.state || "",
        Bid: r.bid !== null ? r.bid : "",
        Impressions: r.impressions,
        Clicks: r.clicks,
        "CTR %": (r.ctr * 100).toFixed(2),
        Spend: r.spend.toFixed(2),
        Sales: r.sales.toFixed(2),
        Orders: r.orders,
        Units: r.units,
        "CVR %": (r.cvr * 100).toFixed(2),
        "ACOS %": (r.acos * 100).toFixed(2),
        CPC: r.cpc.toFixed(2),
        ROAS: r.roas.toFixed(2),
      }))
    );
  }

  /* ---------------------------------------------------------------------
   * Duplicator tab
   * ------------------------------------------------------------------- */
  function computeDuplicateGroups(rows, opts) {
    const map = new Map();
    let unknownAsinCount = 0;

    rows.forEach((r) => {
      if (r.kind !== "keyword" && r.kind !== "productTargeting") return;
      if (!r.normTargetText) return;
      if (r.kind === "productTargeting" && !opts.includeAutoClauses && r.isAutoDefaultClause) return;
      if (!r.scopeId) return;
      const matchKey = r.kind === "keyword" ? (r.matchType || "").trim().toLowerCase() : "pt";
      const asins = getAsinsForRow(r);
      if (!asins.length) {
        unknownAsinCount++;
        return;
      }
      asins.forEach((asin) => {
        const key = r.kind + "|" + r.normTargetText + "|" + matchKey + "|" + asin;
        if (!map.has(key)) map.set(key, { kind: r.kind, asin, instances: [] });
        map.get(key).instances.push(r);
      });
    });

    const groups = [];
    map.forEach((entry) => {
      const scopeSet = new Set(entry.instances.map((i) => i.scopeId));
      if (scopeSet.size < 2) return;
      groups.push(buildGroup(entry));
    });
    groups.sort((a, b) => b.totals.spend - a.totals.spend);
    return { groups, unknownAsinCount };
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

  function buildGroup(entry) {
    const { kind, asin, instances } = entry;
    const totals = sumMetrics(instances);

    const ranked = rankInstances(instances);
    ranked.forEach((inst, idx) => {
      inst.__action = computeAction(inst, idx);
    });

    const wastedSpend = ranked.filter((i) => i.__action === "pause").reduce((s, i) => s + i.spend, 0);

    return {
      kind,
      asin,
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
  }

  function recomputeDuplicateGroups() {
    const includeAutoClauses = document.getElementById("dup-include-auto").checked;
    const { groups, unknownAsinCount } = computeDuplicateGroups(state.allRows, { includeAutoClauses });
    state.duplicateGroups = groups;
    state.dupUnknownAsinCount = unknownAsinCount;
  }

  function filteredDuplicateGroups() {
    const search = normText(document.getElementById("dup-search").value);
    const productFilter = document.getElementById("dup-product-filter").value;
    const matchFilter = document.getElementById("dup-matchtype-filter").value;

    return state.duplicateGroups.filter((g) => {
      if (search && !normText(g.targetText).includes(search) && !normText(g.asin).includes(search)) return false;
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
    if (!toggleEmptyContent("duplicator")) return;
    if (state.duplicateGroups.length === 0) recomputeDuplicateGroups();

    const groups = filteredDuplicateGroups();

    const totalInstances = groups.reduce((s, g) => s + g.instances.length, 0);
    const totalSpend = groups.reduce((s, g) => s + g.totals.spend, 0);
    const totalWaste = groups.reduce((s, g) => s + g.wastedSpend, 0);

    document.getElementById("dup-stat-groups").textContent = groups.length.toLocaleString();
    document.getElementById("dup-stat-instances").textContent = totalInstances.toLocaleString();
    document.getElementById("dup-stat-spend").textContent = fmtMoney(totalSpend);
    document.getElementById("dup-stat-waste").textContent = fmtMoney(totalWaste);

    const note = document.getElementById("dup-unknown-asin-note");
    if (state.dupUnknownAsinCount > 0) {
      note.textContent = `${state.dupUnknownAsinCount.toLocaleString()} keyword/product-target row(s) had no detectable advertised ASIN for their ad group and were excluded from duplicate matching.`;
      note.classList.remove("hidden");
    } else {
      note.classList.add("hidden");
    }

    renderDuplicatorTable(groups);
  }

  const ACTION_LABEL = {
    keep: '<span class="action-keep">Keep — top performer</span>',
    review: '<span class="action-review">Review</span>',
    pause: '<span class="action-pause">Pause — no conversions</span>',
    paused: '<span class="action-paused">Already paused</span>',
  };

  function renderDuplicatorTable(groups) {
    const container = document.getElementById("dup-groups-table");
    if (!groups.length) {
      container.innerHTML = '<div class="empty-state">No duplicate targets found for the current filters.</div>';
      return;
    }

    let html = `<table><thead><tr>
      <th></th><th>Target</th><th>Match Type</th><th>ASIN</th><th>Ad Type(s)</th><th># Instances</th>
      <th>Impr.</th><th>Clicks</th><th>Spend</th><th>Sales</th><th>Orders</th><th>Wasted Spend</th>
    </tr></thead><tbody>`;

    groups.forEach((g, gi) => {
      html += `<tr class="group-row" data-idx="${gi}">
        <td><span class="expand-arrow">▶</span></td>
        <td>${escapeHtml(g.targetText)}</td>
        <td>${escapeHtml(g.matchType || "—")}</td>
        <td><span class="pill pill-asin">${escapeHtml(g.asin)}</span></td>
        <td>${g.products.map(escapeHtml).join(", ")}</td>
        <td>${g.instances.length}</td>
        <td>${fmtInt(g.totals.impressions)}</td>
        <td>${fmtInt(g.totals.clicks)}</td>
        <td>${fmtMoney(g.totals.spend)}</td>
        <td>${fmtMoney(g.totals.sales)}</td>
        <td>${fmtInt(g.totals.orders)}</td>
        <td>${fmtMoney(g.wastedSpend)}</td>
      </tr>`;
      html += `<tr class="detail-row hidden" data-detail-idx="${gi}"><td colspan="12">${renderInstanceTable(g.instances)}</td></tr>`;
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
          ASIN: g.asin,
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
  }

  function runChecker() {
    if (!state.checkerIndex) return;
    const text = document.getElementById("checker-textarea").value;
    const terms = parseTerms(text);
    if (!terms.length) return;
    state.checkerResults = checkTerms(terms, state.checkerIndex);
    renderCheckerResults();
  }

  function dedupeInstanceLabels(instances) {
    const map = new Map();
    instances.forEach((i) => {
      const matchTypeLabel = i.kind === "keyword" || i.kind === "negativeKeyword" ? i.matchType || "—" : "Product Targeting";
      const asins = getAsinsForRow(i);
      const asinLabel = asins.length ? asins.join(", ") : "—";
      const key = matchTypeLabel + "|" + (i.campaignName || "") + "|" + (i.adGroupName || "") + "|" + i.state + "|" + asinLabel;
      if (!map.has(key))
        map.set(key, {
          matchTypeLabel,
          campaignName: i.campaignName || "—",
          adGroupName: i.adGroupName || "—",
          state: i.state,
          asinLabel,
        });
    });
    return Array.from(map.values());
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
      <th>Term</th><th>Status</th><th>Existing Targeting (Match Type &middot; Campaign / Ad Group &middot; ASIN)</th><th>Negative Matches</th><th>Recommendation</th>
    </tr></thead><tbody>`;

    results.forEach((r) => {
      const posList = dedupeInstanceLabels(r.positive)
        .slice(0, 6)
        .map(
          (i) =>
            `<div>${escapeHtml(i.matchTypeLabel)} · ${escapeHtml(i.campaignName)} / ${escapeHtml(i.adGroupName)} ${statePill(
              i.state
            )} <span class="pill pill-asin">${escapeHtml(i.asinLabel)}</span></div>`
        )
        .join("");
      const negList = dedupeInstanceLabels(r.negative)
        .slice(0, 6)
        .map(
          (i) =>
            `<div>${escapeHtml(i.matchTypeLabel)} · ${escapeHtml(i.campaignName)} / ${escapeHtml(i.adGroupName)} ${statePill(
              i.state
            )} <span class="pill pill-asin">${escapeHtml(i.asinLabel)}</span></div>`
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

  function exportCheckerCsv() {
    const rows = state.checkerResults.map((r) => {
      const pos = dedupeInstanceLabels(r.positive)
        .map((i) => `${i.matchTypeLabel}: ${i.campaignName} / ${i.adGroupName} (${i.state}) [${i.asinLabel}]`)
        .join(" | ");
      const neg = dedupeInstanceLabels(r.negative)
        .map((i) => `${i.matchTypeLabel}: ${i.campaignName} / ${i.adGroupName} (${i.state}) [${i.asinLabel}]`)
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
    document.getElementById("checker-results-wrap").classList.add("hidden");
    document.getElementById("checker-textarea").value = "";
    state.checkerResults = [];
  }

  function renderCheckerTabToggle() {
    toggleEmptyContent("checker");
  }

  /* ---------------------------------------------------------------------
   * Global search
   * ------------------------------------------------------------------- */
  function initGlobalSearch() {
    const input = document.getElementById("global-search");
    let debounceTimer = null;
    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const term = input.value.trim();
        if (term.length < 2) {
          if (state.activeTab === "search") activateTab(state.lastRealTab || "campaigns");
          return;
        }
        runGlobalSearch(term);
      }, 200);
    });
  }

  function runGlobalSearch(term) {
    if (!state.allRows.length) return;
    const norm = normText(term);
    document.getElementById("search-term-label").textContent = term;

    const campaigns = state.campaignRows.filter((r) => normText(r.name).includes(norm)).slice(0, 20);
    const asins = state.asinRows.filter((r) => normText(r.asin).includes(norm) || normText(r.sku).includes(norm)).slice(0, 20);
    const targets = state.targetRows.filter((r) => normText(r.targetLabel || r.targetText).includes(norm)).slice(0, 30);

    document.getElementById("search-count-campaigns").textContent = campaigns.length;
    document.getElementById("search-count-asins").textContent = asins.length;
    document.getElementById("search-count-targets").textContent = targets.length;

    renderDataTable(document.getElementById("search-campaigns-table"), CAMPAIGN_COLUMNS, campaigns, null, null, null);
    renderDataTable(document.getElementById("search-asins-table"), ASIN_COLUMNS, asins, null, null, null);
    renderDataTable(document.getElementById("search-targets-table"), TARGET_COLUMNS, targets, null, null, null);

    state.activeTab = "search";
    showTabPanel("search");
    document.getElementById("active-tab-title").textContent = "Search Results";
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    refreshExportButtonVisibility();
  }

  /* ---------------------------------------------------------------------
   * Tab dispatch tables (declared after all render/export fns exist)
   * ------------------------------------------------------------------- */
  var TAB_RENDER = {
    campaigns: renderCampaigns,
    matchtype: renderMatchType,
    placements: renderPlacements,
    asin: renderAsin,
    targets: renderTargets,
    duplicator: renderDuplicator,
    checker: renderCheckerTabToggle,
  };

  var EXPORT_HANDLERS = {
    campaigns: exportCampaignsCsv,
    matchtype: exportMatchTypeCsv,
    placements: exportPlacementsCsv,
    asin: exportAsinCsv,
    targets: exportTargetsCsv,
    duplicator: exportDuplicatorCsv,
    checker: exportCheckerCsv,
  };

  /* ---------------------------------------------------------------------
   * Init
   * ------------------------------------------------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    initSideNav();
    initFileMenu();
    initGlobalSearch();
    initCampaignsTab();
    initPlacementsTab();
    initAsinTab();
    initTargetsTab();
    initDuplicatorTab();
    initCheckerTab();
    updateFileMenuStatus();
    activateTab("campaigns");
  });
})();
