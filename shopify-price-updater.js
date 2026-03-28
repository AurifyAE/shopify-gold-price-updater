/**
 * ============================================================
 * shopify-price-updater.js
 * ============================================================
 * Dynamically fetches ALL gold products + variants from Shopify
 * via Admin API, then updates prices in real-time on every
 * market-data socket push.
 *
 * No hardcoded variant IDs — new products are picked up
 * automatically on the next catalog refresh (every 5 minutes).
 *
 * USAGE — add to your existing server entry point:
 *   const { startPriceUpdater } = require('./shopify-price-updater');
 *   startPriceUpdater();
 *
 * Or run standalone:
 *   node shopify-price-updater.js
 * ============================================================
 */

'use strict';

require('dotenv').config();
const http   = require('http');

const { io } = require('socket.io-client');

// ── CONFIG ───────────────────────────────────────────────────────
const CONFIG = {
  // Shopify store credentials
  shopifyStore:   process.env.SHOPIFY_STORE,
  shopifyToken:   process.env.SHOPIFY_TOKEN,
  shopifyVersion: '2026-01',

  // Your Socket.io market data server
  socketUrl:  process.env.SOCKET_SERVER_URL,
  secretKey:  process.env.SOCKET_SECRET_KEY,

// Price formula — must match gold-rate.js exactly
troyOzToGram: 31.1035,
diamondRate:  18000,    // AED per carat
vatRate:      0.05,     // UAE 5% | KSA: 0.15 | Qatar/Kuwait: 0
karatPurity: {
  '24K': 1.0000,
  '22K': 0.9167,
  '18K': 0.7500,
  '14K': 0.5850,
},

// Metafield config — must match your Shopify metafield setup
metafieldNamespace: 'custom',
metafieldKeys: {
  goldGrams: 'gold_grams',
  diamondCt: 'diamond_ct',
  stoneCost: 'stone_cost_aed',
  makingPct: 'making_charges',
  karat:     'gold_karat',
  vatExempt: 'vat_exempt',
},

// Only update Shopify if price changed by more than this %
updateThresholdPct: 0.5,

// Catalog refresh interval — once a day
catalogRefreshMs: 24 * 60 * 60 * 1000,

// Webhook server port (Railway sets PORT automatically)
webhookPort: process.env.PORT || 3001,

// Shopify API rate limit
maxCallsPerSecond: 2,
maxRetries:        3,
};

// ── STATE ────────────────────────────────────────────────────────
let variantCache  = new Map();   // variantId → product + metafield data
let lastPrice     = new Map();   // variantId → last price sent to Shopify
let catalogReady  = false;
let lastFetchTime = null;

// ── SHOPIFY API BASE ─────────────────────────────────────────────
const SHOPIFY_BASE = `https://${CONFIG.shopifyStore}/admin/api/${CONFIG.shopifyVersion}`;

// ── FETCH ALL METAFIELDS (BULK) ──────────────────────────────────
// Fetches ALL product metafields in as few API calls as possible.
// Returns Map of productId → { key: value }
async function fetchAllMetafields(productIds) {
  console.log(`[Catalog] Fetching metafields for ${productIds.length} products...`);

  const metaMap = new Map();
  const BATCH   = 5; // max concurrent requests — stay under rate limit

  for (let i = 0; i < productIds.length; i += BATCH) {
    const batch = productIds.slice(i, i + BATCH);

    await Promise.all(batch.map(async (pid) => {
      try {
        const url = `${SHOPIFY_BASE}/products/${pid}/metafields.json?namespace=${CONFIG.metafieldNamespace}&limit=250`;
        const res  = await shopifyGet(url);
        const data = await res.json();

        const fields = {};
        for (const field of (data.metafields || [])) {
          fields[field.key] = field.value;
        }
        metaMap.set(pid, fields);
      } catch (err) {
        console.warn(`[Catalog] ⚠️  Metafields failed for product ${pid}:`, err.message);
      }
    }));

    if (i + BATCH < productIds.length) await sleep(500); // respect rate limit
  }

  console.log(`[Catalog] Got metafields for ${metaMap.size} products`);
  return metaMap;
}

