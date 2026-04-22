/**
 * ============================================================
 * shopify-price-updater.js
 * ============================================================
 * Dynamically fetches ALL gold products + variants from Shopify
 * via Admin API, then updates prices in real-time on every
 * market-data socket push.
 *
 * No hardcoded variant IDs — new products are picked up
 * automatically on the next catalog refresh.
 *
 * TWO PRODUCT TYPES — formulas mirror gold-rate.js exactly:
 *
 * JEWELLERY  (is_bullion = false)
 *   rateKarat  = djgRetailRates[karat]              ← DJG retail lookup
 *   goldCost   = goldGrams × rateKarat
 *   diamCost   = diamondCt × 18,000 (AED/ct)
 *   making     = goldCost × (makingPct / 100)       ← gold only (UAE standard)
 *   vatBase    = goldCost + making                   ← diamonds excluded by default
 *   vat        = vatBase × vatRate                   ← 0 if vatExempt
 *   total      = goldCost + diamCost + stoneCost + making + vat
 *
 * BULLION    (is_bullion = true)
 *   rate24kAed = (USD/oz ÷ 31.1035) × usdToAed     ← live socket price
 *   ratePerGram = rate24kAed × bullionPurity[purity]
 *   goldCost   = goldGrams × ratePerGram
 *   vat        = goldCost × vatRate                 ← 0 if vatExempt
 *   total      = goldCost + vat
 *
 * REQUIREMENTS:
 *   Node.js >= 18  (native fetch used throughout)
 *   Add  "engines": { "node": ">=18" }  to package.json so Railway
 *   selects the correct runtime. On older Node, add node-fetch:
 *     const fetch = require('node-fetch');
 *
 * USAGE — standalone:
 *   node shopify-price-updater.js
 *
 * USAGE — as module:
 *   const { startPriceUpdater } = require('./shopify-price-updater');
 *   startPriceUpdater();
 *
 * RATE SYNC NOTE:
 *   POST /rates updates CONFIG.djgRetailRates on THIS server and
 *   triggers a Shopify variant reprice immediately.
 *   gold-rate.js in the browser has its OWN hardcoded djgRetailRates.
 *   To keep the browser in sync, gold-rate.js fetches GET /rates
 *   at startup and overwrites its CONFIG.djgRetailRates.
 * ============================================================
 */

'use strict';

// ── FIX: Node version guard ────────────────────────────────────────
// Native fetch is only available in Node 18+. Fail fast with a clear
// message rather than crashing later with "fetch is not defined".
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 18) {
  console.error(
    '[StartupError] Node.js 18 or higher is required (native fetch).\n' +
    `  Current version: ${process.versions.node}\n` +
    '  Fix: set "engines": { "node": ">=18" } in package.json and redeploy,\n' +
    '  or install node-fetch and add: const fetch = require(\'node-fetch\');'
  );
  process.exit(1);
}

require('dotenv').config();
const http = require('http');
const { io } = require('socket.io-client');

