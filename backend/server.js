// server.js
// KuCoin Proxy + Screener (Tier A confirm + Tier B watch)
//
// Endpoints:
//   GET /api/kucoin/candles?symbol=BTC-USDT&type=1hour&limit=200
//   GET /api/kucoin/ticker?symbol=BTC-USDT
//   GET /api/screener
//
// npm i express cors node-fetch@2

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // v2

const app = express();
const PORT = process.env.PORT || 4000;
const KUCOIN_API_BASE = "https://api.kucoin.com/api/v1";

app.use(
  cors({
    origin: "*",
    methods: ["GET", "OPTIONS"],
  })
);

// -----------------------------
// Config
// -----------------------------

const TIMEFRAMES = [
  { key: "1h", kucoinType: "1hour" },
  { key: "6h", kucoinType: "6hour" },
];

const WATCH_MIN_SCORE = 2;    // Tier B
const CONFIRM_MIN_SCORE = 3;  // Tier A

const INDICATOR_REQUIREMENTS = {
  EMA50: 55,
  MACD: 40,
  RSI: 20,
  BB: 25,
  VWAP: 30,
  RANGE_HILO: 22,
  STRUCTURE: 5,
};

function getRequiredMinBars() {
  return Math.max(...Object.values(INDICATOR_REQUIREMENTS));
}

// symbols cache
let _symbolsCache = { at: 0, list: null };
const SYMBOLS_CACHE_MS = 30 * 60 * 1000;

// -----------------------------
// Utils / Indicators
// -----------------------------

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
  if (signalSeries[lastIdx] == null || signalSeries[prevIdx] == null) return null;

  const macd = macdLine[lastIdx];
  const sigLast = signalSeries[lastIdx];
  const hist = macd - sigLast;

  const macdPrev = macdLine[prevIdx];
  const sigPrev = signalSeries[prevIdx];
  const histPrev = macdPrev - sigPrev;

  return { macd, signal: sigLast, hist, histPrev };
}

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

function getPrevRangeHighLow(candles, lookback = 20) {
  if (!candles || candles.length < lookback + 2) return null;
  const slice = candles.slice(-(lookback + 1), -1);
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of slice) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return { hi, lo };
}

// -----------------------------
// KuCoin API wrapper
// -----------------------------

async function fetchKuCoinCandles(symbol, type, limit = 200) {
  const url = `${KUCOIN_API_BASE}/market/candles?type=${type}&symbol=${symbol}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`KuCoin candles HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "200000" || !Array.isArray(json.data)) {
    throw new Error(`KuCoin candles 回傳錯誤: ${json.code} ${json.msg || ""}`);
  }
  return json.data.map(mapKucoinKlineToCandle).reverse();
}

async function fetchKuCoinTicker(symbol) {
  const url = `${KUCOIN_API_BASE}/market/orderbook/level1?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`KuCoin ticker HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "200000" || !json.data || json.data.price === undefined) {
    throw new Error(`KuCoin ticker 回傳錯誤: ${json.code} ${json.msg || ""}`);
  }
  return { symbol: json.data.symbol, price: parseFloat(json.data.price) };
}

