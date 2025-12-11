// src/KuCoinStrategyScreener.jsx

import React, { useEffect, useState } from "react";

const API_BASE = "http://localhost:4000";

// 前端可以選擇顯示的週期（純前端過濾用）
const TIMEFRAME_FILTERS = [
  { key: "all", label: "全部週期" },
  { key: "30m", label: "30 分鐘" },
  { key: "1h", label: "1 小時" },
  { key: "4h", label: "4 小時" },
];

// 多空方向過濾
const SIDE_FILTERS = [
  { key: "both", label: "全部方向" },
  { key: "long", label: "多頭" },
  { key: "short", label: "空頭" },
];

// 持有時間篩選：短線 / 波段 12–24h
const HOLD_FILTERS = [
  { key: "all", label: "全部持有時間" },
  { key: "short", label: "短線 (&lt; 4 小時)" },
  { key: "swing12_24", label: "波段 12–24 小時" },
];

// --- localStorage 讀寫模擬倉位 ---
function loadSimPositions() {
  try {
    const raw = localStorage.getItem("simPositions");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("loadSimPositions error:", e);
    return [];
  }
}

function saveSimPositions(positions) {
  try {
    localStorage.setItem("simPositions", JSON.stringify(positions));
  } catch (e) {
    console.error("saveSimPositions error:", e);
  }
}

