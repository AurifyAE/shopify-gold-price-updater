'use strict';

/**
 * ============================================================
 * core/catalog.js
 * ============================================================
 * Fetches and caches the Shopify product catalog for one store.
 * One instance created per store via createCatalog().
 *
 * Each store has its own:
 *   - Shopify credentials (store URL + token)
 *   - Metafield key map (custom.gold_weight vs custom.gold_grams etc.)
 *   - Product type routing (price_category metafield or product.type)
 *   - Supported goldTypes (Aura: jewellery/bullion/silver, Faqeesh: jewellery/bullion)
 *
 * VARIANT-LEVEL METAFIELDS WIN over product-level.
 * e.g. a ring product has product.gold_weight = 3g but each
 * size variant has its own variant.gold_weight. The variant value
 * is used; product value is the fallback.
 *
 * Variants with no relevant weight metafield are silently skipped
 * (non-gold products on a mixed-catalog store).
 * ============================================================
 */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * createCatalog(storeConfig)
 *
 * @param {object} storeConfig
 *   label              {string}   'Aura' | 'Faqeesh'
 *   shopifyStore       {string}   mystore.myshopify.com
 *   shopifyToken       {string}   Admin API token
 *   shopifyVersion     {string}   e.g. '2026-01'
 *   metafieldNamespace {string}   e.g. 'custom'
 *   metafieldKeys      {object}   key map — see store configs
 *   supportedGoldTypes {string[]} ['jewellery','bullion','silver'] or subset
 *
 * @returns {{
 *   fetch(): Promise<void>,
 *   getCache(): Map,
 *   isReady(): boolean,
 *   lastFetchTime(): Date|null,
 *   summary(): object
 * }}
 */