async function fetchTopUSDTByVol(limit = 80) {
  const now = Date.now();
  if (_symbolsCache.list && now - _symbolsCache.at < SYMBOLS_CACHE_MS) {
    return _symbolsCache.list;
  }

  const symRes = await fetch(`${KUCOIN_API_BASE}/symbols`);
  const symJson = await symRes.json();
  if (symJson.code !== "200000" || !Array.isArray(symJson.data)) {
    throw new Error(`KuCoin symbols 回傳錯誤: ${symJson.code} ${symJson.msg || ""}`);
  }
  const tradableUSDT = new Set(
    symJson.data
      .filter((s) => s && s.enableTrading && s.quoteCurrency === "USDT")
      .map((s) => s.symbol)
  );

  const tRes = await fetch(`${KUCOIN_API_BASE}/market/allTickers`);
  const tJson = await tRes.json();
  const tickers = tJson?.data?.ticker;
  if (tJson.code !== "200000" || !Array.isArray(tickers)) {
    throw new Error(`KuCoin allTickers 回傳錯誤: ${tJson.code} ${tJson.msg || ""}`);
  }

  const ranked = tickers
    .filter((t) => t && tradableUSDT.has(t.symbol))
    .map((t) => ({ symbol: t.symbol, volValue: parseFloat(t.volValue || "0") }))
    .filter((x) => Number.isFinite(x.volValue) && x.volValue > 0)
    .sort((a, b) => b.volValue - a.volValue)
    .slice(0, limit)
    .map((x) => x.symbol);

  const list = ranked.length
    ? ranked
    : ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "BNB-USDT"];

  _symbolsCache = { at: now, list };
  return list;
}

// -----------------------------
// proxy endpoints
// -----------------------------

app.get("/api/kucoin/candles", async (req, res) => {
  const { symbol, type, limit } = req.query;
  if (!symbol || !type) {
    return res.status(400).json({ code: 400, msg: "缺少 symbol 或 type 參數" });
  }
  try {
    const candles = await fetchKuCoinCandles(symbol, type, Number(limit) || 200);
    res.json(candles);
  } catch (err) {
    console.error("[/api/kucoin/candles] error:", err.message);
    res.status(502).json({ code: 502, msg: "KuCoin K 線數據獲取失敗", detail: err.message });
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
    res.status(502).json({ code: 502, msg: "KuCoin Ticker 獲取失敗", detail: err.message });
  }
});

// -----------------------------
// helpers: parse query filters
// -----------------------------

