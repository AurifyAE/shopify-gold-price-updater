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
 * BUGS FIXED vs previous version:
 *   FIX 1 — Socket reconnect clears lastPrice for bullion/silver so
 *            the first tick after a redeploy always pushes a fresh price.
 *   FIX 2 — Silver tick now calls repriceAll({ silverOnly: true })
 *            instead of repriceAll() — stops jewellery being hit on
 *            every silver tick.
 *   FIX 3 — Bullion/silver use updateThresholdPct: 0 (no skip).
 *            Jewellery still uses 0.5% (DJG rates rarely change).
 *   FIX 4 — POST /rates now validates no rate is suspiciously low
 *            (< 10 AED/g) to prevent accidental corrupt values.
 *   FIX 5 — fetchCatalog() now reads isSilver metafield and
 *            silverGrams so silver variants are correctly cached
 *            and repriced.
 *
 * TWO PRODUCT TYPES — formulas:
 *
 * JEWELLERY  (type = jewellery)
 *   rateKarat  = djgRetailRates[karat]
 *   goldCost   = goldGrams × rateKarat
 *   diamCost   = diamondCt × 18,000 (AED/ct)
 *   making     = goldCost × (makingPct / 100)
 *   vatBase    = goldCost + making
 *   vat        = vatBase × vatRate  (0 if vatExempt)
 *   total      = goldCost + diamCost + stoneCost + making + vat
 *
 * BULLION    (type = bullion)
 *   rate24kAed  = (USD/oz ÷ 31.1035) × usdToAed
 *   ratePerGram = rate24kAed × bullionPurity[purity]
 *   goldCost    = goldGrams × ratePerGram
 *   vat         = goldCost × vatRate  (0 if vatExempt)
 *   total       = goldCost + vat
 *
 * SILVER     (type = silver)
 *   silverCost  = silverGrams × (USD/oz ÷ 31.1035) × usdToAed
 *   vat         = silverCost × vatRate  (0 if vatExempt)
 *   total       = silverCost + vat
 *
 * → ALL final values rounded to nearest whole AED (Math.round)
 *
 * ENDPOINTS:
 *   GET  /health    — status + variant counts + current rates
 *   GET  /price     — calculate price for one product (browser use)
 *   GET  /rates     — read current DJG retail rates
 *   POST /rates     — update DJG rates + reprice Shopify variants immediately
 *   POST /refresh   — force catalog reload
 *   GET  /debug     — raw metafield dump (troubleshooting)
 * ============================================================
 */

'use strict';

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

  djgRetailRates: process.env.DJG_RETAIL_RATES
    ? JSON.parse(process.env.DJG_RETAIL_RATES)
    : { '24K': 582.25, '22K': 539.00, '21K': 517.00, '18K': 443.00, '14K': 345.50 },

  bullionPurity: {
    '999.9': 0.9999, '0.9999': 0.9999,
    '999.0': 0.999, '0.999': 0.999,
    '995.0': 0.995, '0.995': 0.995,
    '916.0': 0.916, '0.916': 0.916,
    '750.0': 0.750, '0.750': 0.750,
  },

  troyOzToGram: 31.1035,
  usdToAed: 3.674,
  diamondRate: 18000,
  vatRate: 0.05,

  metafieldNamespace: 'custom',
  metafieldKeys: {
    goldGrams: 'gold_grams',
    silverGrams: 'silver_grams',   // FIX 5 — added
    diamondCt: 'diamond_ct',
    stoneCost: 'stone_cost_aed',
    makingPct: 'making_charges',
    karat: 'gold_karat',
    vatExempt: 'vat_exempt',
    isBullion: 'is_bullion',
    isSilver: 'is_silver',      // FIX 5 — added
    purity: 'purity',
  },

  // FIX 3 — separate thresholds per product type.
  // Bullion/silver: 0% — always push on every tick (live spot price).
  // Jewellery: 0.5% — DJG rates are admin-set, skip tiny float drift.
  updateThresholdPctBullion: 0,
  updateThresholdPctJewellery: 0.5,

  catalogRefreshMs: 24 * 60 * 60 * 1000,
  webhookPort: process.env.PORT || 3001,
  maxCallsPerSecond: 2,
  maxRetries: 3,

  adminSecret: process.env.ADMIN_SECRET || '',
  adminOrigin: process.env.ADMIN_ORIGIN || '*',
};

