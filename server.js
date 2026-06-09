require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { TOTP } = require('otpauth');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  CONFIG — Values come from .env file
// ============================================================
const CONFIG = {
  apiKey: process.env.ANGEL_API_KEY,
  clientId: process.env.ANGEL_CLIENT_ID,
  password: process.env.ANGEL_PASSWORD,
  totpSecret: process.env.ANGEL_TOTP_SECRET,
};

const ANGEL_BASE = 'https://apiconnect.angelbroking.com';

// ============================================================
//  SESSION — JWT token store (in-memory)
// ============================================================
let SESSION = {
  jwtToken: null,
  refreshToken: null,
  loginTime: null,
};

let MASTER = [];

async function loadMaster() {
  const res = await axios.get(
    'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json'
  );

  MASTER = res.data;

  console.log('Master Loaded:', MASTER.length);
}

// ============================================================
//  TOTP AUTO-GENERATE
// ============================================================
function generateTOTP() {
  const totp = new TOTP({
    secret: CONFIG.totpSecret,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  return totp.generate();
}

// ============================================================
//  ANGEL ONE LOGIN
// ============================================================
async function angelLogin() {
  try {
    const totp = generateTOTP();
    const res = await axios.post(
      `${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`,
      {
        clientcode: CONFIG.clientId,
        password: CONFIG.password,
        totp: totp,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '106.193.147.98',
          'X-MACAddress': '00-00-00-00-00-00',
          'X-PrivateKey': CONFIG.apiKey,
        },
      }
    );

    if (res.data.status && res.data.data) {
      SESSION.jwtToken = res.data.data.jwtToken;
      SESSION.refreshToken = res.data.data.refreshToken;
      SESSION.loginTime = Date.now();
      console.log(`[${new Date().toISOString()}] Angel One login successful`);
      return true;
    } else {
      console.error('Login failed:', res.data.message);
      return false;
    }
  } catch (err) {
    console.error('Login error:', err.message);
    return false;
  }
}

// ============================================================
//  TOKEN REFRESH — Every 6 hours
// ============================================================
async function refreshToken() {
  try {
    const res = await axios.post(
      `${ANGEL_BASE}/rest/auth/angelbroking/jwt/v1/generateTokens`,
      { refreshToken: SESSION.refreshToken },
      { headers: getHeaders() }
    );
    if (res.data.status && res.data.data) {
      SESSION.jwtToken = res.data.data.jwtToken;
      SESSION.refreshToken = res.data.data.refreshToken;
      console.log(`[${new Date().toISOString()}] Token refreshed`);
    }
  } catch (err) {
    // If refresh fails — re-login
    await angelLogin();
  }
}

// Auto refresh every 6 hours
setInterval(refreshToken, 6 * 60 * 60 * 1000);

// ============================================================
//  HEADERS HELPER
// ============================================================
function getHeaders() {
  return {
    'Authorization': `Bearer ${SESSION.jwtToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '106.193.147.98',
    'X-MACAddress': '00-00-00-00-00-00',
    'X-PrivateKey': CONFIG.apiKey,
  };
}

// ============================================================
//  ENSURE LOGGED IN
// ============================================================
async function ensureLoggedIn() {
  if (!SESSION.jwtToken) {
    await angelLogin();
  }
}

// ============================================================
//  FETCH NIFTY SPOT PRICE
//  Token 26000 = NIFTY 50
// ============================================================
async function fetchNiftySpot() {
  await ensureLoggedIn();
  const res = await axios.post(
    `${ANGEL_BASE}/rest/secure/angelbroking/market/v1/quote/`,
    {
      mode: 'LTP',
      exchangeTokens: { NSE: ['26000'] },
    },
    { headers: getHeaders() }
  );
  const ltp = res.data.data.fetched[0].ltp;
  return parseFloat(ltp);
}

// ============================================================
//  FIND OPTION FROM MASTER
// ============================================================
function findOption(strike, type) {
  const items = MASTER.filter(
    x =>
      x.name === 'NIFTY' &&
      x.instrumenttype === 'OPTIDX' &&
      x.symbol.endsWith(type)
  );

  const expiries = [
    ...new Set(items.map(x => x.expiry))
  ].sort((a, b) => new Date(a) - new Date(b));

  const nearestExpiry = expiries[0];

  return items.find(
    x =>
      x.expiry === nearestExpiry &&
      Number(x.strike) / 100 === strike &&
      x.symbol.endsWith(type)
  );
}

function computeStrengthScores(options) {
  const maxVolume = Math.max(...options.map(o => o.volume || 0), 1);
  const maxOi = Math.max(...options.map(o => o.oi || 0), 1);

  return options.map(opt => {
    const ratio = opt.askQty > 0 ? opt.bidQty / opt.askQty : opt.bidQty;
    const ratioScore = Math.min(ratio, 5) / 5;
    const volumeScore = Math.min(opt.volume / maxVolume, 1);
    const oiScore = Math.min(opt.oi / maxOi, 1);
    const strengthScore = ratioScore * 0.45 + volumeScore * 0.35 + oiScore * 0.2;

    return {
      ...opt,
      strengthScore: parseFloat(strengthScore.toFixed(3)),
      ratioScore: parseFloat(ratioScore.toFixed(3)),
      volumeScore: parseFloat(volumeScore.toFixed(3)),
      oiScore: parseFloat(oiScore.toFixed(3)),
    };
  });
}

function computeSideMetrics(totals) {
  const { bidQty, askQty, volume, oi } = totals;
  const ratio = askQty > 0 ? bidQty / askQty : bidQty;
  return {
    bidQty,
    askQty,
    volume,
    oi,
    ratio: parseFloat(ratio.toFixed(3)),
    sellerPressure: askQty > bidQty,
    buyerPressure: bidQty > askQty,
  };
}

function aggregateTotals(options) {
  const sideTotals = { CE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 }, PE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 } };
  const tierTotals = { atm: { CE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 }, PE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 } }, itm1: { CE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 }, PE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 } } };

  options.forEach(opt => {
    if (!sideTotals[opt.type]) return;
    sideTotals[opt.type].bidQty += opt.bidQty;
    sideTotals[opt.type].askQty += opt.askQty;
    sideTotals[opt.type].volume += opt.volume;
    sideTotals[opt.type].oi += opt.oi;
    if (tierTotals[opt.tier] && tierTotals[opt.tier][opt.type]) {
      tierTotals[opt.tier][opt.type].bidQty += opt.bidQty;
      tierTotals[opt.tier][opt.type].askQty += opt.askQty;
      tierTotals[opt.tier][opt.type].volume += opt.volume;
      tierTotals[opt.tier][opt.type].oi += opt.oi;
    }
  });

  return {
    side: {
      CE: computeSideMetrics(sideTotals.CE),
      PE: computeSideMetrics(sideTotals.PE),
    },
    tier: {
      atm: {
        CE: computeSideMetrics(tierTotals.atm.CE),
        PE: computeSideMetrics(tierTotals.atm.PE),
      },
      itm1: {
        CE: computeSideMetrics(tierTotals.itm1.CE),
        PE: computeSideMetrics(tierTotals.itm1.PE),
      },
    },
  };
}

function computeStrikeTotals(options) {
  const strikeMap = {};

  options.forEach(opt => {
    const key = String(opt.strike);
    if (!strikeMap[key]) {
      strikeMap[key] = {
        strike: opt.strike,
        totals: { bidQty: 0, askQty: 0, volume: 0, oi: 0 },
        typeTotals: {
          CE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 },
          PE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 },
        },
        options: [],
      };
    }

    const strike = strikeMap[key];
    strike.totals.bidQty += opt.bidQty;
    strike.totals.askQty += opt.askQty;
    strike.totals.volume += opt.volume;
    strike.totals.oi += opt.oi;
    if (strike.typeTotals[opt.type]) {
      strike.typeTotals[opt.type].bidQty += opt.bidQty;
      strike.typeTotals[opt.type].askQty += opt.askQty;
      strike.typeTotals[opt.type].volume += opt.volume;
      strike.typeTotals[opt.type].oi += opt.oi;
    }
    strike.options.push(opt);
  });

  return Object.values(strikeMap).map(strike => ({
    strike: strike.strike,
    totals: strike.totals,
    typeTotals: {
      CE: computeSideMetrics(strike.typeTotals.CE),
      PE: computeSideMetrics(strike.typeTotals.PE),
    },
    options: strike.options.map(opt => ({
      label: opt.label,
      type: opt.type,
      tier: opt.tier,
      strike: opt.strike,
      bidQty: opt.bidQty,
      askQty: opt.askQty,
      volume: opt.volume,
      oi: opt.oi,
      ratio: opt.ratio,
      strengthScore: opt.strengthScore,
    })),
  }));
}

function buildTradeSuggestion(options) {
  const aggregates = aggregateTotals(options);
  const strikeTotals = computeStrikeTotals(options);

  const strongestOption = options.reduce((best, opt) => {
    return !best || opt.strengthScore > best.strengthScore ? opt : best;
  }, null);

  const suggestedAction = strongestOption
    ? strongestOption.type === 'CE' ? 'BUY CALLS' : 'BUY PUTS'
    : 'NO CLEAR TREND';

  const reason = strongestOption
    ? `${strongestOption.label} is strongest: strength ${strongestOption.strengthScore}, ratio ${strongestOption.ratio}, volume ${strongestOption.volume.toLocaleString()}, OI ${strongestOption.oi.toLocaleString()}`
    : 'Unable to determine a clear strongest option from the available strikes.';

  return {
    aggregates,
    strikeTotals,
    strongestOption: strongestOption ? {
      label: strongestOption.label,
      strike: strongestOption.strike,
      type: strongestOption.type,
      tier: strongestOption.tier,
      symbol: strongestOption.symbol,
      strengthScore: strongestOption.strengthScore,
      ratio: strongestOption.ratio,
      volume: strongestOption.volume,
      oi: strongestOption.oi,
    } : null,
    suggestedAction,
    reason,
    riskPoints: 15,
    rewardPoints: 30,
    riskReward: '1:2',
    virtualTrade: !!strongestOption,
  };
}

// ============================================================
//  BUILD NIFTY WEEKLY OPTION SYMBOL
//  Format: NIFTY + DDMMMYY + STRIKE + CE/PE
//  Example: NIFTY06JUN2425100CE
// ============================================================
function getNiftyWeeklyExpiry() {
  // Find next Thursday (weekly expiry)
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 4=Thu
  let daysToThursday = (4 - day + 7) % 7;
  if (daysToThursday === 0) daysToThursday = 7; // Already Thursday — next one

  const expiry = new Date(now);
  expiry.setDate(now.getDate() + daysToThursday);

  const dd = String(expiry.getDate()).padStart(2, '0');
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const mmm = months[expiry.getMonth()];
  const yy = String(expiry.getFullYear()).slice(2);

  return `${dd}${mmm}${yy}`; // e.g. 06JUN25
}

function buildOptionSymbol(strike, type) {
  const expiry = getNiftyWeeklyExpiry();
  return `NIFTY${expiry}${strike}${type}`; // e.g. NIFTY06JUN2525100CE
}

// ============================================================
//  FETCH OPTION FULL DATA (Bid/Ask + Volume + LTP)
// ============================================================
async function fetchOptionData(tokens) {
  await ensureLoggedIn();
  const res = await axios.post(
    `${ANGEL_BASE}/rest/secure/angelbroking/market/v1/quote/`,
    {
      mode: 'FULL', // FULL mode gives bid/ask data
      exchangeTokens: { NFO: tokens },
    },
    { headers: getHeaders() }
  );
  return res.data.data.fetched;
}

// ============================================================
//  GET ATM STRIKE
// ============================================================
function getATMStrike(spot) {
  return Math.round(spot / 50) * 50;
}

// ============================================================
//  API ROUTE: /api/marketdata
//  Dashboard yahan se data fetch karega
// ============================================================
app.get('/api/marketdata', async (req, res) => {
  try {
    // 1. Fetch NIFTY spot
    const spot = await fetchNiftySpot();
    const atm = getATMStrike(spot);
    const itm1 = atm - 50;
    const itm1Pe = atm + 50;

    // 2. Build option symbols
    const contracts = [
      { label: 'ATM CE', strike: atm,    type: 'CE', tier: 'atm'  },
      { label: 'ATM PE', strike: atm,    type: 'PE', tier: 'atm'  },
      { label: '1 ITM CE', strike: itm1, type: 'CE', tier: 'itm1' },
      { label: '1 ITM PE', strike: itm1Pe, type: 'PE', tier: 'itm1' },
    ];

    // 3. Find tokens for each option
    const tokenMap = {};
    for (const c of contracts) {
      const option = findOption(c.strike, c.type);
      if (option) {
        tokenMap[option.token] = {
          ...c,
          symbol: option.symbol,
        };
      }
    }

    const tokens = Object.keys(tokenMap);

    if (tokens.length === 0) {
      return res.json({ success: false, message: 'No option tokens found — market may be closed or expiry mismatch' });
    }

    // 4. Fetch full market data
    const optionData = await fetchOptionData(tokens);
    const debug = req.query.debug === '1' || req.query.debug === 'true';

    function sumDepthQty(entries) {
      if (!Array.isArray(entries)) return 0;
      return entries.reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0);
    }

    function describeDepth(entries) {
      if (!Array.isArray(entries)) return { count: 0, total: 0, levels: [] };
      const levels = entries.map(item => ({ price: item?.price || null, quantity: Number(item?.quantity) || 0 }));
      return {
        count: levels.length,
        total: levels.reduce((sum, level) => sum + level.quantity, 0),
        levels,
      };
    }

    // 5. Build response with strength scoring
    const rawOptions = optionData.map(opt => {
      const meta = tokenMap[opt.symbolToken] || {};
      const bidDepth = describeDepth(opt.depth?.buy);
      const askDepth = describeDepth(opt.depth?.sell);
      const bidQty = bidDepth.total;
      const askQty = askDepth.total;
      const ratio = askQty > 0 ? parseFloat((bidQty / askQty).toFixed(3)) : 0;
      const priceChange = parseFloat((opt.ltp - opt.close).toFixed(2));
      const pctChange = opt.close > 0
        ? parseFloat(((priceChange / opt.close) * 100).toFixed(2))
        : 0;

      if (debug) {
        console.log(`DEBUG ${meta.label || opt.symbolToken}: buyCount=${bidDepth.count} buyTotal=${bidQty} sellCount=${askDepth.count} sellTotal=${askQty}`);
      }

      const volume = Number(opt.tradeVolume || opt.volume || 0);
      const oi = Number(opt.opnInterest || opt.openInterest || opt.oi || 0);
      return {
        label: meta.label,
        tier: meta.tier,
        strike: meta.strike,
        type: meta.type,
        symbol: meta.symbol,
        price: opt.ltp,
        prevPrice: opt.close,
        bidQty,
        askQty,
        ratio,
        volume,
        avgVolume: Number(opt.averageTradedPrice || 0) * 100,
        volumeSpike: volume > (Number(opt.averageTradedPrice || 0) * 100),
        priceChange,
        pctChange,
        high: opt.high,
        low: opt.low,
        oi,
        bidDepthCount: bidDepth.count,
        askDepthCount: askDepth.count,
        bidDepthLevels: debug ? bidDepth.levels : undefined,
        askDepthLevels: debug ? askDepth.levels : undefined,
      };
    });

    const options = computeStrengthScores(rawOptions);
    const suggestion = buildTradeSuggestion(options);

    return res.json({ success: true, spot, atm, options, suggestion });

  } catch (err) {
    console.error('Market data error:', err.message);

    // If token expired — re-login and retry once
    if (err.response?.status === 401) {
      await angelLogin();
      return res.json({ success: false, message: 'Session expired — retrying login. Refresh in 5 seconds.' });
    }

    return res.json({ success: false, message: err.message });
  }
});

// ============================================================
//  API ROUTE: /api/status
// ============================================================
app.get('/api/status', (req, res) => {
  res.json({
    loggedIn: !!SESSION.jwtToken,
    loginTime: SESSION.loginTime,
    serverTime: new Date().toISOString(),
  });
});

// ============================================================
//  START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`[${new Date().toISOString()}] Server started on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);

  await loadMaster();

  // Login on startup
  const ok = await angelLogin();
  if (!ok) {
    console.error('STARTUP LOGIN FAILED — Check your .env credentials');
  }
});
