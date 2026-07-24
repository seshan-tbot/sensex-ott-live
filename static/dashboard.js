// Read-only mirror of the live Sensex OTT dashboard. No controls, no writes --
// everything here fetches static JSON files (data/state.json, data/history_days.json,
// data/history/<date>.json) published periodically by publish_snapshot.py from the
// real bot's state.json/history.db. There is no live backend behind this page.

let ceChart, ceSeries, peChart, peSeries;
let ceMarkers, peMarkers;
let recapCeChart, recapCeSeries, recapPeChart, recapPeSeries;
let recapCeMarkers, recapPeMarkers;
let recapDaysLoaded = false;
let lastSignalKey = null;

function initCharts() {
  const commonOpts = {
    layout: { background: { color: "#131722" }, textColor: "#7b8394" },
    grid: { vertLines: { color: "#1a1f2b" }, horzLines: { color: "#1a1f2b" } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#232837" },
    rightPriceScale: { borderColor: "#232837" },
  };
  const seriesOpts = {
    upColor: "#26a69a", downColor: "#ef5350", borderVisible: false,
    wickUpColor: "#26a69a", wickDownColor: "#ef5350",
  };

  const ceEl = document.getElementById("ce-chart");
  const peEl = document.getElementById("pe-chart");
  ceChart = LightweightCharts.createChart(ceEl, commonOpts);
  ceSeries = ceChart.addSeries(LightweightCharts.CandlestickSeries, seriesOpts);
  ceMarkers = LightweightCharts.createSeriesMarkers(ceSeries, []);
  peChart = LightweightCharts.createChart(peEl, commonOpts);
  peSeries = peChart.addSeries(LightweightCharts.CandlestickSeries, seriesOpts);
  peMarkers = LightweightCharts.createSeriesMarkers(peSeries, []);

  new ResizeObserver(() => resizeChart(ceEl, ceChart)).observe(ceEl);
  new ResizeObserver(() => resizeChart(peEl, peChart)).observe(peEl);

  const recapCeEl = document.getElementById("recap-ce-chart");
  const recapPeEl = document.getElementById("recap-pe-chart");
  recapCeChart = LightweightCharts.createChart(recapCeEl, commonOpts);
  recapCeSeries = recapCeChart.addSeries(LightweightCharts.CandlestickSeries, seriesOpts);
  recapCeMarkers = LightweightCharts.createSeriesMarkers(recapCeSeries, []);
  recapPeChart = LightweightCharts.createChart(recapPeEl, commonOpts);
  recapPeSeries = recapPeChart.addSeries(LightweightCharts.CandlestickSeries, seriesOpts);
  recapPeMarkers = LightweightCharts.createSeriesMarkers(recapPeSeries, []);

  new ResizeObserver(() => resizeChart(recapCeEl, recapCeChart)).observe(recapCeEl);
  new ResizeObserver(() => resizeChart(recapPeEl, recapPeChart)).observe(recapPeEl);
}

function resizeChart(el, chart) {
  chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
}

function resizeCharts() {
  resizeChart(document.getElementById("ce-chart"), ceChart);
  resizeChart(document.getElementById("pe-chart"), peChart);
}

function resizeRecapCharts() {
  resizeChart(document.getElementById("recap-ce-chart"), recapCeChart);
  resizeChart(document.getElementById("recap-pe-chart"), recapPeChart);
}

function initTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.dataset.tab;
      buttons.forEach((b) => {
        const el = document.getElementById("tab-" + b.dataset.tab);
        if (el) el.classList.toggle("hidden", b.dataset.tab !== target);
      });
      if (target === "charts") resizeCharts();
      if (target === "recap") {
        resizeRecapCharts();
        loadHistoryDays();
      }
    });
  });
}

const IST_OFFSET_SEC = 5.5 * 3600;

function setSeriesData(series, candles) {
  if (!candles || !candles.length) return;
  series.setData(candles.map((c) => ({
    time: toChartTime(c.ts),
    open: c.open, high: c.high, low: c.low, close: c.close,
  })));
}

