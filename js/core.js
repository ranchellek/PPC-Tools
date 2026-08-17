/* Amazon PPC Bulk File Tools — shared core.
 *
 * Owns: bulk file parsing/normalization, the shared app state, the
 * sidebar/tab-switching plumbing, and the top-right file menu (upload,
 * status, clear, export-current-view).
 *
 * Individual tools (duplicator.js, checker.js, and anything added later)
 * register themselves via PPCTools.registerTool(name, def) and never
 * touch this file. def may implement:
 *   - title: string shown in the topbar when this tool is active
 *   - init(): wire up this tool's own DOM listeners, called once on load
 *   - render(): (re)draw this tool's panel, called whenever it becomes active
 *   - exportCsv(): called by the header's "Export Current View" button
 *   - onFileLoaded(): a new bulk file was parsed — rebuild any caches
 *   - onFileCleared(): the file was cleared — reset any caches
 *
 * All parsing/analysis happens client-side in the browser. Nothing leaves the page.
 */
window.PPCTools = (function () {
  "use strict";

  /* ---------------------------------------------------------------------
   * Constants
   * ------------------------------------------------------------------- */
  // Lowercased: Entity values are compared case-insensitively since bulk exports
  // vary between title case ("Product Ad") and sentence case ("Product ad").
  const NEG_KEYWORD_ENTITIES = new Set(["negative keyword", "campaign negative keyword"]);
  const NEG_PT_ENTITIES = new Set(["negative product targeting", "campaign negative product targeting"]);
  const AUTO_DEFAULT_CLAUSES = new Set(["close-match", "loose-match", "substitutes", "complements"]);
  const ASIN_TOKEN_RE = /B0[A-Z0-9]{8}/gi;

  /* ---------------------------------------------------------------------
   * Generic helpers (shared by every tool)
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

  // A target only actually competes/serves if its own row, its ad group, and
  // its campaign are all enabled. Campaign/ad group state is informational-only
  // on some sheets (e.g. SB classic has no ad group), so a missing value
  // doesn't disqualify a row — only an explicit non-"enabled" value does.
  function isActiveRow(r) {
    if (!isEnabled(r)) return false;
    if (r.campaignState && r.campaignState.toLowerCase() !== "enabled") return false;
    if (r.adGroupState && r.adGroupState.toLowerCase() !== "enabled") return false;
    return true;
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

  function toggleEmptyContent(prefix) {
    const hasFile = state.allRows.length > 0;
    const emptyEl = document.getElementById(prefix + "-empty");
    const contentEl = document.getElementById(prefix + "-content");
    if (emptyEl) emptyEl.classList.toggle("hidden", hasFile);
    if (contentEl) contentEl.classList.toggle("hidden", !hasFile);
    return hasFile;
  }

  /* ---------------------------------------------------------------------
   * Shared app state
   * ------------------------------------------------------------------- */
  const state = {
    fileName: null,
    allRows: [],
    sheetSummaries: [],
    currencySymbol: "",
    scopeAsinMap: new Map(),
    activeTab: null,
  };

  function getAsinsForRow(r) {
    const set = state.scopeAsinMap.get(r.scopeId);
    return set ? Array.from(set) : [];
  }

  /* ---------------------------------------------------------------------
   * Parsing & normalization
   *
   * Amazon bulk exports are inconsistently capitalized depending on
   * marketplace/export path — some use "Keyword Text" / "Product Ad",
   * others "Keyword text" / "Product ad". Every header key and Entity
   * value is matched case-insensitively so this doesn't silently drop
   * fields (a row missing its own keyword text due to a header-casing
   * mismatch would otherwise vanish from every tool with no error).
   * ------------------------------------------------------------------- */
  function lowerKeyRow(row) {
    const out = {};
    for (const k in row) {
      if (Object.prototype.hasOwnProperty.call(row, k)) {
        out[k.trim().toLowerCase()] = row[k];
      }
    }
    return out;
  }

  function canonicalProduct(v) {
    const raw = (v || "").toString().trim();
    const norm = raw.toLowerCase();
    if (norm === "sponsored products") return "Sponsored Products";
    if (norm === "sponsored brands") return "Sponsored Brands";
    if (norm === "sponsored display") return "Sponsored Display";
    return raw;
  }

  function canonicalMatchType(v) {
    if (!v) return null;
    const raw = String(v).trim();
    const norm = raw.toLowerCase();
    if (norm === "exact") return "Exact";
    if (norm === "phrase") return "Phrase";
    if (norm === "broad") return "Broad";
    return raw;
  }

  function normalizeRow(sheetName, row) {
    const entity = row["entity"] ? String(row["entity"]).trim() : "";
    const entityNorm = entity.toLowerCase();
    const product = canonicalProduct(row["product"]);

    let kind = "other";
    if (entityNorm === "keyword") kind = "keyword";
    else if (NEG_KEYWORD_ENTITIES.has(entityNorm)) kind = "negativeKeyword";
    else if (entityNorm === "product targeting") kind = "productTargeting";
    else if (NEG_PT_ENTITIES.has(entityNorm)) kind = "negativeProductTargeting";

    const keywordText = pick(row, ["keyword text"]);
    const matchType = canonicalMatchType(pick(row, ["match type"]));
    const targetingExpr = pick(row, ["product targeting expression", "targeting expression"]);
    const resolvedExpr = pick(row, [
      "resolved product targeting expression (informational only)",
      "resolved targeting expression (informational only)",
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

    const campaignId = pick(row, ["campaign id"]);
    const adGroupId = pick(row, ["ad group id"]);
    const normTargetText = normText(targetText);

    return {
      sheet: sheetName,
      product,
      entity,
      kind,
      campaignId,
      campaignName: pick(row, ["campaign name", "campaign name (informational only)"]),
      adGroupId,
      adGroupName: pick(row, ["ad group name", "ad group name (informational only)"]),
      scopeId: adGroupId || campaignId,
      targetId: pick(row, ["keyword id", "product targeting id", "targeting id"]),
      targetText,
      targetLabel,
      matchType: effectiveMatchType,
      normTargetText,
      isAutoDefaultClause: kind === "productTargeting" && AUTO_DEFAULT_CLAUSES.has(normTargetText),
      bid: pick(row, ["bid"]),
      state: pick(row, ["state"]),
      campaignState: pick(row, ["campaign state (informational only)"]),
      adGroupState: pick(row, ["ad group state (informational only)"]),
      impressions: toNum(row["impressions"]),
      clicks: toNum(row["clicks"]),
      ctr: toNum(row["click-through rate"]),
      spend: toNum(row["spend"]),
      sales: toNum(row["sales"]),
      orders: toNum(row["orders"]),
      units: toNum(row["units"]),
      cvr: toNum(row["conversion rate"]),
      acos: toNum(row["acos"]),
      cpc: toNum(row["cpc"]),
      roas: toNum(row["roas"]),
      raw: row,
    };
  }

  function parseWorkbook(wb) {
    const allRows = [];
    const sheetSummaries = [];

    wb.SheetNames.forEach((name) => {
      const ws = wb.Sheets[name];
      const json = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
      const rows = json.map(lowerKeyRow);
      const hasEntityCol = rows.length > 0 && Object.prototype.hasOwnProperty.call(rows[0], "entity");
      if (!hasEntityCol) {
        sheetSummaries.push({ name, rows: json.length, skipped: true });
        return;
      }
      const normalized = rows.map((r) => normalizeRow(name, r));
      allRows.push(...normalized);
      sheetSummaries.push({ name, rows: json.length, skipped: false });
    });

    return { allRows, sheetSummaries };
  }

  function detectCurrency(allRows) {
    const codes = allRows
      .filter((r) => r.sheet.toLowerCase() === "portfolios")
      .map((r) => r.raw["budget currency code"])
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
      const asins = extractAsins(pick(r.raw, ["asin (informational only)", "creative asins", "landing page asins"]));
      if (!asins.length) return;
      if (!map.has(r.scopeId)) map.set(r.scopeId, new Set());
      asins.forEach((a) => map.get(r.scopeId).add(a));
    });
    return map;
  }

  /* ---------------------------------------------------------------------
   * Tool registry & tab switching
   * ------------------------------------------------------------------- */
  const tools = {};

  function registerTool(name, def) {
    tools[name] = def;
  }

  function showTabPanel(name) {
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    document.getElementById("tab-" + name).classList.add("active");
  }

  function refreshExportButtonVisibility() {
    const btn = document.getElementById("export-current-btn");
    const tool = tools[state.activeTab];
    const show = state.allRows.length > 0 && !!(tool && tool.exportCsv);
    btn.classList.toggle("hidden", !show);
  }

  function activateTab(name) {
    const tool = tools[name];
    if (!tool) return;
    state.activeTab = name;
    showTabPanel(name);
    document.getElementById("active-tab-title").textContent = tool.title || name;
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    refreshExportButtonVisibility();
    if (tool.render) tool.render();
  }

  function initSideNav() {
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab));
    });
  }

  /* ---------------------------------------------------------------------
   * File menu (upload / status / clear / export)
   * ------------------------------------------------------------------- */
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

  function forEachTool(fn) {
    Object.keys(tools).forEach((name) => fn(tools[name], name));
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

        forEachTool((tool) => tool.onFileLoaded && tool.onFileLoaded());

        updateFileMenuStatus();
        activateTab(state.activeTab);
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
    state.scopeAsinMap = new Map();

    forEachTool((tool) => tool.onFileCleared && tool.onFileCleared());

    document.getElementById("file-input").value = "";
    hideUploadError();
    updateFileMenuStatus();
    activateTab(state.activeTab);
  }

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
      const tool = tools[state.activeTab];
      if (tool && tool.exportCsv) tool.exportCsv();
    });
  }

  /* ---------------------------------------------------------------------
   * Init
   * ------------------------------------------------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    initFileMenu();
    initSideNav();
    forEachTool((tool) => tool.init && tool.init());
    updateFileMenuStatus();

    const firstBtn = document.querySelector(".nav-btn");
    activateTab(firstBtn ? firstBtn.dataset.tab : Object.keys(tools)[0]);
  });

  /* ---------------------------------------------------------------------
   * Public API for tool modules
   * ------------------------------------------------------------------- */
  return {
    registerTool,
    state,
    pick,
    toNum,
    normText,
    isEnabled,
    isActiveRow,
    escapeHtml,
    fmtInt,
    fmtMoney,
    fmtPct,
    fmtDec,
    extractAsins,
    downloadCsv,
    statePill,
    sumMetrics,
    toggleEmptyContent,
    getAsinsForRow,
  };
})();
