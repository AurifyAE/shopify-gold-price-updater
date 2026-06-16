'use strict';

/**
 * ============================================================
 * server.js
 * ============================================================
 * HTTP server — store-aware routing for all registered stores.
 *
 * ENDPOINTS:
 *   GET  /health              — global status + per-store summary
 *   GET  /price               — calculate price (store param required)
 *   GET  /rates               — read DJG rates (same across stores)
 *   POST /rates               — update DJG rates + reprice all stores
 *   POST /stores/:store/refresh — force catalog reload for one store
 *   POST /refresh             — force catalog reload for all stores
 *   GET  /debug/:store        — raw metafield dump for one store
 *
 * STORE PARAM:
 *   ?store=aura | ?store=faqeesh
 *   Required for /price and /debug.
 *   POST /rates applies to ALL stores (rates are shared).
 *
 * AUTH:
 *   POST /rates requires Authorization: Bearer <ADMIN_SECRET>
 *   if ADMIN_SECRET env var is set.
 * ============================================================
 */

const http = require('http');
const { calculateJewellery, calculateBullion, calculateSilver } = require('./core/calculations');


/**
 * createServer(stores, socketRef, serverConfig)
 *
 * @param {object[]} stores       array of store instances (aura, faqeesh)
 * @param {object}   socketRef    { getLiveRates() } — shared socket live rates
 * @param {object}   serverConfig
 *   port        {number}  process.env.PORT || 3001
 *   adminSecret {string}  process.env.ADMIN_SECRET
 *   adminOrigin {string}  process.env.ADMIN_ORIGIN || '*'
 */
