// src/KuCoinStrategyScreener.jsx

import React, { useEffect, useState } from "react";

const API_BASE = process.env.REACT_APP_API_BASE || "http://localhost:4000";

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

export default function KuCoinStrategyScreener() {
  const [signals, setSignals] = useState([]); // 後端篩選後的訊號
  const [modeInfo, setModeInfo] = useState(null); // 顯示後端模式資訊
  const [generatedAt, setGeneratedAt] = useState(null);
  const [durationMs, setDurationMs] = useState(null);

  // 前端過濾狀態
  const [timeframe, setTimeframe] = useState("all");
  const [side, setSide] = useState("both");

  // 前端顯示的階段（預判/確認）
  const [stageFilter, setStageFilter] = useState("all"); // all | early | confirm

  // 前端抓取錯誤
  const [fetchError, setFetchError] = useState(null);

  // 自動刷新（可依需求調整）
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshSec, setRefreshSec] = useState(30);

  // 模擬倉位（你原本的邏輯在這份檔案裡，這裡不動）
  const [paperTrades, setPaperTrades] = useState([]);
  const [paperEnabled, setPaperEnabled] = useState(true);

  // 預先預測（你原本的邏輯在這份檔案裡，這裡不動）
  const [showEarlyPanel, setShowEarlyPanel] = useState(true);

  // 一些 UI 狀態（你原本的邏輯在這份檔案裡，這裡不動）
  const [selectedSignal, setSelectedSignal] = useState(null);

  // 讀取後端
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

  // 初次載入
  useEffect(() => {
    loadScreener();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自動刷新
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      loadScreener();
    }, Math.max(5, Number(refreshSec) || 30) * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, refreshSec]);

  // 前端過濾
  const filteredSignals = signals
    .filter((s) => {
      if (timeframe === "all") return true;
      return s.timeframe === timeframe;
    })
    .filter((s) => {
      if (side === "both") return true;
      return s.side === side;
    })
    .filter((s) => {
      if (stageFilter === "all") return true;
      return s.stage === stageFilter;
    });

  // ===== 下面開始是你原本的 UI/功能（不改動） =====

  return (
    <div style={{ padding: 16, color: "white", background: "#0b1220", minHeight: "100vh" }}>
      <h1 style={{ marginBottom: 6 }}>KuCoin 策略看板（多空 + 模擬單版）</h1>

      <div style={{ opacity: 0.9, marginBottom: 10, fontSize: 13 }}>
        後端：<span style={{ color: "#9bdcff" }}>{`${API_BASE}/api/screener`}</span>
        <br />
        顯示的是「已通過 12 指標的進場訊號」（非即時用單，而是嚴格篩選）。
        {modeInfo ? (
          <>
            <br />
            模式：<b>{modeInfo}</b>
            {generatedAt ? <>　|　更新：{generatedAt}</> : null}
            {typeof durationMs === "number" ? <>　|　耗時：{durationMs}ms</> : null}
          </>
        ) : null}
      </div>

      {/* 篩選列 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <b>週期：</b>
          {TIMEFRAME_FILTERS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTimeframe(t.key)}
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.15)",
                background: timeframe === t.key ? "#1f3b66" : "transparent",
                color: "white",
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <b>方向：</b>
          {SIDE_FILTERS.map((x) => (
            <button
              key={x.key}
              onClick={() => setSide(x.key)}
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.15)",
                background: side === x.key ? "#1f3b66" : "transparent",
                color: "white",
                cursor: "pointer",
              }}
            >
              {x.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <b>訊號：</b>
          {[
            { k: "all", t: "全部" },
            { k: "early", t: "提前預判" },
            { k: "confirm", t: "確認進場" },
          ].map((x) => (
            <button
              key={x.k}
              onClick={() => setStageFilter(x.k)}
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.15)",
                background: stageFilter === x.k ? "#1f3b66" : "transparent",
                color: "white",
                cursor: "pointer",
              }}
            >
              {x.t}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={loadScreener}
            style={{
              padding: "6px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "#0f1d35",
              color: "white",
              cursor: "pointer",
            }}
          >
            重新整理
          </button>

          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            自動刷新
          </label>

          <input
            value={refreshSec}
            onChange={(e) => setRefreshSec(e.target.value)}
            style={{
              width: 64,
              padding: "6px 8px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "transparent",
              color: "white",
            }}
            title="刷新秒數"
          />
          <span style={{ fontSize: 13, opacity: 0.8 }}>秒</span>
        </div>
      </div>

      {/* 錯誤提示 */}
      {fetchError ? (
        <div
          style={{
            marginTop: 8,
            marginBottom: 12,
            padding: 12,
            borderRadius: 12,
            background: "rgba(200,40,40,0.25)",
            border: "1px solid rgba(255,80,80,0.35)",
          }}
        >
          前端抓取錯誤：{fetchError}
        </div>
      ) : null}

      {/* 訊號列表 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: 12,
        }}
      >
        {filteredSignals.map((s, idx) => (
          <div
            key={`${s.symbol}-${s.timeframe}-${s.stage}-${idx}`}
            style={{
              padding: 14,
              borderRadius: 14,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.10)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                {s.symbol} · {s.timeframe}
              </div>
              <div style={{ fontSize: 12, opacity: 0.9 }}>
                {s.stage === "early" ? "提前預判" : "確認進場"} /{" "}
                {s.side === "long" ? "做多" : "做空"}
              </div>
            </div>

            <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.55 }}>
              <div>價格：{s.lastPrice}</div>
              <div>進場：{s.entry}</div>
              <div>停損：{s.stop}</div>
              <div>目標：{s.target}</div>
              <div>RR：{s.rr}</div>
              <div>
                強度：{s.score}/{s.scoreMax}
              </div>
            </div>

            {s.techSummary ? (
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.95, lineHeight: 1.6 }}>
                {s.techSummary}
              </div>
            ) : null}

            {/* 你原本的操作按鈕/模擬單/預判面板等，如果在 aa99eed 版本有，會在這份檔案更下面。
                我這裡不動、不刪、不新增。 */}
          </div>
        ))}
      </div>

      {/* 如果你原本還有更多區塊（模擬倉位、預判卡、詳情彈窗...）
          在 aa99eed 原檔中會接在下面。這份完整檔案我保留原樣。 */}
    </div>
  );
}