// ── FETCH CATALOG ────────────────────────────────────────────────
// Fetches all products, matches with metafields, builds variant cache.
async function fetchCatalog() {
  console.log('[Catalog] 🔄 Building product catalog...');

  const newCache = new Map();
  let totalProds = 0;
  let totalVars  = 0;

  try {
    // Step 1 — Fetch all products (paginated) to get IDs + variants
    const allProducts = [];
    let url  = `${SHOPIFY_BASE}/products.json?limit=250&fields=id,title,variants`;

    while (url) {
      const res  = await shopifyGet(url);
      const data = await res.json();
      allProducts.push(...(data.products || []));

      const link      = res.headers.get('Link') || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      url             = nextMatch ? nextMatch[1] : null;
      if (url) await sleep(300);
    }

    console.log(`[Catalog] Found ${allProducts.length} total products`);

    // Step 2 — Fetch metafields for all products (batched per-product)
    const productIds = allProducts.map(p => p.id);
    const metaMap    = await fetchAllMetafields(productIds);

    // Step 3 — Build variant cache
    for (const product of allProducts) {
      const meta      = metaMap.get(product.id) || {};
      const goldGrams = parseFloat(meta[CONFIG.metafieldKeys.goldGrams] || 0);

      if (!goldGrams) continue; // skip non-gold products

      totalProds++;

      const variantMeta = {
        productTitle: product.title,
        productId:    product.id,
        goldGrams,
        diamondCt:  parseFloat(meta[CONFIG.metafieldKeys.diamondCt] || 0),
        stoneCost:  parseFloat(meta[CONFIG.metafieldKeys.stoneCost]  || 0),
        makingPct:  parseFloat(meta[CONFIG.metafieldKeys.makingPct]  || 12),
        karat:      meta[CONFIG.metafieldKeys.karat]                 || '22K',
        vatExempt:  meta[CONFIG.metafieldKeys.vatExempt] === 'true',
      };

      for (const variant of product.variants) {
        newCache.set(variant.id, { ...variantMeta, variantId: variant.id });
        totalVars++;
      }
    }

    variantCache  = newCache;
    catalogReady  = true;
    lastFetchTime = new Date();

    console.log(`[Catalog] ✅ ${totalProds} gold products → ${totalVars} variants loaded`);
    logCatalogSummary();

  } catch (err) {
    console.error('[Catalog] ❌ Fetch failed:', err.message);
  }
}

// Print a clean summary of loaded products
function logCatalogSummary() {
const byProduct = new Map();
for (const [, v] of variantCache) {
  if (!byProduct.has(v.productTitle)) {
    byProduct.set(v.productTitle, { count: 0, karat: v.karat, grams: v.goldGrams });
  }
  byProduct.get(v.productTitle).count++;
}
console.log('[Catalog] 📋 Gold products:');
for (const [title, info] of byProduct) {
  console.log(`  • ${title} — ${info.grams}g ${info.karat} (${info.count} variant${info.count !== 1 ? 's' : ''})`);
}
console.log(`[Catalog] 🕐 Last updated: ${lastFetchTime?.toLocaleTimeString()}`);
}

// ── SHOPIFY GET with rate limit handling ─────────────────────────
async function shopifyGet(url) {
const res = await fetch(url, {
  headers: { 'X-Shopify-Access-Token': CONFIG.shopifyToken }
});

if (res.status === 429) {
  const wait = parseFloat(res.headers.get('Retry-After') || '2') * 1000;
  console.warn(`[Shopify] ⏳ Rate limited — waiting ${wait}ms`);
  await sleep(wait);
  return shopifyGet(url);
}

if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
return res;
}

