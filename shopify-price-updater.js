/**
 * ============================================================
 * shopify-price-updater.js — Railway server
 * ============================================================
 * Single source of truth for ALL gold/bullion/silver price maths.
 *
 * Serves two consumers:
 *   1. Shopify checkout  — variant prices updated via REST API
 *   2. Browser storefront — gold-rate.js calls GET /price per card
 *
 * Because both consumers call the same calculateJewellery() /
 * calculateBullion() / calculateSilver() functions, the price
 * shown on the product page is always identical to the checkout price.
 *
 * ROUNDING POLICY:
 *   Every intermediate value is computed in full floating-point.
 *   Only the FINAL total returned to Shopify / to the browser is
 *   rounded to the nearest whole AED (Math.round).
 *   Sub-totals in GET /price responses (goldCost, making, vat …)
 *   are also rounded to whole AED for display consistency.
 *
 * TWO PRODUCT TYPES — formulas:
 *
 * JEWELLERY  (type = jewellery)
 *   rateKarat  = djgRetailRates[karat]              ← DJG retail lookup
 *   goldCost   = goldGrams × rateKarat
 *   diamCost   = diamondCt × 18,000 (AED/ct)
 *   making     = goldCost × (makingPct / 100)       ← gold only (UAE standard)
 *                set makingOnTotal=1 to apply on gold+diamond+stone
 *   vatBase    = goldCost + making                   ← diamonds excluded by default
 *                set vatOnAll=1 to include diamond+stone in VAT base
 *   vat        = vatBase × vatRate                   ← 0 if vatExempt=1
 *   total      = goldCost + diamCost + stoneCost + making + vat
 *   → ALL values rounded to whole AED
 *
 * BULLION    (type = bullion)
 *   rate24kAed  = (USD/oz ÷ 31.1035) × usdToAed    ← live socket price
 *   ratePerGram = rate24kAed × bullionPurity[purity]
 *   goldCost    = goldGrams × ratePerGram
 *   vat         = goldCost × vatRate                ← 0 if vatExempt=1
 *   total       = goldCost + vat
 *   → ALL values rounded to whole AED
 *
 * SILVER     (type = silver)
 *   silverCost  = silverGrams × (USD/oz ÷ 31.1035) × usdToAed
 *   vat         = silverCost × vatRate              ← 0 if vatExempt=1
 *   total       = silverCost + vat
 *   → ALL values rounded to whole AED
 *
 * ENDPOINTS:
 *   GET  /health    — status + variant counts + current rates
 *   GET  /price     — calculate price for one product (browser use)
 *   GET  /rates     — read current DJG retail rates
 *   POST /rates     — update DJG rates + reprice Shopify variants immediately
 *   POST /refresh   — force catalog reload (Shopify product webhooks)
 *   GET  /debug     — raw metafield dump (troubleshooting)
 *
 * REQUIREMENTS: Node.js >= 18 (native fetch).
 *   Set "engines": { "node": ">=18" } in package.json.
 * ============================================================
 */

'use strict';

// ── Node version guard ─────────────────────────────────────────────
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 18) {
  console.error(
    '[StartupError] Node.js 18+ required (native fetch).\n' +
    `  Current: ${process.versions.node}\n` +
    '  Fix: set "engines": { "node": ">=18" } in package.json and redeploy.'
  );
  process.exit(1);
}

require('dotenv').config();
const http = require('http');
const { io } = require('socket.io-client');

