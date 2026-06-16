'use strict';

/**
 * ============================================================
 * core/calculations.js
 * ============================================================
 * Pure price math — no state, no I/O, no store references.
 * Both stores import these functions directly.
 *
 * THREE PRODUCT TYPES:
 *
 * JEWELLERY
 *   rateKarat  = djgRetailRates[karat]  (or proportional 24K fallback)
 *   goldCost   = goldWeight × rateKarat
 *   diamCost   = diamondCt × diamondRate
 *   makingBase = makingOnTotal ? (goldCost + diamCost + stoneCost) : goldCost
 *   making     = makingBase × (makingPct / 100)
 *   vatBase    = vatOnAll ? (goldCost + diamCost + stoneCost + making) : (goldCost + making)
 *   vat        = vatBase × vatRate  (0 if vatExempt)
 *   total      = goldCost + diamCost + stoneCost + making + vat
 *
 * BULLION
 *   rate24kAed  = (offerUsd / troyOzToGram) × usdToAed
 *   ratePerGram = rate24kAed × bullionPurity[purity]
 *   goldCost    = goldWeight × ratePerGram
 *   vat         = goldCost × vatRate  (0 if vatExempt)
 *   total       = goldCost + vat
 *
 * SILVER  (Aura only)
 *   silverCost = silverGrams × (silverUsd / troyOzToGram) × usdToAed
 *   vat        = silverCost × vatRate  (0 if vatExempt)
 *   total      = silverCost + vat
 *
 * ROUNDING POLICY:
 *   All intermediate values stay full floats.
 *   Math.round() only on the final total and each sub-total.
 *   Must match gold-rate.js client-side constants exactly.
 * ============================================================
 */

// ── Shared constants — must match gold-rate.js exactly ───────────
const CONSTANTS = {
  troyOzToGram: 31.1035,
  usdToAed:     3.674,
  diamondRate:  18000,    // AED per carat
  vatRate:      0.05,     // UAE 5%

  bullionPurity: {
    '999.9': 0.9999, '0.9999': 0.9999,
    '999.0': 0.999, '0.999': 0.999,
    '995.0': 0.995, '0.995': 0.995,
    '916.0': 0.916, '0.916': 0.916,
    '750.0': 0.750, '0.750': 0.750,
  },
};


/**
 * calculateJewellery(meta, djgRetailRates)
 *
 * @param {object} meta
 *   goldWeight    {number}  grams
 *   karat         {string}  '22K', '18K', etc
 *   diamondCt     {number}  carats
 *   stoneCost     {number}  AED
 *   makingPct     {number}  % (default 12)
 *   vatExempt     {boolean}
 *   makingOnTotal {boolean} apply making% to full cost incl diamond/stone
 *   vatOnAll      {boolean} apply VAT to diamond/stone too
 *
 * @param {object} djgRetailRates  { '24K': 582.25, '22K': 539, ... }
 *
 * @returns {{ total, goldCost, diamCost, stoneCost, making, vat, rateKarat }}
 */
function calculateJewellery(meta, djgRetailRates) {
  // DJG retail rate for the karat — fall back to proportional 24K
  let rateKarat;
  if (djgRetailRates[meta.karat]) {
    rateKarat = djgRetailRates[meta.karat];
  } else {
    const k = parseFloat(meta.karat) || 18;
    rateKarat = djgRetailRates['24K'] * (k / 24);
  }

  const goldCost  = (meta.goldWeight || 0) * rateKarat;
  const diamCost  = (meta.diamondCt  || 0) * CONSTANTS.diamondRate;
  const stoneCost = (meta.stoneCost  || 0);

  const makingBase = meta.makingOnTotal
    ? (goldCost + diamCost + stoneCost)
    : goldCost;
  const making = makingBase * ((meta.makingPct || 12) / 100);

  const vatBase = meta.vatOnAll
    ? (goldCost + diamCost + stoneCost + making)
    : (goldCost + making);
  const vat   = meta.vatExempt ? 0 : vatBase * CONSTANTS.vatRate;
  const total = goldCost + diamCost + stoneCost + making + vat;

  return {
    total:     Math.round(total),
    goldCost:  Math.round(goldCost),
    diamCost:  Math.round(diamCost),
    stoneCost: Math.round(stoneCost),
    making:    Math.round(making),
    vat:       Math.round(vat),
    rateKarat: Math.round(rateKarat),
  };
}