function toChartTime(ts) {
  return Math.floor(new Date(ts).getTime() / 1000) + IST_OFFSET_SEC;
}

function setSeriesMarkers(markersApi, signals, leg) {
  if (!markersApi) return;
  const markers = signals
    .filter((s) => s.leg === leg)
    .map((s) => {
      const time = toChartTime(s.ts);
      const d = s.detail || {};
      switch (s.action) {
        case "ARM":
          return { time, position: "aboveBar", color: "#d9a441", shape: "circle", text: "ARM" };
        case "CANCEL":
          return { time, position: "aboveBar", color: "#7b8394", shape: "circle", text: "cancel" };
        case "ENTER":
          return { time, position: "belowBar", color: "#26a69a", shape: "arrowUp", text: "ENTER" };
        case "EXIT":
          return {
            time, position: "aboveBar", shape: "arrowDown", text: "EXIT",
            color: (d.points ?? 0) >= 0 ? "#26a69a" : "#ef5350",
          };
        default:
          return null;
      }
    })
    .filter(Boolean)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.time - b.m.time || a.i - b.i)
    .map(({ m }) => m);
  markersApi.setMarkers(markers);
}

function fmt(n, d = 2) {
  return n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(d);
}

function buildTrades(signals) {
  const sorted = signals.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const openByLeg = {};
  const trades = [];
  for (const s of sorted) {
    if (s.action === "ENTER") {
      openByLeg[s.leg] = s;
    } else if (s.action === "EXIT" && openByLeg[s.leg]) {
      const entry = openByLeg[s.leg];
      const ed = entry.detail || {}, xd = s.detail || {};
      trades.push({
        leg: s.leg,
        entryTs: entry.ts, entryPrice: ed.price, stop: ed.stop, qty: ed.qty, strike: ed.strike,
        exitTs: s.ts, exitPrice: xd.price, reason: xd.reason,
        points: xd.points, pnl: xd.pnl,
      });
      delete openByLeg[s.leg];
    }
  }
  return trades;
}

let lastSignals = [];
let tradeSort = { key: "entryTs", dir: "desc" };

function sortTrades(trades) {
  const { key, dir } = tradeSort;
  const mul = dir === "asc" ? 1 : -1;
  return trades.slice().sort((a, b) => {
    const av = key === "entryTs" ? new Date(a.entryTs).getTime() : (a.pnl ?? 0);
    const bv = key === "entryTs" ? new Date(b.entryTs).getTime() : (b.pnl ?? 0);
    return (av - bv) * mul;
  });
}

function initTradeSort() {
  document.querySelectorAll(".trade-table th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (tradeSort.key === key) {
        tradeSort.dir = tradeSort.dir === "asc" ? "desc" : "asc";
      } else {
        tradeSort = { key, dir: "desc" };
      }
      renderTradeHistory(lastSignals);
    });
  });
}

function updateSortHeaders() {
  document.querySelectorAll(".trade-table th.sortable").forEach((th) => {
    const active = th.dataset.sort === tradeSort.key;
    th.classList.toggle("sorted", active);
    th.querySelector(".sort-arrow").textContent = active ? (tradeSort.dir === "asc" ? "▲" : "▼") : "";
  });
}

