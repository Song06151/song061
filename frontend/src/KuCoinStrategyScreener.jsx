import React, { useEffect, useState } from "react";
import "./App.css";

/**
 * API base
 * - local: http://localhost:4000
 * - production: Render backend
 */
const API_BASE =
    process.env.REACT_APP_API_BASE || "http://localhost:4000";
    ? "https://kucoin-screener-backend.onrender.com"
    : "http://localhost:4000";

export default function KuCoinStrategyScreener() {
  const [signals, setSignals] = useState([]);
  const [backendErrors, setBackendErrors] = useState([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");
  const [timeframe, setTimeframe] = useState("all");
  const [stageFilter, setStageFilter] = useState("all"); // all | early | confirm

  useEffect(() => {
    loadScreener();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadScreener() {
    try {
      setLoading(true);
      setErrorMsg("");

      const res = await fetch(`${API_BASE}/api/screener`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json = await res.json();

      // 保底處理（避免 signals 不是 array）
      const list = Array.isArray(json)
        ? json
        : Array.isArray(json?.signals)
        ? json.signals
        : [];

      setSignals(list);

      setBackendErrors(Array.isArray(json?.errors) ? json.errors : []);
      setLastUpdated(
        json?.generatedAt
          ? new Date(json.generatedAt).toLocaleString()
          : new Date().toLocaleString()
      );
    } catch (err) {
      console.error("loadScreener error:", err);
      setErrorMsg("前端抓取錯誤：Failed to fetch");
    } finally {
      setLoading(false);
    }
  }

  const filteredSignals = signals
    .filter((s) => {
      if (timeframe === "all") return true;
      return s.timeframe === timeframe;
    })
    .filter((s) => {
      if (stageFilter === "all") return true;
      return s.stage === stageFilter;
    });

  return (
    <div className="container">
      <h1>KuCoin 策略看板（多空＋模擬單）</h1>

      <div className="toolbar">
        <div>
          <strong>週期：</strong>
          {["all", "30m", "1h", "4h"].map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={timeframe === tf ? "active" : ""}
            >
              {tf === "all" ? "全部" : tf}
            </button>
          ))}
        </div>

        <div>
          <strong>訊號：</strong>
          {[
            { k: "all", t: "全部" },
            { k: "early", t: "提前預判" },
            { k: "confirm", t: "確認進場" },
          ].map((x) => (
            <button
              key={x.k}
              onClick={() => setStageFilter(x.k)}
              className={stageFilter === x.k ? "active" : ""}
            >
              {x.t}
            </button>
          ))}
        </div>

        <button onClick={loadScreener}>重新整理</button>
      </div>

      {loading && <p>資料讀取中…</p>}
      {errorMsg && <div className="error">{errorMsg}</div>}

      {!loading && !errorMsg && filteredSignals.length === 0 && (
        <p>目前沒有符合條件的進場訊號。</p>
      )}

      <div className="grid">
        {filteredSignals.map((s, idx) => (
          <div key={idx} className="card">
            <h3>
              {s.symbol} · {s.timeframe}
            </h3>
            <p>
              方向：<strong>{s.side === "long" ? "做多" : "做空"}</strong>
            </p>
            <p>
              階段：
              <strong>
                {s.stage === "early" ? " 提前預判" : " 確認進場"}
              </strong>
            </p>
            <p>價格：{s.lastPrice}</p>
            <p>進場：{s.entry}</p>
            <p>停損：{s.stop}</p>
            <p>目標：{s.target}</p>
            <p>RR：{s.rr}</p>
            <p>強度：{s.score}/{s.scoreMax}</p>
            <p className="summary">{s.techSummary}</p>
          </div>
        ))}
      </div>

      <footer>
        <small>最後更新：{lastUpdated}</small>
      </footer>
    </div>
  );
}