// ── CONFIG ────────────────────────────────────────────────────────
const CONFIG = {

  // Shopify store credentials (set in Railway environment variables)
  shopifyStore: process.env.SHOPIFY_STORE,
  shopifyToken: process.env.SHOPIFY_TOKEN,
  shopifyVersion: '2026-01',

  // Socket.io market data server
  socketUrl: process.env.SOCKET_SERVER_URL,
  secretKey: process.env.SOCKET_SECRET_KEY,

  // ── DJG Retail Rates (AED per gram) ──────────────────────────
  // Source: dubaicityofgold.com — published 3× daily (9 AM / 3 PM / 8 PM UAE)
  // These are the starting/seed values. Update via POST /rates from admin platform.
  // Pre-seed via env var:
  //   DJG_RETAIL_RATES={"24K":582.25,"22K":539.00,"21K":517.00,"18K":443.00,"14K":345.50}
  djgRetailRates: process.env.DJG_RETAIL_RATES
    ? JSON.parse(process.env.DJG_RETAIL_RATES)
    : {
      '24K': 582.25,
      '22K': 539.00,
      '21K': 517.00,
      '18K': 443.00,
      '14K': 345.50,
    },

  // ── Bullion purity map — must match gold-rate.js CONFIG.bullionPurity ──
  bullionPurity: {
    '999.9': 0.9999,
    '0.9999': 0.9999,
    '999.0': 0.999,
    '0.999': 0.999,
    '995.0': 0.995,
    '0.995': 0.995,
    '916.0': 0.916,
    '0.916': 0.916,
    '750.0': 0.750,
    '0.750': 0.750,
  },

  // ── Shared formula constants — must match gold-rate.js exactly ──
  troyOzToGram: 31.1035,
  usdToAed: 3.674,
  diamondRate: 18000,   // AED per carat
  vatRate: 0.05,        // UAE 5% | KSA: 0.15 | Qatar/Kuwait: 0

  // ── Metafield config ──────────────────────────────────────────
  // Must match Shopify metafield setup in Step 1 of the setup guide.
  metafieldNamespace: 'custom',

  metafieldKeys: {
    goldGrams: 'gold_grams',
    diamondCt: 'diamond_ct',
    stoneCost: 'stone_cost_aed',
    makingPct: 'making_charges',
    karat: 'gold_karat',
    vatExempt: 'vat_exempt',
    isBullion: 'is_bullion',  // True/False metafield — true for bullion products
    purity: 'purity',         // e.g. '999.9' — required for bullion products
  },

  // Only push to Shopify if price changed by more than this %
  updateThresholdPct: 0.5,

  // Catalog refresh interval — daily safety net for missed webhooks
  catalogRefreshMs: 24 * 60 * 60 * 1000,

  // Webhook + admin server port (Railway sets PORT automatically)
  webhookPort: process.env.PORT || 3001,

  // Shopify REST API rate limit
  maxCallsPerSecond: 2,
  maxRetries: 3,

  // Admin API auth for POST /rates endpoint.
  // REQUIRED in production — set ADMIN_SECRET in Railway environment variables.
  adminSecret: process.env.ADMIN_SECRET || '',

  // CORS origin for the admin platform.
  // FIX: Set ADMIN_ORIGIN in Railway env vars to your exact admin URL
  // (e.g. https://your-admin.vercel.app). Defaults to '*' only for local dev.
  // With '*', any origin can attempt requests against POST /rates.
  adminOrigin: process.env.ADMIN_ORIGIN || '*',
};

// ── Warn loudly if security-critical env vars are missing ─────────
if (!CONFIG.adminSecret) {
  console.warn('[Config] ⚠️  ADMIN_SECRET is not set — POST /rates is unprotected. Set it in Railway env vars.');
}
if (CONFIG.adminOrigin === '*') {
  console.warn('[Config] ⚠️  ADMIN_ORIGIN is not set — CORS allows all origins. Set it to your admin platform URL in Railway env vars.');
}

// ── STATE ──────────────────────────────────────────────────────────
let variantCache = new Map(); // variantId → product + metafield data
let lastPrice = new Map();    // variantId → last price pushed to Shopify
let catalogReady = false;
let lastFetchTime = null;
let closingPriceSaved = false;
let currentBid = null;         // latest USD/oz bid from socket
let currentOfferUsd = null;    // latest USD/oz offer from socket — used for bullion calculation

// ── SHOPIFY API BASE ───────────────────────────────────────────────
const SHOPIFY_BASE = `https://${CONFIG.shopifyStore}/admin/api/${CONFIG.shopifyVersion}`;


// ============================================================
// JEWELLERY PRICE CALCULATION
// Mirrors gold-rate.js calculate() — default UAE behaviour:
//   making on gold only, VAT base on gold+making only (diamonds excluded).
// ============================================================
function calculateJewellery(meta) {

  // Step 1 — Karat rate: direct DJG retail lookup
  // For karats outside the DJG table (e.g. 10K, 9K), derive from 24K via purity
  let rateKarat;
  if (CONFIG.djgRetailRates[meta.karat]) {
    rateKarat = CONFIG.djgRetailRates[meta.karat];
  } else {
    const karatNum = parseFloat(meta.karat) || 18;
    rateKarat = CONFIG.djgRetailRates['24K'] * (karatNum / 24);
  }

  // Step 2 — Gold value
  const goldCost = meta.goldGrams * rateKarat;

  // Step 3 — Diamond & stone
  const diamCost = (meta.diamondCt || 0) * CONFIG.diamondRate;
  const stoneCost = meta.stoneCost || 0;

  // Step 4 — Making charges on gold only (UAE industry standard)
  const making = goldCost * ((meta.makingPct || 12) / 100);

  // Step 5 — VAT on gold + making (diamonds excluded — UAE standard)
  const vatBase = goldCost + making;
  const vat = meta.vatExempt ? 0 : vatBase * CONFIG.vatRate;

  const total = goldCost + diamCost + stoneCost + making + vat;
  return parseFloat(total.toFixed(2));
}