function renderTradeHistory(signals) {
  lastSignals = signals;
  const trades = buildTrades(signals);
  const body = document.getElementById("trade-history-body");
  const empty = document.getElementById("trade-history-empty");
  const summary = document.getElementById("history-summary");
  updateSortHeaders();

  if (!trades.length) {
    body.innerHTML = "";
    empty.classList.remove("hidden");
    summary.textContent = "";
    return;
  }
  empty.classList.add("hidden");

  const reasonLabel = (r) => (r === "stop" ? "stop" : r === "square_off" ? "square-off" : (r || "—"));

  body.innerHTML = sortTrades(trades).map((t) => {
    const pnlClass = t.pnl > 0 ? "pnl-pos" : t.pnl < 0 ? "pnl-neg" : "";
    return `<tr>
      <td><span class="leg-tag leg-${t.leg}">${t.leg}</span></td>
      <td>${t.strike != null ? Number(t.strike).toLocaleString() : "—"}</td>
      <td>${new Date(t.entryTs).toLocaleTimeString()}</td>
      <td>${fmt(t.entryPrice, 1)}</td>
      <td>${new Date(t.exitTs).toLocaleTimeString()}</td>
      <td>${fmt(t.exitPrice, 1)}</td>
      <td>${fmt(t.stop, 1)}</td>
      <td>${t.qty ?? "—"}</td>
      <td>${reasonLabel(t.reason)}</td>
      <td class="${pnlClass}">${t.points >= 0 ? "+" : ""}${fmt(t.points, 1)}</td>
      <td class="${pnlClass}">${t.pnl >= 0 ? "+" : ""}₹${fmt(t.pnl, 0)}</td>
    </tr>`;
  }).join("");

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const totalClass = totalPnl > 0 ? "pnl-pos" : totalPnl < 0 ? "pnl-neg" : "";
  summary.innerHTML = `<span>${trades.length} trade${trades.length === 1 ? "" : "s"}</span>` +
    `<span>${wins}W / ${losses}L</span>` +
    `<span class="${totalClass}">${totalPnl >= 0 ? "+" : ""}₹${fmt(totalPnl, 0)}</span>`;
}

async function loadHistoryDays() {
  if (recapDaysLoaded) return;
  let d;
  try {
    d = await (await fetch("data/history_days.json")).json();
  } catch {
    return;
  }
  const select = document.getElementById("recap-day-select");
  const days = d.days || [];
  if (!days.length) {
    select.innerHTML = `<option value="">No days recorded yet</option>`;
    return;
  }
  recapDaysLoaded = true;
  select.innerHTML = days.map((day) => `<option value="${day}">${day}</option>`).join("");
  loadHistoryDay(days[0]);
}

function renderRecapSignalFeed(signals) {
  const feed = document.getElementById("recap-signal-feed");
  feed.innerHTML = signals
    .slice()
    .reverse()
    .map((s) => {
      const time = new Date(s.ts).toLocaleTimeString();
      return `<div class="signal-row"><span class="signal-time">${time}</span>` +
        `<span class="signal-tag signal-${s.action}">${s.action}</span>` +
        `<span>${s.leg}</span><span>${signalText(s)}</span></div>`;
    })
    .join("");
}

function renderRecapTrades(signals) {
  const trades = buildTrades(signals);
  const body = document.getElementById("recap-trade-body");
  const empty = document.getElementById("recap-trade-empty");
  const summary = document.getElementById("recap-summary");

  if (!trades.length) {
    body.innerHTML = "";
    empty.classList.remove("hidden");
    summary.textContent = "";
    return;
  }
  empty.classList.add("hidden");

  const reasonLabel = (r) => (r === "stop" ? "stop" : r === "square_off" ? "square-off" : (r || "—"));
  const sorted = trades.slice().sort((a, b) => new Date(a.entryTs) - new Date(b.entryTs));

  body.innerHTML = sorted.map((t) => {
    const pnlClass = t.points > 0 ? "pnl-pos" : t.points < 0 ? "pnl-neg" : "";
    return `<tr>
      <td><span class="leg-tag leg-${t.leg}">${t.leg}</span></td>
      <td>${t.strike != null ? Number(t.strike).toLocaleString() : "—"}</td>
      <td>${new Date(t.entryTs).toLocaleTimeString()}</td>
      <td>${fmt(t.entryPrice, 1)}</td>
      <td>${new Date(t.exitTs).toLocaleTimeString()}</td>
      <td>${fmt(t.exitPrice, 1)}</td>
      <td>${fmt(t.stop, 1)}</td>
      <td>${reasonLabel(t.reason)}</td>
      <td class="${pnlClass}">${t.points >= 0 ? "+" : ""}${fmt(t.points, 1)}</td>
    </tr>`;
  }).join("");

  const wins = trades.filter((t) => t.points > 0).length;
  const losses = trades.filter((t) => t.points < 0).length;
  const netPts = trades.reduce((sum, t) => sum + (t.points || 0), 0);
  const netClass = netPts > 0 ? "pnl-pos" : netPts < 0 ? "pnl-neg" : "";
  summary.innerHTML = `<span>${trades.length} trade${trades.length === 1 ? "" : "s"}</span>` +
    `<span>${wins}W / ${losses}L</span>` +
    `<span class="${netClass}">${netPts >= 0 ? "+" : ""}${fmt(netPts, 1)} pts</span>`;
}

