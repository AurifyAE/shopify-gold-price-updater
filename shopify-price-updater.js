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

  // Price formula constants (must match gold-rate.js exactly)
  troyOzToGram:  31.1035,
  diamondRate:   18000,             // AED per carat
  vatRate:       0.05,              // UAE 5% | KSA: 0.15 | Qatar: 0
  karatPurity: {
    '24K': 1.0000,
    '22K': 0.9167,
    '18K': 0.7500,
    '14K': 0.5850,
  },

  // Shopify metafield namespace + keys (must match your Shopify setup)
  metafieldNamespace: 'custom',
  metafieldKeys: {
    goldGrams:  'gold_grams',
    diamondCt:  'diamond_ct',
    stoneCost:  'stone_cost_aed',
    makingPct:  'making_charges',
    karat:      'gold_karat',
    vatExempt:  'vat_exempt',
  },

  // Only update Shopify if price changed by more than this %
  // Prevents API spam on tiny rate fluctuations
  updateThresholdPct: 0.5,

  // How often to re-fetch the full product catalog (ms)
  // Picks up new products, metafield changes, new variants
  catalogRefreshMs: 5 * 60 * 1000,  // every 5 minutes

  // Shopify REST API: max 2 calls/second
  maxCallsPerSecond: 2,

  // Retry failed API calls up to N times
  maxRetries: 3,
};

// ── STATE ────────────────────────────────────────────────────────
// variantCache: Map of variantId → product + metafield data
let variantCache = new Map();
let lastPrice    = new Map();   // variantId → last price sent to Shopify
let catalogReady = false;

// ── SHOPIFY API BASE ─────────────────────────────────────────────
const SHOPIFY_BASE = `https://${CONFIG.shopifyStore}/admin/api/${CONFIG.shopifyVersion}`;

// ── FETCH CATALOG ────────────────────────────────────────────────
// Fetches ALL products, checks each for gold metafields,
// builds a variant map on the fly. Handles pagination.
async function fetchCatalog() {
  console.log('[Catalog] 🔄 Fetching gold products from Shopify...');

  const newCache    = new Map();
  let   url         = `${SHOPIFY_BASE}/products.json?limit=250&fields=id,title,variants`;
  let   page        = 0;
  let   totalProds  = 0;
  let   totalVars   = 0;

  try {
    while (url) {
      page++;
      const res = await shopifyGet(url);
      const data = await res.json();

      for (const product of (data.products || [])) {
        // Fetch metafields for this product
        const meta = await fetchProductMetafields(product.id);

        // Only process gold products
        const goldGrams = parseFloat(meta[CONFIG.metafieldKeys.goldGrams] || 0);
        if (!goldGrams) continue;

        totalProds++;

        const variantMeta = {
          productTitle: product.title,
          productId:    product.id,
          goldGrams,
          diamondCt:    parseFloat(meta[CONFIG.metafieldKeys.diamondCt] || 0),
          stoneCost:    parseFloat(meta[CONFIG.metafieldKeys.stoneCost]  || 0),
          makingPct:    parseFloat(meta[CONFIG.metafieldKeys.makingPct]  || 12),
          karat:        meta[CONFIG.metafieldKeys.karat]                 || '22K',
          vatExempt:    meta[CONFIG.metafieldKeys.vatExempt] === 'true',
        };

        // Add every size/variant of this product
        for (const variant of product.variants) {
          newCache.set(variant.id, { ...variantMeta, variantId: variant.id });
          totalVars++;
        }
      }

      // Shopify pagination via Link header
      const link      = res.headers.get('Link') || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      url             = nextMatch ? nextMatch[1] : null;

      if (url) await sleep(500); // throttle between pages
    }

    // Swap cache atomically
    variantCache = newCache;
    catalogReady = true;

    console.log(`[Catalog] ✅ ${totalProds} gold products → ${totalVars} variants loaded (${page} page(s))`);
    logCatalogSummary();

  } catch (err) {
    console.error('[Catalog] ❌ Fetch failed:', err.message);
    // Keep old cache so price updates continue with stale but valid data
  }
}

