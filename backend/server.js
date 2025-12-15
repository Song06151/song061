// server.js
// KuCoin Screener（放寬版：1h / 6h，一天 30+ 訊號）
// 僅調整「條件嚴格度」，其他架構完全不動

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 4000;
const KUCOIN_API_BASE = "https://api.kucoin.com/api/v1";

app.use(cors({ origin: "*", methods: ["GET"] }));

// ---------- 工具 ----------

const mapKucoinKlineToCandle = (k) => ({
  time: new Date(parseInt(k[0], 10) * 1000).toISOString(),
  open: +k[1],
  high: +k[2],
  low: +k[3],
  close: +k[4],
  volume: +k[5],
});

function SMA(arr, p) {
  if (arr.length < p) return null;
  return arr.slice(-p).reduce((a, b) => a + b, 0) / p;
}

function EMA(arr, p) {
  const k = 2 / (p + 1);
  let ema = arr[0];
  for (let i = 1; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}

function RSI(arr, p = 14) {
  if (arr.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = arr.length - p; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  if (l === 0) return 100;
  const rs = g / p / (l / p);
  return 100 - 100 / (1 + rs);
}

function MACD(arr) {
  if (arr.length < 35) return null;
  const fast = EMA(arr, 12);
  const slow = EMA(arr, 26);
  return fast - slow;
}

function BB(arr, p = 20) {
  if (arr.length < p + 1) return null;
  const last = arr.slice(-p);
  const prev = arr.slice(-p - 1, -1);
  const m = SMA(last, p);
  const s = Math.sqrt(last.reduce((a, v) => a + (v - m) ** 2, 0) / p);
  const w = s * 4;
  const mp = SMA(prev, p);
  const sp = Math.sqrt(prev.reduce((a, v) => a + (v - mp) ** 2, 0) / p);
  const wp = sp * 4;
  return { width: w, widthPrev: wp, middle: m };
}

// ---------- KuCoin ----------

async function candles(symbol, type) {
  const r = await fetch(`${KUCOIN_API_BASE}/market/candles?symbol=${symbol}&type=${type}&limit=200`);
  const j = await r.json();
  if (j.code !== "200000") throw new Error("KuCoin candles error");
  return j.data.map(mapKucoinKlineToCandle).reverse();
}

async function ticker(symbol) {
  const r = await fetch(`${KUCOIN_API_BASE}/market/orderbook/level1?symbol=${symbol}`);
  const j = await r.json();
  if (j.code !== "200000") throw new Error("KuCoin ticker error");
  return +j.data.price;
}

// ---------- 設定 ----------

const SYMBOLS = [
  "BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","XRP-USDT",
  "DOGE-USDT","AVAX-USDT","LINK-USDT","ADA-USDT","OP-USDT",
  "ARB-USDT","SUI-USDT","INJ-USDT","SEI-USDT","LTC-USDT"
];

const TIMEFRAMES = [
  { key: "1h", kucoinType: "1hour" },
  { key: "6h", kucoinType: "6hour" },
];

// ---------- Screener ----------

app.get("/api/screener", async (_, res) => {
  const signals = [];

  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      try {
        const [c, price] = await Promise.all([
          candles(symbol, tf.kucoinType),
          ticker(symbol),
        ]);

        const closes = c.map(x => x.close);
        const vols = c.map(x => x.volume);

        const ema20 = EMA(closes, 20);
        const rsi = RSI(closes);
        const macd = MACD(closes);
        const bb = BB(closes);
        const volMa20 = SMA(vols, 20);
        const volPulse = SMA(vols, 5) / volMa20;

        const priceAboveEma = price > ema20;
        const priceBelowEma = price < ema20;

        const bbExpand = bb && bb.width >= bb.widthPrev;
        const volSpike = vols.at(-1) > volMa20 * 1.5;

        let score = 0;
        if (bbExpand) score++;
        if (volPulse > 1.2) score++;
        if (volSpike) score++;
        if (rsi > 45 && rsi < 70) score++;
        if (rsi < 55 && rsi > 30) score++;
        if (macd > 0) score++;

        if (priceAboveEma && score >= 2) {
          signals.push({
            symbol,
            side: "long",
            stage: "confirm",
            timeframe: tf.key,
            score,
            lastPrice: price,
          });
        }

        if (priceBelowEma && score >= 2) {
          signals.push({
            symbol,
            side: "short",
            stage: "confirm",
            timeframe: tf.key,
            score,
            lastPrice: price,
          });
        }

      } catch {}
    }
  }

  res.json({
    mode: "relaxed-30plus",
    generatedAt: new Date().toISOString(),
    signals,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Screener running on ${PORT}`);
});
