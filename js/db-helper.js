/* db-helper.js — Mini-wrapper promisificado sobre IndexedDB.
   Sin librerías externas. Toda la asincronía se resuelve con
   new Promise(), .then(), .catch() y Promise.all().
   Expone global.DB para la página y para el Service Worker. */
(function (global) {
  'use strict';

  var DB = {};
  var dbPromise = null;

  function cfg() {
    return global.OUTBOX_CONFIG;
  }

  function toPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error('Solicitud IndexedDB rechazada'));
      };
    });
  }

  function readAll(source, query) {
    if (typeof source.getAll === 'function') {
      return toPromise(typeof query === 'undefined' ? source.getAll() : source.getAll(query));
    }
    return new Promise(function (resolve, reject) {
      var items = [];
      var request = typeof query === 'undefined' ? source.openCursor() : source.openCursor(query);
      request.onsuccess = function () {
        var cursor = request.result;
        if (!cursor) {
          resolve(items);
          return;
        }
        items.push(cursor.value);
        cursor.continue();
      };
      request.onerror = function () {
        reject(request.error || new Error('No se pudo recorrer el cursor'));
      };
    });
  }

  /* Abre la base una sola vez y reutiliza la misma conexión.
     onupgradeneeded solo se ejecuta cuando la versión cambia:
     ahí se crean los object stores y sus índices. */
  DB.open = function () {
    if (dbPromise) {
      return dbPromise;
    }

    dbPromise = new Promise(function (resolve, reject) {
      var request = global.indexedDB.open(cfg().DB_NAME, cfg().DB_VERSION);

      request.onupgradeneeded = function () {
        var db = request.result;
        var outboxName = cfg().STORE_OUTBOX;

        if (!db.objectStoreNames.contains(outboxName)) {
          var outbox = db.createObjectStore(outboxName, {
            keyPath: 'id',
            autoIncrement: true
          });
          outbox.createIndex('by_status', 'status', { unique: false });
          outbox.createIndex('by_clientId', 'clientId', { unique: true });
          outbox.createIndex('by_createdAt', 'createdAt', { unique: false });
        }

        if (!db.objectStoreNames.contains(cfg().STORE_META)) {
          db.createObjectStore(cfg().STORE_META, { keyPath: 'key' });
        }
      };

      request.onsuccess = function () {
        var db = request.result;
        db.onversionchange = function () {
          db.close();
          dbPromise = null;
        };
        db.onclose = function () {
          dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = function () {
        dbPromise = null;
        reject(request.error || new Error('No se pudo abrir IndexedDB'));
      };

      request.onblocked = function () {
        dbPromise = null;
        reject(new Error('La base está bloqueada por otra pestaña. Cierra las demás pestañas.'));
      };
    });

    return dbPromise;
  };

  DB.close = function () {
    if (!dbPromise) {
      return Promise.resolve();
    }
    return dbPromise.then(function (db) {
      db.close();
      dbPromise = null;
    });
  };

  DB.isSupported = function () {
    return typeof global.indexedDB !== 'undefined';
  };

  /* Ejecuta trabajo dentro de una transacción y resuelve cuando
     la transacción hace commit (no cuando responde el request). */
  function transaction(storeName, mode, work) {
    return DB.open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try {
          tx = db.transaction(storeName, mode);
        } catch (error) {
          reject(error);
          return;
        }

        var store = tx.objectStore(storeName);
        var output;
        var settled = false;

        function fail(error) {
          if (settled) {
            return;
          }
          settled = true;
          reject(error || new Error('Transacción abortada'));
        }

        tx.oncomplete = function () {
          if (settled) {
            return;
          }
          settled = true;
          resolve(output);
        };
        tx.onerror = function () {
          fail(tx.error);
        };
        tx.onabort = function () {
          fail(tx.error);
        };

        try {
          output = work(store, tx, fail);
        } catch (error) {
          try {
            tx.abort();
          } catch (ignored) {
            /* la transacción ya había terminado */
          }
          fail(error);
        }
      });
    });
  }

  DB.transaction = transaction;

  DB.add = function (storeName, value) {
    return transaction(storeName, 'readwrite', function (store) {
      return toPromise(store.add(value));
    });
  };

  DB.put = function (storeName, value) {
    return transaction(storeName, 'readwrite', function (store) {
      return toPromise(store.put(value));
    });
  };

  DB.get = function (storeName, key) {
    return transaction(storeName, 'readonly', function (store) {
      return toPromise(store.get(key));
    });
  };

  DB.getAll = function (storeName) {
    return transaction(storeName, 'readonly', function (store) {
      return readAll(store);
    });
  };

  DB.getAllByIndex = function (storeName, indexName, query) {
    return transaction(storeName, 'readonly', function (store) {
      return readAll(store.index(indexName), query);
    });
  };

  DB.count = function (storeName) {
    return transaction(storeName, 'readonly', function (store) {
      return toPromise(store.count());
    });
  };

  DB.countByIndex = function (storeName, indexName, query) {
    return transaction(storeName, 'readonly', function (store) {
      return toPromise(store.index(indexName).count(query));
    });
  };

  DB.delete = function (storeName, key) {
    return transaction(storeName, 'readwrite', function (store) {
      return toPromise(store.delete(key));
    });
  };

  DB.clear = function (storeName) {
    return transaction(storeName, 'readwrite', function (store) {
      return toPromise(store.clear());
    });
  };

  /* Lectura + modificación + escritura dentro de la MISMA transacción.
     Así se evita que dos contextos pisen el mismo registro. */
  DB.update = function (storeName, key, updater) {
    return transaction(storeName, 'readwrite', function (store, tx, fail) {
      var request = store.get(key);

      request.onsuccess = function () {
        try {
          var current = request.result;
          if (typeof current === 'undefined') {
            return;
          }
          var next = updater(current);
          if (!next) {
            return;
          }
          store.put(next);
        } catch (error) {
          try {
            tx.abort();
          } catch (ignored) {
            /* la transacción ya había terminado */
          }
          fail(error);
        }
      };

      request.onerror = function () {
        try {
          tx.abort();
        } catch (ignored) {
          /* la transacción ya había terminado */
        }
        fail(request.error);
      };

      return undefined;
    });
  };

  global.DB = DB;
})(typeof self !== 'undefined' ? self : this);
