'use strict';

/**
 * ============================================================
 * core/repriceAll.js
 * ============================================================
 * Iterates a store's variantCache, calculates the new price for
 * each variant, and enqueues a Shopify update if the price has
 * changed beyond the configured threshold.
 *
 * One instance created per store via createRepricer().
 * Each store passes its own cache, queue, live rates, and config.
 *
 * TRIGGER MODES (options passed by socket.js):
 *   (none)              — GOLD tick: reprice bullion only
 *                         + jewellery if DJG threshold crossed
 *   { silverOnly: true} — SILVER tick: reprice silver only
 *   { jewelleryOnly: true } — POST /rates: reprice jewellery only
 *
 * THRESHOLDS:
 *   Bullion / Silver : 0%   — push every tick (live spot price)
 *   Jewellery        : 0.5% — DJG rates are admin-set; skip float drift
 * ============================================================
 */

const { calculatePrice } = require('./calculations');


/**
 * createRepricer(storeConfig, deps)
 *
 * @param {object} storeConfig
 *   label                    {string}  'Aura' | 'Faqeesh'
 *   updateThresholdPctBullion   {number}  default 0
 *   updateThresholdPctJewellery {number}  default 0.5
 *
 * @param {object} deps
 *   variantCache   {Map}     populated by catalog.js
 *   lastPrice      {Map}     variantId → last pushed AED price
 *   queue          {object}  { enqueue(variantId, price, meta) }
 *   getLiveRates   {function} () → { offerUsd, silverUsd }
 *   getDjgRates    {function} () → { '24K': n, '22K': n, ... }
 *
 * @returns {{ run(options?): void, clearLiveLastPrices(): void }}
 */
function createRepricer(storeConfig, deps) {
  const {
    label,
    updateThresholdPctBullion   = 0,
    updateThresholdPctJewellery = 0.5,
  } = storeConfig;

  const { variantCache, lastPrice, queue, getLiveRates, getDjgRates } = deps;
  const LOG = `[Repricer:${label}]`;


  /**
   * run(options)
   * Main entry point — called by socket.js on every market tick
   * and by server.js after a POST /rates update.
   *
   * @param {object} [options]
   *   silverOnly    {boolean}  only reprice silver variants
   *   jewelleryOnly {boolean}  only reprice jewellery variants
   */
  function run(options = {}) {
    if (!variantCache || variantCache.size === 0) {
      console.warn(`${LOG} ⏳ Catalog not ready — skipping`);
      return;
    }

    const { silverOnly = false, jewelleryOnly = false } = options;
    const liveRates  = getLiveRates();
    const djgRates   = getDjgRates();

    let updateCount = 0;
    let skipCount   = 0;
    let threshCount = 0;

    for (const [variantId, meta] of variantCache) {
      // ── Filter by trigger type ───────────────────────────
      if (silverOnly    && meta.goldType !== 'silver')    continue;
      if (jewelleryOnly && meta.goldType !== 'jewellery') continue;

      // ── Calculate new price ──────────────────────────────
      const result = calculatePrice(meta, liveRates, djgRates);

      if (result === null) {
        // Live price not yet available (cold start / socket reconnect)
        skipCount++;
        continue;
      }

      const newPrice = result.total;
      const last     = lastPrice.get(variantId);

      // ── Threshold check ──────────────────────────────────
      // Bullion/silver: threshold = 0 → always push
      // Jewellery:      threshold = 0.5% → skip tiny DJG float drift
      const threshold = meta.goldType === 'jewellery'
        ? updateThresholdPctJewellery
        : updateThresholdPctBullion;

      const changePct = last != null
        ? Math.abs((newPrice - last) / last) * 100
        : 100;  // no prior price → always push

      if (changePct < threshold) {
        threshCount++;
        continue;
      }

      // ── Enqueue update ───────────────────────────────────
      lastPrice.set(variantId, newPrice);
      queue.enqueue(variantId, newPrice, meta);
      updateCount++;
    }

    // ── Summary log ─────────────────────────────────────────
    const triggerLabel = jewelleryOnly ? '💰 DJG rate change'
      : silverOnly ? '🥈 Silver tick'
      : '📈 Gold tick';

    const parts = [];
    if (updateCount > 0) parts.push(`${updateCount} queued`);
    if (threshCount > 0) parts.push(`${threshCount} below threshold`);
    if (skipCount   > 0) parts.push(`${skipCount} skipped (no live price)`);
    if (parts.length === 0) parts.push('nothing to update');

    console.log(`${LOG} ${triggerLabel} → ${parts.join(' | ')} (${variantCache.size} total variants)`);
  }


  /**
   * clearLiveLastPrices()
   * Called by socket.js on every (re)connect — FIX 1.
   * Clears lastPrice for bullion and silver variants only so the
   * first tick after a redeploy always pushes a fresh price
   * regardless of threshold.
   * Jewellery is NOT cleared — its price is DJG-rate driven.
   */
  function clearLiveLastPrices() {
    let cleared = 0;
    for (const [variantId, meta] of variantCache) {
      if (meta.goldType === 'bullion' || meta.goldType === 'silver') {
        lastPrice.delete(variantId);
        cleared++;
      }
    }
    if (cleared > 0) {
      console.log(`${LOG} 🔄 Cleared lastPrice for ${cleared} bullion/silver variant(s) — fresh reprice on next tick`);
    }
  }


  return { run, clearLiveLastPrices };
}


module.exports = { createRepricer };