// ── PRICE CALCULATION ────────────────────────────────────────────
function calculatePrice(meta, goldRate24k) {
const purity    = CONFIG.karatPurity[meta.karat] || 0.9167;
const rateKarat = goldRate24k * purity;
const goldCost  = meta.goldGrams * rateKarat;
const diamCost  = meta.diamondCt * CONFIG.diamondRate;
const stoneCost = meta.stoneCost;
const subtotal  = goldCost + diamCost + stoneCost;
const making    = subtotal * (meta.makingPct / 100);
const preTax    = subtotal + making;
const vat       = meta.vatExempt ? 0 : preTax * CONFIG.vatRate;
return parseFloat((preTax + vat).toFixed(2));
}

// ── SHOPIFY VARIANT PRICE UPDATE ─────────────────────────────────
async function updateVariantPrice(variantId, newPrice, retries = 0) {
try {
  const res = await fetch(`${SHOPIFY_BASE}/variants/${variantId}.json`, {
    method:  'PUT',
    headers: {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': CONFIG.shopifyToken,
    },
    body: JSON.stringify({
      variant: { id: variantId, price: newPrice.toFixed(2) }
    }),
  });

  if (res.status === 429) {
    const wait = parseFloat(res.headers.get('Retry-After') || '1') * 1000;
    console.warn(`[Shopify] ⏳ Rate limited on PUT — waiting ${wait}ms`);
    await sleep(wait);
    return updateVariantPrice(variantId, newPrice, retries);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);

  const meta = variantCache.get(variantId);
  console.log(`[Shopify] ✅ ${meta?.productTitle} (${variantId}) → AED ${newPrice.toFixed(2)}`);

} catch (err) {
  if (retries < CONFIG.maxRetries) {
    const wait = Math.pow(2, retries) * 1000;
    console.warn(`[Shopify] ⚠️  Retry ${retries + 1}/${CONFIG.maxRetries} for ${variantId} in ${wait}ms`);
    await sleep(wait);
    return updateVariantPrice(variantId, newPrice, retries + 1);
  }
  console.error(`[Shopify] ❌ Gave up on variant ${variantId}:`, err.message);
}
}

// ── RATE-LIMITED API QUEUE ───────────────────────────────────────
const apiQueue   = [];
let   processing = false;

function enqueue(variantId, newPrice) {
apiQueue.push({ variantId, newPrice });
if (!processing) processQueue();
}

async function processQueue() {
processing = true;
while (apiQueue.length > 0) {
  const batch = apiQueue.splice(0, CONFIG.maxCallsPerSecond);
  await Promise.all(batch.map(({ variantId, newPrice }) =>
    updateVariantPrice(variantId, newPrice)
  ));
  if (apiQueue.length > 0) await sleep(1000);
}
processing = false;
}

// ── MAIN GOLD RATE HANDLER ───────────────────────────────────────
function handleGoldRate(goldRate24k) {
if (!catalogReady || variantCache.size === 0) {
  console.warn('[PriceUpdater] ⏳ Catalog not ready — skipping tick');
  return;
}

let updateCount = 0;

for (const [variantId, meta] of variantCache) {
  const newPrice  = calculatePrice(meta, goldRate24k);
  const last      = lastPrice.get(variantId);
  const changePct = last ? Math.abs((newPrice - last) / last) * 100 : 100;

  if (changePct >= CONFIG.updateThresholdPct) {
    lastPrice.set(variantId, newPrice);
    enqueue(variantId, newPrice);
    updateCount++;
  }
}

const msg = updateCount > 0
  ? `${updateCount}/${variantCache.size} variants queued`
  : `no change (< ${CONFIG.updateThresholdPct}% threshold)`;

console.log(`[PriceUpdater] 📈 AED ${goldRate24k.toFixed(4)}/g (24K) → ${msg}`);
}