function createCatalog(storeConfig) {
  const {
    label,
    shopifyStore,
    shopifyToken,
    shopifyVersion,
    metafieldNamespace,
    metafieldKeys,
    supportedGoldTypes,
  } = storeConfig;

  const LOG      = `[Catalog:${label}]`;
  const ENDPOINT = `https://${shopifyStore}/admin/api/${shopifyVersion}/graphql.json`;
  const HEADERS  = {
    'Content-Type':           'application/json',
    'X-Shopify-Access-Token': shopifyToken,
  };

  let variantCache  = new Map();
  let _ready        = false;
  let _lastFetch    = null;


  // ── resolveGoldType ────────────────────────────────────────
  // Determines product type from price_category metafield first,
  // then falls back to product.type string match.
  // Returns null if the type is not in supportedGoldTypes.
  // ──────────────────────────────────────────────────────────
  function resolveGoldType(priceCategory, productType) {
    const cat = (priceCategory || '').toLowerCase();
    const typ = (productType   || '').toLowerCase();

    let goldType;
    if (cat === 'bullion' || (!cat && /bullion|bar|coin/i.test(typ))) {
      goldType = 'bullion';
    } else if (cat === 'silver' || (!cat && /silver/i.test(typ))) {
      goldType = 'silver';
    } else {
      goldType = 'jewellery';
    }

    // Faqeesh has no silver products — skip if not in supported list
    return supportedGoldTypes.includes(goldType) ? goldType : null;
  }


  // ── buildVariantMeta ───────────────────────────────────────
  // Merges product-level and variant-level metafields into a
  // single flat object using the store's key map.
  // Variant-level wins on every key.
  // ──────────────────────────────────────────────────────────
  function buildVariantMeta(merged, goldType, productTitle, productId, variantId) {
    const k = metafieldKeys;

    const goldWeight  = parseFloat(merged[k.goldWeight]  || 0);
    const silverGrams = parseFloat(merged[k.silverGrams] || 0);

    // Skip variants with no relevant weight for their type
    const hasWeight = goldType === 'silver'
      ? silverGrams > 0
      : goldWeight  > 0;

    if (!hasWeight) return null;

    return {
      variantId,
      productId,
      productTitle,
      goldType,
      goldWeight,
      silverGrams,
      karat:         merged[k.karat]        || '22K',
      purity:        merged[k.purity]        || '999.9',
      makingPct:     parseFloat(merged[k.makingPct]   || 12),
      diamondCt:     parseFloat(merged[k.diamondCt]   || 0),
      stoneCost:     parseFloat(merged[k.stoneCost]   || 0),
      vatExempt:     merged[k.vatExempt]     === 'true',
      makingOnTotal: merged[k.makingOnTotal] === 'true',
      vatOnAll:      merged[k.vatOnAll]      === 'true',
    };
  }


  // ── fetch ──────────────────────────────────────────────────
  // Main catalog build. Paginates through all products,
  // fetching both product-level and variant-level metafields.
  // ──────────────────────────────────────────────────────────
  async function fetch() {
    console.log(`${LOG} 🔄 Building product catalog...`);

    const newCache = new Map();
    const counts   = { products: 0, variants: 0, bullion: 0, silver: 0, skipped: 0 };
    const seenProducts = new Set();

    try {
      let hasNextPage = true;
      let cursor      = null;

      while (hasNextPage) {
        const afterClause = cursor ? `, after: "${cursor}"` : '';

        const query = `{
          products(first: 50${afterClause}) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id title productType
                metafields(first: 20, namespace: "${metafieldNamespace}") {
                  edges { node { key value } }
                }
                variants(first: 100) {
                  edges {
                    node {
                      id
                      metafields(first: 15, namespace: "${metafieldNamespace}") {
                        edges { node { key value } }
                      }
                    }
                  }
                }
              }
            }
          }
        }`;

        const res = await globalThis.fetch(ENDPOINT, {
          method:  'POST',
          headers: HEADERS,
          body:    JSON.stringify({ query }),
        });

        // Shopify rate limit
        if (res.status === 429) {
          const wait = parseFloat(res.headers.get('Retry-After') || '2') * 1000;
          console.warn(`${LOG} ⏳ Rate limited — waiting ${wait}ms`);
          await sleep(wait);
          continue;
        }

        if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);

        const json     = await res.json();
        const products = json.data?.products;

        if (!products) {
          console.error(`${LOG} ❌ GraphQL error:`, JSON.stringify(json.errors));
          break;
        }

        // Debug: log first product's raw metafields on first page only
        if (!cursor && products.edges.length > 0) {
          const fp   = products.edges[0].node;
          const mfs  = (fp.metafields?.edges || []).map(e => e.node);
          console.log(`${LOG} 🔍 "${fp.title}" — ${mfs.length} product metafields`);
          if (!mfs.length) {
            console.log(`${LOG} 🔍 None found. Check namespace='${metafieldNamespace}' and token scopes.`);
          } else {
            console.log(`${LOG} 🔍 Raw: ${JSON.stringify(mfs)}`);
          }
        }

        for (const edge of products.edges) {
          const product = edge.node;

          // Flatten product-level metafields
          const productMeta = {};
          for (const m of (product.metafields?.edges || [])) {
            productMeta[m.node.key] = m.node.value;
          }

          const priceCategory = productMeta[metafieldKeys.priceCategory] || '';
          const goldType      = resolveGoldType(priceCategory, product.productType);

          // Skip product types not supported by this store (e.g. silver on Faqeesh)
          if (!goldType) {
            counts.skipped++;
            continue;
          }

          const numericProductId = parseInt(product.id.split('/').pop());

          for (const vEdge of (product.variants?.edges || [])) {
            const variant = vEdge.node;

            // Flatten variant-level metafields
            const variantMeta = {};
            for (const m of (variant.metafields?.edges || [])) {
              variantMeta[m.node.key] = m.node.value;
            }

            // Merge: variant wins over product on every key
            const merged    = Object.assign({}, productMeta, variantMeta);
            if (storeConfig.transformMeta) storeConfig.transformMeta(merged);
            const variantId = parseInt(variant.id.split('/').pop());

            const meta = buildVariantMeta(
              merged,
              goldType,
              product.title,
              numericProductId,
              variantId
            );

            if (!meta) continue; // no weight — not a gold variant

            // Track unique products for summary
            if (!seenProducts.has(numericProductId)) {
              seenProducts.add(numericProductId);
              counts.products++;
              if (goldType === 'bullion') counts.bullion++;
              if (goldType === 'silver')  counts.silver++;
            }

            newCache.set(variantId, meta);
            counts.variants++;
          }
        }

        hasNextPage = products.pageInfo.hasNextPage;
        cursor      = products.pageInfo.endCursor;
        if (hasNextPage) await sleep(200); // gentle pagination
      }

      variantCache.clear();
      for (const [variantId, meta] of newCache) {
        variantCache.set(variantId, meta);
      }
      _ready       = true;
      _lastFetch   = new Date();

      const jewelleryCount = counts.products - counts.bullion - counts.silver;
      console.log(`${LOG} ✅ ${counts.products} products → ${counts.variants} variants`);
      console.log(`${LOG}    Jewellery: ${jewelleryCount} | Bullion: ${counts.bullion} | Silver: ${counts.silver}`);
      if (counts.skipped > 0) {
        console.log(`${LOG}    Skipped ${counts.skipped} products (unsupported type for this store)`);
      }

      logSummary(newCache);

    } catch (err) {
      console.error(`${LOG} ❌ Fetch failed:`, err.message);
    }
  }


  // ── logSummary ─────────────────────────────────────────────
  function logSummary(cache) {
    const byProduct = new Map();
    for (const [, v] of cache) {
      if (!byProduct.has(v.productTitle)) {
        byProduct.set(v.productTitle, {
          count: 0,
          grams: v.goldType === 'silver' ? v.silverGrams : v.goldWeight,
          karat: v.karat,
          type:  v.goldType,
        });
      }
      byProduct.get(v.productTitle).count++;
    }

    console.log(`${LOG} 📋 Products:`);
    for (const [title, info] of byProduct) {
      const label = info.type === 'bullion' ? `${info.grams}g bullion`
        : info.type === 'silver'  ? `${info.grams}g silver`
        : `${info.grams}g ${info.karat}`;
      console.log(`${LOG}   • ${title} — ${label} (${info.count} variant${info.count !== 1 ? 's' : ''})`);
    }
    console.log(`${LOG} 🕐 Last updated: ${_lastFetch?.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  }


  // ── Public API ────────────────────────────────────────────
  return {
    /** Trigger a full catalog rebuild */
    fetch,

    /** Returns the live variantCache Map */
    getCache() { return variantCache; },

    /** True once first successful fetch has completed */
    isReady() { return _ready; },

    /** Timestamp of last successful fetch */
    lastFetchTime() { return _lastFetch; },

    /** Counts for health endpoint */
    summary() {
      const variants = [...variantCache.values()];
      return {
        total:      variantCache.size,
        jewellery:  variants.filter(v => v.goldType === 'jewellery').length,
        bullion:    variants.filter(v => v.goldType === 'bullion').length,
        silver:     variants.filter(v => v.goldType === 'silver').length,
        // lastFetch:  _lastFetch?.toISOString() || null,
        lastFetch:  _lastFetch?.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) || null,
        ready:      _ready,
      };
    },
  };
}


module.exports = { createCatalog };