/* sw.js — Service Worker: caché del app shell + motor de sincronización.
   Vive en la raíz para controlar todo el scope del proyecto.
   Sin librerías. Sin funciones asíncronas declaradas: solo promesas. */

'use strict';

importScripts(
  './js/config.js',
  './js/db-helper.js',
  './js/outbox-repo.js',
  './js/api.js'
);

var CACHE_NAME = 'outbox-shell-v7';
var INDEX_URL = new URL('./index.html', self.location.href).href;
var SHELL_ASSETS = [
  './index.html',
  './styles.css',
  './manifest.json',
  './icons/icon.svg',
  './js/config.js',
  './js/db-helper.js',
  './js/outbox-repo.js',
  './js/app.js'
];

var activeSync = null;

/* ---------- Ciclo de vida del Service Worker ---------- */

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(SHELL_ASSETS);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            if (key !== CACHE_NAME && key.indexOf('outbox-') === 0) {
              return caches.delete(key);
            }
            return Promise.resolve(false);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

/* ---------- App shell: network-first en navegación, SWR en assets ---------- */

self.addEventListener('fetch', function (event) {
  var request = event.request;

  /* Los POST del Outbox nunca se cachean: van directo a la red. */
  if (request.method !== 'GET') {
    return;
  }

  var url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          /* Un 5xx no debe reemplazar el app shell cacheado. */
          if (!response || !response.ok) {
            return caches.match(INDEX_URL).then(function (cached) {
              return cached || response;
            });
          }

          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, copy);
          });
          return response;
        })
        .catch(function () {
          return caches.match(request).then(function (cached) {
            return cached || caches.match(INDEX_URL);
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) {
        fetch(request)
          .then(function (response) {
            if (response && response.ok) {
              caches.open(CACHE_NAME).then(function (cache) {
                cache.put(request, response.clone());
              });
            }
          })
          .catch(function () {
            /* sin red: seguimos sirviendo la copia */
          });
        return cached;
      }

      return fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(request, response.clone());
            });
          }
          return response;
        })
        .catch(function () {
          return new Response('Recurso no disponible sin conexión.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        });
    })
  );
});

/* ---------- Comunicación Service Worker -> página ---------- */

function notify(message) {
  return self.clients
    .matchAll({ includeUncontrolled: true, type: 'window' })
    .then(function (clientList) {
      clientList.forEach(function (client) {
        try {
          client.postMessage(message);
        } catch (error) {
          /* la pestaña pudo cerrarse entre matchAll y postMessage */
        }
      });
      return clientList.length;
    });
}

/* Evita duplicar el aviso cuando sync + mensaje disparan el mismo run. */
function publish(summary) {
  if (summary.published) {
    return Promise.resolve(0);
  }
  summary.published = true;
  return notify({ type: 'OUTBOX_SYNC_RESULT', summary: summary });
}

/* ---------- Motor de sincronización (vive SOLO aquí) ---------- */

function syncRecord(record, summary) {
  return Outbox.markSyncing(record.id)
    .then(function () {
      return Api.post(record.payload, record.url);
    })
    .then(function (response) {
      summary.sent += 1;
      summary.records.push({
        id: record.id,
        clientId: record.clientId,
        status: 'enviado'
      });
      return Outbox.markSent(record.id, response);
    })
    .catch(function (error) {
      summary.failed += 1;
      summary.records.push({
        id: record.id,
        clientId: record.clientId,
        status: 'error',
        error: error && error.message ? error.message : String(error)
      });
      return Outbox.markError(record.id, error && error.message ? error.message : String(error))
        .catch(function () {
          /* si ni siquiera se puede escribir el error, no rompemos el resto */
        });
    });
}

function runSync(origin) {
  if (activeSync) {
    return activeSync;
  }

  activeSync = Outbox.listRetryable()
    .then(function (records) {
      var summary = {
        id: String(Date.now()) + '-' + Math.random().toString(16).slice(2, 8),
        origin: origin,
        total: records.length,
        sent: 0,
        failed: 0,
        records: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
        published: false
      };

      return notify({ type: 'OUTBOX_SYNC_STARTED', origin: origin, total: records.length })
        .then(function () {
          /* Secuencial y FIFO: respeta el orden de creación de los pedidos. */
          return records.reduce(function (chain, record) {
            return chain.then(function () {
              return syncRecord(record, summary);
            });
          }, Promise.resolve());
        })
        .then(function () {
          summary.finishedAt = new Date().toISOString();
          return summary;
        });
    })
    .then(
      function (summary) {
        activeSync = null;
        return summary;
      },
      function (error) {
        activeSync = null;
        throw error;
      }
    );

  return activeSync;
}

/* Background Sync nativo (Chromium). */
self.addEventListener('sync', function (event) {
  if (event.tag !== OUTBOX_CONFIG.SYNC_TAG) {
    return;
  }

  event.waitUntil(
    runSync('background-sync')
      .then(publish)
      .catch(function (error) {
        return notify({
          type: 'OUTBOX_SYNC_FAILED',
          origin: 'background-sync',
          error: error && error.message ? error.message : String(error)
        });
      })
  );
});

/* Respaldo manual / Safari: la página pide el vaciado por postMessage. */
self.addEventListener('message', function (event) {
  var data = event.data;

  if (!data || typeof data !== 'object') {
    return;
  }

  if (data.type === 'FLUSH_OUTBOX') {
    event.waitUntil(
      runSync(data.origin || 'page')
        .then(publish)
        .catch(function (error) {
          return notify({
            type: 'OUTBOX_SYNC_FAILED',
            origin: data.origin || 'page',
            error: error && error.message ? error.message : String(error)
          });
        })
    );
    return;
  }

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
