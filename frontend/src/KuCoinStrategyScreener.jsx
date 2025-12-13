// frontend/src/KuCoinStrategyScreener.jsx

import React, { useEffect, useMemo, useState } from "react";

const API_BASE = process.env.REACT_APP_API_BASE || "`${API_BASE}/api/screener`";

// 前端過濾用（不影響後端實際抓哪些週期）
const TIMEFRAME_FILTERS = [
  { key: "all", label: "全部週期" },
  { key: "30m", label: "30 分鐘" },
  { key: "1h", label: "1 小時" },
  { key: "4h", label: "4 小時" },
];

const SIDE_FILTERS = [
  { key: "both", label: "全部方向" },
  { key: "long", label: "做多" },
  { key: "short", label: "做空" },
];

const STAGE_FILTERS = [
  { key: "all", label: "全部階段" },
  { key: "early", label: "提前預判" },
  { key: "confirm", label: "確認訊號" },
];

function safeNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmt(v, d = 2) {
  const n = safeNum(v);
  if (n === null) return "-";
  return n.toFixed(d);
}

function fmtInt(v) {
  const n = safeNum(v);
  if (n === null) return "-";
  return Math.round(n).toString();
}

function stageText(stage) {
  return stage === "early" ? "預判" : "確認";
}

function stageLongText(stage) {
  return stage === "early" ? "提前預判（可能還在形成中）" : "確認訊號（條件較完整）";
}

