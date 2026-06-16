'use strict';

/**
 * ============================================================
 * index.js
 * ============================================================
 * Entry point — validates env, wires everything together, starts.
 *
 * Boot sequence:
 *   1. Validate required env vars (fail fast with clear message)
 *   2. Create server (HTTP endpoints)
 *   3. Create socket (one shared connection)
 *   4. Register all stores with the socket
 *   5. Fetch catalogs for all stores (parallel)
 *   6. Connect socket — ticks start flowing
 *   7. Schedule daily catalog refresh
 * ============================================================
 */

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

const aura     = require('./stores/aura');
const faqeesh  = require('./stores/faqeesh');
const { createSocket } = require('./core/socket');
const { createServer } = require('./server');

const STORES = [aura, faqeesh];

const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000; // 24 hours


// ── Env validation ────────────────────────────────────────────
// Fail fast with a clear message rather than crashing later
// with a cryptic fetch error.
function validateEnv() {
  const required = [
    // Socket
    'SOCKET_SERVER_URL',
    'SOCKET_SECRET_KEY',
    // Aura
    'AURA_SHOPIFY_STORE',
    'AURA_SHOPIFY_TOKEN',
    // Faqeesh
    'FAQEESH_SHOPIFY_STORE',
    'FAQEESH_SHOPIFY_TOKEN',
  ];

  const missing = required.filter(k => !process.env[k]);

  if (missing.length > 0) {
    console.error('[StartupError] Missing required environment variables:');
    for (const k of missing) {
      console.error(`  ✗ ${k}`);
    }
    console.error('\nAdd them to your .env file or Railway environment and restart.');
    process.exit(1);
  }

  // Warn about optional but recommended vars
  if (!process.env.ADMIN_SECRET) {
    console.warn('[Config] ⚠️  ADMIN_SECRET not set — POST /rates is unprotected');
  }
  if (!process.env.ADMIN_ORIGIN || process.env.ADMIN_ORIGIN === '*') {
    console.warn('[Config] ⚠️  ADMIN_ORIGIN not set — CORS allows all origins');
  }
}


// ── Banner ────────────────────────────────────────────────────
function printBanner() {
  const storeNames = STORES.map(s => s.label).join(' + ');
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Shopify Live Gold Price Updater                        ║');
  console.log('║   Multi-store edition                                    ║');
  console.log(`║   Stores: ${storeNames.padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`[Config] Node.js : ${process.versions.node}`);
  console.log(`[Config] Socket  : ${process.env.SOCKET_SERVER_URL}`);
  console.log(`[Config] Port    : ${process.env.PORT || 3001}`);
  console.log(`[Config] CORS    : ${process.env.ADMIN_ORIGIN || '*'}`);
  console.log('');

  for (const store of STORES) {
    const rates = store.getDjgRates();
    console.log(`[${store.label}] Store   : ${store.CONFIG.shopifyStore}`);
    console.log(`[${store.label}] Types   : ${store.CONFIG.supportedGoldTypes.join(' / ')}`);
    console.log(`[${store.label}] DJG     : 24K=${rates['24K']} 22K=${rates['22K']} 18K=${rates['18K']}`);
    console.log(`[${store.label}] Threshold: bullion=${store.CONFIG.updateThresholdPctBullion}% jewellery=${store.CONFIG.updateThresholdPctJewellery}%`);
    console.log('');
  }
}


// ── Main ──────────────────────────────────────────────────────
async function main() {
  validateEnv();
  printBanner();

  // 1 — Create socket (shared across all stores)
  const socket = createSocket({
    socketUrl:  process.env.SOCKET_SERVER_URL,
    secretKey:  process.env.SOCKET_SECRET_KEY,
    symbols:    ['GOLD', 'SILVER'],
  });

  // 2 — Create HTTP server
  const server = createServer(STORES, socket, {
    port:        parseInt(process.env.PORT || '3001', 10),
    adminSecret: process.env.ADMIN_SECRET  || '',
    adminOrigin: process.env.ADMIN_ORIGIN  || '*',
  });

  // 3 — Register all stores with the socket
  for (const store of STORES) {
    socket.registerStore(store);
  }

  // 4 — Start HTTP server
  server.listen();

  // 5 — Fetch all catalogs in parallel
  // Jewellery cards need catalog before first tick to be priced.
  // Bullion/silver will price on first socket tick regardless.
  console.log('[Startup] 📦 Fetching catalogs (parallel)...');
  await Promise.all(STORES.map(store =>
    store.catalog.fetch().catch(err =>
      console.error(`[Startup] ❌ Catalog fetch failed for ${store.label}:`, err.message)
    )
  ));
  console.log('[Startup] ✅ All catalogs ready');
  console.log('');

  // 6 — Connect socket — market ticks start flowing
  socket.connect();

  // 7 — Daily catalog refresh for all stores
  setInterval(async () => {
    console.log('[Startup] 🕐 Daily catalog refresh...');
    await Promise.all(STORES.map(store =>
      store.catalog.fetch().catch(err =>
        console.error(`[Startup] ❌ Daily refresh failed for ${store.label}:`, err.message)
      )
    ));
  }, CATALOG_REFRESH_MS);

  console.log('[Startup] 🚀 Running — waiting for market ticks...');
  console.log('');
}

main().catch(err => {
  console.error('[StartupError] Fatal:', err.message);
  process.exit(1);
});