// ============================================================
// BULLION PRICE CALCULATION
// Mirrors gold-rate.js calculateBullion() — uses live socket price.
// Returns null if socket price not yet available (cold start guard).
// ============================================================
function calculateBullion(meta) {
  // FIX: Guard is intentional — bullion variants are skipped until the first
  // socket tick arrives. repriceAll() logs these skips so they are visible
  // in Railway logs. Jewellery pricing is unaffected and proceeds normally.
  if (!currentOfferUsd) return null;

  const fineness = CONFIG.bullionPurity[meta.purity];
  if (!fineness) {
    console.warn(`[Bullion] ⚠️  Unknown purity '${meta.purity}' for ${meta.productTitle} — skipping`);
    return null;
  }

  const rate24kAed = (currentOfferUsd / CONFIG.troyOzToGram) * CONFIG.usdToAed;
  const ratePerGram = rate24kAed * fineness;
  const goldCost = meta.goldGrams * ratePerGram;
  const vat = meta.vatExempt ? 0 : goldCost * CONFIG.vatRate;
  const total = goldCost + vat;

  return parseFloat(total.toFixed(2));
}


// ============================================================
// UNIFIED PRICE DISPATCHER
// Routes to jewellery or bullion formula based on meta.goldType.
// ============================================================
function calculatePrice(meta) {
  if (meta.goldType === 'bullion') {
    return calculateBullion(meta);
  }
  return calculateJewellery(meta);
}


// ============================================================
// GRAPHQL CATALOG FETCH
// Fetches all products with gold_grams > 0.
// gold_type metafield distinguishes bullion from jewellery.
// ============================================================
async function fetchCatalog() {
  console.log('[Catalog] 🔄 Building product catalog...');

  const newCache = new Map();
  let totalProds = 0;
  let totalVars = 0;
  let bullionCount = 0;

  try {
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const afterClause = cursor ? `, after: "${cursor}"` : '';

      const query = `{
        products(first: 50${afterClause}) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              variants(first: 100) {
                edges { node { id } }
              }
              metafields(first: 20, namespace: "${CONFIG.metafieldNamespace}") {
                edges {
                  node { key value }
                }
              }
            }
          }
        }
      }`;

      const res = await fetch(
        `https://${CONFIG.shopifyStore}/admin/api/${CONFIG.shopifyVersion}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': CONFIG.shopifyToken,
          },
          body: JSON.stringify({ query }),
        }
      );

      if (res.status === 429) {
        const wait = parseFloat(res.headers.get('Retry-After') || '2') * 1000;
        console.warn(`[Shopify] ⏳ Rate limited — waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);

      const json = await res.json();
      const products = json.data?.products;

      if (!products) {
        console.error('[Catalog] ❌ GraphQL error:', JSON.stringify(json.errors));
        break;
      }

      // ── Debug: log raw metafields for first product on first page ──
      // This lets you verify namespace, key names, and API token scope.
      // Remove or disable after confirming catalog loads correctly.
      if (!cursor && products.edges.length > 0) {
        const firstProd = products.edges[0].node;
        const rawMeta = (firstProd.metafields?.edges || []).map(e => e.node);
        console.log(`[Catalog] 🔍 First product: "${firstProd.title}" — metafields returned: ${rawMeta.length}`);
        if (rawMeta.length === 0) {
          console.log(`[Catalog] 🔍 No metafields found. Check: namespace='${CONFIG.metafieldNamespace}', key='${CONFIG.metafieldKeys.goldGrams}', token has read_products scope`);
        } else {
          console.log(`[Catalog] 🔍 Raw metafields: ${JSON.stringify(rawMeta)}`);
        }
      }

      for (const edge of products.edges) {
        const product = edge.node;

        const meta = {};
        for (const mEdge of (product.metafields?.edges || [])) {
          meta[mEdge.node.key] = mEdge.node.value;
        }

        const goldGrams = parseFloat(meta[CONFIG.metafieldKeys.goldGrams] || 0);
        if (!goldGrams) continue;  // skip non-gold products

        totalProds++;

        // Shopify True/False metafield comes through GraphQL as the string 'true' or 'false'
        const isBullion = meta[CONFIG.metafieldKeys.isBullion] === 'true';
        if (isBullion) bullionCount++;

        const numericProductId = parseInt(product.id.split('/').pop());

        const variantMeta = {
          productTitle: product.title,
          productId: numericProductId,
          goldGrams,
          goldType: isBullion ? 'bullion' : 'jewellery',
          // Jewellery fields
          diamondCt: parseFloat(meta[CONFIG.metafieldKeys.diamondCt] || 0),
          stoneCost: parseFloat(meta[CONFIG.metafieldKeys.stoneCost] || 0),
          makingPct: parseFloat(meta[CONFIG.metafieldKeys.makingPct] || 12),
          karat: meta[CONFIG.metafieldKeys.karat] || '22K',
          vatExempt: meta[CONFIG.metafieldKeys.vatExempt] === 'true',
          // Bullion fields
          purity: meta[CONFIG.metafieldKeys.purity] || '999.9',
        };

        for (const vEdge of (product.variants?.edges || [])) {
          const variantId = parseInt(vEdge.node.id.split('/').pop());
          newCache.set(variantId, { ...variantMeta, variantId });
          totalVars++;
        }
      }

      hasNextPage = products.pageInfo.hasNextPage;
      cursor = products.pageInfo.endCursor;

      if (hasNextPage) await sleep(200);
    }

    variantCache = newCache;
    catalogReady = true;
    lastFetchTime = new Date();

    console.log(`[Catalog] ✅ ${totalProds} gold products → ${totalVars} variants loaded`);
    console.log(`[Catalog]    Jewellery: ${totalProds - bullionCount} | Bullion: ${bullionCount}`);
    logCatalogSummary();

  } catch (err) {
    console.error('[Catalog] ❌ Fetch failed:', err.message);
  }
}