// ── CONFIG ────────────────────────────────────────────────────────
const CONFIG = {

  shopifyStore: process.env.SHOPIFY_STORE,
  shopifyToken: process.env.SHOPIFY_TOKEN,
  shopifyVersion: '2026-01',

  socketUrl: process.env.SOCKET_SERVER_URL,
  secretKey: process.env.SOCKET_SECRET_KEY,

  // ── DJG Retail Rates (AED per gram) ──────────────────────────
  // Seed values — updated at runtime via POST /rates.
  // Pre-seed via env: DJG_RETAIL_RATES={"24K":582.25,"22K":539.00,...}
  djgRetailRates: process.env.DJG_RETAIL_RATES
    ? JSON.parse(process.env.DJG_RETAIL_RATES)
    : { '24K': 582.25, '22K': 539.00, '21K': 517.00, '18K': 443.00, '14K': 345.50 },

  // ── Bullion purity map ────────────────────────────────────────
  bullionPurity: {
    '999.9': 0.9999, '0.9999': 0.9999,
    '999.0': 0.999, '0.999': 0.999,
    '995.0': 0.995, '0.995': 0.995,
    '916.0': 0.916, '0.916': 0.916,
    '750.0': 0.750, '0.750': 0.750,
  },

  // ── Formula constants ─────────────────────────────────────────
  troyOzToGram: 31.1035,
  usdToAed: 3.674,
  diamondRate: 18000,   // AED per carat
  vatRate: 0.05,    // UAE 5% | KSA: 0.15 | Qatar/Kuwait: 0

  // ── Metafield keys ────────────────────────────────────────────
  metafieldNamespace: 'custom',
  metafieldKeys: {
    goldGrams: 'gold_grams',
    diamondCt: 'diamond_ct',
    stoneCost: 'stone_cost_aed',
    makingPct: 'making_charges',
    karat: 'gold_karat',
    vatExempt: 'vat_exempt',
    isBullion: 'is_bullion',
    purity: 'purity',
  },

  updateThresholdPct: 0.5,           // skip Shopify update if price moved < 0.5%
  catalogRefreshMs: 24 * 60 * 60 * 1000,
  webhookPort: process.env.PORT || 3001,
  maxCallsPerSecond: 2,
  maxRetries: 3,

  adminSecret: process.env.ADMIN_SECRET || '',
  adminOrigin: process.env.ADMIN_ORIGIN || '*',
};

// ── Warn on missing security env vars ─────────────────────────────
if (!CONFIG.adminSecret) {
  console.warn('[Config] ⚠️  ADMIN_SECRET not set — POST /rates is unprotected.');
}
if (CONFIG.adminOrigin === '*') {
  console.warn('[Config] ⚠️  ADMIN_ORIGIN not set — CORS allows all origins.');
}

// ── STATE ──────────────────────────────────────────────────────────
let variantCache = new Map();  // variantId → metafield data
let lastPrice = new Map();  // variantId → last pushed price
let catalogReady = false;
let lastFetchTime = null;
let closingPriceSaved = false;
let currentBidUsd = null;       // latest USD/oz bid from socket
let currentOfferUsd = null;       // latest USD/oz offer from socket
let currentSilverUsd = null;       // latest silver USD/oz offer from socket

const SHOPIFY_BASE = `https://${CONFIG.shopifyStore}/admin/api/${CONFIG.shopifyVersion}`;


// ============================================================
// PRICE CALCULATIONS
//
// ROUNDING POLICY:
//   All intermediate values stay as full floats.
//   The final total — and every sub-total in the returned object —
//   is rounded to the nearest whole AED with Math.round().
//   This ensures the browser display and Shopify checkout are
//   always identical integers with no floating-point drift.
// ============================================================

// ── Jewellery ─────────────────────────────────────────────────────
function calculateJewellery(meta) {
  // Karat rate — DJG retail lookup; derive non-table karats from 24K
  let rateKarat;
  if (CONFIG.djgRetailRates[meta.karat]) {
    rateKarat = CONFIG.djgRetailRates[meta.karat];
  } else {
    const k = parseFloat(meta.karat) || 18;
    rateKarat = CONFIG.djgRetailRates['24K'] * (k / 24);
  }

  const goldCost = (meta.goldGrams || 0) * rateKarat;
  const diamCost = (meta.diamondCt || 0) * CONFIG.diamondRate;
  const stoneCost = meta.stoneCost || 0;

  // Making base: gold only (UAE standard) unless makingOnTotal is set
  const makingBase = meta.makingOnTotal ? (goldCost + diamCost + stoneCost) : goldCost;
  const making = makingBase * ((meta.makingPct || 12) / 100);

  // VAT base: gold + making by default (diamonds excluded — UAE standard)
  // unless vatOnAll is set
  const vatBase = meta.vatOnAll
    ? (goldCost + diamCost + stoneCost + making)
    : (goldCost + making);
  const vat = meta.vatExempt ? 0 : vatBase * CONFIG.vatRate;
  const total = goldCost + diamCost + stoneCost + making + vat;

  return {
    total: Math.round(total),
    goldCost: Math.round(goldCost),
    diamCost: Math.round(diamCost),
    stoneCost: Math.round(stoneCost),
    making: Math.round(making),
    vat: Math.round(vat),
    rateKarat: Math.round(rateKarat),   // whole AED/g for display
  };
}

