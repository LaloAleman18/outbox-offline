/* app.js — Interfaz, validación y puente hacia el Service Worker.
   JavaScript Vanilla. Toda la asincronía con new Promise / .then / .catch. */
(function (global) {
  'use strict';

  var cfg = global.OUTBOX_CONFIG;
  var doc = global.document;
  var navigatorRef = global.navigator;

  var STATUS_LABEL = {
    pendiente: 'Pendiente',
    sincronizando: 'Sincronizando',
    enviado: 'Enviado',
    error: 'Error'
  };

  var state = {
    registration: null,
    workerReady: false,
    online: true,
    demoOffline: false,
    syncing: false,
    records: [],
    log: [],
    watchdog: null
  };

  var dom = {};
  var dateFormatter = null;

  function $(selector) {
    return doc.querySelector(selector);
  }

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (typeof text === 'string') {
      node.textContent = text;
    }
    return node;
  }

  /* ---------- Arranque ---------- */

  function boot() {
    cacheDom();

    if (!dom.form) {
      return;
    }

    bindEvents();
    renderConnectivity();
    renderStrategy();
    renderSyncState();
    log('Aplicación iniciada · JavaScript Vanilla para la lógica.', 'info');

    if (!global.DB || !global.Outbox) {
      log('No se cargaron los módulos de IndexedDB.', 'error');
      return;
    }

    if (!global.DB.isSupported()) {
      log('Este navegador no soporta IndexedDB.', 'error');
      return;
    }

    syncDemoFlag()
      .then(registerServiceWorker)
      .then(function () {
        return refresh();
      })
      .then(autoSyncIfNeeded)
      .catch(function (error) {
        log('Error de arranque: ' + (error && error.message ? error.message : String(error)), 'error');
      });
  }

  function cacheDom() {
    dom.form = $('#order-form');
    dom.cliente = $('#cliente');
    dom.producto = $('#producto');
    dom.cantidad = $('#cantidad');
    dom.notas = $('#notas');
    dom.errorCliente = $('#error-cliente');
    dom.errorProducto = $('#error-producto');
    dom.errorCantidad = $('#error-cantidad');
    dom.submitBtn = $('#submit-btn');

    dom.pillConnection = $('#pill-connection');
    dom.pillConnectionText = $('#pill-connection-text');
    dom.pillWorker = $('#pill-worker');
    dom.pillWorkerText = $('#pill-worker-text');
    dom.pillStrategy = $('#pill-strategy');
    dom.pillStrategyText = $('#pill-strategy-text');

    dom.statTotal = $('#stat-total');
    dom.statPending = $('#stat-pending');
    dom.statSent = $('#stat-sent');
    dom.statError = $('#stat-error');

    dom.btnSync = $('#btn-sync');
    dom.btnPurge = $('#btn-purge');
    dom.btnClear = $('#btn-clear');
    dom.demoOffline = $('#demo-offline');
    dom.syncState = $('#sync-state');
    dom.list = $('#outbox-list');
    dom.empty = $('#outbox-empty');

    dom.log = $('#activity-log');
    dom.btnClearLog = $('#btn-clear-log');
    dom.toasts = $('#toasts');
  }

  function bindEvents() {
    dom.form.addEventListener('submit', handleSubmit);

    [dom.cliente, dom.producto, dom.cantidad].forEach(function (input) {
      input.addEventListener('input', function () {
        var field = input.closest('.field');
        if (field) {
          field.classList.remove('is-invalid');
        }
        var error = doc.getElementById('error-' + input.name);
        if (error) {
          error.hidden = true;
        }
      });
    });

    dom.btnSync.addEventListener('click', function () {
      requestSync('manual').catch(function (error) {
        log('No se pudo sincronizar: ' + error.message, 'warn');
        toast('No se pudo iniciar la sincronización', 'error');
      });
    });

    dom.btnPurge.addEventListener('click', handlePurge);
    dom.btnClear.addEventListener('click', handleClearAll);
    dom.demoOffline.addEventListener('change', handleDemoToggle);

    dom.btnClearLog.addEventListener('click', function () {
      state.log = [];
      renderLog();
    });

    dom.list.addEventListener('click', handleListClick);

    global.addEventListener('online', handleOnline);
    global.addEventListener('offline', handleOffline);

    doc.addEventListener('visibilitychange', function () {
      if (!doc.hidden) {
        refresh();
      }
    });

    if ('serviceWorker' in navigatorRef) {
      navigatorRef.serviceWorker.addEventListener('controllerchange', function () {
        log('El Service Worker tomó el control de esta página.', 'ok');
      });
    }
  }

  /* ---------- Formulario ---------- */

  function handleSubmit(event) {
    event.preventDefault();

    if (!validateForm()) {
      log('Formulario incompleto: revisa los campos marcados.', 'warn');
      return;
    }

    var payload = readForm();
    setFormBusy(true);

    global.Outbox.enqueue(payload)
      .then(function (record) {
        log('Pedido #' + record.id + ' guardado en IndexedDB como pendiente.', 'ok');
        toast('Pedido #' + record.id + ' guardado localmente', 'success');
        resetForm();
        return refresh().then(function () {
          return maybeStartSync('alta').catch(function (error) {
            log('El pedido quedó en cola; se enviará al recuperar la conexión: ' + error.message, 'warn');
            toast('Pedido en cola · pendiente de envío', 'warn');
          });
        });
      })
      .catch(function (error) {
        log('No se pudo guardar en IndexedDB: ' + error.message, 'error');
        toast('Error al guardar el pedido', 'error');
      })
      .then(function () {
        setFormBusy(false);
      });
  }

  function validateForm() {
    var clienteOk = dom.cliente.value.trim().length >= 2;
    var productoOk = dom.producto.value !== '';
    var cantidad = Number(dom.cantidad.value);
    var cantidadOk =
      Number.isFinite(cantidad) &&
      cantidad >= 1 &&
      cantidad <= 99 &&
      Math.floor(cantidad) === cantidad;

    var ok = true;
    ok = markField(dom.cliente, dom.errorCliente, clienteOk) && ok;
    ok = markField(dom.producto, dom.errorProducto, productoOk) && ok;
    ok = markField(dom.cantidad, dom.errorCantidad, cantidadOk) && ok;

    if (!ok) {
      var firstInvalid = dom.form.querySelector('.is-invalid');
      if (firstInvalid) {
        firstInvalid.focus();
      }
    }

    return ok;
  }

  function markField(input, errorNode, ok) {
    input.classList.toggle('is-invalid', !ok);
    errorNode.hidden = ok;
    return ok;
  }

  function readForm() {
    return {
      clientId: uid(),
      cliente: dom.cliente.value.trim(),
      producto: dom.producto.value,
      cantidad: Number(dom.cantidad.value),
      notas: dom.notas.value.trim(),
      origen: 'formulario',
      createdAt: new Date().toISOString()
    };
  }

  function resetForm() {
    dom.form.reset();
    dom.cantidad.value = '1';
    dom.form.querySelectorAll('.is-invalid').forEach(function (input) {
      input.classList.remove('is-invalid');
    });
    dom.errorCliente.hidden = true;
    dom.errorProducto.hidden = true;
    dom.errorCantidad.hidden = true;
    dom.cliente.focus();
  }

  function setFormBusy(busy) {
    dom.submitBtn.disabled = busy;
    var label = dom.submitBtn.querySelector('.btn__label');
    if (label) {
      label.textContent = busy ? 'Guardando…' : 'Guardar pedido';
    }
  }

  /* ---------- Sincronización ---------- */

  function maybeStartSync(origin) {
    if (!state.online) {
      log('Sin conexión: el pedido espera en la cola y se reintentará al volver la red.', 'warn');
      return registerBackgroundSync(origin);
    }

    if (state.demoOffline) {
      log('Red simulada caída: el pedido espera en la cola.', 'warn');
      return registerBackgroundSync(origin);
    }

    return requestSync(origin);
  }

  function supportsNativeSync() {
    return 'serviceWorker' in navigatorRef && 'SyncManager' in global;
  }

  function requestSync(origin) {
    if (state.syncing) {
      log('Ya hay una sincronización en curso.', 'info');
      return Promise.resolve(false);
    }

    if (!state.workerReady || !state.registration) {
      return Promise.reject(new Error('el Service Worker todavía no está listo'));
    }

    state.syncing = true;
    renderSyncState();
    startWatchdog();

    var canRegister = supportsNativeSync() && state.registration.sync;
    var registrationStep = canRegister
      ? state.registration.sync
          .register(cfg.SYNC_TAG)
          .then(function () {
            log('Background Sync registrado (tag "' + cfg.SYNC_TAG + '").', 'info');
          })
          .catch(function (error) {
            log('No se pudo registrar Background Sync: ' + error.message + '. Se usará postMessage.', 'warn');
          })
      : Promise.resolve();

    return registrationStep
      .then(function () {
        return postToWorker({ type: 'FLUSH_OUTBOX', origin: origin });
      })
      .catch(function (error) {
        stopWatchdog();
        state.syncing = false;
        renderSyncState();
        throw error;
      });
  }

  function registerBackgroundSync(origin) {
    if (!state.registration || !state.registration.sync) {
      return Promise.resolve(false);
    }

    return state.registration.sync
      .register(cfg.SYNC_TAG)
      .then(function () {
        log('Background Sync registrado desde ' + origin + ' (tag "' + cfg.SYNC_TAG + '").', 'info');
        return true;
      })
      .catch(function (error) {
        log('No se pudo registrar Background Sync: ' + error.message, 'warn');
        return false;
      });
  }

  function postToWorker(message) {
    return navigatorRef.serviceWorker.ready.then(function (registration) {
      var worker = registration.active || registration.waiting || registration.installing;
      if (!worker) {
        throw new Error('no hay un Service Worker activo');
      }
      worker.postMessage(message);
      return true;
    });
  }

  function startWatchdog() {
    stopWatchdog();
    state.watchdog = global.setTimeout(function () {
      if (!state.syncing) {
        return;
      }
      state.syncing = false;
      renderSyncState();
      log('El Service Worker no respondió en 20 s. Revisa Application → Service Workers.', 'warn');
    }, 20000);
  }

  function stopWatchdog() {
    if (state.watchdog) {
      global.clearTimeout(state.watchdog);
      state.watchdog = null;
    }
  }

  function finishSync() {
    stopWatchdog();
    state.syncing = false;
    renderSyncState();
  }

  function autoSyncIfNeeded() {
    var retryable = state.records.filter(function (record) {
      var pending = record.status === 'pendiente' || record.status === 'error';
      return pending && record.attempts < cfg.MAX_ATTEMPTS;
    });

    if (!retryable.length) {
      return Promise.resolve();
    }

    if (!state.online) {
      log('Hay ' + retryable.length + ' pedido(s) en cola. Se reintentará al volver la red.', 'warn');
      return Promise.resolve();
    }

    if (state.demoOffline) {
      log('Modo demo activo: ' + retryable.length + ' pedido(s) esperan en la cola.', 'warn');
      return Promise.resolve();
    }

    log('Detectados ' + retryable.length + ' pedido(s) en cola. Solicitando sincronización…', 'info');
    return requestSync('arranque').catch(function (error) {
      log('No se pudo sincronizar al arrancar: ' + error.message, 'warn');
    });
  }

  function onWorkerMessage(event) {
    var data = event.data || {};

    if (data.type === 'OUTBOX_SYNC_STARTED') {
      state.syncing = true;
      renderSyncState();
      startWatchdog();
      log('El SW inició la sincronización (' + data.total + ' en cola) · origen: ' + data.origin + '.', 'info');
      refresh();
      return;
    }

    if (data.type === 'OUTBOX_SYNC_RESULT') {
      finishSync();
      var summary = data.summary || {};

      if (summary.total > 0) {
        var tone = summary.failed > 0 ? 'warn' : 'ok';
        log(
          'Sincronización terminada: ' + summary.sent + ' enviado(s), ' +
          summary.failed + ' con error · origen: ' + summary.origin + '.',
          tone
        );
        if (summary.sent > 0) {
          toast(summary.sent + ' pedido(s) enviado(s) al servidor', 'success');
        }
        if (summary.failed > 0) {
          toast(summary.failed + ' pedido(s) no pudieron enviarse', 'error');
        }
      } else {
        log('Sincronización sin cambios: no había pedidos pendientes.', 'info');
      }

      refresh();
      return;
    }

    if (data.type === 'OUTBOX_SYNC_FAILED') {
      finishSync();
      log('El motor de sincronización falló: ' + data.error, 'error');
      toast('Falló la sincronización', 'error');
      refresh();
    }
  }

  /* ---------- Service Worker ---------- */

  function waitForActivation(registration) {
    return new Promise(function (resolve) {
      var timer = global.setTimeout(function () {
        resolve(registration);
      }, 6000);

      navigatorRef.serviceWorker.ready.then(
        function (readyRegistration) {
          global.clearTimeout(timer);
          resolve(readyRegistration);
        },
        function () {
          global.clearTimeout(timer);
          resolve(registration);
        }
      );
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigatorRef)) {
      renderWorker('error', 'SW no soportado');
      log('Este navegador no soporta Service Workers. La cola local funciona, pero sin envío automático.', 'error');
      return Promise.resolve(null);
    }

    renderWorker('neutral', 'Registrando SW…');

    return navigatorRef.serviceWorker
      .register('./sw.js', { scope: './' })
      .then(function (registration) {
        state.registration = registration;
        navigatorRef.serviceWorker.addEventListener('message', onWorkerMessage);
        log('Service Worker registrado con scope ' + registration.scope + '.', 'ok');

        if (registration.waiting && navigatorRef.serviceWorker.controller) {
          log('Hay una nueva versión del SW en espera. Recarga para aplicarla.', 'warn');
        }

        if (registration.active) {
          state.workerReady = true;
          renderWorker('online', 'SW activo');
          log('Service Worker activo. Motor de sincronización listo.', 'ok');
          return registration;
        }

        renderWorker('neutral', 'Activando SW…');

        return waitForActivation(registration).then(function (readyRegistration) {
          state.registration = readyRegistration;
          state.workerReady = !!(readyRegistration && readyRegistration.active);
          if (state.workerReady) {
            renderWorker('online', 'SW activo');
            log('Service Worker activo. Motor de sincronización listo.', 'ok');
          } else {
            renderWorker('error', 'SW sin activar');
            log('El SW no llegó a activarse. Revisa Application → Service Workers.', 'warn');
          }
          return readyRegistration;
        });
      })
      .catch(function (error) {
        renderWorker('error', 'SW con error');
        log(
          'No se pudo registrar el SW: ' + error.message +
          '. Necesitas http://localhost o https:// (no abras index.html con file://).',
          'error'
        );
        return null;
      });
  }

  /* ---------- Estado visual ---------- */

  function setPill(node, textNode, kind, text) {
    node.className = 'statusline statusline--' + kind;
    textNode.textContent = text;
  }

  function renderConnectivity() {
    state.online = navigatorRef.onLine;

    if (!state.online) {
      setPill(dom.pillConnection, dom.pillConnectionText, 'offline', 'Sin conexión');
      doc.body.classList.add('is-offline');
    } else if (state.demoOffline) {
      setPill(dom.pillConnection, dom.pillConnectionText, 'offline', 'Red simulada caída');
      doc.body.classList.add('is-offline');
    } else {
      setPill(dom.pillConnection, dom.pillConnectionText, 'online', 'En línea');
      doc.body.classList.remove('is-offline');
    }
  }

  function renderWorker(kind, text) {
    setPill(dom.pillWorker, dom.pillWorkerText, kind, text);
  }

  function renderStrategy() {
    var native = supportsNativeSync();
    setPill(
      dom.pillStrategy,
      dom.pillStrategyText,
      native ? 'online' : 'warn',
      native ? 'Background Sync' : 'Respaldo: online'
    );
    dom.pillStrategy.title = native
      ? 'SyncManager disponible: el navegador despierta al SW al recuperar la red.'
      : 'Sin SyncManager (Safari/iOS): el evento online de la página pide el vaciado al SW por postMessage.';
  }

  function renderSyncState() {
    dom.syncState.classList.toggle('is-syncing', state.syncing);
    dom.syncState.textContent = state.syncing ? 'Sincronizando…' : 'En espera';
    dom.btnSync.disabled = state.syncing;
    dom.btnSync.textContent = state.syncing ? 'Sincronizando…' : 'Sincronizar';
  }

  function renderStats(rows) {
    var counts = { total: rows.length, pending: 0, sent: 0, error: 0 };

    rows.forEach(function (row) {
      if (row.status === 'pendiente' || row.status === 'sincronizando') {
        counts.pending += 1;
      } else if (row.status === 'enviado') {
        counts.sent += 1;
      } else if (row.status === 'error') {
        counts.error += 1;
      }
    });

    dom.statTotal.textContent = String(counts.total);
    dom.statPending.textContent = String(counts.pending);
    dom.statSent.textContent = String(counts.sent);
    dom.statError.textContent = String(counts.error);
  }

  function refresh() {
    return global.Outbox.list()
      .then(function (rows) {
        state.records = rows;
        renderStats(rows);
        renderRecords(rows);
        return rows;
      })
      .catch(function (error) {
        log('No se pudo leer la cola: ' + error.message, 'error');
        return [];
      });
  }

  /* ---------- Render de la cola ---------- */

  function renderRecords(rows) {
    var fragment = doc.createDocumentFragment();

    rows.forEach(function (record) {
      fragment.appendChild(buildRecord(record));
    });

    dom.list.innerHTML = '';
    dom.list.appendChild(fragment);
    dom.empty.hidden = rows.length > 0;
  }

  function buildRecord(record) {
    var node = doc.createElement('article');
    node.className = 'record list-group-item px-0 py-3';
    node.setAttribute('data-id', String(record.id));

    var head = el(
      'div',
      'record__head d-flex flex-wrap justify-content-between align-items-baseline gap-2'
    );

    var status = el(
      'span',
      'badge rounded-pill status-badge status-badge--' + record.status,
      STATUS_LABEL[record.status] || record.status
    );
    head.appendChild(status);

    var aside = el('span', 'record__aside small text-body-secondary');
    aside.appendChild(el('span', 'record__id font-monospace', '#' + record.id));
    aside.appendChild(doc.createTextNode(' · '));
    var time = doc.createElement('time');
    time.dateTime = record.createdAt;
    time.textContent = formatDate(record.createdAt);
    aside.appendChild(time);
    head.appendChild(aside);
    node.appendChild(head);

    var payload = record.payload || {};
    node.appendChild(
      el('h3', 'record__client h6 mt-2 mb-1', payload.cliente || 'Cliente sin nombre')
    );
    node.appendChild(
      el(
        'p',
        'record__line small text-body-secondary mb-1',
        (payload.producto || 'Producto') + ' × ' + (payload.cantidad || 1)
      )
    );

    if (payload.notas) {
      node.appendChild(el('p', 'record__note fst-italic mb-1', payload.notas));
    }

    if (record.lastError) {
      node.appendChild(
        el('p', 'record__error alert alert-danger py-1 px-2 small mt-2 mb-0', record.lastError)
      );
    }

    var footer = el(
      'div',
      'record__foot d-flex flex-wrap justify-content-between align-items-center gap-2 mt-2'
    );
    footer.appendChild(
      el(
        'span',
        'record__meta font-monospace',
        record.attempts + '/' + cfg.MAX_ATTEMPTS + ' intentos · ' +
          String(record.clientId || '').slice(0, 8)
      )
    );

    var actions = el('div', 'record__actions d-flex gap-3');

    if (record.status === 'pendiente' || record.status === 'error') {
      var retryButton = actionButton(
        'retry',
        record.id,
        'Reintentar',
        'btn btn-link btn-sm p-0 text-decoration-none'
      );
      retryButton.setAttribute(
        'aria-label',
        'Reintentar pedido #' + record.id + ' de ' + (payload.cliente || 'cliente')
      );
      actions.appendChild(retryButton);
    }

    var deleteButton = actionButton(
      'delete',
      record.id,
      'Eliminar',
      'btn btn-link btn-sm p-0 text-decoration-none text-danger'
    );
    deleteButton.setAttribute(
      'aria-label',
      'Eliminar pedido #' + record.id + ' de ' + (payload.cliente || 'cliente')
    );
    actions.appendChild(deleteButton);

    footer.appendChild(actions);
    node.appendChild(footer);

    var details = doc.createElement('details');
    details.className = 'record__details mt-2';
    details.appendChild(el('summary', 'small', 'Detalles'));
    details.appendChild(
      el('pre', 'bg-body-tertiary border rounded p-2 mt-2 mb-0', JSON.stringify(record, null, 2))
    );
    node.appendChild(details);

    return node;
  }

  function actionButton(action, id, label, className) {
    var button = doc.createElement('button');
    button.type = 'button';
    button.className = className;
    button.setAttribute('data-action', action);
    button.setAttribute('data-id', String(id));
    button.textContent = label;
    return button;
  }

  function handleListClick(event) {
    var button = event.target.closest ? event.target.closest('button[data-action]') : null;
    if (!button) {
      return;
    }

    var action = button.getAttribute('data-action');
    var id = Number(button.getAttribute('data-id'));
    if (!id) {
      return;
    }

    if (action === 'retry') {
      retryRecord(id);
    } else if (action === 'delete') {
      deleteRecord(id);
    }
  }

  function retryRecord(id) {
    global.Outbox.resetForRetry(id)
      .then(function () {
        log('Pedido #' + id + ' marcado como pendiente para reintento.', 'info');
        return refresh();
      })
      .then(function () {
        if (!state.online) {
          log('Sin conexión: el reintento esperará.', 'warn');
          return registerBackgroundSync('reintento');
        }
        if (state.demoOffline) {
          log('Modo demo: el reintento esperará.', 'warn');
          return registerBackgroundSync('reintento');
        }
        return requestSync('reintento');
      })
      .catch(function (error) {
        log('No se pudo reintentar #' + id + ': ' + error.message, 'error');
      });
  }

  function deleteRecord(id) {
    global.Outbox.remove(id)
      .then(function () {
        log('Pedido #' + id + ' eliminado de la cola.', 'info');
        toast('Registro #' + id + ' eliminado', 'info');
        return refresh();
      })
      .catch(function (error) {
        log('No se pudo eliminar #' + id + ': ' + error.message, 'error');
      });
  }

  /* ---------- Acciones de la cola ---------- */

  function handlePurge() {
    if (state.syncing) {
      toast('Espera a que termine la sincronización', 'warn');
      return;
    }

    global.Outbox.purgeSent()
      .then(function (count) {
        if (count > 0) {
          log('Purgados ' + count + ' registro(s) enviados.', 'ok');
          toast(count + ' registro(s) enviados purgados', 'success');
        } else {
          log('No había registros enviados para purgar.', 'info');
          toast('Nada que purgar', 'info');
        }
        return refresh();
      })
      .catch(function (error) {
        log('No se pudo purgar la cola: ' + error.message, 'error');
      });
  }

  function handleClearAll() {
    if (state.syncing) {
      toast('Espera a que termine la sincronización', 'warn');
      return;
    }

    var confirmed = global.confirm('¿Vaciar toda la cola? Se borrarán todos los registros locales.');
    if (!confirmed) {
      return;
    }

    global.Outbox.clear()
      .then(function () {
        log('Cola local vaciada por completo.', 'warn');
        toast('Cola vaciada', 'warn');
        return refresh();
      })
      .catch(function (error) {
        log('No se pudo vaciar la cola: ' + error.message, 'error');
      });
  }

  /* ---------- Conexión y demostración ---------- */

  function handleOnline() {
    renderConnectivity();
    log('El navegador recuperó la conexión.', 'ok');

    if (state.demoOffline) {
      log('Modo demo activo: no se enviará nada todavía.', 'warn');
      return;
    }

    if (!supportsNativeSync()) {
      log('Sin SyncManager: usando el evento online como respaldo.', 'info');
      requestSync('online-fallback').catch(function (error) {
        log('Respaldo online: ' + error.message, 'warn');
      });
    } else {
      log('Background Sync disponible: el navegador reintentará la cola.', 'info');
      registerBackgroundSync('online');
    }
  }

  function handleOffline() {
    renderConnectivity();
    log('Sin conexión: los pedidos se guardarán en IndexedDB.', 'warn');
    toast('Sin conexión · modo offline activo', 'warn');
  }

  function handleDemoToggle(event) {
    var checked = event.target.checked;
    state.demoOffline = checked;

    global.Outbox.setFlag(cfg.FLAGS.DEMO_OFFLINE, checked)
      .then(function () {
        renderConnectivity();
        log(
          checked
            ? 'Modo demo: toda salida HTTP fallará de forma simulada.'
            : 'Modo demo desactivado: la red vuelve a intentarse.',
          checked ? 'warn' : 'info'
        );

        if (checked) {
          toast('Red simulada caída', 'warn');
          return;
        }

        if (!navigatorRef.onLine) {
          log('La conexión real sigue caída; los pedidos esperarán.', 'warn');
          return;
        }

        requestSync('demo-off').catch(function (error) {
          log('No se pudo sincronizar al desactivar la demo: ' + error.message, 'warn');
        });
      })
      .catch(function (error) {
        log('No se pudo guardar la bandera de demostración: ' + error.message, 'error');
      });
  }

  function syncDemoFlag() {
    return global.Outbox.getFlag(cfg.FLAGS.DEMO_OFFLINE, false).then(function (value) {
      state.demoOffline = value === true;
      dom.demoOffline.checked = state.demoOffline;
      renderConnectivity();
      return state.demoOffline;
    });
  }

  /* ---------- Registro de actividad y toasts ---------- */

  function log(message, tone) {
    state.log.unshift({
      at: new Date(),
      message: String(message),
      tone: tone || 'info'
    });

    if (state.log.length > 80) {
      state.log.length = 80;
    }

    renderLog();
  }

  function renderLog() {
    var fragment = doc.createDocumentFragment();

    state.log.forEach(function (entry) {
      var item = doc.createElement('li');
      item.className = 'log__item log__item--' + entry.tone;

      var time = doc.createElement('time');
      time.className = 'log__time';
      time.textContent = formatClock(entry.at);

      var message = doc.createElement('span');
      message.className = 'log__msg';
      message.textContent = entry.message;

      item.appendChild(time);
      item.appendChild(message);
      fragment.appendChild(item);
    });

    dom.log.innerHTML = '';
    dom.log.appendChild(fragment);
  }

  function toast(message, tone) {
    var node = el('div', 'app-toast app-toast--' + (tone || 'info'));
    node.setAttribute('role', 'status');
    node.appendChild(el('span', 'app-toast__dot'));
    node.appendChild(el('span', 'app-toast__text', message));
    dom.toasts.appendChild(node);

    global.setTimeout(function () {
      node.classList.add('app-toast--out');
      global.setTimeout(function () {
        if (node.parentNode) {
          node.parentNode.removeChild(node);
        }
      }, 300);
    }, 3800);
  }

  /* ---------- Utilidades ---------- */

  function formatDate(iso) {
    if (!iso) {
      return '—';
    }
    try {
      if (!dateFormatter) {
        dateFormatter = new Intl.DateTimeFormat('es', {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        });
      }
      return dateFormatter.format(new Date(iso));
    } catch (error) {
      return iso;
    }
  }

  function formatClock(date) {
    try {
      return date.toLocaleTimeString('es', { hour12: false });
    } catch (error) {
      return '--:--:--';
    }
  }

  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }

    var bytes = new Uint8Array(16);
    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      global.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < 16; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    var hex = Array.prototype.map
      .call(bytes, function (byte) {
        return ('0' + byte.toString(16)).slice(-2);
      })
      .join('');

    return (
      hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' + hex.slice(20)
    );
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof self !== 'undefined' ? self : this);
