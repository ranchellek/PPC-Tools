/* Duplicator tool — finds Keywords / Product Targets that share the same
 * normalized text, match type, AND advertised ASIN across more than one
 * ad group, and suggests which instance to keep vs. pause.
 *
 * Self-contained: registers itself with PPCTools and only touches DOM
 * elements inside #tab-duplicator.
 */
(function () {
  "use strict";

  const PPC = window.PPCTools;
  const { state, escapeHtml, fmtInt, fmtMoney, fmtPct, fmtDec, downloadCsv, statePill, sumMetrics, toggleEmptyContent, isEnabled, normText, getAsinsForRow } =
    PPC;

  const ACTION_LABEL = {
    keep: '<span class="action-keep">Keep — top performer</span>',
    review: '<span class="action-review">Review</span>',
    pause: '<span class="action-pause">Pause — no conversions</span>',
    paused: '<span class="action-paused">Already paused</span>',
  };

  let duplicateGroups = [];
  let unknownAsinCount = 0;

  /* ---------------------------------------------------------------------
   * Grouping logic
   * ------------------------------------------------------------------- */
  function computeDuplicateGroups(rows, opts) {
    const map = new Map();
    let unknown = 0;

    rows.forEach((r) => {
      if (r.kind !== "keyword" && r.kind !== "productTargeting") return;
      if (!r.normTargetText) return;
      if (r.kind === "productTargeting" && !opts.includeAutoClauses && r.isAutoDefaultClause) return;
      if (!r.scopeId) return;
      const matchKey = r.kind === "keyword" ? (r.matchType || "").trim().toLowerCase() : "pt";
      const asins = getAsinsForRow(r);
      if (!asins.length) {
        unknown++;
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
    return { groups, unknownAsinCount: unknown };
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

  function recomputeDuplicateGroups() {
    const includeAutoClauses = document.getElementById("dup-include-auto").checked;
    const result = computeDuplicateGroups(state.allRows, { includeAutoClauses });
    duplicateGroups = result.groups;
    unknownAsinCount = result.unknownAsinCount;
  }

  function filteredDuplicateGroups() {
    const search = normText(document.getElementById("dup-search").value);
    const productFilter = document.getElementById("dup-product-filter").value;
    const matchFilter = document.getElementById("dup-matchtype-filter").value;

    return duplicateGroups.filter((g) => {
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

  /* ---------------------------------------------------------------------
   * Rendering
   * ------------------------------------------------------------------- */
  function render() {
    if (!toggleEmptyContent("duplicator")) return;
    if (duplicateGroups.length === 0) recomputeDuplicateGroups();

    const groups = filteredDuplicateGroups();

    const totalInstances = groups.reduce((s, g) => s + g.instances.length, 0);
    const totalSpend = groups.reduce((s, g) => s + g.totals.spend, 0);
    const totalWaste = groups.reduce((s, g) => s + g.wastedSpend, 0);

    document.getElementById("dup-stat-groups").textContent = groups.length.toLocaleString();
    document.getElementById("dup-stat-instances").textContent = totalInstances.toLocaleString();
    document.getElementById("dup-stat-spend").textContent = fmtMoney(totalSpend);
    document.getElementById("dup-stat-waste").textContent = fmtMoney(totalWaste);

    const note = document.getElementById("dup-unknown-asin-note");
    if (unknownAsinCount > 0) {
      note.textContent = `${unknownAsinCount.toLocaleString()} keyword/product-target row(s) had no detectable advertised ASIN for their ad group and were excluded from duplicate matching.`;
      note.classList.remove("hidden");
    } else {
      note.classList.add("hidden");
    }

    renderGroupsTable(groups);
  }

  function renderGroupsTable(groups) {
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

  /* ---------------------------------------------------------------------
   * Export
   * ------------------------------------------------------------------- */
  function exportCsv() {
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
   * Lifecycle
   * ------------------------------------------------------------------- */
  function init() {
    ["dup-search", "dup-product-filter", "dup-matchtype-filter"].forEach((id) => {
      document.getElementById(id).addEventListener("input", render);
      document.getElementById(id).addEventListener("change", render);
    });
    document.getElementById("dup-include-auto").addEventListener("change", () => {
      recomputeDuplicateGroups();
      render();
    });
  }

  function onFileLoaded() {
    duplicateGroups = [];
    unknownAsinCount = 0;
  }

  function onFileCleared() {
    duplicateGroups = [];
    unknownAsinCount = 0;
  }

  PPC.registerTool("duplicator", {
    title: "Duplicator",
    init,
    render,
    exportCsv,
    onFileLoaded,
    onFileCleared,
  });
})();
