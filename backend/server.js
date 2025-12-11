// server.js
// KuCoin Proxy + 提前預判 Screener（30m & 1h 強化版）+ 回測模擬單
//
// 提供：
//   GET /api/kucoin/candles
//   GET /api/kucoin/ticker
//   GET /api/screener   （提前預判 + 確認，多空訊號）
//   GET /api/backtest   （單幣種回測模擬單）
//
// 使用前：
//   npm init -y
//   npm install express cors node-fetch@2

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // v2

const app = express();
const PORT = 4000;
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

// ---------- Screener 設定（主流幣 + 30m & 1h） ----------

const SYMBOLS = [
  "BTC-USDT",
  "ETH-USDT",
  "BNB-USDT",
  "SOL-USDT",
  "XRP-USDT",
  "DOGE-USDT",
  "AVAX-USDT",
  "LINK-USDT",
];

const TIMEFRAMES = [
  { key: "30m", kucoinType: "30min" },
  { key: "1h", kucoinType: "1hour" },
];

// ---------- /api/screener：提前預判 + 確認 ----------

app.get("/api/screener", async (req, res) => {
  const started = Date.now();
  const signals = [];
  const errors = [];

  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      try {
        const [candles, ticker] = await Promise.all([
          fetchKuCoinCandles(symbol, tf.kucoinType, 160),
          fetchKuCoinTicker(symbol),
        ]);

        if (!candles || candles.length < 80) {
          errors.push({
            symbol,
            timeframe: tf.key,
            source: "CANDLES",
            message: "K 線資料不足",
          });
          continue;
        }

        const closes = candles.map((c) => c.close);
        const volumes = candles.map((c) => c.volume);
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];

        const price = ticker.price;
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
          macdHist != null &&
          macdHistPrev != null &&
          macdHist > macdHistPrev &&
          macdHist >= 0;
        const macdDown =
          macdHist != null &&
          macdHistPrev != null &&
          macdHist < macdHistPrev &&
          macdHist <= 0;

        const bbExpandingUp =
          bb && bb.widthPrev > 0 && bb.width > bb.widthPrev * 1.1 && price >= bb.middle;
        const bbExpandingDown =
          bb && bb.widthPrev > 0 && bb.width > bb.widthPrev * 1.1 && price <= bb.middle;

        const priceAboveEma = ema20 && price > ema20;
        const priceBelowEma = ema20 && price < ema20;

        const trendUpShort = price > prevClose;
        const trendDownShort = price < prevClose;

        const rsiBull =
          rsi14 != null && rsi14 > 40 && rsi14 < 70;
        const rsiBear =
          rsi14 != null && rsi14 > 30 && rsi14 < 60;

        let vwapDevPct = null;
        if (vwap) {
          vwapDevPct = ((price - vwap) / vwap) * 100;
        }

        const structureBias = detectStructureBias(closes);

        // 多頭條件：提前預判 + 確認
        const earlyLongConds = {
          volSpike,
          volPulseStrong: volPulse > 1.5,
          macdUp,
          bbExpandingUp,
          priceAboveEma,
          trendUpShort,
          rsiBull,
          vwapNearOrBelow:
            vwapDevPct != null && vwapDevPct > -1.5 && vwapDevPct < 3.0,
          structureBull: structureBias === "bullish",
        };
        const earlyLongScore = Object.values(earlyLongConds).filter(Boolean).length;

        const confirmLongConds = {
          priceAboveEma,
          rsiBull,
          macdUp,
          bbExpandingUp,
          trendUpShort,
          volPulseGood: volPulse > 1.2,
          vwapHealthy:
            vwapDevPct != null && vwapDevPct > -1.0 && vwapDevPct < 4.5,
        };
        const confirmLongScore = Object.values(confirmLongConds).filter(Boolean).length;

        // 空頭條件：提前預判 + 確認
        const earlyShortConds = {
          volSpike,
          volPulseStrong: volPulse > 1.5,
          macdDown,
          bbExpandingDown,
          priceBelowEma,
          trendDownShort,
          rsiBear,
          vwapNearOrAbove:
            vwapDevPct != null && vwapDevPct < 1.5 && vwapDevPct > -3.0,
          structureBear: structureBias === "bearish",
        };
        const earlyShortScore = Object.values(earlyShortConds).filter(Boolean).length;

        const confirmShortConds = {
          priceBelowEma,
          rsiBear,
          macdDown,
          bbExpandingDown,
          trendDownShort,
          volPulseGood: volPulse > 1.2,
          vwapHealthy:
            vwapDevPct != null && vwapDevPct < 1.0 && vwapDevPct > -4.5,
        };
        const confirmShortScore = Object.values(confirmShortConds).filter(Boolean).length;

        let side = null;
        let stage = null; // "early" | "confirm"
        let score = 0;
        const scoreMax = 9;
        let techSummary = [];

        if (earlyLongScore >= 2 || confirmLongScore >= 3) {
          side = "long";
          if (confirmLongScore >= 3) {
            stage = "confirm";
            score = confirmLongScore;
          } else {
            stage = "early";
            score = earlyLongScore;
          }

          techSummary = [
            `${priceAboveEma ? "✅" : "❌"} 價格在 EMA20 上方`,
            `${rsiBull ? "✅" : "❌"} RSI 處於多頭健康區（約 40~70）`,
            `${macdUp ? "✅" : "❌"} MACD 動能正在往上或剛翻正`,
            `${bbExpandingUp ? "✅" : "❌"} 布林帶往上擴張，波動率放大`,
            `${volSpike ? "✅" : "❌"} 當前成交量顯著高於過去 20 根`,
            `${volPulse > 1.5 ? "✅" : "❌"} 最近 5 根平均量 > 20 根平均量（量能脈衝）`,
            `${
              vwapDevPct != null && vwapDevPct > -1.5 && vwapDevPct < 3.0
                ? "✅"
                : "❌"
            } 價格相對 VWAP 在合理區間（偏多）`,
            `${structureBias === "bullish" ? "✅" : "❌"} 收盤價結構偏多（高點或低點墊高）`,
          ];
        } else if (earlyShortScore >= 2 || confirmShortScore >= 3) {
          side = "short";
          if (confirmShortScore >= 3) {
            stage = "confirm";
            score = confirmShortScore;
          } else {
            stage = "early";
            score = earlyShortScore;
          }

          techSummary = [
            `${priceBelowEma ? "✅" : "❌"} 價格在 EMA20 下方`,
            `${rsiBear ? "✅" : "❌"} RSI 處於偏弱區（約 30~60）`,
            `${macdDown ? "✅" : "❌"} MACD 動能正在往下或剛翻負`,
            `${bbExpandingDown ? "✅" : "❌"} 布林帶往下擴張，波動率放大`,
            `${volSpike ? "✅" : "❌"} 當前成交量顯著高於過去 20 根`,
            `${volPulse > 1.5 ? "✅" : "❌"} 最近 5 根平均量 > 20 根平均量（量能脈衝）`,
            `${
              vwapDevPct != null && vwapDevPct < 1.5 && vwapDevPct > -3.0
                ? "✅"
                : "❌"
            } 價格相對 VWAP 在合理區間（偏空）`,
            `${structureBias === "bearish" ? "✅" : "❌"} 收盤價結構偏空（高點或低點走低）`,
          ];
        }

        if (!side || !stage) {
          continue;
        }

        const strength = Math.max(
          1,
          Math.min(5, Math.round((score / scoreMax) * 5))
        );

        const basePrice = price;
        let entry = basePrice;
        let stop, target;
        let riskPct, rewardPct;

        if (side === "long") {
          if (stage === "early") {
            stop = basePrice * 0.97;
            target = basePrice * 1.04;
            riskPct = 3;
            rewardPct = 4;
          } else {
            stop = basePrice * 0.98;
            target = basePrice * 1.05;
            riskPct = 2;
            rewardPct = 5;
          }
        } else {
          if (stage === "early") {
            stop = basePrice * 1.03;
            target = basePrice * 0.96;
            riskPct = 3;
            rewardPct = 4;
          } else {
            stop = basePrice * 1.02;
            target = basePrice * 0.95;
            riskPct = 2;
            rewardPct = 5;
          }
        }
        const rr = rewardPct / riskPct;

        signals.push({
          symbol,
          side,
          stage, // "early" or "confirm"
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
      } catch (err) {
        console.error(
          "[/api/screener] error:",
          symbol,
          tf.key,
          err.message || String(err)
        );
        errors.push({
          symbol,
          timeframe: tf.key,
          source: "FRONT",
          message: err.message || String(err),
        });
      }
    }
  }

  signals.sort((a, b) => {
    if (a.stage !== b.stage) {
      if (a.stage === "confirm" && b.stage === "early") return -1;
      if (a.stage === "early" && b.stage === "confirm") return 1;
    }
    if (b.strength !== a.strength) return b.strength - a.strength;
    return 0;
  });

  res.json({
    mode: "early-and-confirm-v2",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    signals,
    errors,
  });
});

