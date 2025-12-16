import React, { useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "kucoin_screener_sim_positions_locked_v1";
const DEFAULT_API_BASE = "https://kucoin-screener-backend.onrender.com";

// ✅ 固定模擬單規格（你要求鎖死）
const FIXED_MARGIN_USDT = 100;
const FIXED_LEVERAGE = 10;

const styles = {
  page: {
    minHeight: "100vh",
    background: "#0b0f17",
    color: "#ffffff",
    padding: 16,
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
  },
  topGrid: {
    display: "grid",
    gridTemplateColumns: "1.2fr 1fr",
    gap: 12,
  },
  card: {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 16,
    padding: 14,
    boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
  },
  title: { margin: 0, fontSize: 18, fontWeight: 900 },
  sub: { marginTop: 6, opacity: 0.8, fontSize: 12, lineHeight: 1.45 },
  row: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
  label: { fontSize: 12, opacity: 0.85, marginBottom: 4 },
  input: {
    background: "rgba(0,0,0,0.35)",
    color: "#ffffff",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 12,
    padding: "10px 12px",
    outline: "none",
    width: "100%",
  },
  select: {
    background: "rgba(0,0,0,0.35)",
    color: "#ffffff",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 12,
    padding: "10px 12px",
    outline: "none",
  },
  btn: (tone = "muted") => ({
    cursor: "pointer",
    userSelect: "none",
    borderRadius: 12,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,0.15)",
    background:
      tone === "primary"
        ? "rgba(99, 102, 241, 0.35)"
        : tone === "ok"
        ? "rgba(34,197,94,0.25)"
        : tone === "danger"
        ? "rgba(239, 68, 68, 0.28)"
        : tone === "warn"
        ? "rgba(251,191,36,0.18)"
        : "rgba(255,255,255,0.08)",
    color: "#ffffff",
    fontWeight: 800,
  }),
  mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" },

  sectionTitle: { fontSize: 13, fontWeight: 900, opacity: 0.95 },
  divider: { height: 1, background: "rgba(255,255,255,0.10)", margin: "10px 0" },

  badge: (kind) => {
    const map = {
      confirm: { bg: "rgba(34,197,94,0.18)", bd: "rgba(34,197,94,0.35)" }, // 可進場
      watch: { bg: "rgba(251,191,36,0.18)", bd: "rgba(251,191,36,0.35)" }, // 觀察
      long: { bg: "rgba(59,130,246,0.18)", bd: "rgba(59,130,246,0.35)" },   // 做多
      short: { bg: "rgba(239,68,68,0.18)", bd: "rgba(239,68,68,0.35)" },   // 做空
      open: { bg: "rgba(34,197,94,0.18)", bd: "rgba(34,197,94,0.35)" },
      closed: { bg: "rgba(251,191,36,0.18)", bd: "rgba(251,191,36,0.35)" },
    };
    const v = map[kind] || { bg: "rgba(255,255,255,0.10)", bd: "rgba(255,255,255,0.18)" };
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "6px 10px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 900,
      background: v.bg,
      border: `1px solid ${v.bd}`,
      color: "#fff",
      whiteSpace: "nowrap",
    };
  },

  signalGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(260px, 1fr))",
    gap: 12,
  },
  signalCard: {
    background: "rgba(0,0,0,0.28)",
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 16,
    padding: 12,
  },
  signalHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 },
  signalSymbol: { fontSize: 15, fontWeight: 950, letterSpacing: 0.2 },
  small: { fontSize: 12, opacity: 0.75, lineHeight: 1.45 },
  kv: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 },

  table: { width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 },
  th: { textAlign: "left", fontSize: 12, opacity: 0.85, padding: 10, borderBottom: "1px solid rgba(255,255,255,0.12)" },
  td: { padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)", verticalAlign: "top" },
};

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function fmt(n, dp = 6) {
  const x = safeNumber(n);
  if (x == null) return "-";
  if (Math.abs(x) >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return x.toFixed(dp);
}

function fmt2(n) {
  const x = safeNumber(n);
  if (x == null) return "-";
  return x.toFixed(2);
}

function fmtPct(n, dp = 2) {
  const x = safeNumber(n);
  if (x == null) return "-";
  return `${x.toFixed(dp)}%`;
}

function makeId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function loadPositions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePositions(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

// 粗略損益（足夠用）
function calcPnL({ side, entryPrice, markPrice, marginUSDT, leverage }) {
  const e = safeNumber(entryPrice);
  const m = safeNumber(markPrice);
  const margin = safeNumber(marginUSDT);
  const lev = Math.max(1, safeNumber(leverage) || 1);
  if (e == null || m == null || margin == null) return { pnl: 0, pnlPct: 0 };

  const notional = margin * lev;
  const qty = notional / e;
  const pnl = side === "short" ? (e - m) * qty : (m - e) * qty;
  const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;
  return { pnl, pnlPct };
}

function buildScreenerUrl(apiBase, filters) {
  const base = apiBase.replace(/\/$/, "");
  const p = new URLSearchParams();

  if (filters.timeframe && filters.timeframe !== "all") p.set("timeframe", filters.timeframe);
  if (filters.stage && filters.stage !== "all") p.set("stage", filters.stage);
  if (filters.side && filters.side !== "all") p.set("side", filters.side);
  if (filters.symbol) p.set("symbol", filters.symbol);

  p.set("top", String(filters.top));
  p.set("minBars", String(filters.minBars));
  p.set("limit", String(filters.limit));
  p.set("maxSignals", String(filters.maxSignals));
  p.set("includeErrors", filters.includeErrors ? "1" : "0");

  return `${base}/api/screener?${p.toString()}`;
}

function stageLabel(stage) {
  return stage === "confirm" ? "可進場" : "觀察中";
}
function sideLabel(side) {
  return side === "long" ? "做多" : "做空";
}

function SignalCard({ s, onAddSim, expanded, onToggleExpanded }) {
  return (
    <div style={styles.signalCard}>
      <div style={styles.signalHeader}>
        <div>
          <div style={styles.signalSymbol}>{s.symbol}</div>
          <div style={styles.small}>
            <span style={styles.mono}>{s.timeframe}</span> • <span style={styles.mono}>{s.time}</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
          <div style={styles.row}>
            <span style={styles.badge(s.stage)}>{stageLabel(s.stage)}</span>
            <span style={styles.badge(s.side)}>{sideLabel(s.side)}</span>
          </div>
          <button style={styles.btn("muted")} onClick={onToggleExpanded}>
            {expanded ? "收合" : "展開"}
          </button>
        </div>
      </div>

      <div style={styles.kv}>
        <div>
          <div style={styles.small}>條件符合</div>
          <div style={{ fontWeight: 900 }}>
            {s.score}/{s.scoreMax} • 強度 {s.strength ?? "-"}
          </div>
        </div>
        <div>
          <div style={styles.small}>現價</div>
          <div style={{ fontWeight: 900 }}>{fmt(s.lastPrice, 6)}</div>
        </div>
        <div>
          <div style={styles.small}>進場 / 停損 / 停利</div>
          <div style={{ fontWeight: 900, fontSize: 13 }}>
            {fmt(s.entry, 6)} / {fmt(s.stop, 6)} / {fmt(s.target, 6)}
          </div>
        </div>
        <div>
          <div style={styles.small}>風報比 / 偏離VWAP</div>
          <div style={{ fontWeight: 900, fontSize: 13 }}>
            {fmt2(s.rr)} • {fmtPct(s.vwapDevPct, 2)}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10, ...styles.row }}>
        <button style={styles.btn("primary")} onClick={() => onAddSim(s)}>
          ＋建立模擬單
        </button>
      </div>

      {expanded ? (
        <>
          <div style={styles.divider} />
          <div style={{ ...styles.small, opacity: 0.9 }}>
            {(s.techSummary || []).map((t, i) => (
              <div key={i}>• {t}</div>
            ))}
            <div style={{ marginTop: 8, opacity: 0.75 }}>
              建議最晚出場時間：<span style={styles.mono}>{s.exitBy}</span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function KuCoinStrategyScreener() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);

  // filters
  const [timeframe, setTimeframe] = useState("all"); // all | 1h | 6h | 1h,6h
  const [stage, setStage] = useState("confirm");     // ✅ 預設直接只看可進場
  const [side, setSide] = useState("all");           // all | long | short
  const [symbol, setSymbol] = useState("");

  // ✅ 你要 Top 50
  const [top, setTop] = useState(50);
  const [minBars, setMinBars] = useState(60);
  const [limit, setLimit] = useState(500);
  const [maxSignals, setMaxSignals] = useState(120);
  const [includeErrors, setIncludeErrors] = useState(false); // ✅ 預設關掉，避免洗

  const [refreshSec, setRefreshSec] = useState(60);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState({ mode: "", generatedAt: "", durationMs: 0, params: null, signals: [], errors: [] });
  const [errMsg, setErrMsg] = useState("");

  const [positions, setPositions] = useState(() => loadPositions());

  // 展開狀態
  const [expandedMap, setExpandedMap] = useState({});
  const toggleExpanded = (key) => setExpandedMap((m) => ({ ...m, [key]: !m[key] }));

  const timerRef = useRef(null);

  async function fetchScreener() {
    setLoading(true);
    setErrMsg("");
    try {
      const url = buildScreenerUrl(apiBase, {
        timeframe,
        stage,
        side,
        symbol: symbol.trim(),
        top,
        minBars,
        limit,
        maxSignals,
        includeErrors,
      });

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData({
        mode: json.mode || "",
        generatedAt: json.generatedAt || "",
        durationMs: json.durationMs || 0,
        params: json.params || null,
        signals: Array.isArray(json.signals) ? json.signals : [],
        errors: Array.isArray(json.errors) ? json.errors : [],
      });
    } catch (e) {
      setErrMsg(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchScreener();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      fetchScreener();
    }, Math.max(5, refreshSec) * 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, refreshSec, apiBase, timeframe, stage, side, symbol, top, minBars, limit, maxSignals, includeErrors]);

  // signals 更新時：同步更新模擬單 mark / pnl
  useEffect(() => {
    if (!Array.isArray(data.signals) || data.signals.length === 0) return;

    const lastPriceBySymbol = new Map();
    for (const s of data.signals) {
      if (s?.symbol && safeNumber(s?.lastPrice) != null) {
        lastPriceBySymbol.set(s.symbol, Number(s.lastPrice));
      }
    }

    const next = positions.map((p) => {
      const mark = lastPriceBySymbol.get(p.symbol);
      if (mark == null) return p;

      const { pnl, pnlPct } = calcPnL({
        side: p.side,
        entryPrice: p.entryPrice,
        markPrice: mark,
        marginUSDT: p.marginUSDT,
        leverage: p.leverage,
      });

      return { ...p, markPrice: mark, pnl, pnlPct, updatedAt: new Date().toISOString() };
    });

    setPositions(next);
    savePositions(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.signals]);

  const tierA = useMemo(() => (data.signals || []).filter((x) => x.stage === "confirm"), [data.signals]);
  const tierB = useMemo(() => (data.signals || []).filter((x) => x.stage === "watch"), [data.signals]);

  // ✅ 模擬單：總持倉盈虧 + 總報酬率（以保證金加權）
  const simSummary = useMemo(() => {
    const open = positions.filter((p) => p.status === "open");
    const totalMargin = open.reduce((s, p) => s + (safeNumber(p.marginUSDT) || 0), 0);
    const totalPnl = open.reduce((s, p) => s + (safeNumber(p.pnl) || 0), 0);
    const roi = totalMargin > 0 ? (totalPnl / totalMargin) * 100 : 0;
    return { openCount: open.length, totalMargin, totalPnl, roi };
  }, [positions]);

  function addPositionFromSignal(sig) {
    const entryPrice = safeNumber(sig.lastPrice) ?? safeNumber(sig.entry) ?? null;
    if (!sig?.symbol || entryPrice == null) return;

    const pos = {
      id: makeId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      symbol: sig.symbol,
      timeframe: sig.timeframe,
      stage: sig.stage,
      side: sig.side, // 以訊號方向為準
      marginUSDT: FIXED_MARGIN_USDT, // ✅ 鎖死
      leverage: FIXED_LEVERAGE,       // ✅ 鎖死
      entryPrice,                    // ✅ 以建立當下進場價為準（鎖死）
      markPrice: entryPrice,
      pnl: 0,
      pnlPct: 0,
      status: "open", // open | closed
      closePrice: null,
      realizedPnl: null,
      realizedPnlPct: null,
      closedAt: null,
    };

    const next = [pos, ...positions];
    setPositions(next);
    savePositions(next);
  }

  function closePosition(id) {
    const next = positions.map((p) => {
      if (p.id !== id) return p;
      if (p.status === "closed") return p;

      const closePrice = safeNumber(p.markPrice) ?? safeNumber(p.entryPrice) ?? 0;
      const { pnl, pnlPct } = calcPnL({
        side: p.side,
        entryPrice: p.entryPrice,
        markPrice: closePrice,
        marginUSDT: p.marginUSDT,
        leverage: p.leverage,
      });

      return {
        ...p,
        status: "closed",
        closePrice,
        realizedPnl: pnl,
        realizedPnlPct: pnlPct,
        closedAt: new Date().toISOString(),
      };
    });

    setPositions(next);
    savePositions(next);
  }

  function deletePosition(id) {
    const next = positions.filter((p) => p.id !== id);
    setPositions(next);
    savePositions(next);
  }

  return (
    <div style={styles.page}>
      <div style={styles.topGrid}>
        {/* 左：控制與篩選 */}
        <div style={styles.card}>
          <div style={styles.row}>
            <div style={{ flex: "1 1 280px" }}>
              <h1 style={styles.title}>KuCoin 策略掃描器</h1>
              <div style={styles.sub}>
                {data.mode || "—"}{" "}
                <span style={{ opacity: 0.6 }}>•</span>{" "}
                可進場：<b>{tierA.length}</b>{" "}
                <span style={{ opacity: 0.6 }}>•</span>{" "}
                觀察：<b>{tierB.length}</b>{" "}
                <span style={{ opacity: 0.6 }}>•</span>{" "}
                <span style={styles.mono}>{data.generatedAt || "-"}</span>{" "}
                （{data.durationMs ? `${data.durationMs}ms` : "-"}）
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button style={styles.btn("muted")} onClick={fetchScreener} disabled={loading}>
                {loading ? "更新中..." : "手動刷新"}
              </button>
              <button style={styles.btn(autoRefresh ? "ok" : "muted")} onClick={() => setAutoRefresh((v) => !v)}>
                自動刷新：{autoRefresh ? "開" : "關"}
              </button>
            </div>
          </div>

          <div style={styles.divider} />

          <div style={styles.row}>
            <div style={{ minWidth: 260, flex: "1 1 360px" }}>
              <div style={styles.label}>後端 API</div>
              <input
                style={styles.input}
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="https://kucoin-screener-backend.onrender.com"
              />
            </div>

            <div>
              <div style={styles.label}>自動刷新（秒）</div>
              <input
                style={{ ...styles.input, width: 140 }}
                type="number"
                min={5}
                value={refreshSec}
                onChange={(e) => setRefreshSec(Number(e.target.value))}
              />
            </div>
          </div>

          <div style={{ height: 10 }} />

          <div style={styles.row}>
            <div>
              <div style={styles.label}>週期</div>
              <select style={styles.select} value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                <option value="all">全部</option>
                <option value="1h">1 小時</option>
                <option value="6h">6 小時</option>
                <option value="1h,6h">1h + 6h</option>
              </select>
            </div>

            <div>
              <div style={styles.label}>訊號等級</div>
              <select style={styles.select} value={stage} onChange={(e) => setStage(e.target.value)}>
                <option value="all">全部</option>
                <option value="confirm">可進場（Tier A）</option>
                <option value="watch">觀察中（Tier B）</option>
              </select>
            </div>

            <div>
              <div style={styles.label}>方向</div>
              <select style={styles.select} value={side} onChange={(e) => setSide(e.target.value)}>
                <option value="all">全部</option>
                <option value="long">做多</option>
                <option value="short">做空</option>
              </select>
            </div>

            <div style={{ flex: "1 1 220px" }}>
              <div style={styles.label}>幣種關鍵字</div>
              <input style={styles.input} value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="BTC / ETH / SOL..." />
            </div>

            <button
              style={styles.btn(stage === "confirm" ? "ok" : "muted")}
              onClick={() => setStage((s) => (s === "confirm" ? "all" : "confirm"))}
              title="一鍵只看可進場"
            >
              只看可進場：{stage === "confirm" ? "開" : "關"}
            </button>
          </div>

          <div style={{ height: 10 }} />

          <div style={styles.row}>
            <div>
              <div style={styles.label}>掃描幣種數（Top）</div>
              <input style={{ ...styles.input, width: 140 }} type="number" min={1} max={200} value={top} onChange={(e) => setTop(Number(e.target.value))} />
            </div>
            <div>
              <div style={styles.label}>最少 K 線數（minBars）</div>
              <input style={{ ...styles.input, width: 160 }} type="number" min={30} max={500} value={minBars} onChange={(e) => setMinBars(Number(e.target.value))} />
            </div>
            <div>
              <div style={styles.label}>K 線抓取上限（limit）</div>
              <input style={{ ...styles.input, width: 160 }} type="number" min={80} max={1500} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
            </div>
            <div>
              <div style={styles.label}>最大回傳訊號（maxSignals）</div>
              <input style={{ ...styles.input, width: 180 }} type="number" min={10} max={2000} value={maxSignals} onChange={(e) => setMaxSignals(Number(e.target.value))} />
            </div>
            <button style={styles.btn(includeErrors ? "warn" : "muted")} onClick={() => setIncludeErrors((v) => !v)}>
              顯示錯誤：{includeErrors ? "開" : "關"}
            </button>
          </div>

          {errMsg ? (
            <div style={{ marginTop: 10, ...styles.card, background: "rgba(239,68,68,0.14)", borderColor: "rgba(239,68,68,0.35)" }}>
              <div style={{ fontWeight: 900 }}>連線失敗</div>
              <div style={{ marginTop: 6, opacity: 0.9 }}>
                <span style={styles.mono}>{errMsg}</span>
              </div>
            </div>
          ) : null}
        </div>

        {/* 右：模擬單（鎖定版） */}
        <div style={styles.card}>
          <div style={styles.row}>
            <div style={{ fontWeight: 950 }}>模擬單（{positions.length}）</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              固定：每單 {FIXED_MARGIN_USDT} USDT / 槓桿 {FIXED_LEVERAGE} 倍（不可修改）
            </div>
          </div>

          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
            目前持倉（OPEN）：
            <b> {simSummary.openCount} </b>單　
            持倉盈虧：
            <b> {fmt2(simSummary.totalPnl)} USDT </b>　
            報酬率：
            <b> {fmtPct(simSummary.roi, 2)} </b>
          </div>

          <div style={styles.divider} />

          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>狀態</th>
                  <th style={styles.th}>幣種</th>
                  <th style={styles.th}>方向</th>
                  <th style={styles.th}>保證金/槓桿</th>
                  <th style={styles.th}>進場價</th>
                  <th style={styles.th}>現價</th>
                  <th style={styles.th}>持倉盈虧</th>
                  <th style={styles.th}>目前報酬率</th>
                  <th style={styles.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id}>
                    <td style={styles.td}>
                      <span style={styles.badge(p.status === "open" ? "open" : "closed")}>
                        {p.status === "open" ? "持倉中" : "已平倉"}
                      </span>
                      <div style={{ marginTop: 6, ...styles.small }}>
                        <span style={styles.mono}>{stageLabel(p.stage)}/{p.timeframe}</span>
                      </div>
                    </td>

                    <td style={styles.td}>
                      <div style={{ fontWeight: 950 }}>{p.symbol}</div>
                      <div style={styles.small}><span style={styles.mono}>{p.createdAt}</span></div>
                    </td>

                    <td style={styles.td}>
                      <span style={styles.badge(p.side)}>{sideLabel(p.side)}</span>
                    </td>

                    <td style={styles.td}>
                      <div style={{ fontWeight: 900 }}>
                        {FIXED_MARGIN_USDT} / {FIXED_LEVERAGE}x
                      </div>
                      <div style={styles.small}>（已鎖定）</div>
                    </td>

                    <td style={styles.td}>
                      <div style={{ fontWeight: 900 }}>{fmt(p.entryPrice, 6)}</div>
                      <div style={styles.small}>（已鎖定）</div>
                    </td>

                    <td style={styles.td}>
                      <div style={{ fontWeight: 950 }}>{fmt(p.markPrice, 6)}</div>
                      <div style={styles.small}><span style={styles.mono}>{p.updatedAt}</span></div>
                    </td>

                    <td style={styles.td}>
                      {p.status === "closed" ? (
                        <div style={{ fontWeight: 950 }}>{fmt2(p.realizedPnl)} USDT</div>
                      ) : (
                        <div style={{ fontWeight: 950 }}>{fmt2(p.pnl)} USDT</div>
                      )}
                    </td>

                    <td style={styles.td}>
                      {p.status === "closed" ? (
                        <div style={{ fontWeight: 950 }}>{fmtPct(p.realizedPnlPct, 2)}</div>
                      ) : (
                        <div style={{ fontWeight: 950 }}>{fmtPct(p.pnlPct, 2)}</div>
                      )}
                    </td>

                    <td style={styles.td}>
                      <div style={styles.row}>
                        {p.status !== "closed" ? (
                          <button style={styles.btn("ok")} onClick={() => closePosition(p.id)}>
                            平倉
                          </button>
                        ) : null}
                        <button style={styles.btn("danger")} onClick={() => deletePosition(p.id)}>
                          刪除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}

                {positions.length === 0 ? (
                  <tr>
                    <td style={styles.td} colSpan={9}>
                      <div style={{ opacity: 0.8 }}>目前沒有模擬單。從「可進場」卡片點「＋建立模擬單」即可。</div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 訊號區 */}
      <div style={{ height: 12 }} />

      <div style={styles.card}>
        <div style={styles.row}>
          <div style={styles.sectionTitle}>可進場（Tier A）</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            這裡是「比較像真的可以挑來開單」的候選（已提高嚴苛度）
          </div>
        </div>

        <div style={{ height: 10 }} />

        {tierA.length > 0 ? (
          <div style={styles.signalGrid}>
            {tierA.map((s, idx) => {
              const key = `${s.symbol}_${s.timeframe}_${s.stage}_${idx}`;
              return (
                <SignalCard
                  key={key}
                  s={s}
                  onAddSim={addPositionFromSignal}
                  expanded={!!expandedMap[key]}
                  onToggleExpanded={() => toggleExpanded(key)}
                />
              );
            })}
          </div>
        ) : (
          <div style={{ opacity: 0.8 }}>
            目前沒有可進場訊號。你可以：
            <span style={styles.mono}> 放寬 minBars</span> 或改成 <span style={styles.mono}>全部</span> 看看。
          </div>
        )}

        <div style={styles.divider} />

        <div style={styles.row}>
          <div style={styles.sectionTitle}>觀察中（Tier B）</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>趨勢成立但位置可能偏追，當提醒用</div>
        </div>

        <div style={{ height: 10 }} />

        {tierB.length > 0 ? (
          <div style={styles.signalGrid}>
            {tierB.map((s, idx) => {
              const key = `${s.symbol}_${s.timeframe}_${s.stage}_${idx}`;
              return (
                <SignalCard
                  key={key}
                  s={s}
                  onAddSim={addPositionFromSignal}
                  expanded={!!expandedMap[key]}
                  onToggleExpanded={() => toggleExpanded(key)}
                />
              );
            })}
          </div>
        ) : (
          <div style={{ opacity: 0.8 }}>目前沒有觀察訊號。</div>
        )}
      </div>

      {/* 錯誤區 */}
      <div style={{ height: 12 }} />

      <div style={styles.card}>
        <div style={styles.row}>
          <div style={styles.sectionTitle}>錯誤紀錄（{(data.errors || []).length}）</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            如果你不想看，關掉「顯示錯誤」就不會回傳
          </div>
        </div>

        <div style={styles.divider} />

        {!includeErrors ? (
          <div style={{ opacity: 0.8 }}>你已關閉錯誤顯示。</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>幣種</th>
                  <th style={styles.th}>週期</th>
                  <th style={styles.th}>來源</th>
                  <th style={styles.th}>訊息</th>
                </tr>
              </thead>
              <tbody>
                {(data.errors || []).slice(0, 250).map((e, i) => (
                  <tr key={i}>
                    <td style={styles.td}><span style={styles.mono}>{e.symbol}</span></td>
                    <td style={styles.td}><span style={styles.mono}>{e.timeframe}</span></td>
                    <td style={styles.td}><span style={styles.mono}>{e.source}</span></td>
                    <td style={{ ...styles.td, opacity: 0.9 }}>{e.message}</td>
                  </tr>
                ))}
                {(data.errors || []).length === 0 ? (
                  <tr>
                    <td style={styles.td} colSpan={4}>
                      <div style={{ opacity: 0.8 }}>目前沒有錯誤。</div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ height: 18 }} />
      <div style={{ opacity: 0.6, fontSize: 12 }}>
        小提醒：你現在 Top 50 + 排除穩定幣 + Tier A 嚴苛化，訊號密度會更像「真的在挑單」的節奏。
      </div>
    </div>
  );
}
