// server.js
// KuCoin Proxy + Screener（勝率優先：confirm only、最多 5 條）+ Backtest
//
// 提供：
//   GET /api/kucoin/candles
//   GET /api/kucoin/ticker
//   GET /api/screener
//   GET /api/backtest
//
// 依賴：
//   npm install express cors node-fetch@2

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // v2

const app = express();

// ✅ Render 一定要用 process.env.PORT
const PORT = process.env.PORT || 4000;

const KUCOIN_API_BASE = "https://api.kucoin.com/api/v1";

// ===== 勝率優先參數（你可以之後再微調）=====
const TOP_N_USDT_SYMBOLS = 80; // 最近一段時間交易量常駐市場前 80（用 allTickers 的 volValue 排）
const TIMEFRAMES = [
  { key: "1h", kucoinType: "1hour" },
  // 如果你之後要加 30m 也可以開回來（但請求會變多）
  // { key: "30m", kucoinType: "30min" },
];

// ✅ confirm 訊號門檻（避免 50/50）
const PASS_SCORE = 6; // 建議 6~7（越高越少訊號、越偏勝率）
const MAX_SIGNALS_RETURN = 5; // 你要一天大約 5 條，就先硬限制回傳最多 5 條

// ===== CORS =====
app.use(
  cors({
    origin: "*",
    methods: ["GET", "OPTIONS"],
  })
);

// ✅ 根路徑健康檢查（你點 Render 主網址不會再 Cannot GET /）
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

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

  return { macd, signal: sigLast, hist, histPrev };
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

  return { middle: mLast, upper, lower, width, widthPrev };
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

// ---------- KuCoin API 封裝 ----------

async function fetchKuCoinCandles(symbol, type, limit = 200) {
  const url = `${KUCOIN_API_BASE}/market/candles?type=${type}&symbol=${symbol}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`KuCoin candles HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "200000" || !Array.isArray(json.data)) {
    throw new Error(`KuCoin 蠟燭 回傳錯誤：${json.code} ${json.msg || ""}`);
  }
  return json.data.map(mapKucoinKlineToCandle).reverse();
}

async function fetchKuCoinTicker(symbol) {
  const url = `${KUCOIN_API_BASE}/market/orderbook/level1?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`KuCoin ticker HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "200000" || !json.data || json.data.price === undefined) {
    throw new Error(`KuCoin 股票代碼 回傳錯誤：${json.code} ${json.msg || ""}`);
  }
  return { symbol: json.data.symbol, price: parseFloat(json.data.price) };
}

