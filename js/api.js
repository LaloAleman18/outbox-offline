/* api.js — Transporte HTTP del Outbox (lo usa únicamente el Service Worker).
   Sin dependencias. Promise.race manual con new Promise() para el timeout. */
(function (global) {
  'use strict';

  var Api = {};

  function cfg() {
    return global.OUTBOX_CONFIG;
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = global.setTimeout(function () {
        reject(new Error('Tiempo de espera agotado tras ' + ms + ' ms'));
      }, ms);

      promise.then(
        function (value) {
          global.clearTimeout(timer);
          resolve(value);
        },
        function (error) {
          global.clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /* Intenta el POST real. Si falla, el llamador decide marcar error o reintentar.
     La bandera demoOffline vive en IndexedDB para que también la lea el SW. */
  Api.post = function (payload, url) {
    return global.Outbox.getFlag(cfg().FLAGS.DEMO_OFFLINE, false)
      .then(function (simulatedOffline) {
        if (simulatedOffline === true) {
          throw new Error('Fallo de red simulado (interruptor de demostración)');
        }

        var options = {
          method: cfg().API_METHOD,
          headers: {
            'Content-Type': 'application/json',
            'X-Outbox-Client': payload.clientId || 'anon'
          },
          body: JSON.stringify(payload),
          cache: 'no-store',
          credentials: 'omit',
          mode: 'cors'
        };

        return withTimeout(
          global.fetch(url || cfg().API_URL, options),
          cfg().REQUEST_TIMEOUT_MS
        );
      })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('El servidor respondió HTTP ' + response.status);
        }
        return response.json().catch(function () {
          return null;
        });
      });
  };

  global.Api = Api;
})(typeof self !== 'undefined' ? self : this);
