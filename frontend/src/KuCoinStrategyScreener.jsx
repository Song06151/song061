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
  { key: "2h", label: "2 小時" },
  { key: "4h", label: "4 小時" },
  { key: "6h", label: "6 小時" },
  { key: "8h", label: "8 小時" },
  { key: "12h", label: "12 小時" },
  { key: "1d", label: "1 天" },
];

const SIDE_FILTERS = [
  { key: "both", label: "全部方向" },
  { key: "long", label: "多頭" },
  { key: "short", label: "空頭" },
];

const STAGE_FILTERS = [
  { key: "all", label: "全部" },
  { key: "confirm", label: "確認進場" },
];

// ===== 模擬單設定（你指定）=====
const PAPER_MARGIN_USDT = 100; // 每單投入 100U
const PAPER_LEVERAGE = 10; // 10x
const PAPER_NOTIONAL_USDT = PAPER_MARGIN_USDT * PAPER_LEVERAGE; // 名目 1000U

// ===== 持倉方案（1–24 小時）=====
const HOLD_PROFILES = [
  { key: "1-4", label: "超短 1–4 小時", minH: 1, maxH: 4 },
  { key: "4-8", label: "短波 4–8 小時", minH: 4, maxH: 8 },
  { key: "8-12", label: "波段 8–12 小時", minH: 8, maxH: 12 },
  { key: "12-24", label: "長波 12–24 小時", minH: 12, maxH: 24 },
];

const LS_TRADES = "kcs_paper_trades_v2_single";
const LS_REALIZED = "kcs_paper_realized_v1";

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

// 合併同幣同向的訊號來源（保留原本用法）
function mergeSourcesForSymbol(signals, symbol, side) {
  const list = (signals || []).filter((s) => s?.symbol === symbol && s?.side === side);
  const tfSet = new Set(list.map((x) => x.timeframe).filter(Boolean));

  const sourceTimeframes = Array.from(tfSet).sort((a, b) => {
    const order = { "1h": 1, "2h": 2, "4h": 3, "6h": 4, "8h": 5, "12h": 6, "1d": 7 };
    return (order[a] || 99) - (order[b] || 99);
  });

  let bestSignal = null;
  for (const x of list) {
    if (!bestSignal) bestSignal = x;
    else if ((x?.strength || 0) > (bestSignal?.strength || 0)) bestSignal = x;
    else if ((x?.score || 0) > (bestSignal?.score || 0)) bestSignal = x;
  }

  const mergedStage = list.some((x) => x.stage === "confirm") ? "confirm" : "confirm";

  return { sourceTimeframes, mergedStage, bestSignal };
}

function holdLabel(key) {
  const p = HOLD_PROFILES.find((x) => x.key === key);
  return p ? p.label : "-";
}

function getProfile(key) {
  return HOLD_PROFILES.find((x) => x.key === key) || HOLD_PROFILES[0];
}

