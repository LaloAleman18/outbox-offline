/* outbox-repo.js — Repositorio de dominio del patrón Outbox.
   Encapsula las operaciones sobre el store "outbox" y el store "meta".
   Compartido por la página (app.js) y el Service Worker (sw.js). */
(function (global) {
  'use strict';

  var Outbox = {};

  function cfg() {
    return global.OUTBOX_CONFIG;
  }

  function DB() {
    return global.DB;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function newestFirst(a, b) {
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? 1 : -1;
  }

  function oldestFirst(a, b) {
    if (a.id === b.id) {
      return 0;
    }
    return a.id > b.id ? 1 : -1;
  }

  /* Crea el registro local ANTES de intentar cualquier envío.
     El payload viaja tal cual y clientId permite idempotencia. */
  Outbox.enqueue = function (payload) {
    var store = cfg().STORE_OUTBOX;
    var record = {
      clientId: payload.clientId,
      method: cfg().API_METHOD,
      url: cfg().API_URL,
      payload: payload,
      status: 'pendiente',
      attempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      sentAt: null,
      lastError: null,
      response: null
    };

    return DB().add(store, record).then(function (id) {
      record.id = id;
      return record;
    });
  };

  Outbox.list = function () {
    return DB().getAll(cfg().STORE_OUTBOX).then(function (rows) {
      return rows.sort(newestFirst);
    });
  };

  Outbox.get = function (id) {
    return DB().get(cfg().STORE_OUTBOX, id);
  };

  Outbox.listByStatus = function (status) {
    return DB()
      .getAllByIndex(cfg().STORE_OUTBOX, 'by_status', status)
      .then(function (rows) {
        return rows.sort(newestFirst);
      });
  };

  /* Solo se reintentan pendientes o errores que no agotaron sus intentos. */
  Outbox.listRetryable = function () {
    return Outbox.list().then(function (rows) {
      var max = cfg().MAX_ATTEMPTS;
      return rows
        .filter(function (row) {
          var retryable = row.status === 'pendiente' || row.status === 'error';
          return retryable && row.attempts < max;
        })
        .sort(oldestFirst);
    });
  };

  Outbox.markSyncing = function (id) {
    return DB().update(cfg().STORE_OUTBOX, id, function (record) {
      record.status = 'sincronizando';
      record.updatedAt = nowIso();
      record.lastError = null;
      return record;
    });
  };

  Outbox.markSent = function (id, response) {
    return DB().update(cfg().STORE_OUTBOX, id, function (record) {
      record.status = 'enviado';
      record.attempts += 1;
      record.updatedAt = nowIso();
      record.sentAt = nowIso();
      record.response = response || null;
      record.lastError = null;
      return record;
    });
  };

  Outbox.markError = function (id, message) {
    return DB().update(cfg().STORE_OUTBOX, id, function (record) {
      record.status = 'error';
      record.attempts += 1;
      record.updatedAt = nowIso();
      record.lastError = String(message || 'Error desconocido');
      return record;
    });
  };

  /* Reintento manual: devuelve el registro a "pendiente" y reinicia el contador. */
  Outbox.resetForRetry = function (id) {
    return DB().update(cfg().STORE_OUTBOX, id, function (record) {
      record.status = 'pendiente';
      record.attempts = 0;
      record.lastError = null;
      record.updatedAt = nowIso();
      return record;
    });
  };

  Outbox.remove = function (id) {
    return DB().delete(cfg().STORE_OUTBOX, id);
  };

  Outbox.clear = function () {
    return DB().clear(cfg().STORE_OUTBOX);
  };

  /* Promise.all para purgar en paralelo, como pide el patrón. */
  Outbox.purgeByStatus = function (status) {
    return Outbox.listByStatus(status).then(function (rows) {
      return Promise.all(
        rows.map(function (row) {
          return Outbox.remove(row.id);
        })
      ).then(function () {
        return rows.length;
      });
    });
  };

  Outbox.purgeSent = function () {
    return Outbox.purgeByStatus('enviado');
  };

  Outbox.stats = function () {
    return Outbox.list().then(function (rows) {
      var stats = {
        total: rows.length,
        pendiente: 0,
        sincronizando: 0,
        enviado: 0,
        error: 0,
        reintentables: 0
      };
      var max = cfg().MAX_ATTEMPTS;

      rows.forEach(function (row) {
        if (typeof stats[row.status] === 'number') {
          stats[row.status] += 1;
        }
        if ((row.status === 'pendiente' || row.status === 'error') && row.attempts < max) {
          stats.reintentables += 1;
        }
      });

      return stats;
    });
  };

  /* Store "meta": banderas de demostración compartidas con el Service Worker. */
  Outbox.getFlag = function (key, fallback) {
    return DB()
      .get(cfg().STORE_META, key)
      .then(function (row) {
        return row && Object.prototype.hasOwnProperty.call(row, 'value') ? row.value : fallback;
      });
  };

  Outbox.setFlag = function (key, value) {
    return DB().put(cfg().STORE_META, {
      key: key,
      value: value,
      updatedAt: nowIso()
    });
  };

  global.Outbox = Outbox;
})(typeof self !== 'undefined' ? self : this);
