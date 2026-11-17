# Tostaduría Andina · Pedidos offline

Aplicación académica de **persistencia offline** con IndexedDB, **patrón Outbox** y **Background Sync**, construida con JavaScript Vanilla y sin dependencias de terceros.

> Temas 5.1, 5.2 y 5.3 · Entrega: enlace de GitHub Pages + repositorio.

---

## Demo

- **GitHub Pages:** `https://TU-USUARIO.github.io/TU-REPO/` _(reemplaza este texto después de publicar)_
- **Repositorio:** `https://github.com/TU-USUARIO/TU-REPO`

### Qué demuestra

1. Cada pedido se guarda **primero** en IndexedDB (`outbox-db` → store `outbox`) con estado `pendiente`.
2. Si hay red, el **Service Worker** lo envía por `POST` y lo marca `enviado`.
3. Si no hay red (real o simulada), el pedido permanece en la cola.
4. Al recuperar la conexión:
   - Chromium usa **Background Sync** (`sync` + tag `outbox-sync`).
   - Safari/iOS usa el evento **`online`** como respaldo y pide el vaciado al SW por `postMessage`.
5. El SW reporta el resultado a la interfaz con `postMessage`; la UI refresca contadores y registros.

---

## Reglas de la cátedra cumplidas

| Regla | Cómo se cumple |
| --- | --- |
| 100 % JavaScript Vanilla | No hay PouchDB, Dexie, idb, Workbox ni ninguna librería. Cero dependencias en el cliente. |
| Cero azúcar sintáctico de funciones asíncronas | Toda la asincronía usa `new Promise()`, `.then()`, `.catch()` y `Promise.all()`. El código no declara funciones con la sintaxis moderna ni usa la palabra clave de espera. |
| Código ensamblado y comprendido | Módulos separados por responsabilidad, comentados y con documentación de defensa en [`DEFENSA.md`](./DEFENSA.md). |
| Rutas relativas | Todos los `src`, `href`, `importScripts` y el scope usan `./` para funcionar en subdirectorios de GitHub Pages. |

---

## Estructura

```text
.
├── index.html              Interfaz (formulario, cola, métricas, log)
├── styles.css              Diseño responsive sin fuentes externas
├── sw.js                   Service Worker: caché + motor de sincronización
├── manifest.json           Metadatos PWA
├── .nojekyll               Evita el procesamiento de Jekyll en GitHub Pages
├── icons/
│   ├── icon.svg
│   ├── icon-192.png
│   └── icon-512.png
├── js/
│   ├── config.js           Configuración compartida (DB, API, tag, límites)
│   ├── db-helper.js        Mini-wrapper promisificado de IndexedDB
│   ├── outbox-repo.js      Repositorio del patrón Outbox
│   ├── api.js              Transporte HTTP (solo lo usa el SW)
│   └── app.js              UI, validación y puente con el Service Worker
└── tools/
    └── server.js           Servidor local + mock de la API (Node, sin dependencias)
```

---

## Ejecutar en local

El Service Worker **no funciona con `file://`**: necesitas `http://localhost` o HTTPS.

### Opción recomendada (incluye mock de API)

```bash
node tools/server.js
```

Abre <http://localhost:8765/>.

El servidor sirve el proyecto y expone:

- `POST /api/pedidos` → responde `201` con el pedido recibido.
- `GET  /api/pedidos` → lista los pedidos que llegaron al mock.

En `localhost`, `js/config.js` apunta automáticamente a ese mock. En GitHub Pages apunta a JSONPlaceholder (o al backend que configures).

### Opción alternativa

Cualquier servidor estático (Live Server, `python -m http.server`, etc.). Si usas otro puerto, arranca igualmente `node tools/server.js` para tener la API en `8765`.

---

## Publicar en GitHub Pages

```bash
git init
git add .
git commit -m "Outbox offline con IndexedDB y Background Sync"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

Luego, en GitHub:

1. **Settings** → **Pages**.
2. **Source:** *Deploy from a branch*.
3. **Branch:** `main` · **Folder:** `/ (root)`.
4. Guarda y espera el despliegue.
5. Abre `https://TU-USUARIO.github.io/TU-REPO/`.

### Por qué no hay errores 404 en el subdirectorio

- Todos los recursos usan `./` (`./styles.css`, `./js/app.js`, `./sw.js`).
- El Service Worker se registra con `scope: './'`.
- `SHELL_ASSETS` usa rutas relativas al propio `sw.js`.
- `.nojekyll` evita que GitHub Pages ignore archivos que empiezan con `_`.

> Si cambias el nombre del repositorio, no hace falta tocar rutas: todo es relativo.

---

## Cómo probar la demo (5 minutos)

### 1. Ver la base de datos

DevTools → **Application** → **IndexedDB** → `outbox-db` → `outbox`.

### 2. Provocar el modo offline

Dos formas:

- **Real:** DevTools → **Network** → *Offline*.
- **Simulada:** activa el interruptor **“Simular caída de red (demo)”**.

La bandera se guarda en IndexedDB (`meta` → `demoOffline`), por lo que **el Service Worker también la respeta**.

### 3. Crear pedidos

Cada pedido aparece como `pendiente`, con payload, `clientId`, intentos y fecha. Todo queda en IndexedDB.

### 4. Recuperar la conexión