// ── Bullion ───────────────────────────────────────────────────────
// Returns null if live socket price not yet available (cold start).
function calculateBullion(meta) {
  if (!currentOfferUsd) return null;

  const fineness = CONFIG.bullionPurity[meta.purity];
  if (!fineness) {
    console.warn(`[Bullion] Unknown purity '${meta.purity}' for ${meta.productTitle}`);
    return null;
  }

  const rate24kAed = (currentOfferUsd / CONFIG.troyOzToGram) * CONFIG.usdToAed;
  const ratePerGram = rate24kAed * fineness;
  const goldCost = (meta.goldGrams || 0) * ratePerGram;
  const vat = meta.vatExempt ? 0 : goldCost * CONFIG.vatRate;
  const total = goldCost + vat;

  return {
    total: Math.round(total),
    goldCost: Math.round(goldCost),
    vat: Math.round(vat),
    ratePerGram: Math.round(ratePerGram),  // whole AED/g for display
    rate24kAed: Math.round(rate24kAed),
    fineness,
    rawUsdOz: Math.round(currentOfferUsd * 100) / 100,  // 2dp USD
  };
}

// ── Silver ────────────────────────────────────────────────────────
// Returns null if live socket price not yet available.
function calculateSilver(meta) {
  if (!currentSilverUsd) return null;

  const rate = (currentSilverUsd / CONFIG.troyOzToGram) * CONFIG.usdToAed;
  const cost = (meta.silverGrams || 0) * rate;
  const vat = meta.vatExempt ? 0 : cost * CONFIG.vatRate;
  const total = cost + vat;

  return {
    total: Math.round(total),
    silverCost: Math.round(cost),
    vat: Math.round(vat),
    ratePerGram: Math.round(rate),
    rawUsdOz: Math.round(currentSilverUsd * 100) / 100,
  };
}

// ── Dispatcher for variant cache (Shopify reprice) ────────────────
function calculatePrice(meta) {
  if (meta.goldType === 'bullion') return calculateBullion(meta);
  if (meta.goldType === 'silver') return calculateSilver(meta);
  return calculateJewellery(meta);
}


// ============================================================
// GRAPHQL CATALOG FETCH
// ============================================================
async function fetchCatalog() {
  console.log('[Catalog] 🔄 Building product catalog...');

  const newCache = new Map();
  let totalProds = 0, totalVars = 0, bullionCount = 0;

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
              id title
              variants(first: 100) { edges { node { id } } }
              metafields(first: 20, namespace: "${CONFIG.metafieldNamespace}") {
                edges { node { key value } }
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

      // Debug log on first page
      if (!cursor && products.edges.length > 0) {
        const fp = products.edges[0].node;
        const rawMeta = (fp.metafields?.edges || []).map(e => e.node);
        console.log(`[Catalog] 🔍 "${fp.title}" — ${rawMeta.length} metafields`);
        if (!rawMeta.length) {
          console.log(`[Catalog] 🔍 None found. Check namespace='${CONFIG.metafieldNamespace}' and token scope.`);
        } else {
          console.log(`[Catalog] 🔍 Raw: ${JSON.stringify(rawMeta)}`);
        }
      }

      for (const edge of products.edges) {
        const product = edge.node;
        const meta = {};
        for (const m of (product.metafields?.edges || [])) {
          meta[m.node.key] = m.node.value;
        }

        const goldGrams = parseFloat(meta[CONFIG.metafieldKeys.goldGrams] || 0);
        if (!goldGrams) continue;

        totalProds++;
        const isBullion = meta[CONFIG.metafieldKeys.isBullion] === 'true';
        if (isBullion) bullionCount++;

        const numericProductId = parseInt(product.id.split('/').pop());

        const variantMeta = {
          productTitle: product.title,
          productId: numericProductId,
          goldGrams,
          goldType: isBullion ? 'bullion' : 'jewellery',
          diamondCt: parseFloat(meta[CONFIG.metafieldKeys.diamondCt] || 0),
          stoneCost: parseFloat(meta[CONFIG.metafieldKeys.stoneCost] || 0),
          makingPct: parseFloat(meta[CONFIG.metafieldKeys.makingPct] || 12),
          karat: meta[CONFIG.metafieldKeys.karat] || '22K',
          vatExempt: meta[CONFIG.metafieldKeys.vatExempt] === 'true',
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

    console.log(`[Catalog] ✅ ${totalProds} products → ${totalVars} variants`);
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
    const label = info.type === 'bullion' ? `${info.grams}g bullion` : `${info.grams}g ${info.karat}`;
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
      body: JSON.stringify({ variant: { id: variantId, price: newPrice.toFixed(2) } }),
    });

    if (res.status === 429) {
      const wait = parseFloat(res.headers.get('Retry-After') || '1') * 1000;
      console.warn(`[Shopify] ⏳ Rate limited — waiting ${wait}ms`);
      await sleep(wait);
      return updateVariantPrice(variantId, newPrice, retries);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);

    const meta = variantCache.get(variantId);
    console.log(`[Shopify] ✅ ${meta?.productTitle} (${variantId}) → AED ${newPrice}`);

  } catch (err) {
    if (retries < CONFIG.maxRetries) {
      const wait = Math.pow(2, retries) * 1000;
      console.warn(`[Shopify] ⚠️  Retry ${retries + 1}/${CONFIG.maxRetries} for ${variantId} in ${wait}ms`);
      await sleep(wait);
      return updateVariantPrice(variantId, newPrice, retries + 1);
    }
    console.error(`[Shopify] ❌ Gave up on ${variantId}:`, err.message);
  }
}


