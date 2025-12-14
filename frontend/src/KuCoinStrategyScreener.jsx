import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * ✅ 雲端用 Render 環境變數 REACT_APP_API_BASE
 * - Render: REACT_APP_API_BASE = https://kucoin-screener-backend.onrender.com
 * - Local:  沒設就會 fallback 到 http://localhost:4000
 */
const API_BASE = process.env.REACT_APP_API_BASE || "http://localhost:4000";

const TIMEFRAME_FILTERS = [
  { key: "all", label: "全部週期" },
  { key: "1h", label: "1 小時" },
  { key: "30m", label: "30 分鐘" },
];

const SIDE_FILTERS = [
  { key: "both", label: "全部方向" },
  { key: "long", label: "多頭" },
  { key: "short", label: "空頭" },
];

const STAGE_FILTERS = [
  { key: "all", label: "全部" },
  { key: "confirm", label: "確認進場" },
  { key: "early", label: "提前預判" },
];

// ===== 持倉方案（你指定：4~12 小時）=====
const HOLD_PLANS = [
  { key: 4, label: "4 小時" },
  { key: 6, label: "6 小時" },
  { key: 8, label: "8 小時" },
  { key: 12, label: "12 小時" },
];

// ===== 模擬單設定（你指定）=====
const PAPER_MARGIN_USDT = 100; // 每單投入 100U
const PAPER_LEVERAGE = 10; // 10x
const PAPER_NOTIONAL_USDT = PAPER_MARGIN_USDT * PAPER_LEVERAGE; // 名目 1000U

const LS_TRADES = "kcs_paper_trades_v2";
const LS_REALIZED = "kcs_paper_realized_v2";
const LS_HOLD_PLAN = "kcs_hold_plan_hours_v1";