Desactiva *Offline* / el interruptor y pulsa **Sincronizar ahora**:

- El SW toma los registros `pendiente`/`error`.
- Hace `POST` secuencial (FIFO).
- Marca `enviado` o `error` con `lastError`.
- Envía `OUTBOX_SYNC_RESULT` a la página con `postMessage`.
- La UI actualiza contadores y muestra un *toast*.

### 5. Probar errores y reintentos

- Con la red simulada caída, pulsa **Sincronizar ahora**: el registro pasa a `error` con el mensaje del fallo.
- Desactiva la simulación y usa **Reintentar**: vuelve a `pendiente`, se reinician los intentos y se sincroniza.
- **Purgar enviados** borra los `enviado`; **Vaciar todo** limpia la cola.

---

## Arquitectura

```text
┌─────────────┐   1. enqueue    ┌──────────────────────┐
│  index.html │ ──────────────► │ IndexedDB outbox-db  │
│   app.js    │                 │ store: outbox        │
└──────┬──────┘                 │ estado: pendiente    │
       │ 2. register(sync)      └──────────┬───────────┘
       │    o postMessage                  │ 3. listRetryable()
       ▼                                   ▼
┌──────────────────────────────────────────────────────┐
│ sw.js · motor de sincronización                      │
│  - sync event (Chromium)                             │
│  - message FLUSH_OUTBOX (respaldo / Safari)          │
│  - Api.post() → POST real                            │
│  - markSent / markError                              │
└──────────────────────────┬───────────────────────────┘
                           │ 4. clients.matchAll()
                           │    client.postMessage(...)
                           ▼
                 ┌───────────────────┐
                 │ app.js actualiza  │
                 │ métricas y cola   │
                 └───────────────────┘
```

### Esquema de datos

Store `outbox` (`keyPath: 'id'`, `autoIncrement: true`):

```js
{
  id: 1,
  clientId: "uuid-v4",          // idempotencia
  method: "POST",
  url: "https://.../api/pedidos",
  payload: { cliente, producto, cantidad, notas, createdAt, clientId },
  status: "pendiente",          // pendiente | sincronizando | enviado | error
  attempts: 0,                  // máximo 5 automáticos
  createdAt: "2026-11-16T...",
  updatedAt: "2026-11-16T...",
  sentAt: null,
  lastError: null,
  response: null                // respuesta del servidor
}
```

Índices: `by_status`, `by_clientId` (único), `by_createdAt`.

Store `meta` (`keyPath: 'key'`): banderas compartidas, por ejemplo `demoOffline`.

### Decisiones técnicas

- **Outbox primero, red después:** el pedido nunca se pierde si el envío falla.
- **`clientId` único:** permite idempotencia; el backend puede ignorar duplicados.
- **Transacciones:** `readwrite` para mutaciones, `readonly` para lecturas. `DB.update` hace lectura + escritura en la **misma** transacción.
- **Una sola conexión:** `DB.open()` memoiza la promesa de apertura.
- **Bloqueo de sincronización:** `activeSync` evita que dos disparos (sync + mensaje) procesen la misma cola a la vez.
- **FIFO:** los registros se envían en orden de creación con `reduce` encadenado.
- **Reintentos acotados:** `MAX_ATTEMPTS = 5`; el reintento manual reinicia el contador.
- **Sin caché de POST:** el handler de `fetch` solo intercepta `GET` del mismo origen.
- **App shell offline:** navegación *network-first* con respaldo en caché; assets *stale-while-revalidate*.

---

## Configuración

Todo vive en `js/config.js`:

```js
API_URL: isLocal
  ? 'http://localhost:8765/api/pedidos'
  : 'https://jsonplaceholder.typicode.com/posts',
```

Para conectar tu propio backend, cambia `API_URL` por tu endpoint HTTPS con CORS habilitado. El resto del código no necesita cambios.

> JSONPlaceholder es una API pública de pruebas: acepta `POST` y responde `201`. Si el día de la defensa no hay internet, usa `node tools/server.js` y abre la app en `localhost`.

---

## Solución de problemas

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| El SW no se registra | Abriste `index.html` con `file://` | Usa `http://localhost` o GitHub Pages. |
| 404 en CSS/JS | Ruta absoluta (`/styles.css`) | Usa rutas relativas (`./styles.css`). |
| “Background Sync is disabled” | Navegador o contexto sin SyncManager | Es normal: la app cae al canal `postMessage`. |
| El POST falla siempre en Pages | JSONPlaceholder caído o bloqueado | Cambia `API_URL` o usa el mock local. |
| La cola no se actualiza | El SW quedó en una versión vieja | DevTools → Application → Service Workers → *Update*. |
| Quiero empezar de cero | Datos de pruebas | DevTools → Application → IndexedDB → elimina `outbox-db`. |

---

## Checklist de entrega

- [ ] Repositorio público en GitHub.
- [ ] GitHub Pages activo en `main` / root.
- [ ] Enlace de Pages probado en una ventana de incógnito.
- [ ] Pedido creado sin red → aparece como `pendiente`.
- [ ] Al volver la red → pasa a `enviado`.
- [ ] `postMessage` visible en el registro de actividad.
- [ ] Consola sin errores.
- [ ] Enlace y repositorio pegados en la tarea.