function createServer(stores, socketRef, serverConfig) {
  const {
    port        = 3001,
    adminSecret = '',
    adminOrigin = '*',
  } = serverConfig;

  // Build a quick lookup map: 'aura' → storeInstance
  const storeMap = {};
  for (const store of stores) {
    storeMap[store.label.toLowerCase()] = store;
  }

  // ── Helpers ──────────────────────────────────────────────

  function json(res, statusCode, data) {
    res.writeHead(statusCode, {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data, null, 2));
  }

  function resolveStore(url) {
    const key = url.searchParams.get('store') || '';
    return storeMap[key.toLowerCase()] || null;
  }

  function requireAuth(req, res) {
    if (!adminSecret) return true; // unprotected if not set
    const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (token !== adminSecret) {
      json(res, 401, { error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid JSON body')); }
      });
    });
  }

  // ── Request handler ───────────────────────────────────────
  const server = http.createServer(async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin',  adminOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, 'http://localhost');

    try {
      await route(req, res, url);
    } catch (err) {
      console.error('[Server] ❌ Unhandled error:', err.message);
      json(res, 500, { error: err.message });
    }
  });


  // ── Router ────────────────────────────────────────────────
  async function route(req, res, url) {

    // ── GET /health ────────────────────────────────────────
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      const socketRates = socketRef.getLiveRates();

      const storeHealths = {};
      for (const store of stores) {
        const summary    = store.catalog.summary();
        const liveRates  = store.getLiveRates();
        storeHealths[store.label.toLowerCase()] = {
          catalogReady:    summary.ready,
          lastFetch:       summary.lastFetch,
          variants:        summary.total,
          jewellery:       summary.jewellery,
          bullion:         summary.bullion,
          silver:          summary.silver,
          queuePending:    store.queue.size(),
          offerUsd:        liveRates.offerUsd,
          silverUsd:       liveRates.silverUsd || null,
          djgRatesUpdatedAt: store.getDjgRatesUpdatedAt(),
        };
      }

      json(res, 200, {
        status:         'running',
        nodeVersion:    process.versions.node,
        socketOfferUsd: socketRates.offerUsd,
        socketBidUsd:   socketRates.bidUsd,
        socketSilverUsd: socketRates.silverUsd,
        djgRetailRates: stores[0].getDjgRates(), // same across stores
        stores:         storeHealths,
      });
      return;
    }


    // ── GET /rates ─────────────────────────────────────────
    // Returns DJG rates — same for all stores
    if (req.method === 'GET' && url.pathname === '/rates') {
      json(res, 200, {
        djgRetailRates: stores[0].getDjgRates(),
        updatedAt:      stores[0].getDjgRatesUpdatedAt(),
      });
      return;
    }


    // ── POST /rates ────────────────────────────────────────
    // Updates DJG rates on ALL stores + reprices jewellery
    if (req.method === 'POST' && url.pathname === '/rates') {
      if (!requireAuth(req, res)) return;

      let payload;
      try {
        payload = await readBody(req);
      } catch (e) {
        json(res, 400, { error: e.message });
        return;
      }

      if (!payload.rates || typeof payload.rates !== 'object') {
        json(res, 400, { error: 'Missing rates object' });
        return;
      }

      // Validate all required karats
      const required = ['24K', '22K', '21K', '18K', '14K'];
      for (const k of required) {
        if (typeof payload.rates[k] !== 'number' || payload.rates[k] <= 0) {
          json(res, 400, { error: `Invalid rate for ${k}` });
          return;
        }
        // FIX 4 — sanity check: no real karat rate below 10 AED/g
        if (payload.rates[k] < 10) {
          json(res, 400, {
            error: `Rate for ${k} is suspiciously low (${payload.rates[k]} AED/g). ` +
              `Minimum accepted is 10 AED/g.`,
          });
          return;
        }
      }

      // Apply to every store + trigger jewellery reprice
      for (const store of stores) {
        const old = { ...store.getDjgRates() };
        store.setDjgRates(payload.rates);

        console.log(`[Server] 🔄 DJG rates updated for ${store.label}:`);
        for (const k of Object.keys(payload.rates)) {
          const changed = old[k] !== payload.rates[k] ? ' ✱' : '';
          console.log(`  ${k}: ${old[k]} → ${payload.rates[k]}${changed}`);
        }

        if (store.catalog.isReady()) {
          console.log(`[Server] ⚡ Repricing jewellery for ${store.label}...`);
          store.repricer.run({ jewelleryOnly: true });
        }
      }

      json(res, 200, {
        status:         'updated',
        djgRetailRates: stores[0].getDjgRates(),
        updatedAt:      stores[0].getDjgRatesUpdatedAt(),
        storesUpdated:  stores.map(s => s.label),
      });
      return;
    }


    // ── GET /price ─────────────────────────────────────────
    // Calculates price for a single product (browser use).
    // Requires ?store=aura or ?store=faqeesh
    if (req.method === 'GET' && url.pathname === '/price') {
      const store = resolveStore(url);
      if (!store) {
        json(res, 400, { error: 'Missing or unknown ?store= param. Use ?store=aura or ?store=faqeesh' });
        return;
      }

      const p          = url.searchParams;
      const type       = (p.get('type') || 'jewellery').toLowerCase();
      const liveRates  = store.getLiveRates();
      const djgRates   = store.getDjgRates();
      let result;

      if (type === 'bullion') {
        result = calculateBullion(
          {
            goldWeight: parseFloat(p.get('grams')  || 0),
            purity:     p.get('purity')             || '999.9',
            vatExempt:  p.get('vatExempt')          === '1',
          },
          liveRates.offerUsd
        );
        if (!result) result = {
          total: 0, goldCost: 0, vat: 0,
          ratePerGram: 0, rate24kAed: 0, fineness: 0, rawUsdOz: 0,
        };

      } else if (type === 'silver') {
        if (!store.getLiveRates().silverUsd) {
          json(res, 400, { error: `Store '${store.label}' does not support silver` });
          return;
        }
        result = calculateSilver(
          {
            silverGrams: parseFloat(p.get('grams') || 0),
            vatExempt:   p.get('vatExempt')         === '1',
          },
          liveRates.silverUsd
        );
        if (!result) result = {
          total: 0, silverCost: 0, vat: 0, ratePerGram: 0, rawUsdOz: 0,
        };

      } else {
        result = calculateJewellery(
          {
            goldWeight:    parseFloat(p.get('grams')   || 0),
            karat:         p.get('karat')               || '22K',
            diamondCt:     parseFloat(p.get('diamond') || 0),
            stoneCost:     parseFloat(p.get('stone')   || 0),
            makingPct:     parseFloat(p.get('making')  || 12),
            vatExempt:     p.get('vatExempt')           === '1',
            makingOnTotal: p.get('makingOnTotal')       === '1',
            vatOnAll:      p.get('vatOnAll')            === '1',
          },
          djgRates
        );
      }

      json(res, 200, result);
      return;
    }


    // ── POST /stores/:store/refresh ────────────────────────
    // Force catalog reload for one specific store
    if (req.method === 'POST' && url.pathname.startsWith('/stores/')) {
      const parts    = url.pathname.split('/').filter(Boolean);
      const storeKey = parts[1] || '';
      const action   = parts[2] || '';

      if (action !== 'refresh') {
        json(res, 404, { error: 'Not found' });
        return;
      }

      const store = storeMap[storeKey.toLowerCase()];
      if (!store) {
        json(res, 404, { error: `Unknown store: ${storeKey}` });
        return;
      }

      console.log(`[Server] 🔔 Catalog refresh triggered for ${store.label}`);
      json(res, 200, { status: 'refreshing', store: store.label });
      store.catalog.fetch().catch(err =>
        console.error(`[Server] ❌ Refresh failed for ${store.label}:`, err.message)
      );
      return;
    }


    // ── POST /refresh ──────────────────────────────────────
    // Force catalog reload for ALL stores
    if (req.method === 'POST' && url.pathname === '/refresh') {
      console.log('[Server] 🔔 Catalog refresh triggered for all stores');
      json(res, 200, {
        status: 'refreshing',
        stores: stores.map(s => s.label),
      });
      for (const store of stores) {
        store.catalog.fetch().catch(err =>
          console.error(`[Server] ❌ Refresh failed for ${store.label}:`, err.message)
        );
      }
      return;
    }


    // ── GET /debug/:store ──────────────────────────────────
    // Raw metafield dump for a specific store — troubleshooting
    if (req.method === 'GET' && url.pathname.startsWith('/debug')) {
      const store = resolveStore(url);
      if (!store) {
        json(res, 400, { error: 'Missing or unknown ?store= param' });
        return;
      }

      const { shopifyStore, shopifyToken, shopifyVersion, metafieldNamespace } = store.CONFIG;
      const endpoint = `https://${shopifyStore}/admin/api/${shopifyVersion}/graphql.json`;
      const headers  = {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': shopifyToken,
      };

      // Query 1: namespace-filtered metafields for first 3 products
      const q1 = `{
        products(first: 3) {
          edges { node { id title
            metafields(first: 20, namespace: "${metafieldNamespace}") {
              edges { node { namespace key value type } }
            }
          }}
        }
      }`;

      // Query 2: all metafields for first product (namespace discovery)
      const q2 = `{
        products(first: 1) {
          edges { node { title
            metafields(first: 30) {
              edges { node { namespace key value type } }
            }
          }}
        }
      }`;

      const [r1, r2] = await Promise.all([
        globalThis.fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query: q1 }) }),
        globalThis.fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query: q2 }) }),
      ]);
      const [j1, j2] = await Promise.all([r1.json(), r2.json()]);

      json(res, 200, {
        store:     store.label,
        namespace: metafieldNamespace,
        metafieldKeys: store.CONFIG.metafieldKeys,
        filteredByNamespace: j1.data?.products?.edges?.map(e => ({
          title:      e.node.title,
          metafields: e.node.metafields?.edges?.map(m => m.node),
        })),
        allMetafieldsFirstProduct: j2.data?.products?.edges?.[0]?.node,
        graphqlErrors: j1.errors || j2.errors || null,
      });
      return;
    }


    // ── 404 ───────────────────────────────────────────────
    json(res, 404, { error: 'Not found' });
  }


  // ── Start ─────────────────────────────────────────────────
  function listen() {
    server.listen(port, () => {
      console.log(`[Server] 🌐 Port ${port}`);
      console.log(`[Server] GET  /health                    — global status`);
      console.log(`[Server] GET  /price?store=<s>           — browser card price`);
      console.log(`[Server] GET  /rates                     — read DJG rates`);
      console.log(`[Server] POST /rates                     — update DJG rates + reprice all stores`);
      console.log(`[Server] POST /stores/<store>/refresh    — reload catalog for one store`);
      console.log(`[Server] POST /refresh                   — reload catalog for all stores`);
      console.log(`[Server] GET  /debug?store=<s>           — metafield dump`);
      console.log(`[Server] CORS origin: ${adminOrigin}`);
      console.log(`[Server] Stores: ${stores.map(s => s.label).join(', ')}`);
    });
    return server;
  }


  return { listen };
}


module.exports = { createServer };