export default function KuCoinStrategyScreener() {
  const [signals, setSignals] = useState([]);
  const [selectedSignal, setSelectedSignal] = useState(null);

  const [backendErrors, setBackendErrors] = useState([]);
  const [fetchError, setFetchError] = useState(null);

  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [timeframeFilter, setTimeframeFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState("both");
  const [stageFilter, setStageFilter] = useState("all");

  // 模擬倉位（會存 localStorage）
  const [simPositions, setSimPositions] = useState([]);

  // 讀 localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("kucoinSimPositions");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setSimPositions(parsed);
      }
    } catch (e) {
      console.error("讀取模擬倉位失敗:", e);
    }
  }, []);

  // 存 localStorage
  useEffect(() => {
    try {
      localStorage.setItem("kucoinSimPositions", JSON.stringify(simPositions));
    } catch (e) {
      console.error("儲存模擬倉位失敗:", e);
    }
  }, [simPositions]);

  function updateSimPositionsWithSignals(newSignals) {
    if (!Array.isArray(newSignals) || newSignals.length === 0) return;

    setSimPositions((prev) =>
      prev.map((pos) => {
        // 以 symbol + timeframe 匹配最新價（你目前後端就是這樣回）
        const match = newSignals.find(
          (s) => s.symbol === pos.symbol && (s.timeframe || "?") === pos.timeframe
        );
        if (!match) return pos;

        const lastPrice = safeNum(match.lastPrice) ?? safeNum(match.close) ?? safeNum(pos.lastPrice);
        if (lastPrice === null) return pos;

        const entryPrice = safeNum(pos.entryPrice);
        if (entryPrice === null) return { ...pos, lastPrice };

        const qty = safeNum(pos.qty) ?? 0;
        const margin = safeNum(pos.margin) ?? 0;

        const priceDiff = pos.side === "long" ? lastPrice - entryPrice : entryPrice - lastPrice;
        const pnl = priceDiff * qty;
        const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;

        return { ...pos, lastPrice, pnl, pnlPct };
      })
    );
  }

  async function loadScreener() {
    setIsLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`${API_BASE}/api/screener`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const list = Array.isArray(json.signals) ? json.signals : [];
      setSignals(list);

      const errs = Array.isArray(json.errors) ? json.errors : [];
      setBackendErrors(errs);

      setLastUpdated(
        json.generatedAt ? new Date(json.generatedAt).toLocaleString() : new Date().toLocaleString()
      );

      updateSimPositionsWithSignals(list);

      // 若原本選到的那筆還存在，就把 selectedSignal 更新成最新的那筆（避免右側卡住舊資料）
      setSelectedSignal((prevSel) => {
        if (!prevSel) return prevSel;
        const next = list.find(
          (s) => s.symbol === prevSel.symbol && (s.timeframe || "?") === (prevSel.timeframe || "?")
        );
        return next || prevSel;
      });
    } catch (err) {
      console.error("loadScreener error:", err);
      setFetchError(err?.message || String(err));
    } finally {
      setIsLoading(false);
    }
  }

  // 啟動 + 每 60 秒更新
  useEffect(() => {
    let timer = null;

    (async () => {
      await loadScreener();
      timer = setInterval(loadScreener, 60000);
    })();

    return () => {
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openSimPosition(signal) {
    const price = safeNum(signal.lastPrice) ?? safeNum(signal.close);
    if (price === null) {
      alert("這筆訊號沒有有效價格，無法建立模擬單。");
      return;
    }

    const margin = 100;
    const leverage = 10;
    const notional = margin * leverage;
    const qty = notional / price;

    const nowIso = new Date().toISOString();

    const newPos = {
      id: `${signal.symbol}-${signal.timeframe || "?"}-${nowIso}`,
      symbol: signal.symbol,
      timeframe: signal.timeframe || "?",
      side: signal.side || "long", // 後端回來應該是 long/short
      stage: signal.stage || "confirm",
      entryPrice: price,
      entryTime: nowIso, // 實際開倉時間
      leverage,
      margin,
      qty,
      lastPrice: price,
      pnl: 0,
      pnlPct: 0,
      status: "OPEN",
    };

    setSimPositions((prev) => [...prev, newPos]);
  }

  function closeSimPosition(id) {
    setSimPositions((prev) => prev.map((p) => (p.id === id ? { ...p, status: "CLOSED" } : p)));
  }

  function clearAllSimPositions() {
    if (!window.confirm("確定要清空所有模擬倉位紀錄嗎？（這會刪除本機保存的紀錄）")) return;
    setSimPositions([]);
  }

  const filteredSignals = useMemo(() => {
    return signals.filter((s) => {
      const tf = s.timeframe || "?";
      const side = s.side || "long";
      const stage = s.stage || "confirm";

      const tfOk = timeframeFilter === "all" ? true : tf === timeframeFilter;
      const sideOk = sideFilter === "both" ? true : side === sideFilter;
      const stageOk = stageFilter === "all" ? true : stage === stageFilter;

      return tfOk && sideOk && stageOk;
    });
  }, [signals, timeframeFilter, sideFilter, stageFilter]);

  const selectedReasons = useMemo(() => {
    if (!selectedSignal) return [];
    const reasons =
      Array.isArray(selectedSignal.reasons) && selectedSignal.reasons.length > 0
        ? selectedSignal.reasons
        : Array.isArray(selectedSignal.techSummary) && selectedSignal.techSummary.length > 0
        ? selectedSignal.techSummary
        : [];
    return reasons;
  }, [selectedSignal]);

  return (
    <div style={pageStyle}>
      {/* Header */}
      <div style={headerRow}>
        <div>
          <h1 style={titleStyle}>KuCoin 策略看板（預判 / 確認 / 模擬倉位）</h1>
          <div style={subTitleStyle}>
            本機開發模式：前端 <b>localhost:3000</b>，後端 <b>`${API_BASE}/api/screener`
</b>（{API_BASE}
            /api/screener）
            <br />
            同一筆訊號只會是一個方向（做多或做空）。預判（early）與確認（confirm）是「階段」差異。
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <button style={refreshButton} onClick={loadScreener}>
            立即刷新
          </button>
          <div style={updateText}>最後更新：{lastUpdated || "讀取中…"}</div>
          {isLoading && <div style={{ fontSize: 13, color: "#fde68a" }}>同步中…</div>}
        </div>
      </div>

      {/* Filters */}
      <div style={filterBar}>
        <div style={filterGroup}>
          <span style={filterLabel}>週期：</span>
          {TIMEFRAME_FILTERS.map((tf) => (
            <button
              key={tf.key}
              onClick={() => setTimeframeFilter(tf.key)}
              style={{
                ...pillButton,
                backgroundColor: timeframeFilter === tf.key ? "#38bdf8" : "#0f172a",
                color: timeframeFilter === tf.key ? "#020617" : "#e5e7eb",
              }}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <div style={filterGroup}>
          <span style={filterLabel}>方向：</span>
          {SIDE_FILTERS.map((sf) => (
            <button
              key={sf.key}
              onClick={() => setSideFilter(sf.key)}
              style={{
                ...pillButton,
                backgroundColor: sideFilter === sf.key ? "#22c55e" : "#0f172a",
                color: sideFilter === sf.key ? "#022c22" : "#e5e7eb",
              }}
            >
              {sf.label}
            </button>
          ))}
        </div>

        <div style={filterGroup}>
          <span style={filterLabel}>階段：</span>
          {STAGE_FILTERS.map((st) => (
            <button
              key={st.key}
              onClick={() => setStageFilter(st.key)}
              style={{
                ...pillButton,
                backgroundColor: stageFilter === st.key ? "#facc15" : "#0f172a",
                color: stageFilter === st.key ? "#422006" : "#e5e7eb",
              }}
            >
              {st.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main */}
      <div style={mainRow}>
        {/* Left list */}
        <div style={leftColumn}>
          {filteredSignals.length === 0 && !isLoading && (
            <div style={noSignalBox}>
              目前沒有符合條件的訊號（或暫時抓不到資料）。<br />
              你可以調整篩選（週期 / 方向 / 階段），或等下一次更新。
            </div>
          )}

          {filteredSignals.map((sig) => {
            const side = sig.side || "long";
            const stage = sig.stage || "confirm";

            const isSelected =
              selectedSignal &&
              selectedSignal.symbol === sig.symbol &&
              (selectedSignal.timeframe || "?") === (sig.timeframe || "?") &&
              (selectedSignal.stage || "confirm") === stage &&
              (selectedSignal.side || "long") === side;

            return (
              <div
                key={`${sig.symbol}-${sig.timeframe || "?"}-${side}-${stage}`}
                style={{
                  ...signalCard,
                  borderColor: side === "long" ? "#22c55e" : "#f97316",
                  boxShadow: isSelected ? "0 0 0 1px #e5e7eb" : "none",
                }}
                onClick={() => setSelectedSignal(sig)}
              >
                <div style={signalHeaderRow}>
                  <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={signalSymbol}>{sig.symbol}</span>
                    <span style={signalTag}>{sig.timeframe || "?"}</span>

                    <span
                      style={{
                        ...signalTag,
                        backgroundColor: side === "long" ? "#16a34a" : "#b45309",
                        color: "#f9fafb",
                      }}
                    >
                      {side === "long" ? "做多" : "做空"}
                    </span>

                    <span
                      style={{
                        ...stageTag,
                        backgroundColor: stage === "early" ? "#facc15" : "#22c55e",
                        color: stage === "early" ? "#422006" : "#022c22",
                      }}
                    >
                      {stageText(stage)}
                    </span>
                  </div>

                  <div style={{ textAlign: "right", fontSize: 13 }}>
                    <div>
                      價格：{" "}
                      <strong>
                        {safeNum(sig.lastPrice) !== null ? sig.lastPrice.toFixed(4) : "-"}
                      </strong>
                    </div>
                    {safeNum(sig.score) !== null && safeNum(sig.scoreMax) !== null && (
                      <div style={{ color: "#a5b4fc" }}>
                        強度：{sig.score.toFixed(1)} / {sig.scoreMax}
                      </div>
                    )}
                    {safeNum(sig.strength) !== null && (
                      <div style={{ color: "#fbbf24" }}>等級：{"★".repeat(sig.strength)}</div>
                    )}
                  </div>
                </div>

                <div style={signalBodyRow}>
                  <div style={signalStatLine}>
                    <span>EMA20：</span>
                    <strong>{fmt(sig.ema20, 4)}</strong>
                  </div>
                  <div style={signalStatLine}>
                    <span>MACD Hist：</span>
                    <strong
                      style={{
                        color:
                          safeNum(sig.macdHist) === null
                            ? "#e5e7eb"
                            : sig.macdHist > 0
                            ? "#22c55e"
                            : sig.macdHist < 0
                            ? "#f97316"
                            : "#e5e7eb",
                      }}
                    >
                      {fmt(sig.macdHist, 4)}
                    </strong>
                  </div>
                  <div style={signalStatLine}>
                    <span>RSI：</span>
                    <strong>{fmt(sig.rsi14, 2)}</strong>
                  </div>
                </div>

                <div style={signalBodyRow}>
                  <div style={signalStatLine}>
                    <span>BB：</span>
                    <strong>
                      {safeNum(sig.bbLower) !== null && safeNum(sig.bbUpper) !== null
                        ? `${sig.bbLower.toFixed(2)} ~ ${sig.bbUpper.toFixed(2)}`
                        : "-"}
                    </strong>
                  </div>
                  <div style={signalStatLine}>
                    <span>Vol / MA20：</span>
                    <strong>
                      {safeNum(sig.volume) !== null && safeNum(sig.volMa20) !== null
                        ? `${fmtInt(sig.volume)} / ${fmtInt(sig.volMa20)}`
                        : "-"}
                    </strong>
                  </div>
                </div>

                <div style={{ marginTop: 8, textAlign: "right" }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openSimPosition(sig);
                    }}
                    style={simButton}
                  >
                    建立模擬單（100U × 10x）
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right details */}
        <div style={rightColumn}>
          {!selectedSignal && (
            <div style={detailPlaceholder}>
              點左側任一張卡，這裡會顯示「預判/確認」與「方向」的完整資訊、指標數值、進場理由。
            </div>
          )}

          {selectedSignal && (
            <div style={detailBox}>
              <h2 style={detailTitle}>
                {selectedSignal.symbol} / {selectedSignal.timeframe || "?"} /{" "}
                {(selectedSignal.side || "long") === "long" ? "做多" : "做空"}（
                {stageText(selectedSignal.stage || "confirm")}）
              </h2>

              <div style={detailSection}>
                <h3 style={detailSectionTitle}>基本資訊</h3>
                <p style={detailText}>
                  最新價格： <strong>{fmt(selectedSignal.lastPrice, 4)}</strong>
                  <br />
                  訊號階段： <strong>{stageLongText(selectedSignal.stage || "confirm")}</strong>
                  <br />
                  預先預測方向：{" "}
                  <strong>
                    {(selectedSignal.side || "long") === "long"
                      ? "偏多（看到做多勝率較高）"
                      : "偏空（看到做空勝率較高）"}
                  </strong>
                  <br />
                  更新時間：{" "}
                  {selectedSignal.updatedAt
                    ? new Date(selectedSignal.updatedAt).toLocaleString()
                    : "-"}
                </p>
              </div>

              <div style={detailSection}>
                <h3 style={detailSectionTitle}>技術指標摘要（含實際數值）</h3>
                <ul style={detailList}>
                  <li>
                    EMA20： <strong>{fmt(selectedSignal.ema20, 4)}</strong>
                  </li>
                  <li>
                    MACD Histogram： <strong>{fmt(selectedSignal.macdHist, 4)}</strong>
                  </li>
                  <li>
                    RSI(14)： <strong>{fmt(selectedSignal.rsi14, 2)}</strong>
                  </li>
                  <li>
                    BB 區間：{" "}
                    <strong>
                      {safeNum(selectedSignal.bbLower) !== null &&
                      safeNum(selectedSignal.bbUpper) !== null
                        ? `${selectedSignal.bbLower.toFixed(2)} ~ ${selectedSignal.bbUpper.toFixed(2)}`
                        : "-"}
                    </strong>
                  </li>
                  <li>
                    Volume / MA20：{" "}
                    <strong>
                      {safeNum(selectedSignal.volume) !== null &&
                      safeNum(selectedSignal.volMa20) !== null
                        ? `${fmtInt(selectedSignal.volume)} / ${fmtInt(selectedSignal.volMa20)}`
                        : "-"}
                    </strong>
                  </li>
                  <li>
                    VWAP 乖離： <strong>{safeNum(selectedSignal.vwapDevPct) !== null ? `${fmt(selectedSignal.vwapDevPct, 2)}%` : "-"}</strong>
                  </li>
                  <li>
                    結構偏向：{" "}
                    <strong>
                      {selectedSignal.structureBias === "bullish"
                        ? "偏多"
                        : selectedSignal.structureBias === "bearish"
                        ? "偏空"
                        : "中性"}
                    </strong>
                  </li>
                </ul>
              </div>

              <div style={detailSection}>
                <h3 style={detailSectionTitle}>進場理由（明確列出）</h3>
                {selectedReasons.length === 0 ? (
                  <p style={detailText}>
                    後端尚未提供文字理由，但此訊號已通過 EMA / MACD / RSI / BB / 量能等條件篩選。
                  </p>
                ) : (
                  <ul style={detailList}>
                    {selectedReasons.map((r, idx) => (
                      <li key={idx}>{r}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div style={{ marginTop: 12, textAlign: "right" }}>
                <button
                  style={simButton}
                  onClick={() => openSimPosition(selectedSignal)}
                >
                  用這筆訊號建立模擬單（100U × 10x）
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Errors */}
      {(fetchError || backendErrors.length > 0) && (
        <div style={errorBox}>
          {fetchError && (
            <div style={{ marginBottom: 6 }}>
              <strong>前端抓取錯誤：</strong> {fetchError}
            </div>
          )}

          {backendErrors.length > 0 && (
            <div>
              部分交易對/週期抓取失敗（{backendErrors.length} 筆）：
              <ul style={{ marginTop: 6, paddingLeft: 18 }}>
                {backendErrors.map((e, idx) => (
                  <li key={idx}>{String(e)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Sim positions */}
      <div style={simBox}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ ...detailTitle, margin: 0 }}>模擬倉位（固定 100U × 10x）</h2>
          <div>
            <button style={dangerButton} onClick={clearAllSimPositions}>
              清空模擬倉位
            </button>
          </div>
        </div>

        {simPositions.length === 0 ? (
          <div style={{ fontSize: 14, color: "#9ca3af", marginTop: 8 }}>
            目前沒有模擬單。你可以從左側卡片或右側詳情按「建立模擬單」。
            <br />
            模擬倉位會保存在本機（localStorage），重新整理頁面不會消失。
          </div>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table style={simTable}>
              <thead>
                <tr>
                  <th style={simTh}>交易對</th>
                  <th style={simTh}>方向</th>
                  <th style={simTh}>階段</th>
                  <th style={simTh}>週期</th>
                  <th style={simTh}>開倉時間</th>
                  <th style={simTh}>進場價</th>
                  <th style={simTh}>最新價</th>
                  <th style={simTh}>槓桿</th>
                  <th style={simTh}>名義倉位</th>
                  <th style={simTh}>浮動損益(U)</th>
                  <th style={simTh}>浮動損益(%)</th>
                  <th style={simTh}>狀態</th>
                  <th style={simTh}>操作</th>
                </tr>
              </thead>
              <tbody>
                {simPositions.map((pos) => {
                  const pnl = safeNum(pos.pnl) ?? 0;
                  const pnlPct = safeNum(pos.pnlPct) ?? 0;
                  const pnlColor = pnl > 0 ? "#22c55e" : pnl < 0 ? "#f97316" : "#e5e7eb";

                  return (
                    <tr key={pos.id}>
                      <td style={simTd}>{pos.symbol}</td>
                      <td style={simTd}>{pos.side === "long" ? "做多" : "做空"}</td>
                      <td style={simTd}>{stageText(pos.stage || "confirm")}</td>
                      <td style={simTd}>{pos.timeframe || "?"}</td>
                      <td style={simTd}>
                        {pos.entryTime ? new Date(pos.entryTime).toLocaleString() : "-"}
                      </td>
                      <td style={simTd}>{safeNum(pos.entryPrice) !== null ? pos.entryPrice.toFixed(4) : "-"}</td>
                      <td style={simTd}>{safeNum(pos.lastPrice) !== null ? pos.lastPrice.toFixed(4) : "-"}</td>
                      <td style={simTd}>{safeNum(pos.leverage) !== null ? `${pos.leverage}x` : "-"}</td>
                      <td style={simTd}>
                        {safeNum(pos.margin) !== null && safeNum(pos.leverage) !== null
                          ? (pos.margin * pos.leverage).toFixed(2)
                          : "-"}
                      </td>
                      <td style={{ ...simTd, color: pnlColor }}>{pnl.toFixed(2)}</td>
                      <td style={{ ...simTd, color: pnlColor }}>{pnlPct.toFixed(2)}%</td>
                      <td style={simTd}>{pos.status}</td>
                      <td style={simTd}>
                        {pos.status === "OPEN" ? (
                          <button style={closeButton} onClick={() => closeSimPosition(pos.id)}>
                            平倉
                          </button>
                        ) : (
                          <span style={{ color: "#9ca3af" }}>-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ====================== Styles (Dark Mode + White Text) ====================== */

const pageStyle = {
  minHeight: "100vh",
  padding: "24px 32px 48px",
  backgroundColor: "#020617",
  color: "#f9fafb",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

const headerRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  marginBottom: 16,
  gap: 12,
  flexWrap: "wrap",
};

const titleStyle = {
  fontSize: 24,
  fontWeight: 800,
  margin: 0,
  color: "#f9fafb",
};

const subTitleStyle = {
  marginTop: 6,
  fontSize: 13,
  color: "#9ca3af",
  lineHeight: 1.6,
};

const refreshButton = {
  padding: "6px 14px",
  borderRadius: 999,
  border: "1px solid #38bdf8",
  backgroundColor: "#020617",
  color: "#e0f2fe",
  cursor: "pointer",
  fontSize: 13,
  marginBottom: 6,
};

const updateText = {
  fontSize: 12,
  color: "#9ca3af",
};

const filterBar = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
  marginBottom: 12,
  padding: "10px 12px",
  borderRadius: 14,
  backgroundColor: "#020617",
  border: "1px solid #1f2937",
};

const filterGroup = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
};

const filterLabel = {
  marginRight: 4,
  fontSize: 13,
  color: "#e5e7eb",
};

const pillButton = {
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid #334155",
  fontSize: 13,
  cursor: "pointer",
  backgroundColor: "#0f172a",
  color: "#e5e7eb",
};

const mainRow = {
  display: "flex",
  gap: 16,
  alignItems: "stretch",
  flexWrap: "wrap",
};

const leftColumn = {
  flex: 1.25,
  minWidth: 340,
};

const rightColumn = {
  flex: 1,
  minWidth: 320,
};

const noSignalBox = {
  padding: "16px 14px",
  borderRadius: 12,
  backgroundColor: "#020617",
  border: "1px solid #1f2937",
  fontSize: 14,
  color: "#e5e7eb",
};

const signalCard = {
  borderRadius: 12,
  padding: "10px 12px",
  backgroundColor: "#020617",
  border: "1px solid #1f2937",
  marginBottom: 10,
  cursor: "pointer",
};

const signalHeaderRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 10,
};

const signalSymbol = {
  fontWeight: 800,
  fontSize: 16,
  marginRight: 8,
  color: "#f9fafb",
};

const signalTag = {
  fontSize: 11,
  borderRadius: 999,
  padding: "2px 8px",
  marginRight: 6,
  backgroundColor: "#0f172a",
  color: "#e5e7eb",
  border: "1px solid #334155",
};

const stageTag = {
  fontSize: 11,
  borderRadius: 999,
  padding: "2px 8px",
  marginLeft: 2,
  border: "1px solid #334155",
};

const signalBodyRow = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 13,
  marginTop: 6,
  gap: 10,
};

const signalStatLine = {
  flex: 1,
  color: "#e5e7eb",
};

const detailPlaceholder = {
  padding: "16px 14px",
  borderRadius: 12,
  backgroundColor: "#020617",
  border: "1px solid #1f2937",
  fontSize: 14,
  color: "#9ca3af",
  lineHeight: 1.6,
};

const detailBox = {
  padding: "16px 16px 18px",
  borderRadius: 12,
  backgroundColor: "#020617",
  border: "1px solid #1f2937",
  fontSize: 14,
  color: "#e5e7eb",
};

const detailTitle = {
  fontSize: 18,
  fontWeight: 800,
  margin: "0 0 10px 0",
  color: "#f9fafb",
};

const detailSection = {
  marginTop: 12,
};

const detailSectionTitle = {
  fontSize: 14,
  fontWeight: 700,
  marginBottom: 6,
  color: "#e5e7eb",
};

const detailText = {
  margin: 0,
  lineHeight: 1.7,
};

const detailList = {
  margin: 0,
  paddingLeft: 18,
  lineHeight: 1.7,
};

const errorBox = {
  marginTop: 16,
  padding: "10px 12px",
  borderRadius: 10,
  backgroundColor: "#7f1d1d",
  color: "#fee2e2",
  fontSize: 13,
};

const simBox = {
  marginTop: 20,
  padding: "14px 16px 18px",
  borderRadius: 12,
  backgroundColor: "#020617",
  border: "1px solid #1f2937",
};

const simTable = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const simTh = {
  padding: "8px 8px",
  borderBottom: "1px solid #1f2937",
  textAlign: "left",
  color: "#e5e7eb",
  whiteSpace: "nowrap",
};

const simTd = {
  padding: "8px 8px",
  borderBottom: "1px solid #0b1220",
  color: "#e5e7eb",
  whiteSpace: "nowrap",
};

const simButton = {
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid #38bdf8",
  backgroundColor: "#020617",
  color: "#e0f2fe",
  fontSize: 12,
  cursor: "pointer",
};

const closeButton = {
  padding: "2px 10px",
  borderRadius: 999,
  border: "1px solid #f97316",
  backgroundColor: "#111827",
  color: "#fed7aa",
  fontSize: 12,
  cursor: "pointer",
};

const dangerButton = {
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid #ef4444",
  backgroundColor: "#111827",
  color: "#fecaca",
  fontSize: 12,
  cursor: "pointer",
};
