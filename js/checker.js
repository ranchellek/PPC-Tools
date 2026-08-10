/* New Target Duplicate Checker — prevents fresh keyword/ASIN research
 * from creating new duplication in the account.
 *
 * Input: a list of newly researched keywords/ASINs, plus the specific
 * ASIN they're meant to be advertised under.
 * Logic: normalize and match new targets against existing, currently
 * active targets, scoped to that same ASIN, by text + match type.
 * Output: per new target, whether it's already targeted — and if so,
 * in which campaign, ad group, ASIN, and match type.
 *
 * Self-contained: registers itself with PPCTools and only touches DOM
 * elements inside #tab-checker.
 */
(function () {
  "use strict";

  const PPC = window.PPCTools;
  const { state, escapeHtml, downloadCsv, statePill, toggleEmptyContent, isActiveRow, normText, getAsinsForRow } = PPC;

  const ASIN_RE = /^b0[a-z0-9]{8}$/i;

  let checkerResults = [];

  /* ---------------------------------------------------------------------
   * Index & matching — scoped to active targets under one advertised ASIN
   * ------------------------------------------------------------------- */
  function buildCheckerIndex(rows, targetAsin) {
    const index = new Map();
    rows.forEach((r) => {
      if (!["keyword", "negativeKeyword", "productTargeting", "negativeProductTargeting"].includes(r.kind)) return;
      if (!r.normTargetText) return;
      if (!isActiveRow(r)) return;
      if (!getAsinsForRow(r).includes(targetAsin)) return;
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
    if (result.status === "new") return "New — not currently targeted under this ASIN. Safe to add.";
    if (result.status === "negative")
      return "Blocked by an active negative match under this ASIN — adding as a positive target may conflict with it.";
    if (result.status === "mixed")
      return "Already actively targeted AND blocked by a negative under this ASIN — review before adding again.";
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
    const existingCount = checkerResults.filter((r) => r.status === "existing" || r.status === "mixed").length;
    const negativeCount = checkerResults.filter((r) => r.status === "negative" || r.status === "mixed").length;

    document.getElementById("chk-stat-total").textContent = checkerResults.length.toLocaleString();
    document.getElementById("chk-stat-new").textContent = newCount.toLocaleString();
    document.getElementById("chk-stat-existing").textContent = existingCount.toLocaleString();
    document.getElementById("chk-stat-negative").textContent = negativeCount.toLocaleString();

    const STATUS_LABEL = {
      new: '<span class="status-new">New</span>',
      existing: '<span class="status-existing">Already Targeted</span>',
      negative: '<span class="status-negative">Blocked by Negative</span>',
      mixed: '<span class="status-mixed">Targeted + Negated</span>',
    };

    let html = `<p class="small-muted">Checked against active targets under ASIN <span class="pill pill-asin">${escapeHtml(
      targetAsin
    )}</span></p><table><thead><tr>
      <th>Term</th><th>Status</th><th>Existing Targeting (Match Type &middot; Campaign / Ad Group &middot; ASIN)</th><th>Negative Matches</th><th>Recommendation</th>
    </tr></thead><tbody>`;

    checkerResults.forEach((r) => {
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

  /* ---------------------------------------------------------------------
   * Export
   * ------------------------------------------------------------------- */
  function exportCsv() {
    const targetAsin = document.getElementById("checker-asin-input").value.trim().toUpperCase();
    const rows = checkerResults.map((r) => {
      const pos = dedupeInstanceLabels(r.positive)
        .map((i) => `${i.matchTypeLabel}: ${i.campaignName} / ${i.adGroupName} (${i.state}) [${i.asinLabel}]`)
        .join(" | ");
      const neg = dedupeInstanceLabels(r.negative)
        .map((i) => `${i.matchTypeLabel}: ${i.campaignName} / ${i.adGroupName} (${i.state}) [${i.asinLabel}]`)
        .join(" | ");
      return {
        "Target ASIN": targetAsin,
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