// ---------- /api/backtest：單幣種回測模擬單 ----------
// 範例：
//   /api/backtest?symbol=BTC-USDT&timeframe=1h&bars=500&mode=both&side=both
//
// 參數：
//   symbol     必填：如 BTC-USDT
//   timeframe  30m / 1h（預設 1h）
//   bars       抓幾根 K（預設 500）
//   mode       early / confirm / both（預設 both，代表兩種訊號都可以開倉）
//   side       long / short / both（預設 both）

app.get("/api/backtest", async (req, res) => {
  const {
    symbol,
    timeframe = "1h",
    bars = "500",
    mode = "both",
    side = "both",
  } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: "缺少 symbol 參數" });
  }

  let kucoinType;
  if (timeframe === "30m") kucoinType = "30min";
  else if (timeframe === "1h") kucoinType = "1hour";
  else {
    return res
      .status(400)
      .json({ error: "timeframe 目前只支援 30m 或 1h" });
  }

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

    const warmup = 80; // 至少 80 根之後才開始回測
    const maxHoldBars = timeframe === "30m" ? 8 : 8; // 可再調整

    let position = null; // 當前持倉
    const trades = [];

    let equityR = 0;
    let maxEquityR = 0;
    let maxDrawdownR = 0;

    const sideFilter = side; // both / long / short
    const modeFilter = mode; // both / early / confirm

    for (let i = warmup; i < candles.length; i++) {
      const candle = candles[i];
      const prevCandle = candles[i - 1];

      // 先檢查是否有持倉需要出場（用當前這根的 high / low / close）
      if (position && i > position.openIndex) {
        const high = candle.high;
        const low = candle.low;
        let exit = null;

        if (position.side === "long") {
          const hitTP = high >= position.target;
          const hitSL = low <= position.stop;

          if (hitTP && hitSL) {
            exit = {
              price: position.stop,
              reason: "sl-tp-same-bar",
            };
          } else if (hitTP) {
            exit = { price: position.target, reason: "tp" };
          } else if (hitSL) {
            exit = { price: position.stop, reason: "sl" };
          } else {
            const heldBars = i - position.openIndex;
            if (heldBars >= maxHoldBars) {
              exit = { price: candle.close, reason: "time" };
            }
          }
        } else if (position.side === "short") {
          const hitTP = low <= position.target;
          const hitSL = high >= position.stop;

          if (hitTP && hitSL) {
            exit = {
              price: position.stop,
              reason: "sl-tp-same-bar",
            };
          } else if (hitTP) {
            exit = { price: position.target, reason: "tp" };
          } else if (hitSL) {
            exit = { price: position.stop, reason: "sl" };
          } else {
            const heldBars = i - position.openIndex;
            if (heldBars >= maxHoldBars) {
              exit = { price: candle.close, reason: "time" };
            }
          }
        }

        if (exit) {
          const entryPrice = position.entryPrice;
          const exitPrice = exit.price;
          const heldBars = i - position.openIndex;
          const tfMinutes = timeframe === "30m" ? 30 : 60;
          const heldHours = (heldBars * tfMinutes) / 60;

          let pnlPct;
          if (position.side === "long") {
            pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
          } else {
            pnlPct = ((entryPrice - exitPrice) / entryPrice) * 100;
          }

          const riskPct = position.riskPct;
          const R = riskPct > 0 ? pnlPct / riskPct : 0;

          equityR += R;
          if (equityR > maxEquityR) {
            maxEquityR = equityR;
          }
          const drawdown = equityR - maxEquityR;
          if (drawdown < maxDrawdownR) {
            maxDrawdownR = drawdown;
          }

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

      // 若目前沒持倉，再用這一根的收盤價判斷「是否要開倉」
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

        const volSpike = volMa20 ? volCurrent > volMa20 * 2.0 : false;
        const volPulse = volMa5 && volMa20 ? volMa5 / volMa20 : 1;

        const macdHist = macd ? macd.hist : null;
        const macdHistPrev = macd ? macd.histPrev : null;

        const macdUp =
          macdHist != null &&
          macdHistPrev != null &&
          macdHist > macdHistPrev &&
          macdHist >= 0;
        const macdDown =
          macdHist != null &&
          macdHistPrev != null &&
          macdHist < macdHistPrev &&
          macdHist <= 0;

        const bbExpandingUp =
          bb &&
          bb.widthPrev > 0 &&
          bb.width > bb.widthPrev * 1.1 &&
          price >= bb.middle;
        const bbExpandingDown =
          bb &&
          bb.widthPrev > 0 &&
          bb.width > bb.widthPrev * 1.1 &&
          price <= bb.middle;

        const priceAboveEma = ema20 && price > ema20;
        const priceBelowEma = ema20 && price < ema20;

        const trendUpShort = price > prevClose;
        const trendDownShort = price < prevClose;

        const rsiBull =
          rsi14 != null && rsi14 > 40 && rsi14 < 70;
        const rsiBear =
          rsi14 != null && rsi14 > 30 && rsi14 < 60;

        let vwapDevPct = null;
        if (vwap) {
          vwapDevPct = ((price - vwap) / vwap) * 100;
        }

        const structureBias = detectStructureBias(closes);

        // 和 /api/screener 相同條件：多頭 early / confirm
        const earlyLongConds = {
          volSpike,
          volPulseStrong: volPulse > 1.5,
          macdUp,
          bbExpandingUp,
          priceAboveEma,
          trendUpShort,
          rsiBull,
          vwapNearOrBelow:
            vwapDevPct != null && vwapDevPct > -1.5 && vwapDevPct < 3.0,
          structureBull: structureBias === "bullish",
        };
        const earlyLongScore = Object.values(earlyLongConds).filter(Boolean).length;

        const confirmLongConds = {
          priceAboveEma,
          rsiBull,
          macdUp,
          bbExpandingUp,
          trendUpShort,
          volPulseGood: volPulse > 1.2,
          vwapHealthy:
            vwapDevPct != null && vwapDevPct > -1.0 && vwapDevPct < 4.5,
        };
        const confirmLongScore = Object.values(confirmLongConds).filter(Boolean).length;

        // 空頭條件：early / confirm
        const earlyShortConds = {
          volSpike,
          volPulseStrong: volPulse > 1.5,
          macdDown,
          bbExpandingDown,
          priceBelowEma,
          trendDownShort,
          rsiBear,
          vwapNearOrAbove:
            vwapDevPct != null && vwapDevPct < 1.5 && vwapDevPct > -3.0,
          structureBear: structureBias === "bearish",
        };
        const earlyShortScore = Object.values(earlyShortConds).filter(Boolean).length;

        const confirmShortConds = {
          priceBelowEma,
          rsiBear,
          macdDown,
          bbExpandingDown,
          trendDownShort,
          volPulseGood: volPulse > 1.2,
          vwapHealthy:
            vwapDevPct != null && vwapDevPct < 1.0 && vwapDevPct > -4.5,
        };
        const confirmShortScore = Object.values(confirmShortConds).filter(Boolean).length;

        const scoreMax = 9;

        // 選擇要開的倉位訊號（根據 side / mode 過濾）
        let candidate = null;

        // 多頭
        if (
          (sideFilter === "both" || sideFilter === "long") &&
          (earlyLongScore >= 2 || confirmLongScore >= 3)
        ) {
          let stage = null;
          let score = 0;
          if (
            confirmLongScore >= 3 &&
            (modeFilter === "both" || modeFilter === "confirm")
          ) {
            stage = "confirm";
            score = confirmLongScore;
          } else if (
            earlyLongScore >= 2 &&
            (modeFilter === "both" || modeFilter === "early")
          ) {
            stage = "early";
            score = earlyLongScore;
          }

          if (stage) {
            candidate = {
              side: "long",
              stage,
              score,
            };
          }
        }

        // 空頭（如果目前沒有候選，才考慮空頭，以避免同一根同時多空）
        if (
          !candidate &&
          (sideFilter === "both" || sideFilter === "short") &&
          (earlyShortScore >= 2 || confirmShortScore >= 3)
        ) {
          let stage = null;
          let score = 0;
          if (
            confirmShortScore >= 3 &&
            (modeFilter === "both" || modeFilter === "confirm")
          ) {
            stage = "confirm";
            score = confirmShortScore;
          } else if (
            earlyShortScore >= 2 &&
            (modeFilter === "both" || modeFilter === "early")
          ) {
            stage = "early";
            score = earlyShortScore;
          }

          if (stage) {
            candidate = {
              side: "short",
              stage,
              score,
            };
          }
        }

        if (candidate) {
          const entryPrice = price; // 以當根收盤價作為進場價
          let stop, target;
          let riskPct, rewardPct;

          if (candidate.side === "long") {
            if (candidate.stage === "early") {
              stop = entryPrice * 0.97;
              target = entryPrice * 1.04;
              riskPct = 3;
              rewardPct = 4;
            } else {
              stop = entryPrice * 0.98;
              target = entryPrice * 1.05;
              riskPct = 2;
              rewardPct = 5;
            }
          } else {
            if (candidate.stage === "early") {
              stop = entryPrice * 1.03;
              target = entryPrice * 0.96;
              riskPct = 3;
              rewardPct = 4;
            } else {
              stop = entryPrice * 1.02;
              target = entryPrice * 0.95;
              riskPct = 2;
              rewardPct = 5;
            }
          }

          const strength = Math.max(
            1,
            Math.min(5, Math.round((candidate.score / scoreMax) * 5))
          );

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

    // 如果最後還有持倉，強制以最後一根收盤價平倉
    const lastIdx = candles.length - 1;
    if (position) {
      const lastCandle = candles[lastIdx];
      const entryPrice = position.entryPrice;
      const exitPrice = lastCandle.close;
      const heldBars = lastIdx - position.openIndex;
      const tfMinutes = timeframe === "30m" ? 30 : 60;
      const heldHours = (heldBars * tfMinutes) / 60;

      let pnlPct;
      if (position.side === "long") {
        pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
      } else {
        pnlPct = ((entryPrice - exitPrice) / entryPrice) * 100;
      }

      const riskPct = position.riskPct;
      const R = riskPct > 0 ? pnlPct / riskPct : 0;

      equityR += R;
      if (equityR > maxEquityR) {
        maxEquityR = equityR;
      }
      const drawdown = equityR - maxEquityR;
      if (drawdown < maxDrawdownR) {
        maxDrawdownR = drawdown;
      }

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

    // 統計結果
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

    const bestR =
      totalTrades > 0 ? Math.max(...trades.map((t) => t.R)) : 0;
    const worstR =
      totalTrades > 0 ? Math.min(...trades.map((t) => t.R)) : 0;

    const avgHoldBars =
      totalTrades > 0
        ? trades.reduce((s, t) => s + t.heldBars, 0) / totalTrades
        : 0;

    const result = {
      symbol,
      timeframe,
      candleCount: candles.length,
      backtestRange: {
        startTime: candles[warmup].time,
        endTime: candles[lastIdx].time,
      },
      params: {
        mode: modeFilter,
        side: sideFilter,
        bars: limit,
        maxHoldBars,
      },
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
      // trades 可能很多，先全部回傳，之後如果太大再加限制
      trades,
    };

    res.json(result);
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
  console.log("🚀 server.js 已載入（提前預判強化版 + 回測模擬單）");
  console.log(`✅ KuCoin Proxy + Screener 運行中: http://localhost:${PORT}`);
});