if (!CONFIG.adminSecret) {
  console.warn('[Config] ⚠️  ADMIN_SECRET not set — POST /rates is unprotected.');
}
if (CONFIG.adminOrigin === '*') {
  console.warn('[Config] ⚠️  ADMIN_ORIGIN not set — CORS allows all origins.');
}

// ── STATE ──────────────────────────────────────────────────────────
let variantCache = new Map();
let lastPrice = new Map();
let catalogReady = false;
let lastFetchTime = null;
let closingPriceSaved = false;
let currentBidUsd = null;
let currentOfferUsd = null;
let currentSilverUsd = null;

const SHOPIFY_BASE = `https://${CONFIG.shopifyStore}/admin/api/${CONFIG.shopifyVersion}`;


// ============================================================
// PRICE CALCULATIONS
// ============================================================

function calculateJewellery(meta) {
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

  const makingBase = meta.makingOnTotal ? (goldCost + diamCost + stoneCost) : goldCost;
  const making = makingBase * ((meta.makingPct || 12) / 100);

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
    rateKarat: Math.round(rateKarat),
  };
}

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
    ratePerGram: Math.round(ratePerGram),
    rate24kAed: Math.round(rate24kAed),
    fineness,
    rawUsdOz: Math.round(currentOfferUsd * 100) / 100,
  };
}

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
  let totalProds = 0, totalVars = 0, bullionCount = 0, silverCount = 0;

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

        // FIX 5 — detect silver products first, then bullion, then jewellery
        const isSilver = meta[CONFIG.metafieldKeys.isSilver] === 'true';
        const isBullion = meta[CONFIG.metafieldKeys.isBullion] === 'true';

        // FIX 5 — silver products use silverGrams; gold products use goldGrams
        const goldGrams = parseFloat(meta[CONFIG.metafieldKeys.goldGrams] || 0);
        const silverGrams = parseFloat(meta[CONFIG.metafieldKeys.silverGrams] || 0);

        // Skip products with no relevant weight
        if (!goldGrams && !silverGrams) continue;

        totalProds++;
        if (isBullion) bullionCount++;
        if (isSilver) silverCount++;

        const goldType = isSilver ? 'silver' : isBullion ? 'bullion' : 'jewellery';
        const numericProductId = parseInt(product.id.split('/').pop());

        const variantMeta = {
          productTitle: product.title,
          productId: numericProductId,
          goldType,
          goldGrams,
          silverGrams,   // FIX 5 — always carry both; calc functions use the right one
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
    console.log(`[Catalog]    Jewellery: ${totalProds - bullionCount - silverCount} | Bullion: ${bullionCount} | Silver: ${silverCount}`);
    logCatalogSummary();

  } catch (err) {
    console.error('[Catalog] ❌ Fetch failed:', err.message);
  }
}