async function loadHistoryDay(date) {
  if (!date) return;
  let d;
  try {
    const r = await fetch("data/history/" + encodeURIComponent(date) + ".json");
    if (!r.ok) return;
    d = await r.json();
  } catch {
    return;
  }

  document.getElementById("recap-spot-val").textContent = fmt(d.open_spot, 2);
  document.getElementById("recap-prevclose-val").textContent = fmt(d.prev_close, 2);
  document.getElementById("recap-expiry-val").textContent = (d.legs && d.legs.expiry) || "—";
  document.getElementById("recap-ce-strike").textContent = d.legs && d.legs.CE ? String(d.legs.CE.STRIKE_PRICE) : "";
  document.getElementById("recap-pe-strike").textContent = d.legs && d.legs.PE ? String(d.legs.PE.STRIKE_PRICE) : "";

  if (d.candles) {
    setSeriesData(recapCeSeries, d.candles.CE);
    setSeriesData(recapPeSeries, d.candles.PE);
  }
  setSeriesMarkers(recapCeMarkers, d.signals || [], "CE");
  setSeriesMarkers(recapPeMarkers, d.signals || [], "PE");

  renderRecapSignalFeed(d.signals || []);
  renderRecapTrades(d.signals || []);
}

document.getElementById("recap-day-select").addEventListener("change", (e) => {
  loadHistoryDay(e.target.value);
});

function updateEngineState(elId, eng) {
  const el = document.getElementById(elId);
  if (!eng || !eng.state) return;
  el.textContent = eng.state;
  el.className = "state-pill state-" + eng.state.toLowerCase();
}

function updatePosition(st) {
  const empty = document.getElementById("position-empty");
  const box = document.getElementById("position-box");
  if (st.active_leg) {
    empty.classList.add("hidden");
    box.classList.remove("hidden");
    document.getElementById("pos-leg").textContent = st.active_leg;
    document.getElementById("pos-entry").textContent = fmt(st.active_entry_price, 1);
    const eng = st.engines && st.engines[st.active_leg];
    document.getElementById("pos-stop").textContent = eng ? fmt(eng.stop_price, 1) : "—";

    const candles = st.candles && st.candles[st.active_leg];
    const lastClose = candles && candles.length ? candles[candles.length - 1].close : null;
    const pnlEl = document.getElementById("pos-pnl");
    if (lastClose != null && st.active_entry_price != null) {
      const pts = lastClose - st.active_entry_price;
      pnlEl.textContent = (pts >= 0 ? "+" : "") + fmt(pts, 1) + " pts";
      pnlEl.className = pts >= 0 ? "pnl-pos" : "pnl-neg";
    } else {
      pnlEl.textContent = "—";
      pnlEl.className = "";
    }
  } else {
    empty.classList.remove("hidden");
    box.classList.add("hidden");
  }

  const dayPnl = (st.signals || [])
    .filter((s) => s.action === "EXIT")
    .reduce((sum, s) => sum + ((s.detail && s.detail.pnl) || 0), 0);
  const dayEl = document.getElementById("day-pnl");
  dayEl.textContent = "₹" + fmt(dayPnl, 0);
  dayEl.className = dayPnl > 0 ? "pnl-pos" : dayPnl < 0 ? "pnl-neg" : "";
}

function signalText(s) {
  const d = s.detail || {};
  switch (s.action) {
    case "ARM": return `trigger ${fmt(d.trigger, 1)}`;
    case "ENTER": return `@ ${fmt(d.price, 1)}, stop ${fmt(d.stop, 1)}, qty ${d.qty ?? "—"}`;
    case "EXIT": return `@ ${fmt(d.price, 1)} (${d.reason || "?"}) ${d.points >= 0 ? "+" : ""}${fmt(d.points, 1)}pt / ₹${fmt(d.pnl, 0)}`;
    case "CANCEL": return (d.reason || "no breakout / trend flipped");
    default: return "";
  }
}

