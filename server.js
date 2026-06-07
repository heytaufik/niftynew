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

// ============================================================
//  VOLUME HISTORY (for spike detection)
// ============================================================
let VOLUME_HISTORY = {};

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
//  SEARCH OPTION SYMBOL TOKEN
//  Angel One ka symbol search — strike ke liye token milega
// ============================================================
async function searchSymbolToken(symbol) {
  await ensureLoggedIn();
  const res = await axios.get(
    `${ANGEL_BASE}/rest/secure/angelbroking/order/v1/searchScrip?exchange=NFO&searchscrip=${encodeURIComponent(symbol)}`,
    { headers: getHeaders() }
  );
  if (res.data.data && res.data.data.length > 0) {
    return res.data.data[0].symboltoken;
  }
  return null;
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
//  VOLUME SPIKE DETECTION
// ============================================================
function detectVolumeSpike(symbol, currentVolume, avgVolume) {
  if (!VOLUME_HISTORY[symbol]) {
    VOLUME_HISTORY[symbol] = [];
  }

  const history = VOLUME_HISTORY[symbol];
  history.push(currentVolume);

  if (history.length > 10) {
    history.shift();
  }

  const avgOfHistory = history.reduce((a, b) => a + b, 0) / history.length;
  const isSpike = currentVolume > (avgOfHistory * 1.5) || currentVolume > (avgVolume * 2);
  const spikePercentage = avgOfHistory > 0 ? 
    Math.round(((currentVolume - avgOfHistory) / avgOfHistory) * 100) : 0;

  return {
    isSpike,
    spikePercentage,
    currentVolume,
    avgVolume,
    historyAvg: parseFloat(avgOfHistory.toFixed(2))
  };
}

// ============================================================
//  CALL vs PUT STRENGTH ANALYZER
// ============================================================
function analyzeCallVsPutStrength(atmStrike, callData, putData) {
  // Bid-Ask Ratio
  const callBidAskRatio = callData.askQty > 0 
    ? parseFloat((callData.bidQty / callData.askQty).toFixed(3))
    : 0;
  
  const putBidAskRatio = putData.askQty > 0 
    ? parseFloat((putData.bidQty / putData.askQty).toFixed(3))
    : 0;

  // Volume Analysis
  const callVolume = callData.volume || 0;
  const putVolume = putData.volume || 0;
  const volumeRatio = putVolume > 0 
    ? parseFloat((callVolume / putVolume).toFixed(3))
    : 0;

  // OI Analysis
  const callOI = callData.oi || 0;
  const putOI = putData.oi || 0;
  const oiRatio = putOI > 0 
    ? parseFloat((callOI / putOI).toFixed(3))
    : 0;

  // Volume Spike Detection
  const callVolumeSpike = detectVolumeSpike('CALL_' + atmStrike, callVolume, callData.avgVolume || 0);
  const putVolumeSpike = detectVolumeSpike('PUT_' + atmStrike, putVolume, putData.avgVolume || 0);

  // Scoring System
  let callScore = 0;
  let putScore = 0;

  if (callBidAskRatio > 1.2) {
    callScore += 3;
  } else if (callBidAskRatio < 0.8) {
    putScore += 3;
  }

  if (volumeRatio > 1.3) {
    callScore += 3;
  } else if (volumeRatio < 0.7) {
    putScore += 3;
  }

  if (oiRatio > 1.3) {
    callScore += 4;
  } else if (oiRatio < 0.7) {
    putScore += 4;
  }

  if (callVolumeSpike.isSpike) {
    callScore += 2;
  }
  if (putVolumeSpike.isSpike) {
    putScore += 2;
  }

  const strongerSide = callScore > putScore ? 'CALL' : 'PUT';
  const strength = Math.abs(callScore - putScore);

  let strengthLevel = 'NEUTRAL';
  if (strength >= 8) strengthLevel = '🔴 VERY STRONG';
  else if (strength >= 5) strengthLevel = '🟠 STRONG';
  else if (strength >= 2) strengthLevel = '🟡 MODERATE';
  else strengthLevel = '⚪ WEAK';

  return {
    strongerSide,
    callScore,
    putScore,
    strengthLevel,
    analysis: {
      bidAsk: {
        call: callBidAskRatio,
        put: putBidAskRatio,
        winner: callBidAskRatio > putBidAskRatio ? 'CALL' : 'PUT',
        signal: callBidAskRatio > 1 ? '✅ BUYERS' : '❌ SELLERS'
      },
      volume: {
        call: callVolume,
        put: putVolume,
        ratio: volumeRatio,
        winner: volumeRatio > 1 ? 'CALL' : 'PUT',
        signal: volumeRatio > 1 ? '✅ CALL STRONG' : '❌ PUT STRONG'
      },
      oi: {
        call: callOI,
        put: putOI,
        ratio: oiRatio,
        winner: oiRatio > 1 ? 'CALL' : 'PUT',
        signal: oiRatio > 1 ? '✅ CALL BUILDUP' : '❌ PUT BUILDUP'
      },
      volumeSpike: {
        call: callVolumeSpike,
        put: putVolumeSpike,
        callSpiked: callVolumeSpike.isSpike,
        putSpiked: putVolumeSpike.isSpike
      }
    }
  };
}

// ============================================================
//  GENERATE TRADING SIGNAL
// ============================================================
function generateTradingSignal(spot, atmStrike, analysis, callPrice, putPrice) {
  const strongerSide = analysis.strongerSide;
  const strengthLevel = analysis.strengthLevel;

  let signal = {};

  if (strongerSide === 'CALL') {
    signal = {
      direction: '📈 CALL (BULLISH)',
      strength: strengthLevel,
      strikePrice: atmStrike,
      spotPrice: spot,
      entry: parseFloat(callPrice.toFixed(2)),
      stopLoss: parseFloat((callPrice - 15).toFixed(2)),
      target: parseFloat((callPrice + 30).toFixed(2)),
      maxLoss: 15,
      maxProfit: 30,
      riskRewardRatio: 2.0,
      message: '☎️ BUY CALL - Strong indicators detected!',
      tradeSetup: {
        quantity: 50,
        totalEntry: (callPrice * 50).toFixed(2),
        totalSL: (15 * 50).toFixed(2),
        totalTarget: (30 * 50).toFixed(2)
      }
    };
  } else {
    signal = {
      direction: '📉 PUT (BEARISH)',
      strength: strengthLevel,
      strikePrice: atmStrike,
      spotPrice: spot,
      entry: parseFloat(putPrice.toFixed(2)),
      stopLoss: parseFloat((putPrice - 15).toFixed(2)),
      target: parseFloat((putPrice + 30).toFixed(2)),
      maxLoss: 15,
      maxProfit: 30,
      riskRewardRatio: 2.0,
      message: '📱 BUY PUT - Strong indicators detected!',
      tradeSetup: {
        quantity: 50,
        totalEntry: (putPrice * 50).toFixed(2),
        totalSL: (15 * 50).toFixed(2),
        totalTarget: (30 * 50).toFixed(2)
      }
    };
  }

  return signal;
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

    // 3. Search tokens for each symbol
    const tokenMap = {};
    for (const c of contracts) {
      const sym = buildOptionSymbol(c.strike, c.type);
      const token = await searchSymbolToken(sym);
      if (token) {
        tokenMap[token] = { ...c, symbol: sym };
      }
    }

    const tokens = Object.keys(tokenMap);

    if (tokens.length === 0) {
      return res.json({ success: false, message: 'No option tokens found — market may be closed or expiry mismatch' });
    }

    // 4. Fetch full market data
    const optionData = await fetchOptionData(tokens);

    // 5. Build response with volume spike and analysis
    const options = optionData.map(opt => {
      const meta = tokenMap[opt.symbolToken] || {};
      const bidQty = opt.depth?.buy?.[0]?.quantity || 0;
      const askQty = opt.depth?.sell?.[0]?.quantity || 0;
      const ratio = askQty > 0 ? parseFloat((bidQty / askQty).toFixed(3)) : 0;
      const volumeSpike = opt.tradeVolume > opt.averageTradedPrice * 100;
      const priceChange = parseFloat((opt.ltp - opt.close).toFixed(2));
      const pctChange = opt.close > 0
        ? parseFloat(((priceChange / opt.close) * 100).toFixed(2))
        : 0;

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
        volume: opt.tradeVolume,
        avgVolume: opt.averageTradedPrice * 100,
        volumeSpike: opt.tradeVolume > (opt.averageTradedPrice * 100),
        priceChange,
        pctChange,
        high: opt.high,
        low: opt.low,
        oi: opt.opnInterest,
      };
    });

    return res.json({ success: true, spot, atm, options });

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
//  API ROUTE: /api/tradeSignal (NEW - MAIN ROUTE)
// ============================================================
app.get('/api/tradeSignal', async (req, res) => {
  try {
    console.log('📊 Fetching trade signal...');

    // 1. Fetch NIFTY spot
    const spot = await fetchNiftySpot();
    const atm = getATMStrike(spot);

    console.log(`NIFTY Spot: ${spot}, ATM: ${atm}`);

    // 2. Build ATM Call & Put symbols
    const callSymbol = buildOptionSymbol(atm, 'CE');
    const putSymbol = buildOptionSymbol(atm, 'PE');

    console.log(`Call: ${callSymbol}, Put: ${putSymbol}`);

    // 3. Search tokens
    const callToken = await searchSymbolToken(callSymbol);
    const putToken = await searchSymbolToken(putSymbol);

    if (!callToken || !putToken) {
      return res.json({ 
        success: false, 
        message: '❌ Option tokens not found - market may be closed' 
      });
    }

    // 4. Fetch market data
    const optionData = await fetchOptionData([callToken, putToken]);

    // 5. Parse data
    const callData = optionData.find(o => o.symbolToken == callToken);
    const putData = optionData.find(o => o.symbolToken == putToken);

    if (!callData || !putData) {
      return res.json({ success: false, message: '❌ Failed to fetch option data' });
    }

    // 6. Extract bid-ask info
    const callBidQty = callData.depth?.buy?.[0]?.quantity || 0;
    const callAskQty = callData.depth?.sell?.[0]?.quantity || 0;
    const putBidQty = putData.depth?.buy?.[0]?.quantity || 0;
    const putAskQty = putData.depth?.sell?.[0]?.quantity || 0;

    // 7. Analyze strength
    const analysis = analyzeCallVsPutStrength(atm, {
      price: callData.ltp,
      bidQty: callBidQty,
      askQty: callAskQty,
      volume: callData.tradeVolume,
      avgVolume: callData.averageTradedPrice * 100,
      oi: callData.opnInterest
    }, {
      price: putData.ltp,
      bidQty: putBidQty,
      askQty: putAskQty,
      volume: putData.tradeVolume,
      avgVolume: putData.averageTradedPrice * 100,
      oi: putData.opnInterest
    });

    // 8. Generate signal
    const signal = generateTradingSignal(spot, atm, analysis, callData.ltp, putData.ltp);

    console.log(`✅ Signal Generated: ${analysis.strongerSide} with strength ${analysis.strengthLevel}`);

    return res.json({ 
      success: true, 
      spot,
      atm,
      analysis,
      signal,
      callData: {
        symbol: callSymbol,
        price: callData.ltp,
        bidQty: callBidQty,
        askQty: callAskQty,
        volume: callData.tradeVolume,
        oi: callData.opnInterest,
        high: callData.high,
        low: callData.low
      },
      putData: {
        symbol: putSymbol,
        price: putData.ltp,
        bidQty: putBidQty,
        askQty: putAskQty,
        volume: putData.tradeVolume,
        oi: putData.opnInterest,
        high: putData.high,
        low: putData.low
      },
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ Signal error:', err.message);
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

  // Login on startup
  const ok = await angelLogin();
  if (!ok) {
    console.error('STARTUP LOGIN FAILED — Check your .env credentials');
  }
});