function logCatalogSummary() {
  const byProduct = new Map();
  for (const [, v] of variantCache) {
    if (!byProduct.has(v.productTitle)) {
      byProduct.set(v.productTitle, {
        count: 0, karat: v.karat,
        grams: v.goldType === 'silver' ? v.silverGrams : v.goldGrams,
        type: v.goldType,
      });
    }
    byProduct.get(v.productTitle).count++;
  }
  console.log('[Catalog] 📋 Products:');
  for (const [title, info] of byProduct) {
    let label;
    if (info.type === 'bullion') label = `${info.grams}g bullion`;
    else if (info.type === 'silver') label = `${info.grams}g silver`;
    else label = `${info.grams}g ${info.karat}`;
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
//
// FIX 2 — options.silverOnly added so SILVER ticks don't reprice jewellery.
// FIX 3 — threshold is 0 for bullion/silver, 0.5% for jewellery.
// ============================================================
function repriceAll(options = {}) {
  if (!catalogReady || variantCache.size === 0) {
    console.warn('[PriceUpdater] ⏳ Catalog not ready — skipping');
    return;
  }

  const jewelleryOnly = options.jewelleryOnly === true;
  const silverOnly = options.silverOnly === true;
  let updateCount = 0, skipCount = 0;

  for (const [variantId, meta] of variantCache) {
    // FIX 2 — filter correctly per trigger type
    if (jewelleryOnly && meta.goldType !== 'jewellery') continue;
    if (silverOnly && meta.goldType !== 'silver') continue;

    const result = calculatePrice(meta);
    if (result === null) { skipCount++; continue; }

    const newPrice = result.total;
    const last = lastPrice.get(variantId);

    // FIX 3 — zero threshold for live-priced types; 0.5% for DJG-rate types
    const threshold = meta.goldType === 'jewellery'
      ? CONFIG.updateThresholdPctJewellery
      : CONFIG.updateThresholdPctBullion;  // 0 for bullion and silver

    const changePct = last ? Math.abs((newPrice - last) / last) * 100 : 100;

    if (changePct >= threshold) {
      lastPrice.set(variantId, newPrice);
      enqueue(variantId, newPrice);
      updateCount++;
    }
  }

  const parts = [`${updateCount}/${variantCache.size} variants queued`];
  if (skipCount > 0) parts.push(`${skipCount} skipped (no live price yet)`);
  if (!updateCount && !skipCount) parts.splice(0, 1, `no change (threshold)`);

  const label = jewelleryOnly ? '💰 DJG rate change'
    : silverOnly ? '🥈 Silver tick'
      : '📈 Market tick';
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

    // FIX 1 — clear lastPrice for bullion/silver on every (re)connect so the
    // first tick always pushes a fresh price regardless of threshold.
    // Jewellery is NOT cleared — its price is DJG-rate driven, not socket driven.
    let cleared = 0;
    for (const [variantId, meta] of variantCache) {
      if (meta.goldType === 'bullion' || meta.goldType === 'silver') {
        lastPrice.delete(variantId);
        cleared++;
      }
    }
    if (cleared > 0) {
      console.log(`[Socket] 🔄 Cleared lastPrice for ${cleared} bullion/silver variant(s) — fresh reprice on first tick`);
    }
  });

  socket.on('market-data', (data) => {
    const symbol = data?.symbol?.toUpperCase();

    if (symbol === 'GOLD') {
      currentBidUsd = data.bid;
      currentOfferUsd = data.offer;

      if (data.marketStatus === 'TRADEABLE') {
        closingPriceSaved = false;
        repriceAll();   // reprices bullion + jewellery (jewellery only if threshold crossed)

      } else if (!closingPriceSaved) {
        closingPriceSaved = true;
        console.log(`[PriceUpdater] 🔔 Market ${data.marketStatus} — saving closing prices`);
        repriceAll();
      }
    }

    if (symbol === 'SILVER') {
      currentSilverUsd = data.offer;
      // FIX 2 — silver tick only reprices silver variants
      repriceAll({ silverOnly: true });
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

    // ── GET /price ────────────────────────────────────────────
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
        if (!result) result = {
          total: 0, goldCost: 0, vat: 0, ratePerGram: 0,
          rate24kAed: 0, fineness: 0, rawUsdOz: 0
        };

      } else if (type === 'silver') {
        result = calculateSilver({
          silverGrams: parseFloat(p.get('grams') || 0),
          vatExempt: p.get('vatExempt') === '1',
        });
        if (!result) result = { total: 0, silverCost: 0, vat: 0, ratePerGram: 0, rawUsdOz: 0 };

      } else {
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

      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
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
            // FIX 4 — sanity check: no real karat rate should be below 10 AED/g
            if (payload.rates[k] < 10) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: `Rate for ${k} is suspiciously low (${payload.rates[k]} AED/g). ` +
                  `Minimum accepted is 10 AED/g. Did you accidentally send a wrong value?`
              }));
              return;
            }
          }

          const old = { ...CONFIG.djgRetailRates };
          CONFIG.djgRetailRates = { ...CONFIG.djgRetailRates, ...payload.rates };
          CONFIG._ratesUpdatedAt = new Date().toISOString();

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
    console.log(`[Server] GET  /price    — browser card price`);
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
  console.log(`[Config] VAT rate: ${CONFIG.vatRate * 100}%  |  usdToAed: ${CONFIG.usdToAed}  |  bullion threshold: ${CONFIG.updateThresholdPctBullion}%  |  jewellery threshold: ${CONFIG.updateThresholdPctJewellery}%`);
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