function updateSignals(signals) {
  const feed = document.getElementById("signal-feed");
  const last = signals.length ? signals[signals.length - 1] : null;
  const key = signals.length + "|" + (last ? last.ts : "");
  if (key === lastSignalKey) return;
  lastSignalKey = key;
  feed.innerHTML = signals
    .slice()
    .reverse()
    .map((s) => {
      const time = new Date(s.ts).toLocaleTimeString();
      return `<div class="signal-row"><span class="signal-time">${time}</span>` +
        `<span class="signal-tag signal-${s.action}">${s.action}</span>` +
        `<span>${s.leg}</span><span>${signalText(s)}</span></div>`;
    })
    .join("");
}

function updateFilterStatus(filters) {
  const chopEl = document.getElementById("chop-filter-val");
  const biasEl = document.getElementById("bias-filter-val");
  filters = filters || {};
  chopEl.textContent = filters.chop_window_enabled ? "ON" : "OFF";
  biasEl.textContent = filters.bias_filter_enabled ? "ON" : "OFF";
}

function updateBiasStatus(bias) {
  const gapEl = document.getElementById("bias-gap-val");
  const breakoutEl = document.getElementById("bias-breakout-val");
  const allowedEl = document.getElementById("bias-allowed-val");
  if (!bias) {
    gapEl.textContent = "—"; breakoutEl.textContent = "—"; allowedEl.textContent = "—";
    return;
  }
  gapEl.textContent = bias.gap_dir || "—";
  breakoutEl.textContent = bias.confirmed_dir
    ? `${bias.confirmed_dir}${bias.confirmed_ts ? " @ " + new Date(bias.confirmed_ts).toLocaleTimeString() : ""}`
    : "not yet";
  allowedEl.textContent = bias.allowed_leg || (bias.confirmed_dir ? "conflicting -- none" : "—");
}

// "Running" here is inferred from data freshness (updated_at within the last
// few minutes), not a live process check -- there's no server behind this
// page to ask. STALE_AFTER_MS is generous vs. the publisher's own ~60s cycle
// so a single missed publish (e.g. a slow git push) doesn't flash "offline".
const STALE_AFTER_MS = 4 * 60 * 1000;

function updateRunBadge(st) {
  const dot = document.getElementById("run-dot");
  const modeBadge = document.getElementById("mode-badge");
  const updatedAt = st && st.updated_at ? new Date(st.updated_at).getTime() : null;
  const fresh = updatedAt != null && (Date.now() - updatedAt) < STALE_AFTER_MS;
  const phase = st ? st.phase : null;

  if (!fresh || phase === "done" || !phase) {
    dot.className = "dot";
    modeBadge.textContent = phase === "done" ? "DONE FOR TODAY" : "OFFLINE / STALE";
    modeBadge.className = "badge";
  } else {
    dot.className = "dot running";
    modeBadge.textContent = st.dry_run ? "DRY_RUN" : "LIVE";
    modeBadge.className = "badge " + (st.dry_run ? "dry-run" : "live");
  }
}

