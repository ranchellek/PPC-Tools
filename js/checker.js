/* New Target Duplicate Checker — prevents fresh keyword/ASIN research
 * from creating new duplication in the account.
 *
 * Input: a list of newly researched keywords/ASINs, plus the specific
 * ASIN they're meant to be advertised under.
 * Logic: normalize and match new targets against existing, currently
 * active targets, scoped to that same ASIN, by text + match type.
 * Output: per new target, whether it's already targeted — and if so,
 * in which campaign, ad group, campaign status, ASIN, and match type,
 * plus that existing target's own performance for reference.
 *
 * Self-contained: registers itself with PPCTools and only touches DOM
 * elements inside #tab-checker.
 */
(function () {
  "use strict";

  const PPC = window.PPCTools;
  const { state, escapeHtml, fmtInt, fmtMoney, fmtPct, downloadCsv, statePill, toggleEmptyContent, isActiveRow, normText, getAsinsForRow } = PPC;

  const ASIN_RE = /^b0[a-z0-9]{8}$/i;

  let checkerResults = [];

  /* ---------------------------------------------------------------------
   * Index & matching — scoped to active targets under one advertised ASIN
   * ------------------------------------------------------------------- */
  function buildCheckerIndex(rows, targetAsin) {
    const index = new Map();
    rows.forEach((r) => {
      if (r.kind !== "keyword" && r.kind !== "productTargeting") return;
      if (!r.normTargetText) return;
      if (!isActiveRow(r)) return;
      if (!getAsinsForRow(r).includes(targetAsin)) return;
      if (!index.has(r.normTargetText)) index.set(r.normTargetText, []);
      index.get(r.normTargetText).push(r);
    });
    return index;
  }

  function checkTerms(terms, index) {
    return terms.map((term) => {
      const norm = normText(term);
      let matches = index.get(norm) || [];

      if (ASIN_RE.test(term.trim())) {
        const ptMatches = index.get(`asin="${norm}"`);
        if (ptMatches) matches = matches.concat(ptMatches);
      }

      matches = matches.slice().sort((a, b) => b.spend - a.spend);

      return { term, norm, status: matches.length ? "existing" : "new", matches };
    });
  }

  function recommendationFor(result) {
    if (result.status === "new") return "New — not currently targeted under this ASIN. Safe to add.";
    return "Already actively targeted under this ASIN — adding again may create internal competition.";
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

  /* ---------------------------------------------------------------------
   * Rendering
   * ------------------------------------------------------------------- */
  function render() {
    toggleEmptyContent("checker");
  }

  function showAsinError(msg) {
    const box = document.getElementById("checker-asin-error");
    box.textContent = msg;
    box.classList.remove("hidden");
  }

  function hideAsinError() {
    document.getElementById("checker-asin-error").classList.add("hidden");
  }

  function runChecker() {
    hideAsinError();
    const targetAsin = document.getElementById("checker-asin-input").value.trim().toUpperCase();
    if (!targetAsin) {
      showAsinError("Enter the ASIN you plan to advertise these targets under before checking.");
      return;
    }

    const text = document.getElementById("checker-textarea").value;
    const terms = parseTerms(text);
    if (!terms.length) return;

    const index = buildCheckerIndex(state.allRows, targetAsin);
    checkerResults = checkTerms(terms, index);
    renderResults(targetAsin);
  }

  function renderResults(targetAsin) {
    document.getElementById("checker-results-wrap").classList.remove("hidden");

    const newCount = checkerResults.filter((r) => r.status === "new").length;
    const existingCount = checkerResults.filter((r) => r.status === "existing").length;

    document.getElementById("chk-stat-total").textContent = checkerResults.length.toLocaleString();
    document.getElementById("chk-stat-new").textContent = newCount.toLocaleString();
    document.getElementById("chk-stat-existing").textContent = existingCount.toLocaleString();

    const STATUS_LABEL = {
      new: '<span class="status-new">New</span>',
      existing: '<span class="status-existing">Already Targeted</span>',
    };

    let html = `<p class="small-muted">Checked against active targets under ASIN <span class="pill pill-asin">${escapeHtml(
      targetAsin
    )}</span></p><table><thead><tr>
      <th></th><th>Term</th><th>Status</th><th># Matches</th><th>Recommendation</th>
    </tr></thead><tbody>`;

    checkerResults.forEach((r, ri) => {
      html += `<tr class="group-row" data-idx="${ri}">
        <td>${r.matches.length ? '<span class="expand-arrow">▶</span>' : ""}</td>
        <td>${escapeHtml(r.term)}</td>
        <td>${STATUS_LABEL[r.status]}</td>
        <td>${r.matches.length}</td>
        <td class="small-muted">${escapeHtml(recommendationFor(r))}</td>
      </tr>`;
      html += `<tr class="detail-row hidden" data-detail-idx="${ri}"><td colspan="5">${renderMatchTable(r.matches, targetAsin)}</td></tr>`;
    });

    html += "</tbody></table>";
    const container = document.getElementById("checker-results-table");
    container.innerHTML = html;

    container.querySelectorAll(".group-row").forEach((row) => {
      row.addEventListener("click", () => {
        const idx = row.dataset.idx;
        const detail = container.querySelector(`[data-detail-idx="${idx}"]`);
        const arrow = row.querySelector(".expand-arrow");
        if (!arrow) return;
        detail.classList.toggle("hidden");
        arrow.classList.toggle("open");
      });
    });
  }

  function renderAsinCell(i, targetAsin) {
    const others = getAsinsForRow(i).filter((a) => a !== targetAsin);
    let html = `<span class="pill pill-asin">${escapeHtml(targetAsin)}</span>`;
    if (others.length) {
      const options = others.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
      html += `<select class="asin-mini-select" title="This ad group also advertises other ASINs">
        <option value="">+${others.length} more</option>
        ${options}
      </select>`;
    }
    return html;
  }

  function renderMatchTable(matches, targetAsin) {
    if (!matches.length) return '<div class="empty-state">No existing matches.</div>';
    let html = `<table class="detail-inner-table"><thead><tr>
      <th>Match Type</th><th>Campaign</th><th>Ad Group</th><th>Campaign Status</th><th>ASIN Advertised</th>
      <th>Impr.</th><th>Clicks</th><th>CTR</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACOS</th>
    </tr></thead><tbody>`;
    matches.forEach((i) => {
      const matchTypeLabel = i.kind === "keyword" ? i.matchType || "—" : "Product Targeting";
      const campaignStatus = i.campaignState || i.state;
      html += `<tr>
        <td>${escapeHtml(matchTypeLabel)}</td>
        <td>${escapeHtml(i.campaignName || "—")}</td>
        <td>${escapeHtml(i.adGroupName || "—")}</td>
        <td>${statePill(campaignStatus)}</td>
        <td class="asin-cell">${renderAsinCell(i, targetAsin)}</td>
        <td>${fmtInt(i.impressions)}</td>
        <td>${fmtInt(i.clicks)}</td>
        <td>${fmtPct(i.ctr)}</td>
        <td>${fmtMoney(i.spend)}</td>
        <td>${fmtMoney(i.sales)}</td>
        <td>${fmtInt(i.orders)}</td>
        <td>${fmtPct(i.acos)}</td>
      </tr>`;
    });
    html += "</tbody></table>";
    return html;
  }

  /* ---------------------------------------------------------------------
   * Export
   * ------------------------------------------------------------------- */
  function exportCsv() {
    const targetAsin = document.getElementById("checker-asin-input").value.trim().toUpperCase();
    const rows = [];
    checkerResults.forEach((r) => {
      if (!r.matches.length) {
        rows.push({
          "Target ASIN": targetAsin,
          Term: r.term,
          Status: r.status,
          "Match Type": "",
          Campaign: "",
          "Ad Group": "",
          "Campaign Status": "",
          "ASIN Advertised": "",
          "Other ASINs Advertised": "",
          Impressions: "",
          Clicks: "",
          Spend: "",
          Sales: "",
          Orders: "",
          "ACOS %": "",
          Recommendation: recommendationFor(r),
        });
        return;
      }
      r.matches.forEach((i) => {
        rows.push({
          "Target ASIN": targetAsin,
          Term: r.term,
          Status: r.status,
          "Match Type": i.kind === "keyword" ? i.matchType || "" : "Product Targeting",
          Campaign: i.campaignName || "",
          "Ad Group": i.adGroupName || "",
          "Campaign Status": i.campaignState || i.state || "",
          "ASIN Advertised": targetAsin,
          "Other ASINs Advertised": getAsinsForRow(i)
            .filter((a) => a !== targetAsin)
            .join(", "),
          Impressions: i.impressions,
          Clicks: i.clicks,
          Spend: i.spend.toFixed(2),
          Sales: i.sales.toFixed(2),
          Orders: i.orders,
          "ACOS %": (i.acos * 100).toFixed(2),
          Recommendation: recommendationFor(r),
        });
      });
    });
    if (!rows.length) return;
    downloadCsv("duplicate_checker_results.csv", rows);
  }

  /* ---------------------------------------------------------------------
   * Lifecycle
   * ------------------------------------------------------------------- */
  function resetUI() {
    document.getElementById("checker-results-wrap").classList.add("hidden");
    document.getElementById("checker-textarea").value = "";
    document.getElementById("checker-asin-input").value = "";
    hideAsinError();
    checkerResults = [];
  }

  function init() {
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
    clearBtn.addEventListener("click", resetUI);
  }

  function onFileLoaded() {
    resetUI();
  }

  function onFileCleared() {
    resetUI();
  }

  PPC.registerTool("checker", {
    title: "New Target Duplicate Checker",
    init,
    render,
    exportCsv,
    onFileLoaded,
    onFileCleared,
  });
})();