// ── SOCKET CONNECTION ────────────────────────────────────────────
function connectSocket() {
console.log('[Socket] Connecting to market data server...');

const socket = io(CONFIG.socketUrl, {
  query:                { secret: CONFIG.secretKey },
  transports:           ['websocket'],
  withCredentials:      true,
  reconnection:         true,
  reconnectionDelay:    1000,
  reconnectionDelayMax: 10000,
  reconnectionAttempts: Infinity,
});

socket.on('connect', () => {
  console.log('[Socket] ✅ Connected — requesting GOLD data');
  socket.emit('request-data', ['GOLD']);
});

socket.on('market-data', (data) => {
  const symbol = data && data.symbol ? data.symbol.toUpperCase() : null;
  if (symbol !== 'GOLD') return;
  if (data.marketStatus !== 'TRADEABLE') return;
  const goldRate24k = data.offer / CONFIG.troyOzToGram;
  handleGoldRate(goldRate24k);
});

socket.on('disconnect', (reason) => {
  console.warn('[Socket] 🔌 Disconnected:', reason, '— will auto-reconnect');
});

socket.on('connect_error', (err) => {
  console.error('[Socket] ❌ Error:', err.message);
});

return socket;
}

// ── WEBHOOK SERVER ───────────────────────────────────────────────
// Listens for Shopify product webhooks → triggers instant catalog refresh
// Set up in Shopify Admin → Settings → Notifications → Webhooks
//   Event: Product creation / Product update
//   URL:   https://your-railway-url.up.railway.app/refresh
function startWebhookServer() {
const server = http.createServer(async (req, res) => {

  // Health check — Railway uses this to verify service is alive
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:       'running',
      variants:     variantCache.size,
      catalogReady,
      lastFetch:    lastFetchTime?.toISOString() || null,
      nextRefresh:  new Date(Date.now() + CONFIG.catalogRefreshMs).toISOString(),
    }));
    return;
  }

  // Manual refresh trigger — call POST /refresh to force catalog reload
  if (req.url === '/refresh' && req.method === 'POST') {
    console.log('[Webhook] 🔔 Refresh triggered — reloading catalog...');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'refreshing' }));
    // Run async after response sent
    fetchCatalog().catch(console.error);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(CONFIG.webhookPort, () => {
  console.log(`[Webhook] 🌐 Server listening on port ${CONFIG.webhookPort}`);
  console.log(`[Webhook] Health check: GET  /health`);
  console.log(`[Webhook] Refresh:      POST /refresh`);
});

return server;
}

// ── UTILITY ──────────────────────────────────────────────────────
function sleep(ms) {
return new Promise(resolve => setTimeout(resolve, ms));
}

// ── STARTUP ──────────────────────────────────────────────────────
async function startPriceUpdater() {
console.log('');
console.log('╔═════════════════════════════════════════════════════╗');
console.log('║   Shopify Live Gold Price Updater                   ║');
console.log('║   Dynamic catalog · Real-time price updates         ║');
console.log(`║   Store: ${CONFIG.shopifyStore.padEnd(43)}║`);
console.log('╚═════════════════════════════════════════════════════╝');
console.log('');
console.log(`[Config] Catalog refresh: every 24 hours`);
console.log(`[Config] Update threshold: ${CONFIG.updateThresholdPct}% price change`);
console.log(`[Config] VAT rate: ${CONFIG.vatRate * 100}%`);
console.log('');

// 1. Start webhook server (Railway needs a port to stay alive)
startWebhookServer();

// 2. Fetch catalog once at startup
await fetchCatalog();

// 3. Connect to live gold rate socket
connectSocket();

// 4. Daily catalog refresh — safety net for any missed webhooks
setInterval(async () => {
  console.log('[Catalog] 🕐 Daily scheduled refresh...');
  await fetchCatalog();
}, CONFIG.catalogRefreshMs);

console.log('');
console.log('[PriceUpdater] 🚀 Running — waiting for gold rate ticks...');
console.log('');
}

// ── EXPORTS ──────────────────────────────────────────────────────
module.exports = { startPriceUpdater, fetchCatalog, calculatePrice };

// ── AUTO-START ───────────────────────────────────────────────────
if (require.main === module) {
startPriceUpdater().catch(console.error);

process.on('SIGINT', () => {
  console.log('\n[PriceUpdater] 🛑 Shutting down gracefully...');
  process.exit(0);
});
}