// ✅ 抓 USDT 交易量前 N（用 allTickers 的 volValue 近似判斷）
async function fetchTopUsdtSymbolsByVolume(topN = 80) {
  const url = `${KUCOIN_API_BASE}/market/allTickers`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`KuCoin allTickers HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "200000" || !json.data || !Array.isArray(json.data.ticker)) {
    throw new Error(`KuCoin allTickers 回傳錯誤：${json.code} ${json.msg || ""}`);
  }

  // 只取 -USDT，依 volValue（成交額）排序
  const list = json.data.ticker
    .filter((t) => typeof t.symbol === "string" && t.symbol.endsWith("-USDT"))
    .map((t) => ({
      symbol: t.symbol,
      volValue: Number(t.volValue || 0),
      vol: Number(t.vol || 0),
    }))
    .filter((x) => Number.isFinite(x.volValue) && x.volValue > 0);

  list.sort((a, b) => b.volValue - a.volValue);

  return list.slice(0, topN).map((x) => x.symbol);
}

// ✅ Symbol cache（避免每次 /api/screener 都重新抓 allTickers）
let SYMBOLS_CACHE = {
  symbols: [],
  updatedAt: null,
  error: null,
};
const SYMBOLS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小時更新一次

async function getSymbolsList() {
  const now = Date.now();
  const age = SYMBOLS_CACHE.updatedAt ? now - SYMBOLS_CACHE.updatedAt : Infinity;

  if (SYMBOLS_CACHE.symbols.length > 0 && age < SYMBOLS_CACHE_TTL_MS) {
    return SYMBOLS_CACHE.symbols;
  }

  try {
    const symbols = await fetchTopUsdtSymbolsByVolume(TOP_N_USDT_SYMBOLS);
    SYMBOLS_CACHE = {
      symbols,
      updatedAt: now,
      error: null,
    };
    return symbols;
  } catch (err) {
    // fallback：不要讓服務掛
    SYMBOLS_CACHE = {
      symbols: SYMBOLS_CACHE.symbols.length ? SYMBOLS_CACHE.symbols : ["BTC-USDT", "ETH-USDT", "SOL-USDT"],
      updatedAt: now,
      error: err.message || String(err),
    };
    return SYMBOLS_CACHE.symbols;
  }
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
    res.status(502).json({ code: 502, msg: "KuCoin K 線數據獲取失敗", detail: err.message });
  }
});

app.get("/api/kucoin/ticker", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ code: 400, msg: "缺少 symbol 參數" });
  try {
    const t = await fetchKuCoinTicker(symbol);
    res.json(t);
  } catch (err) {
    console.error("[/api/kucoin/ticker] error:", err.message);
    res.status(502).json({ code: 502, msg: "KuCoin Ticker 獲取失敗", detail: err.message });
  }
});

// ---------- /api/screener：勝率優先（confirm only、最多 5 條） ----------

app.get("/api/screener", async (req, res) => {
  const started = Date.now();
  const signals = [];
  const errors = [];

  let symbols = [];
  try {
    symbols = await getSymbolsList();
  } catch (err) {
    symbols = ["BTC-USDT", "ETH-USDT", "SOL-USDT"];
    errors.push({ symbol: "SYMBOLS", timeframe: "-", source: "ALL_TICKERS", message: err.message || String(err) });
  }

  // 為了避免 Render 免費機器被打爆：一輪不要跑太久
  // 你要更快可以把 symbols 再縮小或加快取樣
  for (const symbol of symbols) {
    for (const tf of TIMEFRAMES) {
      try {
        const candles = await fetchKuCoinCandles(symbol, tf.kucoinType, 180);

        if (!candles || candles.length < 120) {
          errors.push({ symbol, timeframe: tf.key, source: "CANDLES", message: "K 線資料不足" });
          continue;
        }

        const closes = candles.map((c) => c.close);
        const volumes = candles.map((c) => c.volume);

        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];

        // ✅ 直接用最後一根 close 當價格（避免額外 ticker call）
        const price = last.close;
        const prevClose = prev.close;

        const ema20 = calculateEMA(closes, 20);
        const rsi14 = calculateRSI(closes, 14);
        const macd = calculateMACD(closes, 12, 26, 9);
        const bb = calculateBBLast(closes, 20, 2);
        const vwap = calculateVWAP(candles, 30);

        const volMa20 = calculateSMA(volumes, 20);
        const volMa5 = calculateSMA(volumes, 5);
        const volCurrent = volumes[volumes.length - 1];

        const volSpike = volMa20 ? volCurrent > volMa20 * 2.0 : false;
        const volPulse = volMa5 && volMa20 ? volMa5 / volMa20 : 1;

        const macdHist = macd ? macd.hist : null;
        const macdHistPrev = macd ? macd.histPrev : null;

        const macdUp =
          macdHist != null && macdHistPrev != null && macdHist > macdHistPrev && macdHist >= 0;
        const macdDown =
          macdHist != null && macdHistPrev != null && macdHist < macdHistPrev && macdHist <= 0;

        const bbExpandingUp =
          bb && bb.widthPrev > 0 && bb.width > bb.widthPrev * 1.15 && price >= bb.middle;
        const bbExpandingDown =
          bb && bb.widthPrev > 0 && bb.width > bb.widthPrev * 1.15 && price <= bb.middle;

        const priceAboveEma = ema20 && price > ema20;
        const priceBelowEma = ema20 && price < ema20;

        const trendUpShort = price > prevClose;
        const trendDownShort = price < prevClose;

        // ✅ 更嚴格 RSI 區間（偏勝率）
        const rsiBull = rsi14 != null && rsi14 >= 45 && rsi14 <= 68;
        const rsiBear = rsi14 != null && rsi14 >= 32 && rsi14 <= 55;

        let vwapDevPct = null;
        if (vwap) vwapDevPct = ((price - vwap) / vwap) * 100;

        const structureBias = detectStructureBias(closes);

        // ===== confirm 條件（更嚴格）=====
        const confirmLongConds = {
          priceAboveEma,
          rsiBull,
          macdUp,
          bbExpandingUp,
          trendUpShort,
          volPulseGood: volPulse > 1.25,
          vwapHealthy: vwapDevPct != null && vwapDevPct > -0.8 && vwapDevPct < 3.8,
          structureBull: structureBias === "bullish",
        };
        const confirmLongScore = Object.values(confirmLongConds).filter(Boolean).length;

        const confirmShortConds = {
          priceBelowEma,
          rsiBear,
          macdDown,
          bbExpandingDown,
          trendDownShort,
          volPulseGood: volPulse > 1.25,
          vwapHealthy: vwapDevPct != null && vwapDevPct < 0.8 && vwapDevPct > -3.8,
          structureBear: structureBias === "bearish",
        };
        const confirmShortScore = Object.values(confirmShortConds).filter(Boolean).length;

        const scoreMax = 8;

        let side = null;
        let stage = "confirm";
        let score = 0;

        if (confirmLongScore >= PASS_SCORE) {
          side = "long";
          score = confirmLongScore;
        } else if (confirmShortScore >= PASS_SCORE) {
          side = "short";
          score = confirmShortScore;
        } else {
          continue; // 不夠嚴格就不出訊號
        }

        const strength = Math.max(1, Math.min(5, Math.round((score / scoreMax) * 5)));

        // ===== 風控（沿用你的原本邏輯但稍微保守）=====
        const basePrice = price;
        const entry = basePrice;
        let stop, target, riskPct, rewardPct;

        if (side === "long") {
          stop = basePrice * 0.985;   // 1.5%
          target = basePrice * 1.035; // 3.5%
          riskPct = 1.5;
          rewardPct = 3.5;
        } else {
          stop = basePrice * 1.015;   // 1.5%
          target = basePrice * 0.965; // 3.5%
          riskPct = 1.5;
          rewardPct = 3.5;
        }

        const rr = rewardPct / riskPct;

        const techSummary = side === "long"
          ? [
              `${priceAboveEma ? "✅" : "❌"} 價格在 EMA20 上方`,
              `${rsiBull ? "✅" : "❌"} RSI 多頭健康區（45~68）`,
              `${macdUp ? "✅" : "❌"} MACD 動能往上且翻正`,
              `${bbExpandingUp ? "✅" : "❌"} 布林帶擴張（偏多）`,
              `${volPulse > 1.25 ? "✅" : "❌"} 量能脈衝（5MA/20MA）`,
              `${vwapDevPct != null && vwapDevPct > -0.8 && vwapDevPct < 3.8 ? "✅" : "❌"} VWAP 偏多區`,
              `${structureBias === "bullish" ? "✅" : "❌"} 結構偏多`,
            ]
          : [
              `${priceBelowEma ? "✅" : "❌"} 價格在 EMA20 下方`,
              `${rsiBear ? "✅" : "❌"} RSI 偏弱區（32~55）`,
              `${macdDown ? "✅" : "❌"} MACD 動能往下且翻負`,
              `${bbExpandingDown ? "✅" : "❌"} 布林帶擴張（偏空）`,
              `${volPulse > 1.25 ? "✅" : "❌"} 量能脈衝（5MA/20MA）`,
              `${vwapDevPct != null && vwapDevPct < 0.8 && vwapDevPct > -3.8 ? "✅" : "❌"} VWAP 偏空區`,
              `${structureBias === "bearish" ? "✅" : "❌"} 結構偏空`,
            ];

        signals.push({
          symbol,
          side,
          stage,
          timeframe: tf.key,
          strength,
          score,
          scoreMax,
          lastPrice: basePrice,
          time: last.time,
          entry,
          stop,
          target,
          riskPct,
          rewardPct,
          rr,
          vwap,
          vwapDevPct,
          volMa20,
          volMa5,
          volCurrent,
          volPulse,
          structureBias,
          techSummary,
        });

        // ✅ 收到夠了就不用繼續打 API（保護 Render）
        if (signals.length >= MAX_SIGNALS_RETURN) break;
      } catch (err) {
        console.error("[/api/screener] 錯誤：", symbol, err.message || String(err));
        errors.push({ symbol, timeframe: tf.key, source: "SCREENER", message: err.message || String(err) });
      }
    }

    if (signals.length >= MAX_SIGNALS_RETURN) break;
  }

  // confirm only 其實不用再 sort，但保留強度排序
  signals.sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    if (b.score !== a.score) return b.score - a.score;
    return 0;
  });

  res.json({
    mode: `confirm-only_top${TOP_N_USDT_SYMBOLS}_pass${PASS_SCORE}_max${MAX_SIGNALS_RETURN}`,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    symbolsMeta: {
      topN: TOP_N_USDT_SYMBOLS,
      cacheUpdatedAt: SYMBOLS_CACHE.updatedAt ? new Date(SYMBOLS_CACHE.updatedAt).toISOString() : null,
      cacheError: SYMBOLS_CACHE.error || null,
      timeframes: TIMEFRAMES.map((t) => t.key),
    },
    signals,
    errors,
  });
});

// ---------- /api/backtest：單幣種回測模擬單（保留你原本結構） ----------
// 範例：
//   /api/backtest?symbol=BTC-USDT&timeframe=1h&bars=500&mode=confirm&side=both
//
// 參數：
//   symbol     必填：如 BTC-USDT
//   timeframe  1h（如需 30m 自己再加回 TIMEFRAMES）
//   bars       抓幾根 K（預設 500）
//   mode       confirm（這版以 confirm 為主）
//   side       long / short / both（預設 both）

app.get("/api/backtest", async (req, res) => {
  const {
    symbol,
    timeframe = "1h",
    bars = "500",
    mode = "confirm",
    side = "both",
  } = req.query;

  if (!symbol) return res.status(400).json({ error: "缺少 symbol 參數" });

  let kucoinType;
  if (timeframe === "1h") kucoinType = "1hour";
  else if (timeframe === "30m") kucoinType = "30min";
  else return res.status(400).json({ error: "timeframe 目前只支援 30m 或 1h" });

  const limit = parseInt(bars, 10) || 500;

  try {
    const candles = await fetchKuCoinCandles(symbol, kucoinType, limit);
    if (!candles || candles.length < 120) {
      return res.status(400).json({
        error: "K 線資料不足，無法回測",
        candleCount: candles ? candles.length : 0,
      });
    }

    const closesAll = candles.map((c) => c.close);
    const volumesAll = candles.map((c) => c.volume);

    const warmup = 80;
    const maxHoldBars = timeframe === "30m" ? 8 : 8;

    let position = null;
    const trades = [];

    let equityR = 0;
    let maxEquityR = 0;
    let maxDrawdownR = 0;

    const sideFilter = side;
    const modeFilter = mode;

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
          const tfMinutes = timeframe === "30m" ? 30 : 60;
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
            stage: position.stage,
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

      // 再進場
      if (!position) {
        const closes = closesAll.slice(0, i + 1);
        const volumes = volumesAll.slice(0, i + 1);
        const price = candle.close;
        const prevClose = prevCandle.close;

        const ema20 = calculateEMA(closes, 20);
        const rsi14 = calculateRSI(closes, 14);
        const macd = calculateMACD(closes, 12, 26, 9);
        const bb = calculateBBLast(closes, 20, 2);
        const vwap = calculateVWAP(candles.slice(0, i + 1), 30);

        const volMa20 = calculateSMA(volumes, 20);
        const volMa5 = calculateSMA(volumes, 5);
        const volCurrent = volumes[volumes.length - 1];

        const volPulse = volMa5 && volMa20 ? volMa5 / volMa20 : 1;

        const macdHist = macd ? macd.hist : null;
        const macdHistPrev = macd ? macd.histPrev : null;

        const macdUp =
          macdHist != null && macdHistPrev != null && macdHist > macdHistPrev && macdHist >= 0;
        const macdDown =
          macdHist != null && macdHistPrev != null && macdHist < macdHistPrev && macdHist <= 0;

        const bbExpandingUp =
          bb && bb.widthPrev > 0 && bb.width > bb.widthPrev * 1.15 && price >= bb.middle;
        const bbExpandingDown =
          bb && bb.widthPrev > 0 && bb.width > bb.widthPrev * 1.15 && price <= bb.middle;

        const priceAboveEma = ema20 && price > ema20;
        const priceBelowEma = ema20 && price < ema20;

        const trendUpShort = price > prevClose;
        const trendDownShort = price < prevClose;

        const rsiBull = rsi14 != null && rsi14 >= 45 && rsi14 <= 68;
        const rsiBear = rsi14 != null && rsi14 >= 32 && rsi14 <= 55;

        let vwapDevPct = null;
        if (vwap) vwapDevPct = ((price - vwap) / vwap) * 100;

        const structureBias = detectStructureBias(closes);

        const confirmLongConds = {
          priceAboveEma,
          rsiBull,
          macdUp,
          bbExpandingUp,
          trendUpShort,
          volPulseGood: volPulse > 1.25,
          vwapHealthy: vwapDevPct != null && vwapDevPct > -0.8 && vwapDevPct < 3.8,
          structureBull: structureBias === "bullish",
        };
        const confirmLongScore = Object.values(confirmLongConds).filter(Boolean).length;

        const confirmShortConds = {
          priceBelowEma,
          rsiBear,
          macdDown,
          bbExpandingDown,
          trendDownShort,
          volPulseGood: volPulse > 1.25,
          vwapHealthy: vwapDevPct != null && vwapDevPct < 0.8 && vwapDevPct > -3.8,
          structureBear: structureBias === "bearish",
        };
        const confirmShortScore = Object.values(confirmShortConds).filter(Boolean).length;

        const scoreMax = 8;

        let candidate = null;

        if ((sideFilter === "both" || sideFilter === "long") && confirmLongScore >= PASS_SCORE) {
          if (modeFilter === "confirm" || modeFilter === "both") {
            candidate = { side: "long", stage: "confirm", score: confirmLongScore };
          }
        }

        if (!candidate && (sideFilter === "both" || sideFilter === "short") && confirmShortScore >= PASS_SCORE) {
          if (modeFilter === "confirm" || modeFilter === "both") {
            candidate = { side: "short", stage: "confirm", score: confirmShortScore };
          }
        }

        if (candidate) {
          const entryPrice = price;
          let stop, target, riskPct, rewardPct;

          if (candidate.side === "long") {
            stop = entryPrice * 0.985;
            target = entryPrice * 1.035;
            riskPct = 1.5;
            rewardPct = 3.5;
          } else {
            stop = entryPrice * 1.015;
            target = entryPrice * 0.965;
            riskPct = 1.5;
            rewardPct = 3.5;
          }

          const strength = Math.max(1, Math.min(5, Math.round((candidate.score / scoreMax) * 5)));

          position = {
            side: candidate.side,
            stage: candidate.stage,
            entryPrice,
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

    // 最後強制平倉
    const lastIdx = candles.length - 1;
    if (position) {
      const lastCandle = candles[lastIdx];
      const entryPrice = position.entryPrice;
      const exitPrice = lastCandle.close;
      const heldBars = lastIdx - position.openIndex;
      const tfMinutes = timeframe === "30m" ? 30 : 60;
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
        stage: position.stage,
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
      params: { mode: modeFilter, side: sideFilter, bars: limit, maxHoldBars, passScore: PASS_SCORE },
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
    res.status(500).json({ error: "回測過程發生錯誤", detail: err.message || String(err) });
  }
});

// ---------- 啟動 ----------
app.listen(PORT, () => {
  console.log("🚀 server.js 已載入（勝率優先：confirm-only + top80 + max5）");
  console.log(`✅ KuCoin Proxy + Screener 運行中: http://localhost:${PORT}`);
});