function parseCsvOrSingle(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(parseCsvOrSingle);
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeEnum(v, allowed, fallback) {
  const s = String(v || "").toLowerCase().trim();
  if (!s) return fallback;
  return allowed.includes(s) ? s : fallback;
}

function matchFilter(str, q) {
  if (!q) return true;
  return String(str || "").toUpperCase().includes(String(q).toUpperCase());
}

// -----------------------------
// /api/screener
// -----------------------------

app.get("/api/screener", async (req, res) => {
  const started = Date.now();

  const errors = [];
  const signals = [];

  const top = Math.max(1, Math.min(200, Number(req.query.top) || 80));
  const candlesLimit = Math.max(50, Math.min(1500, Number(req.query.limit) || 500));
  const minBars = Math.max(30, Math.min(500, Number(req.query.minBars) || getRequiredMinBars()));
  const includeErrors = String(req.query.includeErrors ?? "1") !== "0";
  const maxSignals = Math.max(10, Math.min(2000, Number(req.query.maxSignals) || 200));

  const stageFilter = normalizeEnum(req.query.stage, ["all", "confirm", "watch"], "all");
  const sideFilter = normalizeEnum(req.query.side, ["all", "long", "short"], "all");

  // timeframe: all | 1h | 6h | 1h,6h
  const tfRaw = String(req.query.timeframe || "all").toLowerCase().trim();
  const tfList =
    tfRaw === "all"
      ? TIMEFRAMES.map((t) => t.key)
      : parseCsvOrSingle(tfRaw).filter((x) => ["1h", "6h"].includes(x));

  const symbolQuery = req.query.symbol ? String(req.query.symbol).trim() : "";
  const strictSymbol = req.query.symbolExact ? String(req.query.symbolExact).trim() : "";

  let SYMBOLS = [];
  try {
    SYMBOLS = await fetchTopUSDTByVol(top);
  } catch (e) {
    console.error("[symbols] error:", e.message || String(e));
    errors.push({ symbol: "-", timeframe: "-", source: "SYMBOLS", message: e.message || String(e) });
    SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "BNB-USDT"];
  }

  // symbol filters
  if (strictSymbol) {
    SYMBOLS = SYMBOLS.filter((s) => String(s).toUpperCase() === strictSymbol.toUpperCase());
  } else if (symbolQuery) {
    SYMBOLS = SYMBOLS.filter((s) => matchFilter(s, symbolQuery));
  }

  const tfsToScan = TIMEFRAMES.filter((t) => tfList.includes(t.key));
  if (tfsToScan.length === 0) {
    return res.json({
      mode: `tierA-confirm + tierB-watch`,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      params: { top, limit: candlesLimit, minBars, timeframe: tfRaw, stage: stageFilter, side: sideFilter, symbol: symbolQuery },
      signals: [],
      errors: includeErrors ? [{ symbol: "-", timeframe: "-", source: "PARAMS", message: "timeframe 參數無效" }] : [],
    });
  }

  for (const symbol of SYMBOLS) {
    for (const tf of tfsToScan) {
      try {
        const [candles, ticker] = await Promise.all([
          fetchKuCoinCandles(symbol, tf.kucoinType, candlesLimit),
          fetchKuCoinTicker(symbol),
        ]);

        if (!candles || candles.length < minBars) {
          if (includeErrors) {
            errors.push({
              symbol,
              timeframe: tf.key,
              source: "CANDLES",
              message: `K 線資料不足（need ${minBars}, got ${candles ? candles.length : 0}）`,
            });
          }
          continue;
        }

        const closes = candles.map((c) => c.close);
        const volumes = candles.map((c) => c.volume);
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];

        const price = ticker.price;
        const prevClose = prev.close;

        const ema20 = calculateEMA(closes, 20);
        const ema50 = calculateEMA(closes, 50);
        const rsi14 = calculateRSI(closes, 14);
        const macd = calculateMACD(closes, 12, 26, 9);
        const bb = calculateBBLast(closes, 20, 2);
        const vwap = calculateVWAP(candles, 30);

        const volMa20 = calculateSMA(volumes, 20);
        const volMa5 = calculateSMA(volumes, 5);
        const volCurrent = volumes[volumes.length - 1];

        const volSpike = volMa20 ? volCurrent > volMa20 * 1.5 : false;
        const volPulse = volMa5 && volMa20 ? volMa5 / volMa20 : 1;

        const macdHist = macd ? macd.hist : null;
        const macdHistPrev = macd ? macd.histPrev : null;

        const macdUp =
          macdHist != null && macdHistPrev != null && macdHist > macdHistPrev && macdHist >= 0;
        const macdDown =
          macdHist != null && macdHistPrev != null && macdHist < macdHistPrev && macdHist <= 0;

        const bbExpanding = bb && bb.widthPrev > 0 && bb.width >= bb.widthPrev;

        const priceAboveEma20 = ema20 && price > ema20;
        const priceBelowEma20 = ema20 && price < ema20;

        const trendUpShort = price > prevClose;
        const trendDownShort = price < prevClose;

        const rsiPullbackLong = rsi14 != null && rsi14 >= 45 && rsi14 <= 58;
        const rsiPullbackShort = rsi14 != null && rsi14 <= 55 && rsi14 >= 42;

        const rsiHotLong = rsi14 != null && rsi14 >= 60 && rsi14 <= 72;
        const rsiColdShort = rsi14 != null && rsi14 >= 28 && rsi14 <= 40;

        let vwapDevPct = null;
        if (vwap) vwapDevPct = ((price - vwap) / vwap) * 100;

        const structureBias = detectStructureBias(closes);

        const range = getPrevRangeHighLow(candles, 20);
        const breakoutUp = range ? price >= range.hi : false;
        const breakoutDown = range ? price <= range.lo : false;

        // Tier B (watch)
        const trendLongOk = ema20 && ema50 && ema20 > ema50 && priceAboveEma20;
        const trendShortOk = ema20 && ema50 && ema20 < ema50 && priceBelowEma20;

        const structureLongOk = structureBias !== "bearish";
        const structureShortOk = structureBias !== "bullish";

        const watchLongMust = trendLongOk && structureLongOk;
        const watchShortMust = trendShortOk && structureShortOk;

        const watchLongScoreItems = {
          breakoutUp,
          macdUp,
          rsiHotLong,
          bbExpanding,
          volPulseGood: volPulse > 1.1,
          volSpike,
          trendUpShort,
          vwapOk: vwapDevPct != null && vwapDevPct > -3.0 && vwapDevPct < 6.0,
        };
        const watchLongScore = Object.values(watchLongScoreItems).filter(Boolean).length;

        const watchShortScoreItems = {
          breakoutDown,
          macdDown,
          rsiColdShort,
          bbExpanding,
          volPulseGood: volPulse > 1.1,
          volSpike,
          trendDownShort,
          vwapOk: vwapDevPct != null && vwapDevPct < 3.0 && vwapDevPct > -6.0,
        };
        const watchShortScore = Object.values(watchShortScoreItems).filter(Boolean).length;

        // Tier A (confirm)
        const confirmLongItems = {
          trendLongOk,
          rsiPullbackLong,
          macdUp,
          bbExpandingUp: bbExpanding && bb && price >= bb.middle,
          volPulseOk: volPulse > 1.1,
          vwapOk: vwapDevPct != null && vwapDevPct > -2.0 && vwapDevPct < 5.0,
        };
        const confirmLongScore = Object.values(confirmLongItems).filter(Boolean).length;

        const confirmShortItems = {
          trendShortOk,
          rsiPullbackShort,
          macdDown,
          bbExpandingDown: bbExpanding && bb && price <= bb.middle,
          volPulseOk: volPulse > 1.1,
          vwapOk: vwapDevPct != null && vwapDevPct < 2.0 && vwapDevPct > -5.0,
        };
        const confirmShortScore = Object.values(confirmShortItems).filter(Boolean).length;

        let side = null;
        let stage = null; // confirm | watch
        let score = 0;
        const scoreMax = 8;
        let techSummary = [];

        if (confirmLongScore >= CONFIRM_MIN_SCORE) {
          side = "long";
          stage = "confirm";
          score = confirmLongScore;
          techSummary = [
            `${trendLongOk ? "✅" : "❌"} 趨勢：EMA20>EMA50 + 價格在 EMA20 上`,
            `${rsiPullbackLong ? "✅" : "❌"} RSI 回落（45~58）`,
            `${macdUp ? "✅" : "❌"} MACD 動能轉強/維持正向`,
            `${bbExpanding ? "✅" : "❌"} BB 不縮/擴張`,
            `${volPulse > 1.1 ? "✅" : "❌"} 量能脈衝（5/20）`,
          ];
        } else if (confirmShortScore >= CONFIRM_MIN_SCORE) {
          side = "short";
          stage = "confirm";
          score = confirmShortScore;
          techSummary = [
            `${trendShortOk ? "✅" : "❌"} 趨勢：EMA20<EMA50 + 價格在 EMA20 下`,
            `${rsiPullbackShort ? "✅" : "❌"} RSI 回抽（42~55）`,
            `${macdDown ? "✅" : "❌"} MACD 動能轉弱/維持負向`,
            `${bbExpanding ? "✅" : "❌"} BB 不縮/擴張`,
            `${volPulse > 1.1 ? "✅" : "❌"} 量能脈衝（5/20）`,
          ];
        } else if (watchLongMust && watchLongScore >= WATCH_MIN_SCORE) {
          side = "long";
          stage = "watch";
          score = watchLongScore;
          techSummary = [
            `🟡 Tier B：趨勢成立但位置可能偏追，建議等回踩/再確認`,
            `${breakoutUp ? "✅" : "❌"} 可能突破前高`,
            `${macdUp ? "✅" : "❌"} MACD 偏強`,
            `${rsiHotLong ? "✅" : "❌"} RSI 偏熱（60~72）`,
            `${bbExpanding ? "✅" : "❌"} BB 不縮/擴張`,
            `${volPulse > 1.1 ? "✅" : "❌"} 量能不是死的`,
          ];
        } else if (watchShortMust && watchShortScore >= WATCH_MIN_SCORE) {
          side = "short";
          stage = "watch";
          score = watchShortScore;
          techSummary = [
            `🟡 Tier B：趨勢成立但位置可能偏追，建議等反彈/再確認`,
            `${breakoutDown ? "✅" : "❌"} 可能跌破前低`,
            `${macdDown ? "✅" : "❌"} MACD 偏弱`,
            `${rsiColdShort ? "✅" : "❌"} RSI 偏冷（28~40）`,
            `${bbExpanding ? "✅" : "❌"} BB 不縮/擴張`,
            `${volPulse > 1.1 ? "✅" : "❌"} 量能不是死的`,
          ];
        }

        if (!side || !stage) continue;

        // Apply filters (stage/side)
        if (stageFilter !== "all" && stage !== stageFilter) continue;
        if (sideFilter !== "all" && side !== sideFilter) continue;

        // strength 1~5
        const strength = Math.max(1, Math.min(5, Math.round((score / scoreMax) * 5)));

        const holdHours = 6;
        const signalTime = last.time;
        const exitBy = new Date(new Date(signalTime).getTime() + holdHours * 60 * 60 * 1000).toISOString();

        // risk model (保留你的調性)
        const basePrice = price;
        let stop, target, riskPct, rewardPct;

        if (side === "long") {
          if (stage === "confirm") {
            stop = basePrice * 0.98;
            target = basePrice * 1.05;
            riskPct = 2;
            rewardPct = 5;
          } else {
            stop = basePrice * 0.97;
            target = basePrice * 1.04;
            riskPct = 3;
            rewardPct = 4;
          }
        } else {
          if (stage === "confirm") {
            stop = basePrice * 1.02;
            target = basePrice * 0.95;
            riskPct = 2;
            rewardPct = 5;
          } else {
            stop = basePrice * 1.03;
            target = basePrice * 0.96;
            riskPct = 3;
            rewardPct = 4;
          }
        }

        const rr = rewardPct / riskPct;

        signals.push({
          symbol,
          side,
          stage,
          timeframe: tf.key,
          holdHours,
          exitBy,
          strength,
          score,
          scoreMax,
          lastPrice: basePrice,
          time: last.time,
          entry: basePrice, // 先用 lastPrice 當 entry（前端可自行調整）
          stop,
          target,
          riskPct,
          rewardPct,
          rr,
          vwap,
          vwapDevPct,
          volPulse,
          structureBias,
          techSummary,
        });

        // 快速收斂：如果你有設 maxSignals，達標就不要再掃太久
        if (signals.length >= maxSignals) break;
      } catch (err) {
        if (includeErrors) {
          errors.push({
            symbol,
            timeframe: tf.key,
            source: "COMPUTE",
            message: err.message || String(err),
          });
        }
      }
    }
    if (signals.length >= maxSignals) break;
  }

  // sorting: confirm first, then strength, then score
  signals.sort((a, b) => {
    const aRank = a.stage === "confirm" ? 0 : 1;
    const bRank = b.stage === "confirm" ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    if (b.strength !== a.strength) return b.strength - a.strength;
    if (b.score !== a.score) return b.score - a.score;
    return 0;
  });

  res.json({
    mode: `tierA-confirm + tierB-watch (1h/6h, top${top} USDT by vol)`,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    params: {
      top,
      limit: candlesLimit,
      minBars,
      timeframe: tfRaw,
      stage: stageFilter,
      side: sideFilter,
      symbol: symbolQuery || strictSymbol || "",
      maxSignals,
      includeErrors,
    },
    signals,
    errors: includeErrors ? errors : [],
  });
});

app.listen(PORT, () => {
  console.log("🚀 Screener backend running");
  console.log(`✅ http://localhost:${PORT}`);
});