// ── Rate-limited API queue ─────────────────────────────────────────
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
// REPRICE ALL VARIANTS
// ============================================================
function repriceAll(options = {}) {
  if (!catalogReady || variantCache.size === 0) {
    console.warn('[PriceUpdater] ⏳ Catalog not ready — skipping');
    return;
  }

  const jewelleryOnly = options.jewelleryOnly === true;
  let updateCount = 0, skipCount = 0;

  for (const [variantId, meta] of variantCache) {
    if (jewelleryOnly && meta.goldType !== 'jewellery') continue;

    const result = calculatePrice(meta);
    if (result === null) { skipCount++; continue; }

    const newPrice = result.total;  // already a whole AED integer
    const last = lastPrice.get(variantId);
    const changePct = last ? Math.abs((newPrice - last) / last) * 100 : 100;

    if (changePct >= CONFIG.updateThresholdPct) {
      lastPrice.set(variantId, newPrice);
      enqueue(variantId, newPrice);
      updateCount++;
    }
  }

  const parts = [`${updateCount}/${variantCache.size} variants queued`];
  if (skipCount > 0) parts.push(`${skipCount} skipped (no live price yet)`);
  if (!updateCount && !skipCount) parts.splice(0, 1, `no change (< ${CONFIG.updateThresholdPct}% threshold)`);

  const label = jewelleryOnly ? '💰 DJG rate change' : '📈 Market tick';
  console.log(`[PriceUpdater] ${label} → ${parts.join(' | ')}`);
}


