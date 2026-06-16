  # Shopify Live Gold Price Updater

  A Node.js backend service that automatically keeps Shopify product prices in sync with live precious-metal spot prices. It connects to a real-time market-data WebSocket, calculates accurate AED prices for jewellery, gold bullion, and silver products, and pushes updates to Shopify variants via the Admin REST API — all without any manual intervention.

  ---

  ## Table of Contents

  - [Project Overview](#project-overview)
  - [Features](#features)
  - [Tech Stack](#tech-stack)
  - [Architecture](#architecture)
  - [Folder Structure](#folder-structure)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [API Documentation](#api-documentation)
  - [Database / Catalog Cache](#database--catalog-cache)
  - [Usage](#usage)
  - [Deployment](#deployment)
  - [Pricing Formulas](#pricing-formulas)
  - [Future Improvements](#future-improvements)
  - [Contributing](#contributing)
  - [License](#license)

  ---

  ## Project Overview

  Gold and silver spot prices change by the second. Manually updating hundreds of Shopify variant prices is impractical. This service solves that by acting as the **single source of truth** for all precious-metal price calculations.

  On startup it:
  1. Fetches the full product catalog from Shopify (via GraphQL) and builds an in-memory variant cache.
  2. Opens a persistent WebSocket connection to a live market-data server.
  3. On every market tick it recalculates prices for all relevant product types and batches the updates to Shopify.

  It also exposes a small HTTP API so the browser storefront can fetch live card prices without touching the Shopify admin token, and so an admin panel can push updated DJG karat retail rates.

  ---

  ## Features

  | Feature | Details |
  |---|---|
  | **Live spot-price sync** | Subscribes to a WebSocket feed for `GOLD` and `SILVER` |
  | **Three product types** | Jewellery, Bullion, Silver — each with its own pricing formula |
  | **Intelligent threshold** | Bullion/silver update on every tick (0 % threshold); jewellery skips changes < 0.5 % |
  | **Rate-limited Shopify writes** | Max 2 API calls per second, exponential-backoff retry (up to 3 attempts) |
  | **Admin rate endpoint** | `POST /rates` lets an admin panel push new DJG karat retail rates and immediately trigger a jewellery reprice |
  | **Daily catalog refresh** | Re-fetches the Shopify catalog every 24 hours automatically |
  | **Browser price endpoint** | `GET /price` lets the storefront calculate a live price for any product parameters without exposing the admin token |
  | **CORS control** | Configurable origin allowlist for the admin origin |
  | **Debug endpoint** | `GET /debug` dumps raw Shopify metafields for troubleshooting |
  | **Graceful reconnect** | Socket reconnects automatically with exponential back-off; price history for bullion/silver is cleared on reconnect so the first tick always pushes a fresh price |
  | **Input validation** | `POST /rates` rejects any karat rate below 10 AED/g and requires a Bearer token |
  | **Node.js version guard** | Exits immediately with a clear error message if Node < 18 is detected |

  ---

  ## Tech Stack

  | Layer | Technology |
  |---|---|
  | **Runtime** | Node.js ≥ 18 (native `fetch` required) |
  | **HTTP server** | Node.js built-in `http` module |
  | **Real-time data** | `socket.io-client` v4 |
  | **Shopify catalog** | Shopify GraphQL Admin API (`2026-01`) |
  | **Shopify price writes** | Shopify REST Admin API (`/variants/:id.json`) |
  | **Environment config** | `dotenv` |
  | **Deployment** | Railway (referenced in source header) |

  ---

  ## Architecture

  ```mermaid
  flowchart TD
      A[Market Data WebSocket Server] -->|"market-data (GOLD/SILVER)"| B[Socket.IO Client]
      B --> C{Price Changed?}
      C -->|"Yes (threshold met)"| D[Calculate Price\nper product type]
      D --> E[API Queue\n2 calls/sec]
      E --> F[Shopify REST API\nPUT /variants/:id]

      G[Browser Storefront] -->|GET /price| H[HTTP Server]
      H --> D

      I[Admin Panel] -->|"POST /rates\nBearer token"| H
      H -->|Reprice jewellery| D

      J[Shopify GraphQL API] -->|Product + metafields| K[fetchCatalog]
      K --> L[In-Memory Variant Cache]
      L --> D
  ```

  ### Data flow

  1. **Startup** — `fetchCatalog()` pages through all Shopify products via GraphQL, reads the `custom` metafields for each product, and builds an in-memory `Map<variantId → meta>`.
  2. **Market tick** — The WebSocket fires `market-data`. The handler updates the shared `currentOfferUsd` / `currentSilverUsd` state variables and calls `repriceAll()`.
  3. **repriceAll()** — Iterates the variant cache, calls the appropriate `calculate*()` function for each variant, compares the result against the last pushed price, and enqueues an update if the change exceeds the threshold.
  4. **processQueue()** — Drains the queue in batches of 2 with 1-second gaps, calling `PUT /variants/:id` for each.
  5. **HTTP server** — Handles admin and storefront requests independently of the socket loop.

  ---

  ## Folder Structure

  ```
  shopify-gold-price-updater/
  ├── shopify-price-updater.js   # Entire application — single entry point
  ├── package.json               # Dependencies and start script
  ├── package-lock.json          # Lockfile
  ├── .env                       # Local environment variables (not committed)
  ├── .gitignore                 # Ignores .env and node_modules
  └── node_modules/              # Installed dependencies
  ```

  This is intentionally a single-file service. All logic (config, pricing maths, catalog fetch, Shopify writes, HTTP server, socket client, queue) lives in `shopify-price-updater.js`.

  ---

  ## Installation

  ### Prerequisites

  - **Node.js 18 or higher** — required for the native `fetch` API
  - A Shopify store with Admin API access
  - A WebSocket market-data server compatible with the `market-data` event format

  ### Steps

  ```bash
  # 1. Clone the repository
  git clone <repository-url>
  cd shopify-gold-price-updater

  # 2. Install dependencies
  npm install

  # 3. Create your environment file
  cp .env.example .env   # or create .env manually — see Configuration below

  # 4. Start the server
  npm start
  ```

  ---

  ## Configuration

  All configuration is supplied through environment variables. Create a `.env` file in the project root:

  ```dotenv
  # ── Shopify ──────────────────────────────────────────────────────────
  # Your Shopify store domain (e.g. my-store.myshopify.com)
  SHOPIFY_STORE=your-store.myshopify.com

  # Shopify Admin API access token with read/write access to Products
  SHOPIFY_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx

  # ── Market data WebSocket ─────────────────────────────────────────────
  # URL of the Socket.IO server that emits market-data events
  SOCKET_SERVER_URL=https://your-market-data-server.com

  # Secret passed as a query param when connecting to the socket
  SOCKET_SECRET_KEY=your-socket-secret

  # ── Admin API security ───────────────────────────────────────────────
  # Bearer token required to call POST /rates (leave blank = unprotected ⚠️)
  ADMIN_SECRET=your-strong-secret-here

  # CORS origin allowed for the admin panel (leave blank = allow all ⚠️)
  ADMIN_ORIGIN=https://your-admin-panel.com

  # ── Optional overrides ───────────────────────────────────────────────
  # HTTP port (default: 3001)
  PORT=3001

  # DJG retail rates in AED per gram, as a JSON object.
  # Defaults to: {"24K":582.25,"22K":539.00,"21K":517.00,"18K":443.00,"14K":345.50}
  DJG_RETAIL_RATES={"24K":582.25,"22K":539.00,"21K":517.00,"18K":443.00,"14K":345.50}
  ```

  ### Environment Variable Reference

  | Variable | Required | Default | Description |
  |---|---|---|---|
  | `SHOPIFY_STORE` | Yes | — | Shopify store domain (`*.myshopify.com`) |
  | `SHOPIFY_TOKEN` | Yes | — | Shopify Admin API token (needs `write_products` scope) |
  | `SOCKET_SERVER_URL` | Yes | — | WebSocket server URL emitting live spot prices |
  | `SOCKET_SECRET_KEY` | Yes | — | Authentication secret for the WebSocket connection |
  | `ADMIN_SECRET` | Recommended | `""` (unprotected) | Bearer token for `POST /rates` |
  | `ADMIN_ORIGIN` | Recommended | `*` (all origins) | Allowed CORS origin for admin requests |
  | `PORT` | No | `3001` | TCP port the HTTP server listens on |
  | `DJG_RETAIL_RATES` | No | See above | JSON map of karat → AED/gram retail rates |

  ### Hardcoded constants (in source)

  | Constant | Value | Description |
  |---|---|---|
  | `usdToAed` | `3.674` | USD to AED conversion rate |
  | `vatRate` | `0.05` | UAE VAT (5%) |
  | `diamondRate` | `18,000` | AED per carat for diamonds |
  | `troyOzToGram` | `31.1035` | Standard troy-ounce conversion |
  | `shopifyVersion` | `2026-01` | Shopify Admin API version |
  | `metafieldNamespace` | `custom` | Shopify metafield namespace |
  | `maxCallsPerSecond` | `2` | Shopify API rate-limit guard |
  | `maxRetries` | `3` | Retry attempts on failed Shopify writes |
  | `catalogRefreshMs` | `86400000` | Catalog re-fetch interval (24 h) |
  | `updateThresholdPctBullion` | `0` | Min % change to push bullion/silver update |
  | `updateThresholdPctJewellery` | `0.5` | Min % change to push jewellery update |

  ---

  ## API Documentation

  Base URL: `http://localhost:3001` (or your deployed URL)

  ---

  ### `GET /health`

  Returns the current service status, variant counts, live spot prices, and DJG rates.

  **Response `200`**
  ```json
  {
    "status": "running",
    "variants": 120,
    "jewelleryVariants": 100,
    "bullionVariants": 15,
    "silverVariants": 5,
    "catalogReady": true,
    "lastFetch": "2026-06-06T08:00:00.000Z",
    "currentBidUsd": 2345.10,
    "currentOfferUsd": 2345.50,
    "currentSilverUsd": 29.85,
    "djgRetailRates": {
      "24K": 582.25,
      "22K": 539.00,
      "21K": 517.00,
      "18K": 443.00,
      "14K": 345.50
    },
    "ratesUpdatedAt": "2026-06-06T07:30:00.000Z",
    "nodeVersion": "20.11.0"
  }
  ```

  ---

  ### `GET /price`

  Calculates a live price for a single product. Intended for storefront JavaScript.

  **Query Parameters**

  | Parameter | Type | Default | Description |
  |---|---|---|---|
  | `type` | `jewellery` \| `bullion` \| `silver` | `jewellery` | Product type |
  | `grams` | number | `0` | Gold or silver weight in grams |
  | `karat` | string | `22K` | Karat (jewellery only): `24K`, `22K`, `21K`, `18K`, `14K` |
  | `purity` | string | `999.9` | Fineness (bullion only): `999.9`, `999.0`, `995.0`, `916.0`, `750.0` |
  | `diamond` | number | `0` | Diamond weight in carats (jewellery only) |
  | `stone` | number | `0` | Stone cost in AED (jewellery only) |
  | `making` | number | `12` | Making charge % (jewellery only) |
  | `vatExempt` | `0` \| `1` | `0` | Pass `1` to suppress VAT |
  | `makingOnTotal` | `0` \| `1` | `0` | Base making on total cost instead of gold cost |
  | `vatOnAll` | `0` \| `1` | `0` | Apply VAT to diamond and stone costs too |

  **Example request**
  ```
  GET /price?type=bullion&grams=100&purity=999.9
  ```

  **Response `200` — bullion**
  ```json
  {
    "total": 28855,
    "goldCost": 27481,
    "vat": 1374,
    "ratePerGram": 274,
    "rate24kAed": 274,
    "fineness": 0.9999,
    "rawUsdOz": 2345.50
  }
  ```

  **Response `200` — jewellery**
  ```json
  {
    "total": 4821,
    "goldCost": 3234,
    "diamCost": 900,
    "stoneCost": 0,
    "making": 388,
    "vat": 181,
    "rateKarat": 539
  }
  ```

  **Response `200` — silver**
  ```json
  {
    "total": 312,
    "silverCost": 297,
    "vat": 15,
    "ratePerGram": 3,
    "rawUsdOz": 29.85
  }
  ```

  ---

  ### `GET /rates`

  Returns the current DJG retail rates and when they were last updated.

  **Response `200`**
  ```json
  {
    "djgRetailRates": {
      "24K": 582.25,
      "22K": 539.00,
      "21K": 517.00,
      "18K": 443.00,
      "14K": 345.50
    },
    "updatedAt": "2026-06-06T07:30:00.000Z"
  }
  ```

  ---

  ### `POST /rates`

  Updates DJG karat retail rates and immediately reprices all jewellery variants.

  **Headers**
  ```
  Authorization: Bearer <ADMIN_SECRET>
  Content-Type: application/json
  ```

  **Request body**
  ```json
  {
    "rates": {
      "24K": 590.00,
      "22K": 546.00,
      "21K": 523.00,
      "18K": 449.00,
      "14K": 350.00
    }
  }
  ```

  All five keys (`24K`, `22K`, `21K`, `18K`, `14K`) must be present and must be positive numbers ≥ 10 AED/g.

  **Response `200`**
  ```json
  {
    "status": "updated",
    "djgRetailRates": { "24K": 590.00, "22K": 546.00, "21K": 523.00, "18K": 449.00, "14K": 350.00 },
    "updatedAt": "2026-06-06T08:05:00.000Z"
  }
  ```

  **Response `401`** — Missing or invalid Bearer token  
  **Response `400`** — Missing `rates` object, missing karat key, non-positive value, or value < 10 AED/g

  ---

  ### `POST /refresh`

  Forces an immediate catalog reload from Shopify. Runs asynchronously; returns `200` immediately.

  **Response `200`**
  ```json
  { "status": "refreshing" }
  ```

  ---

  ### `GET /debug`

  Returns a raw metafield dump for the first 3 products (filtered by namespace) and all metafields for the first product. For troubleshooting only.

  **Response `200`**
  ```json
  {
    "hint": "namespace='custom' key='gold_grams'",
    "filteredByNamespace": [...],
    "allMetafieldsFirstProduct": {...},
    "graphqlErrors": null
  }
  ```

  ---

  ## Database / Catalog Cache

  There is no external database. The service maintains two in-memory data structures:

  | Structure | Type | Purpose |
  |---|---|---|
  | `variantCache` | `Map<variantId, meta>` | Full product metadata for every Shopify variant, keyed by numeric variant ID |
  | `lastPrice` | `Map<variantId, number>` | Last price pushed to Shopify for each variant, used for threshold comparison |

  ### Shopify Metafields

  Products are enriched with metafields under the `custom` namespace. The service reads the following keys:

  | Metafield Key | Type | Used by | Description |
  |---|---|---|---|
  | `gold_grams` | number | Jewellery, Bullion | Weight of gold in grams |
  | `silver_grams` | number | Silver | Weight of silver in grams |
  | `diamond_ct` | number | Jewellery | Diamond weight in carats |
  | `stone_cost_aed` | number | Jewellery | Fixed stone cost in AED |
  | `making_charges` | number | Jewellery | Making charge percentage (default 12) |
  | `gold_karat` | string | Jewellery | Karat grade (`22K`, `24K`, `18K`, `21K`, `14K`) |
  | `vat_exempt` | boolean | All | `"true"` to suppress VAT |
  | `is_bullion` | boolean | Detection | `"true"` for gold bullion products |
  | `is_silver` | boolean | Detection | `"true"` for silver products |
  | `purity` | string | Bullion | Fineness value (`999.9`, `999.0`, `995.0`, `916.0`, `750.0`) |

  Product type is determined in priority order: silver → bullion → jewellery.

  ---

  ## Usage

  ### Start the server

  ```bash
  npm start
  # or directly:
  node shopify-price-updater.js
  ```

  On startup you will see:
  ```
  ╔══════════════════════════════════════════════════════════╗
  ║   Shopify Live Gold Price Updater                        ║
  ║   Single source of truth for all price calculations      ║
  ║   Store: your-store.myshopify.com                        ║
  ╚══════════════════════════════════════════════════════════╝
  ```

  The service then:
  1. Starts the HTTP server on the configured port
  2. Fetches the Shopify product catalog
  3. Connects to the market-data WebSocket
  4. Begins processing price ticks

  ### Check service health

  ```bash
  curl http://localhost:3001/health
  ```

  ### Get a live price (storefront use)

  ```bash
  # 100g 999.9 gold bullion
  curl "http://localhost:3001/price?type=bullion&grams=100&purity=999.9"

  # 5g 22K jewellery with 0.5ct diamond, 12% making charge
  curl "http://localhost:3001/price?type=jewellery&grams=5&karat=22K&diamond=0.5&making=12"

  # 50g silver bar
  curl "http://localhost:3001/price?type=silver&grams=50"
  ```

  ### Update DJG retail rates (admin use)

  ```bash
  curl -X POST http://localhost:3001/rates \
    -H "Authorization: Bearer your-admin-secret" \
    -H "Content-Type: application/json" \
    -d '{"rates":{"24K":590,"22K":546,"21K":523,"18K":449,"14K":350}}'
  ```

  ### Force catalog refresh

  ```bash
  curl -X POST http://localhost:3001/refresh
  ```

  ---

  ## Pricing Formulas

  ### Jewellery

  ```
  rateKarat  = djgRetailRates[karat]   (admin-configurable)
  goldCost   = goldGrams × rateKarat
  diamCost   = diamondCt × 18,000 AED/ct
  makingBase = goldCost  (or goldCost + diamCost + stoneCost if makingOnTotal)
  making     = makingBase × (makingPct / 100)
  vatBase    = goldCost + making  (or all components if vatOnAll)
  vat        = vatBase × 0.05   (0 if vatExempt)
  total      = goldCost + diamCost + stoneCost + making + vat
  ```

  ### Gold Bullion

  ```
  rate24kAed  = (currentOfferUsd ÷ 31.1035) × 3.674
  ratePerGram = rate24kAed × bullionPurity[purity]
  goldCost    = goldGrams × ratePerGram
  vat         = goldCost × 0.05   (0 if vatExempt)
  total       = goldCost + vat
  ```

  ### Silver

  ```
  ratePerGram = (currentSilverUsd ÷ 31.1035) × 3.674
  silverCost  = silverGrams × ratePerGram
  vat         = silverCost × 0.05   (0 if vatExempt)
  total       = silverCost + vat
  ```

  All totals are rounded to the nearest whole AED (`Math.round`).

  ### Supported bullion purities

  | Label | Fineness |
  |---|---|
  | `999.9` / `0.9999` | 0.9999 |
  | `999.0` / `0.999` | 0.999 |
  | `995.0` / `0.995` | 0.995 |
  | `916.0` / `0.916` | 0.916 |
  | `750.0` / `0.750` | 0.750 |

  ---

  ## Deployment

  The service is designed to run on **Railway** (referenced in the source header comment), but any Node.js 18+ hosting provider works.

  ### Railway

  1. Push the repository to GitHub.
  2. Create a new Railway project → **Deploy from GitHub repo**.
  3. Add all required environment variables in the Railway dashboard under **Variables**.
  4. Railway auto-detects `npm start` from `package.json` and deploys.

  ### General (any provider)

  ```bash
  # Ensure Node.js ≥ 18
  node --version

  # Install production dependencies only
  npm install --omit=dev

  # Set environment variables in your hosting platform, then:
  npm start
  ```

  ### Docker (not included — example)

  ```dockerfile
  FROM node:20-alpine
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci --omit=dev
  COPY shopify-price-updater.js .
  EXPOSE 3001
  CMD ["node", "shopify-price-updater.js"]
  ```

  ### Health check URL

  Configure your platform's health check to poll `GET /health` — it returns `200` with `{ "status": "running" }` whenever the service is up.

  ---

  ## Future Improvements

  - **Persistent rate storage** — DJG rates are currently in-memory and reset on redeploy. A lightweight database (e.g. Redis, SQLite) would preserve them across restarts.
  - **Configurable USD → AED rate** — The exchange rate is currently hardcoded (`3.674`). Fetching it from a live FX feed would improve accuracy.
  - **Configurable diamond rate** — The 18,000 AED/ct diamond rate is hardcoded; an admin endpoint to update it would mirror the DJG rates pattern.
  - **Test suite** — The calculation functions (`calculateJewellery`, `calculateBullion`, `calculateSilver`) are already exported from the module and are well-suited for unit tests.
  - **Webhook-driven catalog refresh** — Currently the catalog refreshes on a 24-hour timer. A Shopify product-update webhook would make it near-instant.
  - **Structured logging** — Replace `console.log` with a structured logger (e.g. `pino`) for better observability in production.
  - **Multi-currency support** — All prices are in AED; abstracting the currency would allow the service to target other markets.
  - **Admin UI** — A simple frontend for the `POST /rates` endpoint to allow non-technical staff to update DJG rates without using `curl`.

  ---

  ## Contributing

  1. Fork the repository and create a feature branch.
  2. Make your changes in `shopify-price-updater.js`.
  3. Test locally against a Shopify development store.
  4. Open a pull request with a clear description of the change and why it is needed.

  Please do not commit `.env` files or credentials. The `.gitignore` already excludes `.env`.

  ---

  ## License

  Not identified from codebase. Please add a `LICENSE` file to clarify terms of use.
