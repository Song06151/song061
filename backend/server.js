// server.js
// KuCoin Proxy + 高勝率 Screener（1h 進場 + 6h 同向確認）+ 回測模擬單
//
// 提供：
//   GET /api/kucoin/candles
//   GET /api/kucoin/ticker
//   GET /api/screener   （勝率優先：1h confirm + 6h filter，多空訊號）
//   GET /api/backtest   （單幣種回測模擬單）
//
// 使用前：
//   npm init -y
//   npm install express cors node-fetch@2

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // v2

const app = express();
const PORT = precess.env.PORT||4000；
const KUCOIN_API_BASE = "https://api.kucoin.com/api/v1";

app.use(
  cors({
    origin: "*",
    methods: ["GET", "OPTIONS"],
  })
);

// ---------- 工具函式 ----------

const mapKucoinKlineToCandle = (k) => ({
  time: new Date(parseInt(k[0], 10) * 1000).toISOString(),
  open: parseFloat(k[1]),
  high: parseFloat(k[2]),
  low: parseFloat(k[3]),
  close: parseFloat(k[4]),
  volume: parseFloat(k[5]),
});

function calculateEMA(values, period) {
  if (!values || values.length === 0) return null;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateSMA(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

function calculateRSI(values, period = 14) {
  if (!values || values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// MACD：回傳最後兩筆 hist
function calculateMACD(values, fast = 12, slow = 26, signal = 9) {
  if (!values || values.length < slow + signal + 5) return null;

  const emaSeries = (period) => {
    const k = 2 / (period + 1);
    const result = [];
    let ema = values[0];
    result.push(ema);
    for (let i = 1; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  };

  const emaFast = emaSeries(fast);
  const emaSlow = emaSeries(slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);

  const signalSeries = [];
  const kSignal = 2 / (signal + 1);
  let sig = macdLine[slow];
  signalSeries[slow] = sig;
  for (let i = slow + 1; i < macdLine.length; i++) {
    sig = macdLine[i] * kSignal + sig * (1 - kSignal);
    signalSeries[i] = sig;
  }

  const lastIdx = macdLine.length - 1;
  const prevIdx = lastIdx - 1;
  if (!signalSeries[lastIdx] || !signalSeries[prevIdx]) return null;

  const macd = macdLine[lastIdx];
  const sigLast = signalSeries[lastIdx];
  const hist = macd - sigLast;

  const macdPrev = macdLine[prevIdx];
  const sigPrev = signalSeries[prevIdx];
  const histPrev = macdPrev - sigPrev;

  return {
    macd,
    signal: sigLast,
    hist,
    histPrev,
    macdPrev,
    signalPrev: sigPrev,
  };
}

// BB：只取最後一段 & 前一段寬度
function calculateBBLast(values, period = 20, mult = 2) {
  if (!values || values.length < period + 1) return null;

  const lastSegment = values.slice(-period);
  const prevSegment = values.slice(-period - 1, -1);

  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const stddev = (arr, m) =>
    Math.sqrt(arr.reduce((s, v) => s + (v - m) * (v - m), 0) / arr.length);

  const mLast = mean(lastSegment);
  const sdLast = stddev(lastSegment, mLast);

  const mPrev = mean(prevSegment);
  const sdPrev = stddev(prevSegment, mPrev);

  const upper = mLast + mult * sdLast;
  const lower = mLast - mult * sdLast;
  const width = upper - lower;
  const widthPrev = (mPrev + mult * sdPrev) - (mPrev - mult * sdPrev);

  return {
    middle: mLast,
    upper,
    lower,
    width,
    widthPrev,
  };
}

// VWAP（最近 N 根）
function calculateVWAP(candles, period = 30) {
  if (!candles || candles.length < period) return null;
  const slice = candles.slice(-period);
  let pvSum = 0;
  let volSum = 0;
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3;
    pvSum += typical * c.volume;
    volSum += c.volume;
  }
  if (volSum === 0) return null;
  return pvSum / volSum;
}

// 結構偏多 / 偏空（最近 5 根收盤）
function detectStructureBias(closes) {
  if (!closes || closes.length < 5) return "neutral";
  const last5 = closes.slice(-5);
  let upCount = 0;
  let downCount = 0;
  for (let i = 1; i < last5.length; i++) {
    if (last5[i] > last5[i - 1]) upCount++;
    if (last5[i] < last5[i - 1]) downCount++;
  }
  if (upCount >= 3 && last5[last5.length - 1] > last5[0]) return "bullish";
  if (downCount >= 3 && last5[last5.length - 1] < last5[0]) return "bearish";
  return "neutral";
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// 依強度建議持倉方案（1h～24h）
function suggestHoldProfile(strength) {
  if (strength >= 5) return { key: "12-24", minH: 12, maxH: 24, label: "長波 12–24 小時" };
  if (strength >= 4) return { key: "8-12", minH: 8, maxH: 12, label: "波段 8–12 小時" };
  if (strength >= 3) return { key: "4-8", minH: 4, maxH: 8, label: "短波 4–8 小時" };
  return { key: "1-4", minH: 1, maxH: 4, label: "超短 1–4 小時" };
}

// ---------- KuCoin API 封裝 ----------

async function fetchKuCoinCandles(symbol, type, limit = 200) {
  const url = `${KUCOIN_API_BASE}/market/candles?type=${type}&symbol=${symbol}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`KuCoin candles HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.code !== "200000" || !Array.isArray(json.data)) {
    throw new Error(`KuCoin candles 回傳錯誤: ${json.code} ${json.msg || ""}`);
  }
  return json.data.map(mapKucoinKlineToCandle).reverse();
}

async function fetchKuCoinTicker(symbol) {
  const url = `${KUCOIN_API_BASE}/market/orderbook/level1?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`KuCoin ticker HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.code !== "200000" || !json.data || json.data.price === undefined) {
    throw new Error(`KuCoin ticker 回傳錯誤: ${json.code} ${json.msg || ""}`);
  }
  return {
    symbol: json.data.symbol,
    price: parseFloat(json.data.price),
  };
}

// ---------- 對外 API：candles / ticker ----------

app.get("/api/kucoin/candles", async (req, res) => {
  const { symbol, type, limit } = req.query;
  if (!symbol || !type) {
    return res.status(400).json({ code: 400, msg: "缺少 symbol 或 type 參數" });
  }
  try {
    const candles = await fetchKuCoinCandles(symbol, type, limit || 200);
    res.json(candles);
  } catch (err) {
    console.error("[/api/kucoin/candles] error:", err.message);
    res.status(502).json({
      code: 502,
      msg: "KuCoin K 線數據獲取失敗",
      detail: err.message,
    });
  }
});

app.get("/api/kucoin/ticker", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ code: 400, msg: "缺少 symbol 參數" });
  }
  try {
    const t = await fetchKuCoinTicker(symbol);
    res.json(t);
  } catch (err) {
    console.error("[/api/kucoin/ticker] error:", err.message);
    res.status(502).json({
      code: 502,
      msg: "KuCoin Ticker 獲取失敗",
      detail: err.message,
    });
  }
});

