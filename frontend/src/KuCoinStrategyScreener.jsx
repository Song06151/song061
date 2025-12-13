// frontend/src/KuCoinStrategyScreener.jsx

import React, { useEffect, useState } from "react";

const API_BASE = process.env.REACT_APP_API_BASE || "http://localhost:4000";

const TIMEFRAME_FILTERS = [
  { key: "all", label: "全部週期" },
  { key: "30m", label: "30 分鐘" },
  { key: "1h", label: "1 小時" },
  { key: "4h", label: "4 小時" },
];

const SIDE_FILTERS = [
  { key: "both", label: "全部方向" },
  { key: "long", label: "多頭" },
  { key: "short", label: "空頭" },
];

export default function KuCoinStrategyScreener() {
  const [signals, setSignals] = useState([]);
  const [modeInfo, setModeInfo] = useState(null);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [durationMs, setDurationMs] = useState(null);

  const [timeframe, setTimeframe] = useState("all");
  const [side, setSide] = useState("both");
  const [stageFilter, setStageFilter] = useState("all");

  const [fetchError, setFetchError] = useState(null);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshSec, setRefreshSec] = useState(30);

  const [paperTrades, setPaperTrades] = useState([]);
  const [paperEnabled, setPaperEnabled] = useState(true);

  const [showEarlyPanel, setShowEarlyPanel] = useState(true);
  const [selectedSignal, setSelectedSignal] = useState(null);

  // ✅ 只改這裡：加 async
  const loadScreener = async () => {
    try {
      setFetchError(null);

      const res = await fetch(`${API_BASE}/api/screener`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json = await res.json();
      setModeInfo(json?.mode ?? null);
      setGeneratedAt(json?.generatedAt ?? null);
      setDurationMs(json?.durationMs ?? null);

      const list = Array.isArray(json?.signals) ? json.signals : [];
      setSignals(list);
    } catch (err) {
      console.error("loadScreener error:", err);
      setFetchError("Failed to fetch");
      setSignals([]);
    }
  };

  useEffect(() => {
    loadScreener();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      loadScreener();
    }, Math.max(5, Number(refreshSec) || 30) * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, refreshSec]);

  const filteredSignals = signals
    .filter((s) => (timeframe === "all" ? true : s.timeframe === timeframe))
    .filter((s) => (side === "both" ? true : s.side === side))
    .filter((s) => (stageFilter === "all" ? true : s.stage === stageFilter));

  return (
    <div style={{ padding: 16, color: "white", background: "#0b1220", minHeight: "100vh" }}>
      <h1>KuCoin 策略看板（多空 + 模擬單版）</h1>

      <div style={{ opacity: 0.9, marginBottom: 10, fontSize: 13 }}>
        後端：{`${API_BASE}/api/screener`}
        <br />
        顯示的是「已通過 12 指標的進場訊號」（非即時下單）。
        {modeInfo && (
          <>
            <br />
            模式：<b>{modeInfo}</b>
            {generatedAt && <> ｜ 更新：{generatedAt}</>}
            {typeof durationMs === "number" && <> ｜ 耗時：{durationMs}ms</>}
          </>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <b>週期：</b>
        {TIMEFRAME_FILTERS.map((t) => (
          <button key={t.key} onClick={() => setTimeframe(t.key)}>
            {t.label}
          </button>
        ))}

        <b>方向：</b>
        {SIDE_FILTERS.map((x) => (
          <button key={x.key} onClick={() => setSide(x.key)}>
            {x.label}
          </button>
        ))}

        <b>訊號：</b>
        {[
          { k: "all", t: "全部" },
          { k: "early", t: "提前預判" },
          { k: "confirm", t: "確認進場" },
        ].map((x) => (
          <button key={x.k} onClick={() => setStageFilter(x.k)}>
            {x.t}
          </button>
        ))}

        <button onClick={loadScreener}>重新整理</button>
      </div>

      {fetchError && (
        <div style={{ padding: 12, background: "rgba(200,40,40,0.3)", borderRadius: 8 }}>
          前端抓取錯誤：{fetchError}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px,1fr))", gap: 12 }}>
        {filteredSignals.map((s, idx) => (
          <div key={idx} style={{ padding: 14, borderRadius: 12, background: "rgba(255,255,255,0.05)" }}>
            <b>{s.symbol} · {s.timeframe}</b>
            <div>方向：{s.side === "long" ? "做多" : "做空"}</div>
            <div>階段：{s.stage === "early" ? "提前預判" : "確認進場"}</div>
            <div>價格：{s.lastPrice}</div>
            <div>進場：{s.entry}</div>
            <div>停損：{s.stop}</div>
            <div>目標：{s.target}</div>
            <div>RR：{s.rr}</div>
            <div>強度：{s.score}/{s.scoreMax}</div>
            {s.techSummary && <div style={{ fontSize: 12, marginTop: 6 }}>{s.techSummary}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