function logCatalogSummary() {
  const byProduct = new Map();
  for (const [, v] of variantCache) {
    if (!byProduct.has(v.productTitle)) {
      byProduct.set(v.productTitle, { count: 0, karat: v.karat, grams: v.goldGrams, type: v.goldType });
    }
    byProduct.get(v.productTitle).count++;
  }
  console.log('[Catalog] 📋 Gold products:');
  for (const [title, info] of byProduct) {
    const label = info.type === 'bullion'
      ? `${info.grams}g bullion`
      : `${info.grams}g ${info.karat}`;
    console.log(`  • ${title} — ${label} (${info.count} variant${info.count !== 1 ? 's' : ''})`);
  }
  console.log(`[Catalog] 🕐 Last updated: ${lastFetchTime?.toLocaleTimeString()}`);
}


// ============================================================
// SHOPIFY VARIANT PRICE UPDATE
// ============================================================
async function updateVariantPrice(variantId, newPrice, retries = 0) {
  try {
    const res = await fetch(`${SHOPIFY_BASE}/variants/${variantId}.json`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
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


// ============================================================
// RATE-LIMITED API QUEUE
// ============================================================
const apiQueue = [];
let processing = false;

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


// ============================================================
// MAIN PRICE UPDATE HANDLER
//
// Called in three situations:
//   1. Market tick arrives (TRADEABLE) — reprices all variants
//   2. Market closes — saves closing price once
//   3. POST /rates — DJG rates updated — reprices jewellery only
//
// Bullion variants are skipped (logged) if socket price not yet available.
//
// FIX: Concurrent POST /rates + socket tick note —
//   When POST /rates fires repriceAll({ jewelleryOnly: true }), a concurrent
//   socket tick may also call repriceAll() for bullion. These two calls do
//   not interfere: jewelleryOnly skips bullion, and the socket call uses the
//   latest currentOfferUsd. The only edge case is if the bullion lastPrice
//   entry was just cleared — but bullion lastPrice is never cleared by POST
//   /rates (only jewellery entries are deleted), so there is no conflict.
// ============================================================
function repriceAll(options = {}) {
  if (!catalogReady || variantCache.size === 0) {
    console.warn('[PriceUpdater] ⏳ Catalog not ready — skipping');
    return;
  }

  const jewelleryOnly = options.jewelleryOnly === true;
  let updateCount = 0;
  let skipCount = 0;

  for (const [variantId, meta] of variantCache) {

    // If triggered by a DJG rate update, skip bullion — their price is socket-driven
    if (jewelleryOnly && meta.goldType === 'bullion') continue;

    const newPrice = calculatePrice(meta);

    // Bullion returns null if socket not connected yet — skip gracefully
    if (newPrice === null) {
      skipCount++;
      continue;
    }

    const last = lastPrice.get(variantId);
    const changePct = last ? Math.abs((newPrice - last) / last) * 100 : 100;

    if (changePct >= CONFIG.updateThresholdPct) {
      lastPrice.set(variantId, newPrice);
      enqueue(variantId, newPrice);
      updateCount++;
    }
  }

  const parts = [`${updateCount}/${variantCache.size} variants queued`];
  if (skipCount > 0) parts.push(`${skipCount} bullion skipped (no socket price yet)`);
  if (updateCount === 0 && skipCount === 0) {
    parts.length = 0;
    parts.push(`no change (< ${CONFIG.updateThresholdPct}% threshold)`);
  }

  const label = jewelleryOnly ? '💰 DJG rate change' : '📈 Market tick';
  console.log(`[PriceUpdater] ${label} → ${parts.join(' | ')}`);
}


// ============================================================
// SOCKET CONNECTION
//
// For jewellery: socket status drives open/close reprice trigger.
//   The actual price formula uses DJG rates, NOT the bid/offer.
//
// For bullion: currentOfferUsd is updated on every tick and used
//   directly in calculateBullion().
// ============================================================
function connectSocket() {
  console.log('[Socket] Connecting to market data server...');

  const socket = io(CONFIG.socketUrl, {
    query: { secret: CONFIG.secretKey },
    transports: ['websocket'],
    withCredentials: true,
    reconnection: true,
    reconnectionDelay: 1000,
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

    // Always capture live price for bullion calculations
    currentBid = data.bid;
    currentOfferUsd = data.offer;

    if (data.marketStatus === 'TRADEABLE') {
      closingPriceSaved = false;
      repriceAll();  // jewellery uses DJG rates; bullion uses currentOfferUsd

    } else if (data.marketStatus === 'CLOSED' || data.marketStatus === 'WEEKEND') {
      // Save closing price once — no more ticks come after market closes
      if (!closingPriceSaved) {
        closingPriceSaved = true;
        console.log(`[PriceUpdater] 🔔 Market ${data.marketStatus} — saving closing prices`);
        repriceAll();
      }
    }
  });

  socket.on('disconnect', (reason) => {
    console.warn('[Socket] 🔌 Disconnected:', reason, '— will auto-reconnect');
  });

  socket.on('connect_error', (err) => {
    console.error('[Socket] ❌ Error:', err.message);
  });

  return socket;
}


// ============================================================
// WEBHOOK + ADMIN SERVER
//
// Endpoints:
//
//   GET  /health    — Railway health check + full status JSON
//   POST /refresh   — Force catalog reload (Shopify product webhooks)
//   GET  /rates     — Read current DJG retail rates
//                     gold-rate.js calls this at startup to stay in sync
//   POST /rates     — Update DJG rates from admin platform
//                     Triggers immediate reprice of ALL jewellery variants.
//                     Does NOT affect bullion (bullion price is socket-driven).
//   GET  /debug     — Raw metafield inspection (use when catalog shows 0 products)
//
// Shopify webhooks (Admin → Settings → Notifications):
//   Product creation → POST https://your-url.railway.app/refresh
//   Product update   → POST https://your-url.railway.app/refresh
//
// POST /rates payload:
//   Authorization: Bearer <ADMIN_SECRET>
//   { "rates": { "24K": 582.25, "22K": 539.00, "21K": 517.00, "18K": 443.00, "14K": 345.50 } }
//
// Required Railway environment variables:
//   SHOPIFY_STORE      — mystore.myshopify.com
//   SHOPIFY_TOKEN      — shpat_…
//   SOCKET_SERVER_URL  — wss://…
//   SOCKET_SECRET_KEY  — …
//   ADMIN_SECRET       — strong random string (protects POST /rates)
//   ADMIN_ORIGIN       — https://your-admin.vercel.app (restricts CORS for POST /rates)
//   PORT               — set automatically by Railway
//   DJG_RETAIL_RATES   — optional JSON seed (see CONFIG above)
// ============================================================
function startWebhookServer() {
  const server = http.createServer(async (req, res) => {

    // FIX: Use specific ADMIN_ORIGIN instead of wildcard '*' in production.
    // Set ADMIN_ORIGIN in Railway env vars to your admin platform URL.
    res.setHeader('Access-Control-Allow-Origin', CONFIG.adminOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── GET /health ───────────────────────────────────────────
    if ((req.url === '/' || req.url === '/health') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        variants: variantCache.size,
        jewelleryVariants: [...variantCache.values()].filter(v => v.goldType !== 'bullion').length,
        bullionVariants: [...variantCache.values()].filter(v => v.goldType === 'bullion').length,
        catalogReady,
        lastFetch: lastFetchTime?.toISOString() || null,
        currentBidUsd: currentBid,
        currentOfferUsd: currentOfferUsd,
        djgRetailRates: CONFIG.djgRetailRates,
        ratesUpdatedAt: CONFIG._ratesUpdatedAt || null,
        nodeVersion: process.versions.node,
      }));
      return;
    }

    // ── POST /refresh — catalog reload ────────────────────────
    if (req.url === '/refresh' && req.method === 'POST') {
      console.log('[Webhook] 🔔 Refresh triggered — reloading catalog...');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'refreshing' }));
      fetchCatalog().catch(console.error);
      return;
    }

    // ── GET /rates — read current DJG rates ───────────────────
    // gold-rate.js calls this at startup to stay in sync with the server.
    if (req.url === '/rates' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        djgRetailRates: CONFIG.djgRetailRates,
        updatedAt: CONFIG._ratesUpdatedAt || null,
      }));
      return;
    }

    // ── GET /debug — raw metafield inspection ─────────────────
    // Fetches first 3 products from Shopify and returns their raw
    // metafields so you can verify namespace, key names, and values.
    // Use this when catalog shows 0 gold products.
    // Example: GET https://your-url.railway.app/debug
    if (req.url === '/debug' && req.method === 'GET') {
      try {
        const query = `{
          products(first: 3) {
            edges {
              node {
                id
                title
                metafields(first: 20, namespace: "${CONFIG.metafieldNamespace}") {
                  edges { node { namespace key value type } }
                }
              }
            }
          }
        }`;

        const r = await fetch(
          `https://${CONFIG.shopifyStore}/admin/api/${CONFIG.shopifyVersion}/graphql.json`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': CONFIG.shopifyToken,
            },
            body: JSON.stringify({ query }),
          }
        );

        const json = await r.json();

        // Also fetch without namespace filter to show ALL metafields on first product
        const queryAll = `{
          products(first: 1) {
            edges {
              node {
                title
                metafields(first: 30) {
                  edges { node { namespace key value type } }
                }
              }
            }
          }
        }`;

        const rAll = await fetch(
          `https://${CONFIG.shopifyStore}/admin/api/${CONFIG.shopifyVersion}/graphql.json`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': CONFIG.shopifyToken,
            },
            body: JSON.stringify({ query: queryAll }),
          }
        );
        const jsonAll = await rAll.json();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          hint: `Namespace filter used: '${CONFIG.metafieldNamespace}', goldGrams key: '${CONFIG.metafieldKeys.goldGrams}'`,
          filteredByNamespace: json.data?.products?.edges?.map(e => ({
            title: e.node.title,
            metafields: e.node.metafields?.edges?.map(m => m.node),
          })),
          allMetafieldsFirstProduct: jsonAll.data?.products?.edges?.[0]?.node,
          graphqlErrors: json.errors || jsonAll.errors || null,
        }, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── POST /rates — update DJG rates from admin platform ────
    // Updates this server's CONFIG.djgRetailRates and immediately
    // reprices all jewellery variants in Shopify.
    // Bullion variants are NOT repriced here — they update on next socket tick.
    if (req.url === '/rates' && req.method === 'POST') {

      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace('Bearer ', '').trim();

      if (CONFIG.adminSecret && token !== CONFIG.adminSecret) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);

          if (!payload.rates || typeof payload.rates !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing rates object' }));
            return;
          }

          // Validate each rate value
          const requiredKarats = ['24K', '22K', '21K', '18K', '14K'];
          for (const k of requiredKarats) {
            if (typeof payload.rates[k] !== 'number' || payload.rates[k] <= 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Invalid rate for ${k}` }));
              return;
            }
          }

          // Apply new rates
          const old = { ...CONFIG.djgRetailRates };
          CONFIG.djgRetailRates = { ...CONFIG.djgRetailRates, ...payload.rates };
          CONFIG._ratesUpdatedAt = new Date().toISOString();

          // Clear lastPrice cache for jewellery only — forces reprice against new rates.
          // Bullion lastPrice is intentionally preserved; bullion prices are socket-driven
          // and will reprice on the next market tick regardless.
          for (const [variantId, meta] of variantCache) {
            if (meta.goldType !== 'bullion') lastPrice.delete(variantId);
          }

          console.log('[Rates] 🔄 DJG retail rates updated:');
          for (const k of Object.keys(payload.rates)) {
            const changed = old[k] !== payload.rates[k];
            console.log(`  ${k}: ${old[k]} → ${payload.rates[k]}${changed ? ' ✱' : ''}`);
          }

          // Trigger immediate reprice of jewellery variants only
          if (catalogReady) {
            console.log('[Rates] ⚡ Repricing jewellery variants...');
            repriceAll({ jewelleryOnly: true });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'updated',
            djgRetailRates: CONFIG.djgRetailRates,
            updatedAt: CONFIG._ratesUpdatedAt,
          }));

        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(CONFIG.webhookPort, () => {
    console.log(`[Server] 🌐 Listening on port ${CONFIG.webhookPort}`);
    console.log(`[Server] Health check: GET  /health`);
    console.log(`[Server] Catalog sync: POST /refresh`);
    console.log(`[Server] Read rates:   GET  /rates`);
    console.log(`[Server] Update rates: POST /rates  (Authorization: Bearer <ADMIN_SECRET>)`);
    console.log(`[Server] Debug:        GET  /debug  ← use if catalog shows 0 products`);
    console.log(`[Server] CORS origin:  ${CONFIG.adminOrigin}`);
  });

  return server;
}


// ============================================================
// UTILITY
// ============================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ============================================================
// STARTUP
// ============================================================
async function startPriceUpdater() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Shopify Live Gold Price Updater                        ║');
  console.log('║   Jewellery: DJG retail rates                            ║');
  console.log('║   Bullion:   Live socket price                           ║');
  console.log(`║   Store: ${(CONFIG.shopifyStore || 'not set').padEnd(48)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`[Config] Node.js: ${process.versions.node}`);
  console.log(`[Config] DJG rates: 24K=${CONFIG.djgRetailRates['24K']} 22K=${CONFIG.djgRetailRates['22K']} 21K=${CONFIG.djgRetailRates['21K']} 18K=${CONFIG.djgRetailRates['18K']} 14K=${CONFIG.djgRetailRates['14K']}`);
  console.log(`[Config] Update threshold: ${CONFIG.updateThresholdPct}%`);
  console.log(`[Config] VAT rate: ${CONFIG.vatRate * 100}%`);
  console.log(`[Config] usdToAed: ${CONFIG.usdToAed}`);
  console.log(`[Config] CORS origin: ${CONFIG.adminOrigin}`);
  console.log('');

  startWebhookServer();
  await fetchCatalog();
  connectSocket();

  setInterval(async () => {
    console.log('[Catalog] 🕐 Daily scheduled refresh...');
    await fetchCatalog();
  }, CONFIG.catalogRefreshMs);

  console.log('');
  console.log('[PriceUpdater] 🚀 Running — waiting for market ticks...');
  console.log('');
}


// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  startPriceUpdater,
  fetchCatalog,
  calculateJewellery,
  calculateBullion,
  calculatePrice,
  repriceAll,
};


// ============================================================
// AUTO-START
// ============================================================
if (require.main === module) {
  startPriceUpdater().catch(console.error);

  process.on('SIGINT', () => {
    console.log('\n[PriceUpdater] 🛑 Shutting down gracefully...');
    process.exit(0);
  });
}