// ---------- Screener 設定 ----------
// 注意：你之前要「前 80 大」那條要做得精準會牽涉外部資料源（30d volume），這裡先維持可控的名單。
// 你要我再把「自動抓 top80」補上，我可以下一版直接做（會加快取、避免 Render 超慢）。

const SYMBOLS = [
  "BTC-USDT",
  "ETH-USDT",
  "BNB-USDT",
  "SOL-USDT",
  "XRP-USDT",
  "DOGE-USDT",
  "AVAX-USDT",
  "LINK-USDT",
  "ADA-USDT",
  "TRX-USDT",
  "TON-USDT",
  "DOT-USDT",
  "MATIC-USDT",
  "LTC-USDT",
  "BCH-USDT",
  "ATOM-USDT",
  "NEAR-USDT",
  "APT-USDT",
  "OP-USDT",
  "ARB-USDT",
  "SUI-USDT",
  "INJ-USDT",
  "FIL-USDT",
  "ETC-USDT",
  "ICP-USDT",
  "UNI-USDT",
  "AAVE-USDT",
  "SNX-USDT",
  "IMX-USDT",
  "RNDR-USDT",
];

// 你要的範圍：最少 1h、最多 24h。
// 這版的「下單訊號」以 1h 觸發，並用 6h 做同向確認；另外保留可延伸的 timeframes 供 UI 顯示。
const TIMEFRAMES = [
  { key: "1h", kucoinType: "1hour" },
  { key: "2h", kucoinType: "2hour" },
  { key: "4h", kucoinType: "4hour" },
  { key: "6h", kucoinType: "6hour" },
  { key: "8h", kucoinType: "8hour" },
  { key: "12h", kucoinType: "12hour" },
  { key: "1d", kucoinType: "1day" },
];

// 主策略：以 1h 觸發，6h 過濾
const ENTRY_TF = { key: "1h", kucoinType: "1hour" };
const FILTER_TF = { key: "6h", kucoinType: "6hour" };

// 訊號數量目標（你要一天約 5 條）
const MAX_SIGNALS = 5;

// ---------- /api/screener：勝率優先（1h confirm + 6h 同向確認） ----------