// ============================================================
// SOCKET CONNECTION
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
    console.log('[Socket] ✅ Connected');
    socket.emit('request-data', ['GOLD', 'SILVER']);
  });

  socket.on('market-data', (data) => {
    const symbol = data?.symbol?.toUpperCase();

    if (symbol === 'GOLD') {
      currentBidUsd = data.bid;
      currentOfferUsd = data.offer;

      if (data.marketStatus === 'TRADEABLE') {
        closingPriceSaved = false;
        repriceAll();

      } else if (!closingPriceSaved) {
        closingPriceSaved = true;
        console.log(`[PriceUpdater] 🔔 Market ${data.marketStatus} — saving closing prices`);
        repriceAll();
      }
    }

    if (symbol === 'SILVER') {
      currentSilverUsd = data.offer;
      // Reprice silver variants on every tick (like bullion)
      repriceAll();
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
// HTTP SERVER
//
// Required Railway environment variables:
//   SHOPIFY_STORE      mystore.myshopify.com
//   SHOPIFY_TOKEN      shpat_…
//   SOCKET_SERVER_URL  wss://…
//   SOCKET_SECRET_KEY  …
//   ADMIN_SECRET       strong random string (protects POST /rates)
//   ADMIN_ORIGIN       https://your-admin.vercel.app
//   PORT               set automatically by Railway
//   DJG_RETAIL_RATES   optional JSON seed
// ============================================================
function startWebhookServer() {
  const server = http.createServer(async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin', CONFIG.adminOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost`);

    // ── GET /health ──────────────────────────────────────────
    if ((url.pathname === '/' || url.pathname === '/health') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        variants: variantCache.size,
        jewelleryVariants: [...variantCache.values()].filter(v => v.goldType === 'jewellery').length,
        bullionVariants: [...variantCache.values()].filter(v => v.goldType === 'bullion').length,
        silverVariants: [...variantCache.values()].filter(v => v.goldType === 'silver').length,
        catalogReady,
        lastFetch: lastFetchTime?.toISOString() || null,
        currentBidUsd,
        currentOfferUsd,
        currentSilverUsd,
        djgRetailRates: CONFIG.djgRetailRates,
        ratesUpdatedAt: CONFIG._ratesUpdatedAt || null,
        nodeVersion: process.versions.node,
      }));
      return;
    }

    // ── GET /price — browser card price calculator ────────────
    //
    // Query params:
    //   type        jewellery | bullion | silver
    //
    //   jewellery:
    //     grams     gold weight
    //     karat     22K | 21K | 18K | 14K | 24K
    //     diamond   diamond carats (optional, default 0)
    //     stone     stone cost AED (optional, default 0)
    //     making    making % (optional, default 12)
    //     vatExempt 1 | 0 (optional, default 0)
    //     makingOnTotal  1 | 0 (optional, default 0)
    //     vatOnAll       1 | 0 (optional, default 0)
    //
    //   bullion:
    //     grams     gold weight
    //     purity    999.9 | 999.0 | 995.0 | 916.0 | 750.0
    //     vatExempt 1 | 0
    //
    //   silver:
    //     grams     silver weight
    //     vatExempt 1 | 0
    //
    // Response: JSON with total + sub-totals, all whole AED integers.
    // ─────────────────────────────────────────────────────────
    if (url.pathname === '/price' && req.method === 'GET') {
      const p = url.searchParams;
      const type = (p.get('type') || 'jewellery').toLowerCase();

      let result;

      if (type === 'bullion') {
        result = calculateBullion({
          goldGrams: parseFloat(p.get('grams') || 0),
          purity: p.get('purity') || '999.9',
          vatExempt: p.get('vatExempt') === '1',
        });
        if (!result) {
          // No live socket price yet — return 0 so card shows nothing rather than crashing
          result = {
            total: 0, goldCost: 0, vat: 0, ratePerGram: 0,
            rate24kAed: 0, fineness: 0, rawUsdOz: 0
          };
        }

      } else if (type === 'silver') {
        result = calculateSilver({
          silverGrams: parseFloat(p.get('grams') || 0),
          vatExempt: p.get('vatExempt') === '1',
        });
        if (!result) {
          result = { total: 0, silverCost: 0, vat: 0, ratePerGram: 0, rawUsdOz: 0 };
        }

      } else {
        // jewellery (default)
        result = calculateJewellery({
          goldGrams: parseFloat(p.get('grams') || 0),
          karat: p.get('karat') || '22K',
          diamondCt: parseFloat(p.get('diamond') || 0),
          stoneCost: parseFloat(p.get('stone') || 0),
          makingPct: parseFloat(p.get('making') || 12),
          vatExempt: p.get('vatExempt') === '1',
          makingOnTotal: p.get('makingOnTotal') === '1',
          vatOnAll: p.get('vatOnAll') === '1',
        });
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(result));
      return;
    }

    // ── GET /rates ────────────────────────────────────────────
    if (url.pathname === '/rates' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        djgRetailRates: CONFIG.djgRetailRates,
        updatedAt: CONFIG._ratesUpdatedAt || null,
      }));
      return;
    }

    // ── POST /refresh ─────────────────────────────────────────
    if (url.pathname === '/refresh' && req.method === 'POST') {
      console.log('[Webhook] 🔔 Refresh triggered');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'refreshing' }));
      fetchCatalog().catch(console.error);
      return;
    }

    // ── GET /debug ────────────────────────────────────────────
    if (url.pathname === '/debug' && req.method === 'GET') {
      try {
        const query = `{
          products(first: 3) {
            edges { node { id title
              metafields(first: 20, namespace: "${CONFIG.metafieldNamespace}") {
                edges { node { namespace key value type } }
              }
            }}
          }
        }`;
        const queryAll = `{
          products(first: 1) {
            edges { node { title
              metafields(first: 30) {
                edges { node { namespace key value type } }
              }
            }}
          }
        }`;
        const headers = {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': CONFIG.shopifyToken,
        };
        const endpoint = `https://${CONFIG.shopifyStore}/admin/api/${CONFIG.shopifyVersion}/graphql.json`;
        const [r1, r2] = await Promise.all([
          fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query }) }),
          fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query: queryAll }) }),
        ]);
        const [j1, j2] = await Promise.all([r1.json(), r2.json()]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          hint: `namespace='${CONFIG.metafieldNamespace}' key='${CONFIG.metafieldKeys.goldGrams}'`,
          filteredByNamespace: j1.data?.products?.edges?.map(e => ({
            title: e.node.title,
            metafields: e.node.metafields?.edges?.map(m => m.node),
          })),
          allMetafieldsFirstProduct: j2.data?.products?.edges?.[0]?.node,
          graphqlErrors: j1.errors || j2.errors || null,
        }, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── POST /rates ───────────────────────────────────────────
    if (url.pathname === '/rates' && req.method === 'POST') {
      const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
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

          const required = ['24K', '22K', '21K', '18K', '14K'];
          for (const k of required) {
            if (typeof payload.rates[k] !== 'number' || payload.rates[k] <= 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Invalid rate for ${k}` }));
              return;
            }
          }

          const old = { ...CONFIG.djgRetailRates };
          CONFIG.djgRetailRates = { ...CONFIG.djgRetailRates, ...payload.rates };
          CONFIG._ratesUpdatedAt = new Date().toISOString();

          // Clear lastPrice for jewellery only (bullion/silver are socket-driven)
          for (const [variantId, meta] of variantCache) {
            if (meta.goldType === 'jewellery') lastPrice.delete(variantId);
          }

          console.log('[Rates] 🔄 DJG rates updated:');
          for (const k of Object.keys(payload.rates)) {
            console.log(`  ${k}: ${old[k]} → ${payload.rates[k]}${old[k] !== payload.rates[k] ? ' ✱' : ''}`);
          }

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
    console.log(`[Server] 🌐 Port ${CONFIG.webhookPort}`);
    console.log(`[Server] GET  /health   — status`);
    console.log(`[Server] GET  /price    — browser card price (single source of truth)`);
    console.log(`[Server] GET  /rates    — read DJG rates`);
    console.log(`[Server] POST /rates    — update DJG rates + reprice Shopify`);
    console.log(`[Server] POST /refresh  — reload catalog`);
    console.log(`[Server] GET  /debug    — metafield dump`);
    console.log(`[Server] CORS origin:   ${CONFIG.adminOrigin}`);
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
  console.log('║   Single source of truth for all price calculations      ║');
  console.log(`║   Store: ${(CONFIG.shopifyStore || 'not set').padEnd(48)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`[Config] Node.js: ${process.versions.node}`);
  console.log(`[Config] DJG rates: 24K=${CONFIG.djgRetailRates['24K']} 22K=${CONFIG.djgRetailRates['22K']} 21K=${CONFIG.djgRetailRates['21K']} 18K=${CONFIG.djgRetailRates['18K']} 14K=${CONFIG.djgRetailRates['14K']}`);
  console.log(`[Config] VAT rate: ${CONFIG.vatRate * 100}%  |  usdToAed: ${CONFIG.usdToAed}  |  threshold: ${CONFIG.updateThresholdPct}%`);
  console.log(`[Config] CORS origin: ${CONFIG.adminOrigin}`);
  console.log('');

  startWebhookServer();
  await fetchCatalog();
  connectSocket();

  setInterval(async () => {
    console.log('[Catalog] 🕐 Daily scheduled refresh...');
    await fetchCatalog();
  }, CONFIG.catalogRefreshMs);

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
  calculateSilver,
  calculatePrice,
  repriceAll,
};

if (require.main === module) {
  startPriceUpdater().catch(console.error);
  process.on('SIGINT', () => {
    console.log('\n[PriceUpdater] 🛑 Shutting down...');
    process.exit(0);
  });
}