export default function KuCoinStrategyScreener() {
  const [signals, setSignals] = useState([]); // 後端回來的所有訊號
  const [selectedSignal, setSelectedSignal] = useState(null); // 右側詳情
  const [backendErrors, setBackendErrors] = useState([]); // 後端回報的錯誤
  const [fetchError, setFetchError] = useState(null); // 前端抓取錯誤
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [timeframeFilter, setTimeframeFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState("both");
  const [holdFilter, setHoldFilter] = useState("all"); // 新增：持有時間篩選

  // 模擬倉位列表（從 localStorage 初始化）
  const [simPositions, setSimPositions] = useState(() => loadSimPositions());

  // 每次模擬倉位變動就寫回 localStorage
  useEffect(() => {
    saveSimPositions(simPositions);
  }, [simPositions]);

  // 讀取 screener 資料
  async function loadScreener() {
    setIsLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`${API_BASE}/api/screener`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();

      const list = Array.isArray(json.signals) ? json.signals : [];
      setSignals(list);

      const errs = Array.isArray(json.errors) ? json.errors : [];
      setBackendErrors(errs);

      setLastUpdated(
        json.generatedAt
          ? new Date(json.generatedAt).toLocaleString()
          : new Date().toLocaleString()
      );

      // 用最新價更新所有模擬倉位
      updateSimPositionsWithSignals(list);
    } catch (err) {
      console.error("loadScreener error:", err);
      setFetchError(err.message || String(err));
    } finally {
      setIsLoading(false);
    }
  }

  // 啟動時以及每 60 秒刷新一次
  useEffect(() => {
    let timer;
    (async () => {
      await loadScreener();
      timer = setInterval(loadScreener, 60000); // 60 秒
    })();
    return () => {
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 用最新 signals 價格更新模擬單損益
  function updateSimPositionsWithSignals(newSignals) {
    if (!newSignals || newSignals.length === 0) return;

    setSimPositions((prev) =>
      prev.map((pos) => {
        const match = newSignals.find(
          (s) => s.symbol === pos.symbol && s.timeframe === pos.timeframe
        );
        if (!match) return pos;

        const lastPrice =
          typeof match.lastPrice === "number"
            ? match.lastPrice
            : typeof match.close === "number"
            ? match.close
            : pos.lastPrice;

        if (!lastPrice) return pos;

        const priceDiff =
          pos.side === "long"
            ? lastPrice - pos.entryPrice
            : pos.entryPrice - lastPrice;

        const pnl = priceDiff * pos.qty;
        const pnlPct = (pnl / pos.margin) * 100;

        return {
          ...pos,
          lastPrice,
          pnl,
          pnlPct,
        };
      })
    );
  }

  // 新增模擬倉位：固定 100U 保證金 × 10 倍槓桿
  function openSimPosition(signal) {
    const price =
      typeof signal.lastPrice === "number"
        ? signal.lastPrice
        : typeof signal.close === "number"
        ? signal.close
        : null;

    if (!price) {
      alert("這個訊號沒有有效的價格，無法建立模擬單。");
      return;
    }

    const margin = 100;
    const leverage = 10;
    const notional = margin * leverage;
    const qty = notional / price;

    const now = new Date();
    const nowISO = now.toISOString();
    const nowText = now.toLocaleString(); // 顯示用

    const newPos = {
      id: `${signal.symbol}-${signal.timeframe}-${nowISO}`,
      symbol: signal.symbol,
      side: signal.side || "long", // 預設多頭
      timeframe: signal.timeframe || "?",
      entryPrice: price,
      entryTime: nowISO, // 存 ISO，顯示時轉成在地時間
      entryTimeText: nowText,
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

  // 手動平倉（只把狀態改成 CLOSED，數字保留當紀錄）
  function closeSimPosition(id) {
    setSimPositions((prev) =>
      prev.map((pos) =>
        pos.id === id ? { ...pos, status: "CLOSED" } : pos
      )
    );
  }

  // 前端過濾顯示的訊號列表
  const filteredSignals = signals.filter((s) => {
    const tfOk =
      timeframeFilter === "all" ? true : s.timeframe === timeframeFilter;

    const side =
      s.side ||
      (s.direction === "多" ? "long" : s.direction === "空" ? "short" : "both");

    const sideOk =
      sideFilter === "both"
        ? true
        : sideFilter === "long"
        ? side === "long"
        : side === "short";

    // 持有時間 (分鐘) 過濾
    const minM = s.holdMinutesMin;
    const maxM = s.holdMinutesMax;
    let holdOk = true;

    if (holdFilter === "short") {
      // 短線：預估持有 <= 240 分鐘（4 小時）
      if (typeof maxM === "number") {
        holdOk = maxM <= 240;
      } else {
        holdOk = false;
      }
    } else if (holdFilter === "swing12_24") {
      // 波段：12–24 小時（720–1440 分鐘）有交集
      if (typeof minM === "number" && typeof maxM === "number") {
        const from = 720;
        const to = 1440;
        holdOk = maxM >= from && minM <= to;
      } else {
        holdOk = false;
      }
    }

    return tfOk && sideOk && holdOk;
  });

  return (
    <div style={pageStyle}>
      {/* 上方列：標題 + 說明 + 更新時間 */}
      <div style={headerRow}>
        <div>
          <h1 style={titleStyle}>KuCoin 策略看板（多空＋模擬單版）</h1>
          <div style={subTitleStyle}>
            後端：{API_BASE}/api/screener
            <br />
            顯示的是「已通過 12 指標的進場訊號」（非即開即用單，而是嚴格篩選）。
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <button style={refreshButton} onClick={loadScreener}>
            立即刷新
          </button>
          <div style={updateText}>
            最後更新時間：{lastUpdated || "讀取中…"}
          </div>
          {isLoading && (
            <div style={{ fontSize: 13, color: "#fde68a" }}>
              數據同步中，請稍候…
            </div>
          )}
        </div>
      </div>

      {/* 過濾器列 */}
      <div style={filterBar}>
        <div style={{ marginRight: 24 }}>
          <span style={filterLabel}>週期：</span>
          {TIMEFRAME_FILTERS.map((tf) => (
            <button
              key={tf.key}
              onClick={() => setTimeframeFilter(tf.key)}
              style={{
                ...pillButton,
                backgroundColor:
                  timeframeFilter === tf.key ? "#38bdf8" : "#0f172a",
                color:
                  timeframeFilter === tf.key ? "#020617" : "#e5e7eb",
              }}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <div style={{ marginRight: 24 }}>
          <span style={filterLabel}>方向：</span>
          {SIDE_FILTERS.map((sf) => (
            <button
              key={sf.key}
              onClick={() => setSideFilter(sf.key)}
              style={{
                ...pillButton,
                backgroundColor:
                  sideFilter === sf.key ? "#22c55e" : "#0f172a",
                color: sideFilter === sf.key ? "#022c22" : "#e5e7eb",
              }}
            >
              {sf.label}
            </button>
          ))}
        </div>

        <div>
          <span style={filterLabel}>持有時間：</span>
          {HOLD_FILTERS.map((hf) => (
            <button
              key={hf.key}
              onClick={() => setHoldFilter(hf.key)}
              style={{
                ...pillButton,
                backgroundColor:
                  holdFilter === hf.key ? "#a855f7" : "#0f172a",
                color: holdFilter === hf.key ? "#fdf2ff" : "#e5e7eb",
              }}
            >
              {hf.label}
            </button>
          ))}
        </div>
      </div>

      {/* 主體：左側訊號列表 + 右側詳情 */}
      <div style={mainRow}>
        {/* 左邊：訊號列表 */}
        <div style={leftColumn}>
          {filteredSignals.length === 0 && !isLoading && (
            <div style={noSignalBox}>
              目前沒有符合條件的進場訊號（或暫時抓不到資料）。<br />
              你可以改用較寬鬆的模式，或等下一次更新再看一次。
            </div>
          )}

          {filteredSignals.map((sig) => (
            <div
              key={`${sig.symbol}-${sig.timeframe}-${sig.side}`}
              style={{
                ...signalCard,
                borderColor:
                  sig.side === "long"
                    ? "#22c55e"
                    : sig.side === "short"
                    ? "#f97316"
                    : "#4b5563",
                boxShadow:
                  selectedSignal &&
                  selectedSignal.symbol === sig.symbol &&
                  selectedSignal.timeframe === sig.timeframe
                    ? "0 0 0 1px #e5e7eb"
                    : "none",
              }}
              onClick={() => setSelectedSignal(sig)}
            >
              <div style={signalHeaderRow}>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <span style={signalSymbol}>{sig.symbol}</span>
                  <span style={signalTag}>{sig.timeframe}</span>
                  <span
                    style={{
                      ...signalTag,
                      backgroundColor:
                        sig.side === "long" ? "#16a34a" : "#b91c1c",
                      color: "#f9fafb",
                    }}
                  >
                    {sig.side === "long" ? "多頭" : "空頭"}
                  </span>
                </div>
                <div style={{ textAlign: "right", fontSize: 13 }}>
                  <div>
                    價格：{" "}
                    <strong>
                      {typeof sig.lastPrice === "number"
                        ? sig.lastPrice.toFixed(4)
                        : "-"}
                    </strong>
                  </div>
                  {typeof sig.score === "number" && (
                    <div style={{ color: "#a5b4fc" }}>
                      指標強度：{sig.score.toFixed(1)} / 12
                    </div>
                  )}
                  {typeof sig.holdMinutesMin === "number" &&
                    typeof sig.holdMinutesMax === "number" && (
                      <div style={{ color: "#9ca3af" }}>
                        預估持有：~
                        {(
                          (sig.holdMinutesMin + sig.holdMinutesMax) /
                          2 /
                          60
                        ).toFixed(1)}
                        小時
                      </div>
                    )}
                </div>
              </div>

              {/* 左卡上的技術指標數值摘要 */}
              <div style={signalBodyRow}>
                <div style={signalStatLine}>
                  <span>EMA20：</span>
                  <strong>
                    {typeof sig.ema20 === "number"
                      ? sig.ema20.toFixed(4)
                      : "-"}
                  </strong>
                </div>
                <div style={signalStatLine}>
                  <span>MACD Hist：</span>
                  <strong
                    style={{
                      color:
                        sig.macdHist > 0
                          ? "#22c55e"
                          : sig.macdHist < 0
                          ? "#f97316"
                          : "#e5e7eb",
                    }}
                  >
                    {typeof sig.macdHist === "number"
                      ? sig.macdHist.toFixed(4)
                      : "-"}
                  </strong>
                </div>
                <div style={signalStatLine}>
                  <span>RSI(14)：</span>
                  <strong>
                    {typeof sig.rsi14 === "number"
                      ? sig.rsi14.toFixed(2)
                      : "-"}
                  </strong>
                </div>
              </div>

              <div style={signalBodyRow}>
                <div style={signalStatLine}>
                  <span>BB 區間：</span>
                  <strong>
                    {typeof sig.bbLower === "number" &&
                    typeof sig.bbUpper === "number"
                      ? `${sig.bbLower.toFixed(2)} ~ ${sig.bbUpper.toFixed(2)}`
                      : "-"}
                  </strong>
                </div>
                <div style={signalStatLine}>
                  <span>Volume / MA20：</span>
                  <strong>
                    {typeof sig.volume === "number" &&
                    typeof sig.volMa20 === "number"
                      ? `${sig.volume.toFixed(0)} / ${sig.volMa20.toFixed(0)}`
                      : "-"}
                  </strong>
                </div>
              </div>

              {/* 建立模擬單按鈕 */}
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
          ))}
        </div>

        {/* 右邊：詳情區 */}
        <div style={rightColumn}>
          {!selectedSignal && (
            <div style={detailPlaceholder}>
              請先在左方列表點選一個交易對，這裡會顯示進場區域 / 風險 / 指標細節。
            </div>
          )}

          {selectedSignal && (
            <div style={detailBox}>
              <h2 style={detailTitle}>
                {selectedSignal.symbol} / {selectedSignal.timeframe} /{" "}
                {selectedSignal.side === "long" ? "多頭" : "空頭"}
              </h2>

              <div style={detailSection}>
                <h3 style={detailSectionTitle}>基本資訊</h3>
                <p style={detailText}>
                  最新價格：{" "}
                  <strong>
                    {typeof selectedSignal.lastPrice === "number"
                      ? selectedSignal.lastPrice.toFixed(4)
                      : "-"}
                  </strong>
                  <br />
                  建議持有時間：
                  {selectedSignal.holdMinutesMin &&
                  selectedSignal.holdMinutesMax
                    ? `約 ${selectedSignal.holdMinutesMin} ~ ${selectedSignal.holdMinutesMax} 分鐘`
                    : "依當下盤勢調整"}
                  <br />
                  更新時間：{" "}
                  {selectedSignal.updatedAt
                    ? new Date(
                        selectedSignal.updatedAt
                      ).toLocaleString()
                    : "-"}
                </p>
              </div>

              {/* 技術指標摘要：全部用實際數值 */}
              <div style={detailSection}>
                <h3 style={detailSectionTitle}>技術指標摘要（數值）</h3>
                <ul style={detailList}>
                  <li>
                    EMA20：{" "}
                    <strong>
                      {typeof selectedSignal.ema20 === "number"
                        ? selectedSignal.ema20.toFixed(4)
                        : "-"}
                    </strong>
                  </li>
                  <li>
                    MACD Histogram：{" "}
                    <strong>
                      {typeof selectedSignal.macdHist === "number"
                        ? selectedSignal.macdHist.toFixed(4)
                        : "-"}
                    </strong>
                  </li>
                  <li>
                    RSI(14)：{" "}
                    <strong>
                      {typeof selectedSignal.rsi14 === "number"
                        ? selectedSignal.rsi14.toFixed(2)
                        : "-"}
                    </strong>
                  </li>
                  <li>
                    BB 區間：{" "}
                    <strong>
                      {typeof selectedSignal.bbLower === "number" &&
                      typeof selectedSignal.bbUpper === "number"
                        ? `${selectedSignal.bbLower.toFixed(
                            2
                          )} ~ ${selectedSignal.bbUpper.toFixed(2)}`
                        : "-"}
                    </strong>
                  </li>
                  <li>
                    Volume：{" "}
                    <strong>
                      {typeof selectedSignal.volume === "number"
                        ? selectedSignal.volume.toFixed(0)
                        : "-"}
                    </strong>{" "}
                    / MA20：{" "}
                    <strong>
                      {typeof selectedSignal.volMa20 === "number"
                        ? selectedSignal.volMa20.toFixed(0)
                        : "-"}
                    </strong>
                  </li>
                </ul>
              </div>

              {/* 進場理由：明確條列 */}
              <div style={detailSection}>
                <h3 style={detailSectionTitle}>進場理由（條列）</h3>
                {Array.isArray(selectedSignal.reasons) &&
                selectedSignal.reasons.length > 0 ? (
                  <ol style={detailList}>
                    {selectedSignal.reasons.map((r, idx) => (
                      <li key={idx}>{r}</li>
                    ))}
                  </ol>
                ) : (
                  <p style={detailText}>
                    後端尚未提供具體文字理由，但此訊號已通過多項技術指標的嚴格篩選。
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 底部：錯誤訊息（後端 / 抓取） */}
      {(backendErrors.length > 0 || fetchError) && (
        <div style={errorBox}>
          {fetchError && (
            <div style={{ marginBottom: 6 }}>
              <strong>前端抓取錯誤：</strong>
              {fetchError}
            </div>
          )}
          {backendErrors.length > 0 && (
            <div>
              部分交易對 / 週期獲取失敗（{backendErrors.length} 筆）：
              <ul style={{ marginTop: 4, paddingLeft: 20 }}>
                {backendErrors.map((e, idx) => (
                  <li key={idx}>{String(e)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* 模擬倉位區塊 */}
      <div style={simBox}>
        <h2 style={detailTitle}>模擬倉位（固定 100U 保證金 × 10x）</h2>

        {simPositions.length === 0 && (
          <div style={{ fontSize: 14, color: "#9ca3af" }}>
            目前沒有模擬單。從上面的訊號卡片按「建立模擬單（100U × 10x）」即可開始。
          </div>
        )}

        {simPositions.length > 0 && (
          <table style={simTable}>
            <thead>
              <tr>
                <th style={simTh}>交易對</th>
                <th style={simTh}>方向</th>
                <th style={simTh}>週期</th>
                <th style={simTh}>開倉時間</th>
                <th style={simTh}>進場價</th>
                <th style={simTh}>最新價</th>
                <th style={simTh}>槓桿</th>
                <th style={simTh}>名義倉位</th>
                <th style={simTh}>浮動損益 (U)</th>
                <th style={simTh}>浮動損益 (%)</th>
                <th style={simTh}>狀態</th>
                <th style={simTh}>操作</th>
              </tr>
            </thead>
            <tbody>
              {simPositions.map((pos) => (
                <tr key={pos.id}>
                  <td style={simTd}>{pos.symbol}</td>
                  <td style={simTd}>
                    {pos.side === "long" ? "多頭" : "空頭"}
                  </td>
                  <td style={simTd}>{pos.timeframe}</td>
                  <td style={simTd}>
                    {pos.entryTime
                      ? new Date(pos.entryTime).toLocaleString()
                      : "-"}
                  </td>
                  <td style={simTd}>{pos.entryPrice.toFixed(4)}</td>
                  <td style={simTd}>
                    {pos.lastPrice ? pos.lastPrice.toFixed(4) : "-"}
                  </td>
                  <td style={simTd}>{pos.leverage}x</td>
                  <td style={simTd}>
                    {(pos.margin * pos.leverage).toFixed(2)}
                  </td>
                  <td
                    style={{
                      ...simTd,
                      color:
                        pos.pnl > 0
                          ? "#22c55e"
                          : pos.pnl < 0
                          ? "#f97316"
                          : "#e5e7eb",
                    }}
                  >
                    {pos.pnl ? pos.pnl.toFixed(2) : "0.00"}
                  </td>
                  <td
                    style={{
                      ...simTd,
                      color:
                        pos.pnlPct > 0
                          ? "#22c55e"
                          : pos.pnlPct < 0
                          ? "#f97316"
                          : "#e5e7eb",
                    }}
                  >
                    {pos.pnlPct ? pos.pnlPct.toFixed(2) + "%" : "0.00%"}
                  </td>
                  <td style={simTd}>{pos.status}</td>
                  <td style={simTd}>
                    {pos.status === "OPEN" && (
                      <button
                        onClick={() => closeSimPosition(pos.id)}
                        style={closeButton}
                      >
                        平倉
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ====== 共用樣式 ====== */

const pageStyle = {
  minHeight: "100vh",
  padding: "24px 32px 48px",
  backgroundColor: "#020617", // 超深色背景
  color: "#f9fafb", // 預設文字很亮
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

const headerRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  marginBottom: 16,
};

const titleStyle = {
  fontSize: 24,
  fontWeight: 700,
  color: "#f9fafb",
  margin: 0,
};

const subTitleStyle = {
  marginTop: 4,
  fontSize: 13,
  color: "#9ca3af",
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
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 12,
  padding: "8px 12px",
  borderRadius: 12,
  backgroundColor: "#020617",
  border: "1px solid #1f2937",
};

const filterLabel = {
  marginRight: 8,
  fontSize: 13,
  color: "#e5e7eb",
};

const pillButton = {
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid #334155",
  fontSize: 13,
  cursor: "pointer",
  marginRight: 6,
  backgroundColor: "#0f172a",
  color: "#e5e7eb",
};

const mainRow = {
  display: "flex",
  gap: 16,
  alignItems: "stretch",
};

const leftColumn = {
  flex: 1.3,
  minWidth: 0,
};

const rightColumn = {
  flex: 1,
  minWidth: 0,
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
  marginBottom: 4,
};

const signalSymbol = {
  fontWeight: 700,
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
};

const signalBodyRow = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 13,
  marginTop: 2,
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
  fontWeight: 700,
  margin: "0 0 8px 0",
  color: "#f9fafb",
};

const detailSection = {
  marginTop: 10,
};

const detailSectionTitle = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 4,
  color: "#e5e7eb",
};

const detailText = {
  margin: 0,
  lineHeight: 1.6,
};

const detailList = {
  margin: 0,
  paddingLeft: 18,
  lineHeight: 1.6,
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
  marginTop: 8,
  fontSize: 13,
};

const simTh = {
  padding: "6px 8px",
  borderBottom: "1px solid #1f2937",
  textAlign: "left",
  color: "#e5e7eb",
  whiteSpace: "nowrap",
};

const simTd = {
  padding: "6px 8px",
  borderBottom: "1px solid #020617",
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
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid #f97316",
  backgroundColor: "#111827",
  color: "#fed7aa",
  fontSize: 12,
  cursor: "pointer",
};