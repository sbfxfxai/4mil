const https = require('https');

const GMX_BASE = 'https://arbitrum.gmxapi.io';
const WALLET   = '0xDC4EA35771eE89c6f27a765A5d3bfc302aEB8352';

// Market address → token symbol
const MARKET_SYMBOLS = {
  '0x47c031236e19d024b42f8ae6780e44a573170703': 'BTC',
  '0x70d95587d40a2caf56bd97485ab3eec10bee6336': 'ETH',
  '0x0df2be76f517bcf0000abffcb6344b3b2ac4cc4f': 'SOL',
  '0x09400d9db990d5ed3f35d7be61dfaeb900af03c9': 'DOGE',
  '0x63dc80ee90f26363b3fcd1f4c069f5f56c0f1c5': 'XRP',
  '0xd9535bb5f58a1a75032416f2dfe7880c30575a41': 'ARB',
  '0x2d340912aa47e33a5ef02cd0243c2800dab1a0f4': 'AVAX',
  '0x248c35760068ce009a13076d573ed3497a47bcd4': 'LINK',
  '0x0ccb4faa6f1f1b74b2882ff5d1f5f3e93bab5b8b': 'ATOM',
  '0x64485012b3d990be056b781ea5e3d519d58d4f4a': 'NEAR',
  '0xcacb964144f9056a8f99447a303e60b4873ca9b4': 'ADA',
  '0x448fa722717df299ee197e2f6d8eb7911eff6cec': 'BNB',
  '0xb3a403dd5a98ec71bb43c8f2b0e3a2a16f0d14c5': 'PEPE',
  '0x0ccb4faa6f1f1b74b2882ff5d1f5f3e93bab5b8b': 'OP',
};

function gmxGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(GMX_BASE + path);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'AlgoEdge/1.0' },
        timeout: 20000 },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Paginate through all trades (GMX returns max 100 per page)
async function fetchAllTrades(account) {
  const all = [];
  let cursor = undefined;
  let pages = 0;
  while (pages < 20) {  // hard cap at 2000 trades
    const qs = new URLSearchParams({ address: account, limit: '100', actions: 'OrderExecuted' });
    if (cursor) qs.set('cursor', cursor);
    const { status, body } = await gmxGet('/v1/trades?' + qs.toString());
    if (status !== 200) throw new Error('GMX API ' + status);
    const trades = body.trades || [];
    all.push(...trades);
    if (!body.hasMore || !body.nextCursor) break;
    cursor = body.nextCursor;
    pages++;
  }
  return all;
}

function marketSymbol(addr) {
  return addr ? (MARKET_SYMBOLS[addr.toLowerCase()] || addr.slice(0, 6).toUpperCase()) : '—';
}

const DIV = 1e30;  // GMX stores USD values * 1e30

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const account = (req.query && req.query.account) || WALLET;

  try {
    const raw = await fetchAllTrades(account);

    // Filter to decrease orders (closes) — orderType 2=market, 3=limit, sizeDelta > 0
    const closes = raw.filter(t =>
      (t.orderType === 2 || t.orderType === 3) &&
      BigInt(t.sizeDeltaUsd || '0') > 0n
    );

    // Build enriched trade list
    const trades = closes.map(t => {
      const pnl        = Number(BigInt(t.pnlUsd || '0')) / DIV;
      const size       = Number(BigInt(t.sizeDeltaUsd || '0')) / DIV;
      const collateral = Number(BigInt(t.initialCollateralDeltaAmount || '0'));
      const colPrice   = Number(BigInt(t.collateralTokenPriceMin || '1')) / 1e24; // 6-dec USDC
      const collateralUsd = (collateral / 1e6) * colPrice;
      const leverage   = collateralUsd > 0.01 ? size / collateralUsd : 0;
      const execPrice  = Number(BigInt(t.executionPrice || '0')) / 1e30;
      const positionFee = Number(BigInt(t.positionFeeAmount || '0')) / 1e6;
      const borrowFee   = Number(BigInt(t.borrowingFeeAmount || '0')) / 1e6;
      const fundingFee  = Number(BigInt(t.fundingFeeAmount  || '0')) / 1e6;
      const totalFees   = positionFee + borrowFee + fundingFee;

      return {
        id:          t.id,
        timestamp:   t.timestamp,
        txHash:      t.transactionHash,
        market:      marketSymbol(t.marketAddress),
        isLong:      t.isLong,
        sizeUsd:     size,
        collUsd:     collateralUsd,
        leverage:    leverage,
        execPrice:   execPrice,
        pnlUsd:      pnl,
        feesUsd:     totalFees,
        netPnlUsd:   pnl - totalFees,
        win:         pnl > 0,
      };
    });

    // Sort newest first
    trades.sort((a, b) => b.timestamp - a.timestamp);

    // Aggregate stats
    const wins   = trades.filter(t => t.win);
    const losses = trades.filter(t => !t.win);
    const totalPnl  = trades.reduce((s, t) => s + t.pnlUsd, 0);
    const totalFees = trades.reduce((s, t) => s + t.feesUsd, 0);
    const totalVol  = trades.reduce((s, t) => s + t.sizeUsd, 0);
    const avgSize   = trades.length ? totalVol / trades.length : 0;
    const avgLev    = trades.length ? trades.reduce((s,t) => s + t.leverage, 0) / trades.length : 0;
    const avgWin    = wins.length   ? wins.reduce((s,t) => s + t.pnlUsd, 0) / wins.length : 0;
    const avgLoss   = losses.length ? losses.reduce((s,t) => s + t.pnlUsd, 0) / losses.length : 0;
    const profitFactor = losses.length > 0 && avgLoss !== 0
      ? Math.abs((avgWin * wins.length) / (avgLoss * losses.length)) : null;

    // Rough ROI: total PnL / (avgSize / avgLev) * 100
    const capitalProxy = avgLev > 0 ? avgSize / avgLev : avgSize;
    const roi = capitalProxy > 0 ? (totalPnl / capitalProxy) * 100 : 0;

    // Equity curve (cumulative PnL, oldest first)
    const equityCurve = [];
    let acc = 0;
    [...trades].reverse().forEach(t => { acc += t.pnlUsd; equityCurve.push(acc); });

    // Market breakdown
    const byMarket = {};
    trades.forEach(t => {
      if (!byMarket[t.market]) byMarket[t.market] = { trades: 0, wins: 0, pnlUsd: 0, vol: 0 };
      byMarket[t.market].trades++;
      byMarket[t.market].pnlUsd += t.pnlUsd;
      byMarket[t.market].vol    += t.sizeUsd;
      if (t.win) byMarket[t.market].wins++;
    });

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      account,
      stats: {
        totalTrades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: trades.length ? wins.length / trades.length * 100 : 0,
        totalPnlUsd: totalPnl,
        totalFeesUsd: totalFees,
        netPnlUsd: totalPnl - totalFees,
        totalVolumeUsd: totalVol,
        avgSizeUsd: avgSize,
        avgLeverage: avgLev,
        avgWinUsd: avgWin,
        avgLossUsd: avgLoss,
        profitFactor,
        roi,
        bestTradeUsd: trades.length ? Math.max(...trades.map(t=>t.pnlUsd)) : 0,
        worstTradeUsd: trades.length ? Math.min(...trades.map(t=>t.pnlUsd)) : 0,
      },
      equityCurve,
      byMarket,
      recentTrades: trades.slice(0, 50),
    });
  } catch (err) {
    console.error('GMX handler error:', err.message);
    return res.status(502).json({ error: err.message });
  }
};