app.get("/api/screener", async (req, res) => {
  const started = Date.now();
  const signals = [];
  const errors = [];

  for (const symbol of SYMBOLS) {
    try {
      const [candles1h, candles6h, ticker] = await Promise.all([
        fetchKuCoinCandles(symbol, ENTRY_TF.kucoinType, 220),
        fetchKuCoinCandles(symbol, FILTER_TF.kucoinType, 220),
        fetchKuCoinTicker(symbol),
      ]);

      if (!candles1h || candles1h.length < 120) {
        errors.push({ symbol, timeframe: "1h", source: "CANDLES", message: "1h K 線資料不足" });
        continue;
      }
      if (!candles6h || candles6h.length < 120) {
        errors.push({ symbol, timeframe: "6h", source: "CANDLES", message: "6h K 線資料不足" });
        continue;
      }

      // ===== 1h 指標 =====
      const closes1h = candles1h.map((c) => c.close);
      const volumes1h = candles1h.map((c) => c.volume);
      const last1h = candles1h[candles1h.length - 1];
      const prev1h = candles1h[candles1h.length - 2];

      const price = ticker.price;
      const prevClose = prev1h.close;

      const ema20_1h = calculateEMA(closes1h, 20);
      const ema20Prev_1h = calculateEMA(closes1h.slice(0, -1), 20);
      const emaSlopeUp_1h = ema20_1h != null && ema20Prev_1h != null ? ema20_1h > ema20Prev_1h : false;
      const emaSlopeDown_1h = ema20_1h != null && ema20Prev_1h != null ? ema20_1h < ema20Prev_1h : false;

      const rsi14_1h = calculateRSI(closes1h, 14);
      const rsiPrev_1h = calculateRSI(closes1h.slice(0, -1), 14);
      const rsiUp_1h = rsi14_1h != null && rsiPrev_1h != null ? rsi14_1h > rsiPrev_1h : false;
      const rsiDown_1h = rsi14_1h != null && rsiPrev_1h != null ? rsi14_1h < rsiPrev_1h : false;

      const macd_1h = calculateMACD(closes1h, 12, 26, 9);
      const bb_1h = calculateBBLast(closes1h, 20, 2);
      const vwap_1h = calculateVWAP(candles1h, 30);

      const volMa20_1h = calculateSMA(volumes1h, 20);
      const volMa5_1h = calculateSMA(volumes1h, 5);
      const volCurrent_1h = volumes1h[volumes1h.length - 1];

      const volPulse_1h = volMa5_1h && volMa20_1h ? volMa5_1h / volMa20_1h : 1;

      let vwapDevPct_1h = null;
      if (vwap_1h) vwapDevPct_1h = ((price - vwap_1h) / vwap_1h) * 100;

      const structureBias_1h = detectStructureBias(closes1h);

      // ===== 6h 指標（同向確認）=====
      const closes6h = candles6h.map((c) => c.close);
      const volumes6h = candles6h.map((c) => c.volume);
      const ema20_6h = calculateEMA(closes6h, 20);
      const ema20Prev_6h = calculateEMA(closes6h.slice(0, -1), 20);
      const emaSlopeUp_6h = ema20_6h != null && ema20Prev_6h != null ? ema20_6h > ema20Prev_6h : false;
      const emaSlopeDown_6h = ema20_6h != null && ema20Prev_6h != null ? ema20_6h < ema20Prev_6h : false;
      const rsi14_6h = calculateRSI(closes6h, 14);
      const macd_6h = calculateMACD(closes6h, 12, 26, 9);
      const structureBias_6h = detectStructureBias(closes6h);

      // ===== 共同判斷 =====
      const priceAboveEma_1h = ema20_1h != null ? price > ema20_1h : false;
      const priceBelowEma_1h = ema20_1h != null ? price < ema20_1h : false;

      const priceAboveEma_6h = ema20_6h != null ? price > ema20_6h : false;
      const priceBelowEma_6h = ema20_6h != null ? price < ema20_6h : false;

      // MACD 更嚴格：翻正/翻負 或 真的站上/站下
      const hist_1h = macd_1h ? macd_1h.hist : null;
      const histPrev_1h = macd_1h ? macd_1h.histPrev : null;
      const macdLine_1h = macd_1h ? macd_1h.macd : null;
      const signalLine_1h = macd_1h ? macd_1h.signal : null;

      const macdFlipUp_1h = hist_1h != null && histPrev_1h != null && histPrev_1h < 0 && hist_1h > 0;
      const macdFlipDown_1h = hist_1h != null && histPrev_1h != null && histPrev_1h > 0 && hist_1h < 0;

      const macdUpStrong_1h =
        macdLine_1h != null && signalLine_1h != null && macdLine_1h > signalLine_1h &&
        hist_1h != null && histPrev_1h != null && hist_1h > histPrev_1h && hist_1h > 0;

      const macdDownStrong_1h =
        macdLine_1h != null && signalLine_1h != null && macdLine_1h < signalLine_1h &&
        hist_1h != null && histPrev_1h != null && hist_1h < histPrev_1h && hist_1h < 0;

      const macdOkLong_1h = macdFlipUp_1h || macdUpStrong_1h;
      const macdOkShort_1h = macdFlipDown_1h || macdDownStrong_1h;

      // BB 更嚴格：擴張幅度 + 波動門檻
      const bbExpandUp_1h =
        bb_1h &&
        bb_1h.widthPrev > 0 &&
        bb_1h.width > bb_1h.widthPrev * 1.15 &&
        bb_1h.middle > 0 &&
        (bb_1h.width / bb_1h.middle) > 0.02 &&
        price >= bb_1h.middle;

      const bbExpandDown_1h =
        bb_1h &&
        bb_1h.widthPrev > 0 &&
        bb_1h.width > bb_1h.widthPrev * 1.15 &&
        bb_1h.middle > 0 &&
        (bb_1h.width / bb_1h.middle) > 0.02 &&
        price <= bb_1h.middle;

      // RSI 更挑（勝率取向）
      const rsiBull_1h = rsi14_1h != null && rsi14_1h >= 55 && rsi14_1h <= 68 && rsiUp_1h;
      const rsiBear_1h = rsi14_1h != null && rsi14_1h >= 32 && rsi14_1h <= 45 && rsiDown_1h;

      // VWAP 過濾：不要追太遠（勝率取向）
      const vwapLongOk_1h = vwapDevPct_1h != null && vwapDevPct_1h >= -0.5 && vwapDevPct_1h <= 2.5;
      const vwapShortOk_1h = vwapDevPct_1h != null && vwapDevPct_1h <= 0.5 && vwapDevPct_1h >= -2.5;

      // 量能：至少有脈衝（不要無量亂拉亂殺）
      const volOk_1h = volPulse_1h > 1.3;

      // 6h 同向確認：順勢 + 結構
      const filterLong_6h =
        priceAboveEma_6h && emaSlopeUp_6h &&
        rsi14_6h != null && rsi14_6h > 52 &&
        (structureBias_6h === "bullish");

      const filterShort_6h =
        priceBelowEma_6h && emaSlopeDown_6h &&
        rsi14_6h != null && rsi14_6h < 48 &&
        (structureBias_6h === "bearish");

      // ===== 只輸出 confirm（勝率優先）=====
      // 多頭 confirm：1h 必須都很乾淨 + 6h 同向
      const confirmLongConds = {
        filter6h: filterLong_6h,
        priceAboveEma_1h,
        emaSlopeUp_1h,
        structureBull_1h: structureBias_1h === "bullish",
        rsiBull_1h,
        macdOkLong_1h,
        bbExpandUp_1h,
        volOk_1h,
        vwapLongOk_1h,
      };

      // 空頭 confirm：1h 必須都很乾淨 + 6h 同向
      const confirmShortConds = {
        filter6h: filterShort_6h,
        priceBelowEma_1h,
        emaSlopeDown_1h,
        structureBear_1h: structureBias_1h === "bearish",
        rsiBear_1h,
        macdOkShort_1h,
        bbExpandDown_1h,
        volOk_1h,
        vwapShortOk_1h,
      };

      const confirmLongScore = Object.values(confirmLongConds).filter(Boolean).length;
      const confirmShortScore = Object.values(confirmShortConds).filter(Boolean).length;

      const scoreMax = 9;

      // 你要勝率高：再加一道「至少 8/9」才放行（這會大幅壓低訊號數）
      const PASS_SCORE = 8;

      let side = null;
      let score = 0;
      let techSummary = [];

      if (confirmLongScore >= PASS_SCORE) {
        side = "long";
        score = confirmLongScore;
        techSummary = [
          `${confirmLongConds.filter6h ? "✅" : "❌"} 6h 同向確認（趨勢 + 結構）`,
          `${priceAboveEma_1h ? "✅" : "❌"} 1h 價格在 EMA20 上方`,
          `${emaSlopeUp_1h ? "✅" : "❌"} 1h EMA20 上升（順勢）`,
          `${structureBias_1h === "bullish" ? "✅" : "❌"} 1h 結構偏多（最近 5 根至少 3 根上漲）`,
          `${rsiBull_1h ? "✅" : "❌"} 1h RSI 55–68 且上升`,
          `${macdOkLong_1h ? "✅" : "❌"} 1h MACD 翻正或強勢站上`,
          `${bbExpandUp_1h ? "✅" : "❌"} 1h BB 擴張（避免盤整假訊號）`,
          `${volOk_1h ? "✅" : "❌"} 1h 量能脈衝（volPulse > 1.3）`,
          `${vwapLongOk_1h ? "✅" : "❌"} 1h 不追高（VWAP 偏離 -0.5%~+2.5%）`,
        ];
      } else if (confirmShortScore >= PASS_SCORE) {
        side = "short";
        score = confirmShortScore;
        techSummary = [
          `${confirmShortConds.filter6h ? "✅" : "❌"} 6h 同向確認（趨勢 + 結構）`,
          `${priceBelowEma_1h ? "✅" : "❌"} 1h 價格在 EMA20 下方`,
          `${emaSlopeDown_1h ? "✅" : "❌"} 1h EMA20 下降（順勢）`,
          `${structureBias_1h === "bearish" ? "✅" : "❌"} 1h 結構偏空（最近 5 根至少 3 根下跌）`,
          `${rsiBear_1h ? "✅" : "❌"} 1h RSI 32–45 且下降`,
          `${macdOkShort_1h ? "✅" : "❌"} 1h MACD 翻負或強勢跌破`,
          `${bbExpandDown_1h ? "✅" : "❌"} 1h BB 擴張（避免盤整假訊號）`,
          `${volOk_1h ? "✅" : "❌"} 1h 量能脈衝（volPulse > 1.3）`,
          `${vwapShortOk_1h ? "✅" : "❌"} 1h 不追空（VWAP 偏離 -2.5%~+0.5%）`,
        ];
      } else {
        continue;
      }

      // 強度（1~5）
      const strength = clamp(Math.round((score / scoreMax) * 5), 1, 5);

      // 進出場（勝率取向：不要太貪、RR 不要太極端）
      const basePrice = price;
      let entry = basePrice;
      let stop, target;
      let riskPct, rewardPct;

      if (side === "long") {
        // 強度越高，停損略縮、目標略放，持倉時間也更長
        if (strength >= 5) { stop = basePrice * 0.985; target = basePrice * 1.045; riskPct = 1.5; rewardPct = 4.5; }
        else if (strength >= 4) { stop = basePrice * 0.985; target = basePrice * 1.040; riskPct = 1.5; rewardPct = 4.0; }
        else { stop = basePrice * 0.98; target = basePrice * 1.030; riskPct = 2.0; rewardPct = 3.0; }
      } else {
        if (strength >= 5) { stop = basePrice * 1.015; target = basePrice * 0.955; riskPct = 1.5; rewardPct = 4.5; }
        else if (strength >= 4) { stop = basePrice * 1.015; target = basePrice * 0.960; riskPct = 1.5; rewardPct = 4.0; }
        else { stop = basePrice * 1.02; target = basePrice * 0.970; riskPct = 2.0; rewardPct = 3.0; }
      }

      const rr = rewardPct / riskPct;

      const hold = suggestHoldProfile(strength);

      signals.push({
        symbol,
        side,
        stage: "confirm",
        timeframe: "1h",
        confirmTimeframe: "6h",
        strength,
        score,
        scoreMax,
        lastPrice: basePrice,
        time: last1h.time,
        entry,
        stop,
        target,
        riskPct,
        rewardPct,
        rr,

        // 透明化數值（你後面要顯示實際指標數字會用到）
        ema20_1h,
        rsi14_1h,
        macd_1h,
        bb_1h,
        vwap_1h,
        vwapDevPct_1h,
        volMa20_1h,
        volMa5_1h,
        volCurrent_1h,
        volPulse_1h,
        structureBias_1h,

        filter6h: {
          ema20_6h,
          rsi14_6h,
          macd_6h,
          structureBias_6h,
          priceAboveEma_6h,
          priceBelowEma_6h,
          emaSlopeUp_6h,
          emaSlopeDown_6h,
        },

        // 持倉建議（1–24h）
        holdProfileKey: hold.key,
        holdMinH: hold.minH,
        holdMaxH: hold.maxH,
        holdLabel: hold.label,

        techSummary,
      });
    } catch (err) {
      console.error("[/api/screener] error:", symbol, err.message || String(err));
      errors.push({
        symbol,
        timeframe: "1h/6h",
        source: "FRONT",
        message: err.message || String(err),
      });
    }
  }

  // 排序：強度 > 分數 > RR
  signals.sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    if (b.score !== a.score) return b.score - a.score;
    return (b.rr || 0) - (a.rr || 0);
  });

  // 只取你要的「一天約 5 條」
  const topSignals = signals.slice(0, MAX_SIGNALS);

  res.json({
    mode: "confirm-1h-with-6h-filter-v1",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    signals: topSignals,
    errors,
    meta: {
      maxSignals: MAX_SIGNALS,
      entryTimeframe: ENTRY_TF.key,
      confirmTimeframe: FILTER_TF.key,
      passScore: PASS_SCORE,
      note: "勝率優先：只輸出 confirm；1h 進場 + 6h 同向確認；每天訊號量目標約 5 條。",
    },
  });
});