function fmt2(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  const x = Number(n);
  return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmt4(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  const x = Number(n);
  return x.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function fmtTime(ts) {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}
function addHoursISO(iso, hours) {
  try {
    const d = new Date(iso);
    d.setHours(d.getHours() + Number(hours || 0));
    return d.toISOString();
  } catch {
    return null;
  }
}

function calcPnlUSDT({ side, entryPrice, currentPrice }) {
  const entry = Number(entryPrice);
  const cur = Number(currentPrice);
  if (!entry || !cur) return 0;
  const move = (cur - entry) / entry;
  const signed = side === "short" ? -move : move;
  return signed * PAPER_NOTIONAL_USDT;
}

export default function KuCoinStrategyScreener() {
  // ===== screener =====
  const [signals, setSignals] = useState([]);
  const [modeInfo, setModeInfo] = useState(null);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [durationMs, setDurationMs] = useState(null);

  const [timeframe, setTimeframe] = useState("all");
  const [side, setSide] = useState("both");
  const [stageFilter, setStageFilter] = useState("confirm");

  const [fetchError, setFetchError] = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshSec, setRefreshSec] = useState(60);

  // ===== 持倉方案 =====
  const [holdHours, setHoldHours] = useState(6);

  // ===== 模擬單 =====
  const [paperTrades, setPaperTrades] = useState([]); // 未平倉
  const [realizedPnl, setRealizedPnl] = useState(0); // 已實現

  const hasLoadedLS = useRef(false);

  // ===== UI：深色樣式 =====
  const ui = useMemo(() => {
    const bg = "#0b1220";
    const card = "rgba(255,255,255,0.04)";
    const border = "rgba(255,255,255,0.10)";
    const border2 = "rgba(255,255,255,0.14)";
    const text = "#ffffff";
    const muted = "rgba(255,255,255,0.78)";
    const muted2 = "rgba(255,255,255,0.62)";
    const accent = "#4aa3ff";
    const good = "#43d17c";
    const bad = "#ff5c5c";
    const warn = "#ffb020";
    const btn = "#101c33";
    const btnOn = "#1f3b66";
    return { bg, card, border, border2, text, muted, muted2, accent, good, bad, warn, btn, btnOn };
  }, []);

  // ===== 讀 localStorage（只做一次）=====
  useEffect(() => {
    if (hasLoadedLS.current) return;
    hasLoadedLS.current = true;

    try {
      const raw = localStorage.getItem(LS_TRADES);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setPaperTrades(parsed);
      }
    } catch {}

    try {
      const raw = localStorage.getItem(LS_REALIZED);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "number") setRealizedPnl(parsed);
      }
    } catch {}

    try {
      const raw = localStorage.getItem(LS_HOLD_PLAN);
      if (raw) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) setHoldHours(parsed);
      }
    } catch {}
  }, []);

  // ===== 寫回 localStorage =====
  useEffect(() => {
    try {
      localStorage.setItem(LS_TRADES, JSON.stringify(paperTrades));
    } catch {}
  }, [paperTrades]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_REALIZED, JSON.stringify(realizedPnl));
    } catch {}
  }, [realizedPnl]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_HOLD_PLAN, String(holdHours));
    } catch {}
  }, [holdHours]);

  // ===== 抓後端 =====
  const loadScreener = async () => {
    try {
      setFetchError(null);

      const res = await fetch(`${API_BASE}/api/screener`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      setModeInfo(json?.mode ?? null);
      setGeneratedAt(json?.generatedAt ?? null);
      setDurationMs(json?.durationMs ?? null);

      const list = Array.isArray(json?.signals) ? json.signals : [];
      setSignals(list);

      setLastFetchedAt(new Date().toISOString());
    } catch (err) {
      console.error("loadScreener error:", err);
      setFetchError("Failed to fetch");
      setSignals([]);
      setLastFetchedAt(new Date().toISOString());
    }
  };

  // 初次載入
  useEffect(() => {
    loadScreener();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自動刷新
  useEffect(() => {
    if (!autoRefresh) return;
    const sec = Math.max(10, Number(refreshSec) || 60);
    const id = setInterval(loadScreener, sec * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, refreshSec]);

  // ===== symbol -> price map（用 signals 的 lastPrice 更新模擬單）=====
  const priceBySymbol = useMemo(() => {
    const m = new Map();
    for (const s of signals) {
      if (s?.symbol && s?.lastPrice !== undefined) m.set(s.symbol, Number(s.lastPrice));
    }
    return m;
  }, [signals]);

  // ✅ 每次 signals 更新，就更新模擬單 currentPrice（不改 entry）
  useEffect(() => {
    if (!paperTrades.length) return;
    setPaperTrades((prev) =>
      prev.map((t) => {
        const p = priceBySymbol.get(t.symbol);
        if (!p) return t;
        return { ...t, currentPrice: p, lastPriceUpdatedAt: new Date().toISOString() };
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceBySymbol]);

  // ===== 前端過濾 =====
  const filteredSignals = useMemo(() => {
    return signals
      .filter((s) => (timeframe === "all" ? true : s.timeframe === timeframe))
      .filter((s) => (side === "both" ? true : s.side === side))
      .filter((s) => (stageFilter === "all" ? true : s.stage === stageFilter));
  }, [signals, timeframe, side, stageFilter]);

  // ===== 模擬單：新增 / 平倉 / 清空 =====
  function openPaperTrade(signal) {
    // ✅ 同一個幣只能一單（不是整個系統只能一單）
    const exists = paperTrades.some((t) => t.symbol === signal.symbol && t.status === "open");
    if (exists) return;

    const now = new Date().toISOString();
    const entry = Number(signal.entry ?? signal.lastPrice);
    const cur = Number(signal.lastPrice ?? signal.entry);

    const suggestedCloseAt = addHoursISO(now, holdHours);

    const trade = {
      id: `pt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      symbol: signal.symbol,
      side: signal.side, // long / short（你點卡片建立時決定）
      stage: signal.stage,
      timeframeHint: signal.timeframe, // 只作顯示用
      openTime: now,
      entryPrice: entry,
      currentPrice: cur || entry,
      marginUSDT: PAPER_MARGIN_USDT,
      leverage: PAPER_LEVERAGE,
      notionalUSDT: PAPER_NOTIONAL_USDT,
      status: "open",

      // ✅ 持倉方案
      planHours: holdHours,
      suggestedCloseAt,
    };

    setPaperTrades((prev) => [trade, ...prev]);
  }

  function closePaperTrade(tradeId) {
    setPaperTrades((prev) => {
      const t = prev.find((x) => x.id === tradeId);
      if (!t) return prev;

      const pnl = calcPnlUSDT(t);
      setRealizedPnl((r) => Number(r) + Number(pnl));

      return prev.filter((x) => x.id !== tradeId);
    });
  }

  function clearAllPaperTrades() {
    setPaperTrades([]);
  }

  function resetPaperAccount() {
    setPaperTrades([]);
    setRealizedPnl(0);
  }

  // ===== 統計 =====
  const paperStats = useMemo(() => {
    const open = paperTrades;
    const unrealized = open.reduce((sum, t) => sum + calcPnlUSDT(t), 0);
    const equity = Number(realizedPnl) + Number(unrealized);
    return { openCount: open.length, unrealized, equity };
  }, [paperTrades, realizedPnl]);

  // ===== UI components =====
  const Btn = ({ active, onClick, children, title }) => (
    <button
      title={title}
      onClick={onClick}
      style={{
        padding: "10px 14px",
        borderRadius: 999,
        border: `1px solid ${ui.border2}`,
        background: active ? ui.btnOn : ui.btn,
        color: ui.text,
        cursor: "pointer",
        fontSize: 14,
        fontWeight: 700,
      }}
    >
      {children}
    </button>
  );

  const SmallBtn = ({ onClick, children, tone = "dark", title }) => {
    const bg =
      tone === "good" ? "rgba(67,209,124,0.18)" :
      tone === "bad" ? "rgba(255,92,92,0.18)" :
      tone === "warn" ? "rgba(255,176,32,0.18)" :
      ui.btn;

    const bd =
      tone === "good" ? "rgba(67,209,124,0.35)" :
      tone === "bad" ? "rgba(255,92,92,0.35)" :
      tone === "warn" ? "rgba(255,176,32,0.35)" :
      ui.border2;

    return (
      <button
        title={title}
        onClick={onClick}
        style={{
          padding: "10px 12px",
          borderRadius: 12,
          border: `1px solid ${bd}`,
          background: bg,
          color: ui.text,
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 800,
        }}
      >
        {children}
      </button>
    );
  };

  const Pill = ({ children, tone = "muted" }) => {
    const color =
      tone === "good" ? ui.good :
      tone === "bad" ? ui.bad :
      tone === "warn" ? ui.warn :
      ui.muted;

    const bg =
      tone === "good" ? "rgba(67,209,124,0.12)" :
      tone === "bad" ? "rgba(255,92,92,0.12)" :
      tone === "warn" ? "rgba(255,176,32,0.12)" :
      "rgba(255,255,255,0.06)";

    const bd =
      tone === "good" ? "rgba(67,209,124,0.22)" :
      tone === "bad" ? "rgba(255,92,92,0.22)" :
      tone === "warn" ? "rgba(255,176,32,0.22)" :
      "rgba(255,255,255,0.10)";

    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: 999,
          border: `1px solid ${bd}`,
          background: bg,
          color,
          fontSize: 13,
          fontWeight: 800,
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </span>
    );
  };

  return (
    <div style={{ padding: 18, color: ui.text, background: ui.bg, minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: 0.3 }}>
            KuCoin 策略看板（多空 + 模擬單版）
          </div>

          <div style={{ marginTop: 8, fontSize: 15, color: ui.muted, lineHeight: 1.5 }}>
            後端：<span style={{ color: ui.accent, fontWeight: 800 }}>{`${API_BASE}/api/screener`}</span>
            <br />
            勝率優先：只出「確認進場」且分數達標（最多 5 條）。
          </div>
        </div>

        {/* 更新時間：一眼看到 */}
        <div style={{
          padding: 14,
          borderRadius: 16,
          background: ui.card,
          border: `1px solid ${ui.border}`,
          minWidth: 320,
        }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
            <Pill tone={fetchError ? "bad" : "good"}>{fetchError ? "API 異常" : "API 正常"}</Pill>
            {modeInfo ? <Pill>mode: {modeInfo}</Pill> : null}
          </div>

          <div style={{ marginTop: 10, fontSize: 14, color: ui.muted }}>
            <div>
              <b style={{ color: ui.text }}>資料更新：</b> {generatedAt ? fmtTime(generatedAt) : "-"}
            </div>
            <div style={{ marginTop: 4 }}>
              <b style={{ color: ui.text }}>最後抓取：</b> {lastFetchedAt ? fmtTime(lastFetchedAt) : "-"}
              {typeof durationMs === "number" ? (
                <span style={{ marginLeft: 10, color: ui.muted2 }}>（耗時 {durationMs}ms）</span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Filters / Controls */}
      <div style={{ marginTop: 16, padding: 14, borderRadius: 16, background: ui.card, border: `1px solid ${ui.border}` }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span style={{ fontWeight: 900, fontSize: 15 }}>週期：</span>
            {TIMEFRAME_FILTERS.map((t) => (
              <Btn key={t.key} active={timeframe === t.key} onClick={() => setTimeframe(t.key)}>
                {t.label}
              </Btn>
            ))}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span style={{ fontWeight: 900, fontSize: 15 }}>方向：</span>
            {SIDE_FILTERS.map((x) => (
              <Btn key={x.key} active={side === x.key} onClick={() => setSide(x.key)}>
                {x.label}
              </Btn>
            ))}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span style={{ fontWeight: 900, fontSize: 15 }}>訊號：</span>
            {STAGE_FILTERS.map((x) => (
              <Btn key={x.key} active={stageFilter === x.key} onClick={() => setStageFilter(x.key)}>
                {x.label}
              </Btn>
            ))}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginLeft: "auto" }}>
            <SmallBtn onClick={loadScreener} title="手動刷新">重新整理</SmallBtn>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, color: ui.muted }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                style={{ transform: "scale(1.1)" }}
              />
              自動刷新
            </label>

            <input
              value={refreshSec}
              onChange={(e) => setRefreshSec(e.target.value)}
              style={{
                width: 76,
                padding: "10px 10px",
                borderRadius: 12,
                border: `1px solid ${ui.border2}`,
                background: "rgba(0,0,0,0.25)",
                color: ui.text,
                fontSize: 14,
                fontWeight: 800,
              }}
              title="刷新秒數"
            />
            <span style={{ fontSize: 14, color: ui.muted2 }}>秒</span>
          </div>
        </div>

        {fetchError ? (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 14,
              background: "rgba(255,92,92,0.14)",
              border: "1px solid rgba(255,92,92,0.25)",
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            前端抓取錯誤：{fetchError}
          </div>
        ) : null}
      </div>

      {/* 持倉方案 */}
      <div style={{ marginTop: 16, padding: 14, borderRadius: 16, background: ui.card, border: `1px solid ${ui.border}` }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 900 }}>持倉方案（建議平倉時間）</div>
            <Pill>目前：{holdHours} 小時</Pill>
            <span style={{ color: ui.muted, fontSize: 14 }}>（建立模擬單時會記住方案）</span>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {HOLD_PLANS.map((p) => (
              <Btn key={p.key} active={holdHours === p.key} onClick={() => setHoldHours(p.key)}>
                {p.label}
              </Btn>
            ))}
          </div>
        </div>
      </div>

      {/* 模擬單區塊 */}
      <div style={{ marginTop: 16, padding: 14, borderRadius: 16, background: ui.card, border: `1px solid ${ui.border}` }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 900 }}>模擬單（同幣最多一單 / 每單 100U / 10x）</div>
            <Pill>未平倉：{paperStats.openCount} 單</Pill>
            <Pill tone={paperStats.unrealized >= 0 ? "good" : "bad"}>
              未實現：{paperStats.unrealized >= 0 ? "+" : ""}{fmt2(paperStats.unrealized)} U
            </Pill>
            <Pill tone={realizedPnl >= 0 ? "good" : "bad"}>
              已實現：{realizedPnl >= 0 ? "+" : ""}{fmt2(realizedPnl)} U
            </Pill>
            <Pill tone={paperStats.equity >= 0 ? "good" : "bad"}>
              累積盈虧：{paperStats.equity >= 0 ? "+" : ""}{fmt2(paperStats.equity)} U
            </Pill>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <SmallBtn tone="warn" onClick={clearAllPaperTrades} title="清空未平倉（不影響已實現）">清空未平倉</SmallBtn>
            <SmallBtn tone="bad" onClick={resetPaperAccount} title="清空未平倉 + 已實現歸零">重置模擬帳</SmallBtn>
          </div>
        </div>

        {paperTrades.length === 0 ? (
          <div style={{ marginTop: 12, color: ui.muted, fontSize: 14 }}>
            目前沒有未平倉模擬單。你可以在下方訊號卡片按「建立模擬單」。
          </div>
        ) : (
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 12 }}>
            {paperTrades.map((t) => {
              const pnl = calcPnlUSDT(t);
              const roi = PAPER_MARGIN_USDT ? (pnl / PAPER_MARGIN_USDT) * 100 : 0;
              return (
                <div
                  key={t.id}
                  style={{
                    padding: 14,
                    borderRadius: 16,
                    background: "rgba(0,0,0,0.20)",
                    border: `1px solid ${ui.border}`,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontSize: 18, fontWeight: 900 }}>
                        {t.symbol} · {t.timeframeHint || "-"}
                      </div>
                      <Pill tone={t.side === "long" ? "good" : "bad"}>
                        {t.side === "long" ? "做多" : "做空"} · {t.leverage}x
                      </Pill>
                      <Pill>{PAPER_MARGIN_USDT}U / 單</Pill>
                      <Pill tone="warn">方案：{t.planHours}h</Pill>
                    </div>

                    <SmallBtn tone="warn" onClick={() => closePaperTrade(t.id)} title="將此單平倉並計入已實現盈虧">
                      平倉
                    </SmallBtn>
                  </div>

                  <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 }}>
                    <div style={{ fontSize: 14, color: ui.muted }}>
                      <div><b style={{ color: ui.text }}>開單時間：</b>{fmtTime(t.openTime)}</div>
                      <div style={{ marginTop: 6 }}><b style={{ color: ui.text }}>建議平倉前：</b>{fmtTime(t.suggestedCloseAt)}</div>
                      <div style={{ marginTop: 6 }}><b style={{ color: ui.text }}>進場價：</b>{fmt4(t.entryPrice)}</div>
                      <div style={{ marginTop: 6 }}><b style={{ color: ui.text }}>目前價：</b>{fmt4(t.currentPrice)}</div>
                      <div style={{ marginTop: 6, color: ui.muted2 }}><b style={{ color: ui.text }}>更新：</b>{fmtTime(t.lastPriceUpdatedAt)}</div>
                    </div>

                    <div style={{ fontSize: 14, color: ui.muted }}>
                      <div>
                        <b style={{ color: ui.text }}>未實現損益：</b>
                        <span style={{ color: pnl >= 0 ? ui.good : ui.bad, fontWeight: 900 }}>
                          {pnl >= 0 ? " +" : " "}{fmt2(pnl)} U
                        </span>
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <b style={{ color: ui.text }}>報酬率（以保證金）：</b>
                        <span style={{ color: roi >= 0 ? ui.good : ui.bad, fontWeight: 900 }}>
                          {roi >= 0 ? " +" : " "}{fmt2(roi)}%
                        </span>
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <b style={{ color: ui.text }}>名目：</b> {fmt2(PAPER_NOTIONAL_USDT)} U
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 訊號列表 */}
      <div style={{ marginTop: 16 }}>
        {filteredSignals.length === 0 ? (
          <div
            style={{
              padding: 14,
              borderRadius: 16,
              background: ui.card,
              border: `1px solid ${ui.border}`,
              color: ui.muted,
              fontSize: 15,
              fontWeight: 800,
            }}
          >
            目前沒有符合條件的進場訊號（或暫時抓不到資料）。你可以稍後再刷新。
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
              gap: 14,
            }}
          >
            {filteredSignals.map((s, idx) => {
              const tone = s.side === "long" ? "good" : "bad";
              const stageLabel = s.stage === "early" ? "提前預判" : "確認進場";

              return (
                <div
                  key={`${s.symbol}-${s.timeframe}-${s.stage}-${idx}`}
                  style={{
                    padding: 16,
                    borderRadius: 18,
                    background: ui.card,
                    border: `1px solid ${ui.border}`,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontSize: 20, fontWeight: 900 }}>
                        {s.symbol} · {s.timeframe}
                      </div>
                      <Pill tone={tone}>{s.side === "long" ? "做多" : "做空"}</Pill>
                      <Pill>{stageLabel}</Pill>
                      <Pill>強度 {s.score}/{s.scoreMax}</Pill>
                    </div>

                    <div style={{ display: "flex", gap: 10 }}>
                      <SmallBtn
                        tone="good"
                        onClick={() => openPaperTrade(s)}
                        title="以 100U / 10x 建立模擬單（同幣最多一單）"
                      >
                        建立模擬單
                      </SmallBtn>
                    </div>
                  </div>

                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 }}>
                    <div style={{ fontSize: 15, color: ui.muted, lineHeight: 1.7 }}>
                      <div><b style={{ color: ui.text }}>價格：</b>{fmt4(s.lastPrice)}</div>
                      <div><b style={{ color: ui.text }}>進場：</b>{fmt4(s.entry)}</div>
                      <div><b style={{ color: ui.text }}>停損：</b>{fmt4(s.stop)}</div>
                      <div><b style={{ color: ui.text }}>目標：</b>{fmt4(s.target)}</div>
                    </div>

                    <div style={{ fontSize: 15, color: ui.muted, lineHeight: 1.7 }}>
                      <div><b style={{ color: ui.text }}>RR：</b>{fmt2(s.rr)}</div>
                      <div><b style={{ color: ui.text }}>risk：</b>{fmt2(s.riskPct)}%</div>
                      <div><b style={{ color: ui.text }}>reward：</b>{fmt2(s.rewardPct)}%</div>
                      <div><b style={{ color: ui.text }}>結構偏向：</b>{s.structureBias ?? "-"}</div>
                    </div>
                  </div>

                  {s.techSummary ? (
                    <div
                      style={{
                        marginTop: 12,
                        padding: 12,
                        borderRadius: 14,
                        background: "rgba(0,0,0,0.22)",
                        border: `1px solid ${ui.border}`,
                        fontSize: 14,
                        color: ui.text,
                        lineHeight: 1.7,
                        fontWeight: 700,
                      }}
                    >
                      {Array.isArray(s.techSummary) ? s.techSummary.map((x, i) => <div key={i}>{x}</div>) : s.techSummary}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ marginTop: 18, color: ui.muted2, fontSize: 13 }}>
        提醒：模擬單為粗略估算，損益以 signals 的 lastPrice 更新，非交易所逐筆成交精準損益。
      </div>
    </div>
  );
}
