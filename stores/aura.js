'use strict';

/**
 * ============================================================
 * stores/aura.js
 * ============================================================
 * Aura store instance.
 * Wires catalog, queue, repricer, and socket handlers together
 * for the Aura Shopify store.
 *
 * Supported product types: jewellery / bullion / silver
 *
 * Metafield keys (namespace: custom):
 *   gold_grams       — grams (variant or product)
 *   silver_grams     — grams (silver products)
 *   gold_karat       — '22K', '18K', etc
 *   purity           — '999.9', '995.0', etc
 *   making_charges   — making charge % (default 12)
 *   diamond_ct       — diamond carats
 *   stone_cost_aed   — stone cost AED
 *   vat_exempt       — boolean
 *   making_on_total  — boolean
 *   vat_on_all       — boolean
 *   is_bullion       — 'true'|'false' boolean flag for bullion routing
 *   is_silver        — 'true'|'false' boolean flag for silver routing
 *
 * NOTE: Aura uses is_bullion / is_silver boolean metafields for routing.
 * transformMeta() translates these into the 'bullion' | 'silver' | ''
 * string that catalog.js resolveGoldType() expects.
 * ============================================================
 */

const { createCatalog }  = require('../core/catalog');
const { createQueue }    = require('../core/queue');
const { createRepricer } = require('../core/repriceAll');

// ── Store config ──────────────────────────────────────────────
const CONFIG = {
  label:          'Aura',
  shopifyStore:   process.env.AURA_SHOPIFY_STORE,
  shopifyToken:   process.env.AURA_SHOPIFY_TOKEN,
  shopifyVersion: '2026-01',

  metafieldNamespace: 'custom',
  metafieldKeys: {
    goldWeight:     'gold_grams',        // Aura uses gold_grams not gold_weight
    silverGrams:    'silver_grams',
    karat:          'gold_karat',        // Aura uses gold_karat not karat
    purity:         'purity',
    makingPct:      'making_charges',    // Aura uses making_charges not making_pct
    diamondCt:      'diamond_ct',
    stoneCost:      'stone_cost_aed',    // Aura uses stone_cost_aed not stone_cost
    vatExempt:      'vat_exempt',
    makingOnTotal:  'making_on_total',
    vatOnAll:       'vat_on_all',
    // catalog.js reads merged[k.priceCategory] for resolveGoldType.
    // We point it at is_bullion — transformMeta below writes the
    // resolved 'bullion' | 'silver' | '' value there before catalog
    // sees it, so resolveGoldType works without any changes.
    priceCategory:  'is_bullion',
  },

  supportedGoldTypes: ['jewellery', 'bullion', 'silver'],

  // FIX 3 — zero threshold for live-priced types
  updateThresholdPctBullion:   0,
  updateThresholdPctJewellery: 0.5,

  maxCallsPerSecond: 2,
  maxRetries:        3,

  // ── transformMeta ─────────────────────────────────────────
  // Called by catalog.js after merging product + variant metafields.
  // Translates Aura's boolean is_bullion / is_silver flags into the
  // 'bullion' | 'silver' | '' string that resolveGoldType expects.
  // Priority: is_bullion wins over is_silver if both are somehow true.
  transformMeta(merged) {
    if (merged['is_bullion'] === 'true') {
      merged['is_bullion'] = 'bullion';
    } else if (merged['is_silver'] === 'true') {
      // priceCategory key points at is_bullion — write resolved value there
      merged['is_bullion'] = 'silver';
    } else {
      merged['is_bullion'] = '';   // jewellery — resolveGoldType falls through
    }
    return merged;
  },
};

// ── Per-store state ───────────────────────────────────────────
let offerUsd  = null;
let silverUsd = null;

let djgRetailRates = process.env.AURA_DJG_RATES
  ? JSON.parse(process.env.AURA_DJG_RATES)
  : { '24K': 582.25, '22K': 539.00, '21K': 517.00, '18K': 443.00, '14K': 345.50 };

let djgRatesUpdatedAt  = null;
const lastPrice        = new Map();
let closingPriceSaved  = false;

// ── Core instances ────────────────────────────────────────────
const catalog = createCatalog(CONFIG);

const queue = createQueue(CONFIG);

const repricer = createRepricer(CONFIG, {
  variantCache: catalog.getCache(),
  lastPrice,
  queue,
  getLiveRates: () => ({ offerUsd, silverUsd }),
  getDjgRates:  () => djgRetailRates,
});


// ── Socket handler interface ──────────────────────────────────

const label = CONFIG.label;

function onConnect() {
  // FIX 1 — clear bullion/silver lastPrice on every (re)connect
  repricer.clearLiveLastPrices();
}

function onDisconnect() {
  // No action needed — socket.io-client auto-reconnects
}

function onGold(data) {
  offerUsd = data.offer;

  if (data.marketStatus === 'TRADEABLE') {
    closingPriceSaved = false;
    repricer.run();
  } else if (!closingPriceSaved) {
    closingPriceSaved = true;
    console.log(`[Aura] 🔔 Market ${data.marketStatus} — saving closing prices`);
    repricer.run();
  }
}

function onSilver(data) {
  // FIX 2 — only reprice silver variants on silver tick
  silverUsd = data.offer;
  repricer.run({ silverOnly: true });
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

  getLiveRates() { return { offerUsd, silverUsd }; },
};