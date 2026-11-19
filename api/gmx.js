const https = require('https');

const SUBGRAPHS = [
  // Primary: Satsuma hosted
  'https://subgraph.satsuma-prod.com/3b2ced13c8d9/gmx/synthetics-arbitrum-stats/api',
  // Fallback: The Graph decentralised network
  'https://api.thegraph.com/subgraphs/name/gmx-io/gmx-arbitrum-stats',
];

function httpsPost(url, payload) {
  return new Promise((resolve, reject) => {
    const { hostname, pathname, search } = new URL(url);
    const body = JSON.stringify(payload);
    const options = {
      hostname,
      path: pathname + (search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'AlgoEdge-Dashboard/1.0',
        'Origin': 'https://4mil-iwbr.vercel.app',
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const payload = req.body;
  if (!payload || !payload.query) {
    return res.status(400).json({ error: 'Missing GraphQL query in body' });
  }

  let lastError = null;

  for (const url of SUBGRAPHS) {
    try {
      const { status, body } = await httpsPost(url, payload);
      if (status >= 200 && status < 300) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Proxy-Source', url);
        return res.status(200).send(body);
      }
      lastError = `Upstream ${status} from ${url}`;
    } catch (err) {
      lastError = `${url}: ${err.message}`;
      console.error('Proxy attempt failed:', lastError);
    }
  }

  console.error('All subgraph endpoints failed. Last error:', lastError);
  return res.status(502).json({ error: 'All subgraph endpoints failed', detail: lastError });
}
