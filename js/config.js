/* config.js — Configuración única para página y Service Worker.
   Se carga antes que el resto de módulos (en index.html y con importScripts). */
(function (global) {
  'use strict';

  var host = global.location ? global.location.hostname : '';
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '';

  global.OUTBOX_CONFIG = {
    DB_NAME: 'outbox-db',
    DB_VERSION: 1,
    STORE_OUTBOX: 'outbox',
    STORE_META: 'meta',

    SYNC_TAG: 'outbox-sync',
    MAX_ATTEMPTS: 5,
    REQUEST_TIMEOUT_MS: 15000,

    /* En local se usa el mock incluido en tools/server.js.
       En GitHub Pages se usa una API pública que acepta POST (JSONPlaceholder).
       Para conectar un backend propio basta con cambiar API_URL. */
    API_URL: isLocal
      ? 'http://localhost:8765/api/pedidos'
      : 'https://jsonplaceholder.typicode.com/posts',
    API_METHOD: 'POST',

    FLAGS: {
      DEMO_OFFLINE: 'demoOffline'
    }
  };
})(typeof self !== 'undefined' ? self : this);