// ---------- /api/backtest：單幣種回測模擬單 ----------
// 範例：
//   /api/backtest?symbol=BTC-USDT&timeframe=1h&bars=800&mode=confirm&side=both
//
// 參數：
//   symbol     必填：如 BTC-USDT
//   timeframe  1h / 2h / 4h / 6h / 8h / 12h / 1d（預設 1h）
//   bars       抓幾根 K（預設 800）
//   mode       confirm（預設 confirm）
//   side       long / short / both（預設 both）

app.get("/api/backtest", async (req, res) => {
  const {
    symbol,
    timeframe = "1h",
    bars = "800",
    mode = "confirm",
    side = "both",
  } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: "缺少 symbol 參數" });
  }

  const tfMap = {
    "1h": "1hour",
    "2h": "2hour",
    "4h": "4hour",
    "6h": "6hour",
    "8h": "8hour",
    "12h": "12hour",
    "1d": "1day",
  };

  const kucoinType = tfMap[timeframe];
  if (!kucoinType) {
    return res.status(400).json({ error: "timeframe 只支援 1h/2h/4h/6h/8h/12h/1d" });
  }

  const limit = parseInt(bars, 10) || 800;

  try {
    const candles = await fetchKuCoinCandles(symbol, kucoinType, limit);
    if (!candles || candles.length < 160) {
      return res.status(400).json({
        error: "K 線資料不足，無法回測",
        candleCount: candles ? candles.length : 0,
      });
    }

    const closesAll = candles.map((c) => c.close);
    const volumesAll = candles.map((c) => c.volume);

    const warmup = 120;
    const tfMinutes =
      timeframe === "1h" ? 60 :
      timeframe === "2h" ? 120 :
      timeframe === "4h" ? 240 :
      timeframe === "6h" ? 360 :
      timeframe === "8h" ? 480 :
      timeframe === "12h" ? 720 :
      1440;

    // 你要 1～24 小時：maxHoldBars 依 timeframe 自動換算
    const maxHoldBars = Math.max(1, Math.round(24 * 60 / tfMinutes));

    let position = null;
    const trades = [];

    let equityR = 0;
    let maxEquityR = 0;
    let maxDrawdownR = 0;

    const sideFilter = side; // both / long / short

    for (let i = warmup; i < candles.length; i++) {
      const candle = candles[i];
      const prevCandle = candles[i - 1];

      // 先出場
      if (position && i > position.openIndex) {
        const high = candle.high;
        const low = candle.low;
        let exit = null;

        if (position.side === "long") {
          const hitTP = high >= position.target;
          const hitSL = low <= position.stop;

          if (hitTP && hitSL) exit = { price: position.stop, reason: "sl-tp-same-bar" };
          else if (hitTP) exit = { price: position.target, reason: "tp" };
          else if (hitSL) exit = { price: position.stop, reason: "sl" };
          else {
            const heldBars = i - position.openIndex;
            if (heldBars >= maxHoldBars) exit = { price: candle.close, reason: "time" };
          }
        } else {
          const hitTP = low <= position.target;
          const hitSL = high >= position.stop;

          if (hitTP && hitSL) exit = { price: position.stop, reason: "sl-tp-same-bar" };
          else if (hitTP) exit = { price: position.target, reason: "tp" };
          else if (hitSL) exit = { price: position.stop, reason: "sl" };
          else {
            const heldBars = i - position.openIndex;
            if (heldBars >= maxHoldBars) exit = { price: candle.close, reason: "time" };
          }
        }

        if (exit) {
          const entryPrice = position.entryPrice;
          const exitPrice = exit.price;
          const heldBars = i - position.openIndex;
          const heldHours = (heldBars * tfMinutes) / 60;

          let pnlPct;
          if (position.side === "long") pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
          else pnlPct = ((entryPrice - exitPrice) / entryPrice) * 100;

          const riskPct = position.riskPct;
          const R = riskPct > 0 ? pnlPct / riskPct : 0;

          equityR += R;
          if (equityR > maxEquityR) maxEquityR = equityR;
          const drawdown = equityR - maxEquityR;
          if (drawdown < maxDrawdownR) maxDrawdownR = drawdown;

          trades.push({
            side: position.side,
            stage: "confirm",
            timeframe,
            entryIndex: position.openIndex,
            exitIndex: i,
            entryTime: position.openTime,
            exitTime: candle.time,
            entryPrice,
            exitPrice,
            stop: position.stop,
            target: position.target,
            riskPct,
            rewardPct: position.rewardPct,
            pnlPct,
            R,
            heldBars,
            heldHours,
            exitReason: exit.reason,
            scoreAtEntry: position.score,
            strengthAtEntry: position.strength,
          });

          position = null;
        }
      }

      // 再進場（只做 confirm）
      if (!position) {
        const closes = closesAll.slice(0, i + 1);
        const volumes = volumesAll.slice(0, i + 1);
        const price = candle.close;

        const ema20 = calculateEMA(closes, 20);
        const ema20Prev = calculateEMA(closes.slice(0, -1), 20);
        const emaSlopeUp = ema20 != null && ema20Prev != null ? ema20 > ema20Prev : false;
        const emaSlopeDown = ema20 != null && ema20Prev != null ? ema20 < ema20Prev : false;

        const rsi14 = calculateRSI(closes, 14);
        const rsiPrev = calculateRSI(closes.slice(0, -1), 14);
        const rsiUp = rsi14 != null && rsiPrev != null ? rsi14 > rsiPrev : false;
        const rsiDown = rsi14 != null && rsiPrev != null ? rsi14 < rsiPrev : false;

        const macd = calculateMACD(closes, 12, 26, 9);
        const bb = calculateBBLast(closes, 20, 2);

        const volMa20 = calculateSMA(volumes, 20);
        const volMa5 = calculateSMA(volumes, 5);
        const volPulse = volMa5 && volMa20 ? volMa5 / volMa20 : 1;

        const structureBias = detectStructureBias(closes);

        const priceAboveEma = ema20 != null ? price > ema20 : false;
        const priceBelowEma = ema20 != null ? price < ema20 : false;

        const hist = macd ? macd.hist : null;
        const histPrev = macd ? macd.histPrev : null;
        const macdLine = macd ? macd.macd : null;
        const signalLine = macd ? macd.signal : null;

        const macdFlipUp = hist != null && histPrev != null && histPrev < 0 && hist > 0;
        const macdFlipDown = hist != null && histPrev != null && histPrev > 0 && hist < 0;

        const macdUpStrong =
          macdLine != null && signalLine != null && macdLine > signalLine &&
          hist != null && histPrev != null && hist > histPrev && hist > 0;

        const macdDownStrong =
          macdLine != null && signalLine != null && macdLine < signalLine &&
          hist != null && histPrev != null && hist < histPrev && hist < 0;

        const macdOkLong = macdFlipUp || macdUpStrong;
        const macdOkShort = macdFlipDown || macdDownStrong;

        const bbExpandUp =
          bb && bb.widthPrev > 0 && bb.width > bb.widthPrev * 1.15 &&
          bb.middle > 0 && (bb.width / bb.middle) > 0.02 &&
          price >= bb.middle;

        const bbExpandDown =
          bb && bb.widthPrev > 0 && bb.width > bb.widthPrev * 1.15 &&
          bb.middle > 0 && (bb.width / bb.middle) > 0.02 &&
          price <= bb.middle;

        const rsiBull = rsi14 != null && rsi14 >= 55 && rsi14 <= 68 && rsiUp;
        const rsiBear = rsi14 != null && rsi14 >= 32 && rsi14 <= 45 && rsiDown;

        const volOk = volPulse > 1.3;

        // confirm 分數（不含 6h filter，回測先做單一週期）
        const confirmLongConds = {
          priceAboveEma,
          emaSlopeUp,
          structureBull: structureBias === "bullish",
          rsiBull,
          macdOkLong,
          bbExpandUp,
          volOk,
        };
        const confirmShortConds = {
          priceBelowEma,
          emaSlopeDown,
          structureBear: structureBias === "bearish",
          rsiBear,
          macdOkShort,
          bbExpandDown,
          volOk,
        };

        const longScore = Object.values(confirmLongConds).filter(Boolean).length;
        const shortScore = Object.values(confirmShortConds).filter(Boolean).length;
        const scoreMax = 7;

        const PASS = 6;

        let candidate = null;

        if ((sideFilter === "both" || sideFilter === "long") && longScore >= PASS) {
          candidate = { side: "long", score: longScore };
        }
        if (!candidate && (sideFilter === "both" || sideFilter === "short") && shortScore >= PASS) {
          candidate = { side: "short", score: shortScore };
        }

        if (candidate) {
          const strength = clamp(Math.round((candidate.score / scoreMax) * 5), 1, 5);

          let stop, target, riskPct, rewardPct;
          if (candidate.side === "long") {
            if (strength >= 5) { stop = price * 0.985; target = price * 1.045; riskPct = 1.5; rewardPct = 4.5; }
            else if (strength >= 4) { stop = price * 0.985; target = price * 1.040; riskPct = 1.5; rewardPct = 4.0; }
            else { stop = price * 0.98; target = price * 1.030; riskPct = 2.0; rewardPct = 3.0; }
          } else {
            if (strength >= 5) { stop = price * 1.015; target = price * 0.955; riskPct = 1.5; rewardPct = 4.5; }
            else if (strength >= 4) { stop = price * 1.015; target = price * 0.960; riskPct = 1.5; rewardPct = 4.0; }
            else { stop = price * 1.02; target = price * 0.970; riskPct = 2.0; rewardPct = 3.0; }
          }

          position = {
            side: candidate.side,
            stage: "confirm",
            entryPrice: price,
            stop,
            target,
            openIndex: i,
            openTime: candle.time,
            riskPct,
            rewardPct,
            score: candidate.score,
            strength,
          };
        }
      }
    }

    // 收尾平倉
    const lastIdx = candles.length - 1;
    if (position) {
      const lastCandle = candles[lastIdx];
      const entryPrice = position.entryPrice;
      const exitPrice = lastCandle.close;
      const heldBars = lastIdx - position.openIndex;
      const heldHours = (heldBars * tfMinutes) / 60;

      let pnlPct;
      if (position.side === "long") pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
      else pnlPct = ((entryPrice - exitPrice) / entryPrice) * 100;

      const riskPct = position.riskPct;
      const R = riskPct > 0 ? pnlPct / riskPct : 0;

      equityR += R;
      if (equityR > maxEquityR) maxEquityR = equityR;
      const drawdown = equityR - maxEquityR;
      if (drawdown < maxDrawdownR) maxDrawdownR = drawdown;

      trades.push({
        side: position.side,
        stage: "confirm",
        timeframe,
        entryIndex: position.openIndex,
        exitIndex: lastIdx,
        entryTime: position.openTime,
        exitTime: lastCandle.time,
        entryPrice,
        exitPrice,
        stop: position.stop,
        target: position.target,
        riskPct,
        rewardPct: position.rewardPct,
        pnlPct,
        R,
        heldBars,
        heldHours,
        exitReason: "end",
        scoreAtEntry: position.score,
        strengthAtEntry: position.strength,
      });
    }

    // 統計
    const totalTrades = trades.length;
    const wins = trades.filter((t) => t.pnlPct > 0);
    const losses = trades.filter((t) => t.pnlPct <= 0);

    const sumR = trades.reduce((s, t) => s + t.R, 0);
    const sumWinR = wins.reduce((s, t) => s + t.R, 0);
    const sumLossR = losses.reduce((s, t) => s + t.R, 0);

    const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;
    const avgR = totalTrades > 0 ? sumR / totalTrades : 0;
    const avgWinR = wins.length > 0 ? sumWinR / wins.length : 0;
    const avgLossR = losses.length > 0 ? sumLossR / losses.length : 0;

    const bestR = totalTrades > 0 ? Math.max(...trades.map((t) => t.R)) : 0;
    const worstR = totalTrades > 0 ? Math.min(...trades.map((t) => t.R)) : 0;

    const avgHoldBars =
      totalTrades > 0 ? trades.reduce((s, t) => s + t.heldBars, 0) / totalTrades : 0;

    res.json({
      symbol,
      timeframe,
      candleCount: candles.length,
      backtestRange: { startTime: candles[warmup].time, endTime: candles[lastIdx].time },
      params: { mode, side: sideFilter, bars: limit, maxHoldBars, tfMinutes },
      stats: {
        totalTrades,
        winTrades: wins.length,
        lossTrades: losses.length,
        winRate,
        totalR: sumR,
        avgR,
        avgWinR,
        avgLossR,
        bestR,
        worstR,
        equityR,
        maxDrawdownR,
        avgHoldBars,
      },
      trades,
    });
  } catch (err) {
    console.error("[/api/backtest] error:", err);
    res.status(500).json({
      error: "回測過程發生錯誤",
      detail: err.message || String(err),
    });
  }
});

// ---------- 啟動伺服器 ----------

app.listen(PORT, () => {
  console.log("🚀 server.js 已載入（勝率優先：1h confirm + 6h filter + 回測）");
  console.log(`✅ KuCoin Proxy + Screener 運行中: http://localhost:${PORT}`);
});