async function pollState() {
  let st;
  try {
    st = await (await fetch("data/state.json?_=" + Date.now())).json();
  } catch {
    return;
  }
  if (!st) return;

  updateRunBadge(st);

  document.getElementById("spot-val").textContent = fmt(st.spot, 2);
  document.getElementById("prevclose-val").textContent = fmt(st.prev_close, 2);

  const changeEl = document.getElementById("change-val");
  if (st.spot != null && st.prev_close) {
    const chg = st.spot - st.prev_close;
    const pct = (chg / st.prev_close) * 100;
    changeEl.textContent = `${chg >= 0 ? "+" : ""}${fmt(chg, 2)}  (${chg >= 0 ? "+" : ""}${fmt(pct, 2)}%)`;
    changeEl.className = chg > 0 ? "pnl-pos" : chg < 0 ? "pnl-neg" : "";
  } else {
    changeEl.textContent = "—";
    changeEl.className = "";
  }

  document.getElementById("ws-val").textContent = st.ws_connected ? "Connected (live ticks)" : "REST fallback";
  document.getElementById("updated-val").textContent = st.updated_at ? new Date(st.updated_at).toLocaleTimeString() : "—";

  if (st.legs) {
    document.getElementById("ce-strike").textContent = st.legs.CE ? String(st.legs.CE.STRIKE_PRICE) : "";
    document.getElementById("pe-strike").textContent = st.legs.PE ? String(st.legs.PE.STRIKE_PRICE) : "";
  }

  if (st.candles) {
    setSeriesData(ceSeries, st.candles.CE);
    setSeriesData(peSeries, st.candles.PE);
  }

  if (st.engines) {
    updateEngineState("ce-state", st.engines.CE);
    updateEngineState("pe-state", st.engines.PE);
  }

  updateFilterStatus(st.filters);
  updateBiasStatus(st.bias);
  updatePosition(st);
  updateSignals(st.signals || []);
  setSeriesMarkers(ceMarkers, st.signals || [], "CE");
  setSeriesMarkers(peMarkers, st.signals || [], "PE");
  renderTradeHistory(st.signals || []);
}

const EXPAND_MS = 220;
let expandedFrom = null;
let expandAnimating = false;

function flip(el, firstRect, onDone) {
  const lastRect = el.getBoundingClientRect();
  const dx = firstRect.left - lastRect.left;
  const dy = firstRect.top - lastRect.top;
  const sx = firstRect.width / lastRect.width;
  const sy = firstRect.height / lastRect.height;

  el.style.transition = "none";
  el.style.transformOrigin = "top left";
  el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  el.getBoundingClientRect();

  requestAnimationFrame(() => {
    el.style.transition = `transform ${EXPAND_MS}ms ease`;
    el.style.transform = "none";
  });

  setTimeout(() => {
    el.style.transition = "";
    el.style.transform = "";
    el.style.transformOrigin = "";
    if (onDone) onDone();
  }, EXPAND_MS + 30);
}

function openExpand(elementId, title) {
  if (expandAnimating || expandedFrom) return;
  const el = document.getElementById(elementId);
  const modal = document.getElementById("expand-modal");
  const body = document.getElementById("modal-body");
  if (!el || !modal || !body) return;

  expandAnimating = true;
  const firstRect = el.getBoundingClientRect();

  expandedFrom = { el, parent: el.parentNode, next: el.nextSibling };
  modal.classList.remove("hidden");
  body.appendChild(el);
  document.getElementById("modal-title").textContent = title || "";

  requestAnimationFrame(() => modal.classList.add("open"));
  flip(el, firstRect, () => { expandAnimating = false; });
}

function closeExpand() {
  const modal = document.getElementById("expand-modal");
  if (expandAnimating || !expandedFrom) {
    modal.classList.remove("open");
    modal.classList.add("hidden");
    expandedFrom = null;
    return;
  }
  const { el, parent, next } = expandedFrom;
  expandedFrom = null;
  expandAnimating = true;

  const firstRect = el.getBoundingClientRect();
  if (next) parent.insertBefore(el, next);
  else parent.appendChild(el);

  modal.classList.remove("open");
  flip(el, firstRect, () => {
    modal.classList.add("hidden");
    expandAnimating = false;
  });
}

function initExpandButtons() {
  document.querySelectorAll(".expand-btn").forEach((btn) => {
    btn.addEventListener("click", () => openExpand(btn.dataset.expand, btn.dataset.title));
  });
  document.getElementById("modal-close").addEventListener("click", closeExpand);
  document.getElementById("expand-modal").addEventListener("click", (e) => {
    if (e.target.id === "expand-modal") closeExpand();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("expand-modal").classList.contains("hidden")) closeExpand();
  });
}

initCharts();
initTabs();
initTradeSort();
initExpandButtons();
pollState();
setInterval(pollState, 15000);