export default function KuCoinStrategyScreener() {
  // ===== screener =====
  const [signals, setSignals] = useState([]);
  const [modeInfo, setModeInfo] = useState(null);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [durationMs, setDurationMs] = useState(null);

  const [timeframe, setTimeframe] = useState("all");
  const [side, setSide] = useState("both");
  const [stageFilter, setStageFilter] = useState("all");

  const [fetchError, setFetchError] = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshSec, setRefreshSec] = useState(30);

  // ===== 模擬單（同幣最多一單）=====
  const [paperTrades, setPaperTrades] = useState([]);
  const [realizedPnl, setRealizedPnl] = useState(0);

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
      // 抓不到 signals 沒關係：模擬單要保留，不要清
      setSignals([]);
      setLastFetchedAt(new Date().toISOString());
    }
  };

  // 初次載入
  useEffect(() => {
    loadScreener();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自動刷新（下限 10 秒）
  useEffect(() => {
    if (!autoRefresh) return;
    const sec = Math.max(10, Number(refreshSec) || 30);
    const id = setInterval(loadScreener, sec * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, refreshSec]);

  // ===== symbol -> price map（更新模擬單用）=====
  const priceBySymbol = useMemo(() => {
    const m = new Map();
    for (const s of signals) {
      if (s?.symbol && s?.lastPrice !== undefined) {
        if (!m.has(s.symbol)) m.set(s.symbol, Number(s.lastPrice));
      }
    }
    return m;
  }, [signals]);

  // ===== 每次 signals 更新 -> 更新所有模擬單 currentPrice + 來源資訊 =====
  useEffect(() => {
    if (!paperTrades.length) return;

    setPaperTrades((prev) =>
      prev.map((t) => {
        const p = priceBySymbol.get(t.symbol);
        const merged = mergeSourcesForSymbol(signals, t.symbol, t.side);

        return {
          ...t,
          currentPrice: p ? p : t.currentPrice,
          lastPriceUpdatedAt: new Date().toISOString(),
          sourceTimeframes: merged.sourceTimeframes?.length ? merged.sourceTimeframes : t.sourceTimeframes,
          mergedStage: merged.mergedStage || t.mergedStage,
          bestScore: merged.bestSignal?.score ?? t.bestScore,
          bestScoreMax: merged.bestSignal?.scoreMax ?? t.bestScoreMax,
          confirmTimeframe: merged.bestSignal?.confirmTimeframe ?? t.confirmTimeframe,
          holdProfileKey: merged.bestSignal?.holdProfileKey ?? t.holdProfileKey,
          holdMinH: merged.bestSignal?.holdMinH ?? t.holdMinH,
          holdMaxH: merged.bestSignal?.holdMaxH ?? t.holdMaxH,
          holdLabel: merged.bestSignal?.holdLabel ?? t.holdLabel,
        };
      })
    );

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceBySymbol, signals]);

  // ===== 前端過濾 =====
  const filteredSignals = useMemo(() => {
    return signals
      .filter((s) => (timeframe === "all" ? true : s.timeframe === timeframe))
      .filter((s) => (side === "both" ? true : s.side === side))
      .filter((s) => (stageFilter === "all" ? true : s.stage === stageFilter));
  }, [signals, timeframe, side, stageFilter]);

  // ===== 模擬單：新增 / 平倉 / 清空 =====
  function openPaperTrade(signal) {
    // 同一個幣只能一單（不管多/空）
    const existsSameSymbol = paperTrades.some((t) => t.symbol === signal.symbol && t.status === "open");
    if (existsSameSymbol) return;

    const symbol = signal.symbol;
    const sSide = signal.side;

    const merged = mergeSourcesForSymbol(signals, symbol, sSide);

    const now = new Date().toISOString();
    const entry = Number(signal.entry ?? signal.lastPrice);
    const cur = Number(signal.lastPrice ?? signal.entry);

    const profileKey = signal.holdProfileKey || "4-8";
    const profile = getProfile(profileKey);

    const trade = {
      id: `pt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      symbol,
      side: sSide,
      openTime: now,
      entryPrice: entry,
      currentPrice: cur || entry,
      marginUSDT: PAPER_MARGIN_USDT,
      leverage: PAPER_LEVERAGE,
      notionalUSDT: PAPER_NOTIONAL_USDT,
      status: "open",

      // 來源/確認週期
      sourceTimeframes: merged.sourceTimeframes?.length ? merged.sourceTimeframes : [signal.timeframe].filter(Boolean),
      confirmTimeframe: signal.confirmTimeframe || "6h",
      mergedStage: "confirm",
      bestScore: signal.score,
      bestScoreMax: signal.scoreMax,

      // 持倉方案（1–24h）
      holdProfileKey: profile.key,
      holdMinH: profile.minH,
      holdMaxH: profile.maxH,
      holdLabel: signal.holdLabel || profile.label,
      closeByTime: addHoursISO(now, profile.maxH),
      lastPriceUpdatedAt: null,
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

  function updateHoldProfileForTrade(tradeId, nextKey) {
    setPaperTrades((prev) =>
      prev.map((t) => {
        if (t.id !== tradeId) return t;

        const profile = getProfile(nextKey);
        return {
          ...t,
          holdProfileKey: profile.key,
          holdMinH: profile.minH,
          holdMaxH: profile.maxH,
          holdLabel: profile.label,
          closeByTime: addHoursISO(t.openTime, profile.maxH),
        };
      })
    );
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

  const SmallBtn = ({ onClick, children, tone = "dark", title, disabled }) => {
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
        disabled={disabled}
        style={{
          padding: "10px 12px",
          borderRadius: 12,
          border: `1px solid ${bd}`,
          background: bg,
          color: ui.text,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
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
            勝率優先：只出「確認進場」，並用 6h 同向確認（訊號量目標一天約 5 條）。
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
            <SmallBtn onClick={loadScreener} title="手動刷新">
              重新整理
            </SmallBtn>

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

      {/* 模擬單區塊 */}
      <div style={{ marginTop: 16, padding: 14, borderRadius: 16, background: ui.card, border: `1px solid ${ui.border}` }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 900 }}>模擬單（同幣最多一單 / 每單 100U / 10x 槓桿）</div>
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
            <SmallBtn tone="warn" onClick={clearAllPaperTrades} title="清空未平倉（不影響已實現）">
              清空未平倉
            </SmallBtn>
            <SmallBtn tone="bad" onClick={resetPaperAccount} title="清空未平倉 + 已實現歸零">
              重置模擬帳
            </SmallBtn>
          </div>
        </div>

        {paperTrades.length === 0 ? (
          <div style={{ marginTop: 12, color: ui.muted, fontSize: 14 }}>
            目前沒有未平倉模擬單。你可以在下方訊號卡片按「建立模擬單」（同一個幣最多一單）。
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
                      <div style={{ fontSize: 18, fontWeight: 900 }}>{t.symbol}</div>
                      <Pill tone={t.side === "long" ? "good" : "bad"}>
                        {t.side === "long" ? "做多" : "做空"} · {t.leverage}x
                      </Pill>
                      <Pill>1h 進場 · {t.confirmTimeframe || "6h"} 確認</Pill>
                    </div>

                    <SmallBtn tone="warn" onClick={() => closePaperTrade(t.id)} title="將此單平倉並計入已實現盈虧">
                      平倉
                    </SmallBtn>
                  </div>

                  {/* 持倉方案 */}
                  <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                    <Pill>持倉方案：{holdLabel(t.holdProfileKey)}</Pill>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {HOLD_PROFILES.map((p) => (
                        <SmallBtn
                          key={p.key}
                          tone={t.holdProfileKey === p.key ? "good" : "dark"}
                          onClick={() => updateHoldProfileForTrade(t.id, p.key)}
                          title={`切換持倉方案：${p.label}`}
                        >
                          {p.label}
                        </SmallBtn>
                      ))}
                    </div>

                    <Pill tone="warn">
                      建議最晚平倉：{t.closeByTime ? fmtTime(t.closeByTime) : "-"} 之前
                    </Pill>
                  </div>

                  <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 }}>
                    <div style={{ fontSize: 14, color: ui.muted }}>
                      <div><b style={{ color: ui.text }}>開單時間：</b>{fmtTime(t.openTime)}</div>
                      <div style={{ marginTop: 6 }}><b style={{ color: ui.text }}>進場價：</b>{fmt4(t.entryPrice)}</div>
                      <div style={{ marginTop: 6 }}><b style={{ color: ui.text }}>目前價：</b>{fmt4(t.currentPrice)}</div>
                      <div style={{ marginTop: 6 }}><b style={{ color: ui.text }}>最後更新：</b>{t.lastPriceUpdatedAt ? fmtTime(t.lastPriceUpdatedAt) : "-"}</div>
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

                  <div style={{ marginTop: 10, color: ui.muted2, fontSize: 13 }}>
                    註：你關掉網頁不會更新沒關係；下次打開抓到新 signals 後，會更新這單的損益。
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
            目前沒有符合條件的進場訊號（勝率優先所以會比較少）。你可以稍後再刷新。
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

              const disabledOpen = paperTrades.some((t) => t.symbol === s.symbol && t.status === "open");

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
                      <Pill>確認進場</Pill>
                      <Pill>強度 {s.score}/{s.scoreMax}</Pill>
                      <Pill tone="warn">6h 同向確認</Pill>
                      <Pill tone="warn">建議持倉：{s.holdLabel || holdLabel(s.holdProfileKey)}</Pill>
                    </div>

                    <div style={{ display: "flex", gap: 10 }}>
                      <SmallBtn
                        tone="good"
                        disabled={disabledOpen}
                        onClick={() => openPaperTrade(s)}
                        title={
                          disabledOpen
                            ? "同一個幣只能一單：此幣已經有未平倉模擬單"
                            : "建立模擬單（勝率優先訊號：1h 進場 + 6h 同向確認）"
                        }
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
                      <div><b style={{ color: ui.text }}>結構偏向：</b>{s.structureBias_1h ?? "-"}</div>
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
                      {Array.isArray(s.techSummary)
                        ? s.techSummary.map((t, i) => <div key={i}>{t}</div>)
                        : String(s.techSummary)}
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
