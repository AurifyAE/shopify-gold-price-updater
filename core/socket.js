'use strict';

/**
 * ============================================================
 * core/socket.js
 * ============================================================
 * ONE Socket.io connection shared across all stores.
 * Broadcasts GOLD and SILVER ticks to every registered store.
 *
 * Each store registers itself with:
 *   { onGold(data), onSilver(data), onConnect(), onDisconnect() }
 *
 * The socket does NOT know about Shopify, prices, or catalogs.
 * It only delivers raw market data and lifecycle events.
 *
 * GOLD tick  → calls onGold(data)   on all registered stores
 * SILVER tick → calls onSilver(data) on all registered stores
 * connect    → calls onConnect()    on all registered stores
 * disconnect → calls onDisconnect() on all registered stores
 *
 * This means adding a third store in the future is just:
 *   socket.registerStore(clientC)  — no changes to socket.js needed
 * ============================================================
 */


/**
 * createSocket(socketConfig)
 *
 * @param {object} socketConfig
 *   socketUrl   {string}   wss://capital-server-gnsu.onrender.com
 *   secretKey   {string}   socket auth secret
 *   socketIoCDN {string}   not used server-side (Node has socket.io-client)
 *   symbols     {string[]} ['GOLD', 'SILVER']
 *
 * @returns {{
 *   registerStore(store: StoreHandler): void,
 *   connect(): void,
 *   getLiveRates(): { offerUsd: number|null, silverUsd: number|null, bidUsd: number|null }
 * }}
 *
 * StoreHandler interface:
 *   label        {string}    for logging
 *   onGold       {function}  (data) => void
 *   onSilver     {function}  (data) => void
 *   onConnect    {function}  () => void
 *   onDisconnect {function}  () => void
 */
function createSocket(socketConfig) {
  const {
    socketUrl,
    secretKey,
    symbols = ['GOLD', 'SILVER'],
  } = socketConfig;

  const LOG    = '[Socket]';
  const stores = [];  // registered store handlers

  // Shared live rates — updated on every tick, read by server.js /health
  let offerUsd  = null;
  let bidUsd    = null;
  let silverUsd = null;


  /**
   * registerStore(store)
   * Call once per store before connect().
   * Order of registration determines order of tick delivery.
   */
  function registerStore(store) {
    stores.push(store);
    console.log(`${LOG} 📋 Registered store: ${store.label}`);
  }


  /**
   * connect()
   * Opens the socket connection and wires all event handlers.
   * Safe to call once — do not call again after initial connect
   * (reconnection is automatic via socket.io-client).
   */
  function connect() {
    if (stores.length === 0) {
      console.warn(`${LOG} ⚠️  No stores registered — connecting anyway, ticks will be ignored`);
    }

    const { io } = require('socket.io-client');

    const socket = io(socketUrl, {
      query:                { secret: secretKey },
      transports:           ['websocket'],
      withCredentials:      true,
      reconnection:         true,
      reconnectionDelay:    1000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: Infinity,
    });

    // ── connect ────────────────────────────────────────────
    socket.on('connect', () => {
      console.log(`${LOG} ✅ Connected — requesting ${symbols.join(', ')}`);
      socket.emit('request-data', symbols);

      // Notify all stores — each store clears its bullion/silver lastPrice
      for (const store of stores) {
        try { store.onConnect(); }
        catch (err) { console.error(`${LOG} ❌ onConnect error in ${store.label}:`, err.message); }
      }
    });

    // ── market-data ────────────────────────────────────────
    socket.on('market-data', (data) => {
      const symbol = data?.symbol?.toUpperCase();
      if (!symbol) return;

      if (symbol === 'GOLD') {
        offerUsd = data.offer;
        bidUsd   = data.bid;

        for (const store of stores) {
          try { store.onGold(data); }
          catch (err) { console.error(`${LOG} ❌ onGold error in ${store.label}:`, err.message); }
        }
      }

      if (symbol === 'SILVER') {
        silverUsd = data.offer;

        for (const store of stores) {
          try { store.onSilver(data); }
          catch (err) { console.error(`${LOG} ❌ onSilver error in ${store.label}:`, err.message); }
        }
      }
    });

    // ── disconnect ─────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.warn(`${LOG} 🔌 Disconnected: ${reason} — will auto-reconnect`);

      for (const store of stores) {
        try { store.onDisconnect(); }
        catch (err) { console.error(`${LOG} ❌ onDisconnect error in ${store.label}:`, err.message); }
      }
    });

    // ── connect_error ──────────────────────────────────────
    socket.on('connect_error', (err) => {
      console.error(`${LOG} ❌ Connection error: ${err.message}`);
    });

    // ── error ──────────────────────────────────────────────
    socket.on('error', (err) => {
      console.error(`${LOG} ❌ Socket error: ${err}`);
    });

    // Clean disconnect on process exit
    process.on('SIGINT', () => {
      console.log(`\n${LOG} 🛑 Disconnecting...`);
      socket.disconnect();
    });

    return socket;
  }


  /**
   * getLiveRates()
   * Returns the latest raw USD prices from the socket.
   * Used by server.js /health endpoint only.
   * Each store reads its own live rates via getLiveRates() closure
   * defined in its store file — see stores/aura.js.
   */
  function getLiveRates() {
    return { offerUsd, bidUsd, silverUsd };
  }


  return { registerStore, connect, getLiveRates };
}


module.exports = { createSocket };