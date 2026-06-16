'use strict';

/**
 * ============================================================
 * stores/faqeesh.js
 * ============================================================
 * Faqeesh store instance.
 * Wires catalog, queue, repricer, and socket handlers together
 * for the Faqeesh Shopify store.
 *
 * Supported product types: jewellery / bullion (no silver)
 *
 * Metafield keys (namespace: custom):
 *   gold_weight      — grams (variant or product)
 *   karat            — '22K', '18K', etc
 *   purity           — '999.9', '995.0', etc
 *   making_pct       — making charge % (default 12)
 *   diamond_ct       — diamond carats
 *   stone_cost       — stone cost AED
 *   vat_exempt       — boolean
 *   making_on_total  — boolean
 *   vat_on_all       — boolean
 *   price_category   — 'bullion' | '' (jewellery default)
 *
 * NOTE: Faqeesh uses price_category string metafield (not boolean flags).
 * No transformMeta needed — catalog.js resolveGoldType reads it directly.
 * ============================================================
 */

const { createCatalog }  = require('../core/catalog');
const { createQueue }    = require('../core/queue');
const { createRepricer } = require('../core/repriceAll');

// ── Store config ──────────────────────────────────────────────
const CONFIG = {
  label:          'Faqeesh',
  shopifyStore:   process.env.FAQEESH_SHOPIFY_STORE,
  shopifyToken:   process.env.FAQEESH_SHOPIFY_TOKEN,
  shopifyVersion: '2026-04',

  metafieldNamespace: 'custom',
  metafieldKeys: {
    goldWeight:     'gold_weight',       // Faqeesh uses gold_weight
    silverGrams:    null,                // not used — no silver products
    karat:          'karat',             // Faqeesh uses karat
    purity:         'purity',
    makingPct:      'making_pct',        // Faqeesh uses making_pct
    diamondCt:      'diamond_ct',
    stoneCost:      'stone_cost',        // Faqeesh uses stone_cost
    vatExempt:      'vat_exempt',
    makingOnTotal:  'making_on_total',
    vatOnAll:       'vat_on_all',
    priceCategory:  'price_category',    // 'bullion' | '' — read directly
  },

  supportedGoldTypes: ['jewellery', 'bullion'],   // no silver

  // FIX 3 — zero threshold for live-priced types
  updateThresholdPctBullion:   0,
  updateThresholdPctJewellery: 0.5,

  maxCallsPerSecond: 2,
  maxRetries:        3,

  // No transformMeta needed — price_category is already the correct string
};

// ── Per-store state ───────────────────────────────────────────
let offerUsd = null;   // no silverUsd — Faqeesh has no silver

let djgRetailRates = process.env.FAQEESH_DJG_RATES
  ? JSON.parse(process.env.FAQEESH_DJG_RATES)
  : { '24K': 582.25, '22K': 539.00, '21K': 517.00, '18K': 443.00, '14K': 345.50 };

let djgRatesUpdatedAt = null;
const lastPrice       = new Map();
let closingPriceSaved = false;

// ── Core instances ────────────────────────────────────────────
const catalog = createCatalog(CONFIG);

const queue = createQueue(CONFIG);

const repricer = createRepricer(CONFIG, {
  variantCache: catalog.getCache(),
  lastPrice,
  queue,
  getLiveRates: () => ({ offerUsd, silverUsd: null }),  // no silver
  getDjgRates:  () => djgRetailRates,
});


// ── Socket handler interface ──────────────────────────────────

const label = CONFIG.label;

function onConnect() {
  // FIX 1 — clear bullion lastPrice on reconnect
  repricer.clearLiveLastPrices();
}

function onDisconnect() {
  // No action needed
}

function onGold(data) {
  offerUsd = data.offer;

  if (data.marketStatus === 'TRADEABLE') {
    closingPriceSaved = false;
    repricer.run();
  } else if (!closingPriceSaved) {
    closingPriceSaved = true;
    console.log(`[Faqeesh] 🔔 Market ${data.marketStatus} — saving closing prices`);
    repricer.run();
  }
}

function onSilver(_data) {
  // Faqeesh has no silver products — intentional no-op
}


// ── Public API ────────────────────────────────────────────────

module.exports = {
  label,
  CONFIG,

  onGold,
  onSilver,
  onConnect,
  onDisconnect,

  catalog,
  queue,

  getDjgRates()          { return djgRetailRates; },
  getDjgRatesUpdatedAt() { return djgRatesUpdatedAt; },

  setDjgRates(rates) {
    djgRetailRates    = { ...djgRetailRates, ...rates };
    djgRatesUpdatedAt = new Date().toISOString();
    const cache = catalog.getCache();
    for (const [variantId, meta] of cache) {
      if (meta.goldType === 'jewellery') lastPrice.delete(variantId);
    }
  },

  repricer,

  getLiveRates() { return { offerUsd, silverUsd: null }; },
};