// Fetch metafields for a single product, returns key→value map
async function fetchProductMetafields(productId) {
  try {
    const res  = await shopifyGet(
      `${SHOPIFY_BASE}/products/${productId}/metafields.json?namespace=${CONFIG.metafieldNamespace}`
    );
    const data = await res.json();
    const meta = {};
    for (const field of (data.metafields || [])) {
      meta[field.key] = field.value;
    }
    return meta;
  } catch {
    return {};
  }
}

// Shared Shopify GET with rate limit handling
async function shopifyGet(url) {
  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': CONFIG.shopifyToken }
  });
  if (res.status === 429) {
    const wait = parseFloat(res.headers.get('Retry-After') || '2') * 1000;
    console.warn(`[Shopify] ⏳ Rate limited on GET — waiting ${wait}ms`);
    await sleep(wait);
    return shopifyGet(url);
  }
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res;
}

// Log a clean summary of loaded products
function logCatalogSummary() {
  const byProduct = new Map();
  for (const [, v] of variantCache) {
    if (!byProduct.has(v.productTitle)) {
      byProduct.set(v.productTitle, { count: 0, karat: v.karat, grams: v.goldGrams });
    }
    byProduct.get(v.productTitle).count++;
  }
  console.log('[Catalog] 📋 Loaded products:');
  for (const [title, info] of byProduct) {
    console.log(`  • ${title} — ${info.grams}g ${info.karat} (${info.count} variant${info.count !== 1 ? 's' : ''})`);
  }
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
      console.warn(`[Shopify] ⚠️  Retry ${retries + 1}/${CONFIG.maxRetries} — variant ${variantId} in ${wait}ms`);
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
    if (apiQueue.length > 0) await sleep(1000); // 1s between batches
  }
  processing = false;
}

// ── MAIN GOLD RATE HANDLER ───────────────────────────────────────
function handleGoldRate(goldRate24k) {
  if (!catalogReady || variantCache.size === 0) {
    console.warn('[PriceUpdater] ⏳ Catalog not ready yet — skipping tick');
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
    ? `${updateCount}/${variantCache.size} variants queued for update`
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
    console.error('[Socket] ❌ Connection error:', err.message);
  });

  return socket;
}

// ── STARTUP ──────────────────────────────────────────────────────
async function startPriceUpdater() {
  console.log('');
  console.log('╔═════════════════════════════════════════════════════╗');
  console.log('║   Shopify Live Gold Price Updater                   ║');
  console.log('║   Dynamic catalog · Auto-picks new products         ║');
  console.log(`║   Store: ${CONFIG.shopifyStore.padEnd(43)}║`);
  console.log('╚═════════════════════════════════════════════════════╝');
  console.log('');

  // 1. Load full product catalog from Shopify
  await fetchCatalog();

  // 2. Connect to live gold rate socket
  const socket = connectSocket();

  // 3. Refresh catalog every N minutes → picks up new products
  setInterval(async () => {
    console.log(`[Catalog] 🔄 Scheduled refresh (every ${CONFIG.catalogRefreshMs / 60000} min)...`);
    await fetchCatalog();
  }, CONFIG.catalogRefreshMs);

  console.log(`[PriceUpdater] 🚀 Running — catalog refreshes every ${CONFIG.catalogRefreshMs / 60000} minutes`);
  return socket;
}

// ── UTILITY ──────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── EXPORTS ──────────────────────────────────────────────────────
module.exports = { startPriceUpdater, fetchCatalog, calculatePrice };

// ── AUTO-START if run directly ───────────────────────────────────
if (require.main === module) {
  startPriceUpdater().catch(console.error);

  process.on('SIGINT', () => {
    console.log('\n[PriceUpdater] 🛑 Shutting down...');
    process.exit(0);
  });
}