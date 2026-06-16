'use strict';

/**
 * ============================================================
 * core/queue.js
 * ============================================================
 * Rate-limited Shopify variant price update queue.
 * One instance created per store — stores never share a queue.
 *
 * Features:
 *   - Batches updates to respect Shopify's REST API rate limit
 *   - Exponential backoff on 429 / transient errors
 *   - Per-variant retry up to maxRetries before giving up
 *   - Logs every update with store label for easy filtering
 *
 * Usage:
 *   const queue = createQueue(storeConfig);
 *   queue.enqueue(variantId, newPrice, variantMeta);
 * ============================================================
 */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * createQueue(storeConfig)
 *
 * @param {object} storeConfig
 *   label             {string}  e.g. 'Aura' — used in log lines
 *   shopifyStore      {string}  mystore.myshopify.com
 *   shopifyToken      {string}  Admin API access token
 *   shopifyVersion    {string}  e.g. '2026-01'
 *   maxCallsPerSecond {number}  default 2
 *   maxRetries        {number}  default 3
 *
 * @returns {{ enqueue(variantId, newPrice, meta): void, size(): number }}
 */
function createQueue(storeConfig) {
  const {
    label,
    shopifyStore,
    shopifyToken,
    shopifyVersion,
    maxCallsPerSecond = 2,
    maxRetries        = 3,
  } = storeConfig;

  const BASE_URL  = `https://${shopifyStore}/admin/api/${shopifyVersion}`;
  const LOG       = `[Queue:${label}]`;
  const queue     = [];
  let processing  = false;


  // ── updateVariantPrice ─────────────────────────────────────
  // Single Shopify REST PUT with retry + 429 handling.
  // ──────────────────────────────────────────────────────────
  async function updateVariantPrice(variantId, newPrice, meta, retries = 0) {
    try {
      const res = await fetch(`${BASE_URL}/variants/${variantId}.json`, {
        method:  'PUT',
        headers: {
          'Content-Type':           'application/json',
          'X-Shopify-Access-Token': shopifyToken,
        },
        body: JSON.stringify({
          variant: { id: variantId, price: newPrice.toFixed(2) },
        }),
      });

      // Shopify rate limit — wait the Retry-After header duration
      if (res.status === 429) {
        const wait = parseFloat(res.headers.get('Retry-After') || '1') * 1000;
        console.warn(`${LOG} ⏳ Rate limited on ${variantId} — waiting ${wait}ms`);
        await sleep(wait);
        return updateVariantPrice(variantId, newPrice, meta, retries);
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} — ${await res.text()}`);
      }

      const title = meta?.productTitle || variantId;
      console.log(`${LOG} ✅ ${title} (${variantId}) → AED ${newPrice}`);

    } catch (err) {
      if (retries < maxRetries) {
        const wait = Math.pow(2, retries) * 1000;
        console.warn(`${LOG} ⚠️  Retry ${retries + 1}/${maxRetries} for ${variantId} in ${wait}ms — ${err.message}`);
        await sleep(wait);
        return updateVariantPrice(variantId, newPrice, meta, retries + 1);
      }
      console.error(`${LOG} ❌ Gave up on ${variantId} after ${maxRetries} retries — ${err.message}`);
    }
  }


  // ── processQueue ──────────────────────────────────────────
  // Drains the queue in batches of maxCallsPerSecond.
  // Waits 1s between batches to stay under Shopify's bucket.
  // ─────────────────────────────────────────────────────────
  async function processQueue() {
    processing = true;
    while (queue.length > 0) {
      const batch = queue.splice(0, maxCallsPerSecond);
      await Promise.all(
        batch.map(({ variantId, newPrice, meta }) =>
          updateVariantPrice(variantId, newPrice, meta)
        )
      );
      if (queue.length > 0) await sleep(1000);
    }
    processing = false;
  }


  // ── Public API ────────────────────────────────────────────

  /**
   * enqueue(variantId, newPrice, meta)
   * Adds a price update to the queue and starts processing
   * if not already running.
   *
   * @param {number} variantId
   * @param {number} newPrice   whole AED integer
   * @param {object} [meta]     variant metadata (for logging)
   */
  function enqueue(variantId, newPrice, meta) {
    queue.push({ variantId, newPrice, meta });
    if (!processing) processQueue();
  }

  /**
   * size()
   * Returns the number of items currently waiting in the queue.
   * Useful for health endpoint diagnostics.
   *
   * @returns {number}
   */
  function size() {
    return queue.length;
  }

  return { enqueue, size };
}


module.exports = { createQueue };