/**
 * calculateBullion(meta, offerUsd)
 *
 * @param {object} meta
 *   goldWeight  {number}  grams
 *   purity      {string}  '999.9', '995.0', etc
 *   vatExempt   {boolean}
 *   productTitle {string} for logging only
 *
 * @param {number|null} offerUsd  current GOLD offer price in USD/oz
 *
 * @returns {{ total, goldCost, vat, ratePerGram, rate24kAed, fineness, rawUsdOz } | null}
 *   Returns null if offerUsd is not yet available.
 */
function calculateBullion(meta, offerUsd) {
  if (!offerUsd) return null;

  const fineness = CONSTANTS.bullionPurity[String(meta.purity)];
  if (!fineness) {
    console.warn(`[Calc] Unknown bullion purity '${meta.purity}' for ${meta.productTitle || 'unknown'}`);
    return null;
  }

  const rate24kAed  = (offerUsd / CONSTANTS.troyOzToGram) * CONSTANTS.usdToAed;
  const ratePerGram = rate24kAed * fineness;
  const goldCost    = (meta.goldWeight || 0) * ratePerGram;
  const vat         = meta.vatExempt ? 0 : goldCost * CONSTANTS.vatRate;
  const total       = goldCost + vat;

  return {
    total:       Math.round(total),
    goldCost:    Math.round(goldCost),
    vat:         Math.round(vat),
    ratePerGram: Math.round(ratePerGram),
    rate24kAed:  Math.round(rate24kAed),
    fineness,
    rawUsdOz:    Math.round(offerUsd * 100) / 100,
  };
}


/**
 * calculateSilver(meta, silverUsd)
 *
 * @param {object} meta
 *   silverGrams {number}  grams
 *   vatExempt   {boolean}
 *
 * @param {number|null} silverUsd  current SILVER offer price in USD/oz
 *
 * @returns {{ total, silverCost, vat, ratePerGram, rawUsdOz } | null}
 *   Returns null if silverUsd is not yet available.
 */
function calculateSilver(meta, silverUsd) {
  if (!silverUsd) return null;

  const rate      = (silverUsd / CONSTANTS.troyOzToGram) * CONSTANTS.usdToAed;
  const cost      = (meta.silverGrams || 0) * rate;
  const vat       = meta.vatExempt ? 0 : cost * CONSTANTS.vatRate;
  const total     = cost + vat;

  return {
    total:       Math.round(total),
    silverCost:  Math.round(cost),
    vat:         Math.round(vat),
    ratePerGram: Math.round(rate),
    rawUsdOz:    Math.round(silverUsd * 100) / 100,
  };
}


/**
 * calculatePrice(meta, liveRates, djgRetailRates)
 * Router — delegates to the correct calculator based on meta.goldType.
 *
 * @param {object} meta         variant metadata (includes goldType)
 * @param {object} liveRates    { offerUsd, silverUsd }
 * @param {object} djgRetailRates
 *
 * @returns {object|null}
 */
function calculatePrice(meta, liveRates, djgRetailRates) {
  if (meta.goldType === 'bullion') return calculateBullion(meta, liveRates.offerUsd);
  if (meta.goldType === 'silver')  return calculateSilver(meta, liveRates.silverUsd);
  return calculateJewellery(meta, djgRetailRates);
}


module.exports = {
  CONSTANTS,
  calculateJewellery,
  calculateBullion,
  calculateSilver,
  calculatePrice,
};