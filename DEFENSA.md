# Defensa oral · guion y preguntas frecuentes

Documento de apoyo para la defensa práctica de 5 minutos sobre GitHub Pages y el código fuente.

---

## Guion sugerido (5 minutos)

### 0:00 – 0:40 · Contexto

> “La app es un panel de pedidos de una tostaduría. El problema que resuelve es que un pedido no se puede perder si el usuario está sin red o si el servidor falla. Para eso combiné tres piezas: IndexedDB como base local, el patrón Outbox como cola de salida y el Service Worker con Background Sync como motor de envío.”

### 0:40 – 1:40 · Tema 5.1: IndexedDB

> “`localStorage` es síncrono, guarda solo strings y bloquea el hilo principal. `Cache API` está pensada para respuestas HTTP. IndexedDB es una base transaccional, asíncrona y orientada a objetos, ideal para una cola.
>
> En `db-helper.js` hay un mini-wrapper promisificado. La base `outbox-db` se crea en `onupgradeneeded`, que solo corre cuando cambia la versión. Ahí creo el store `outbox` con `keyPath: 'id'` autoincremental y tres índices: por estado, por `clientId` y por fecha.
>
> Las lecturas usan transacciones `readonly`; las escrituras, `readwrite`. `DB.update` hace lectura y escritura dentro de la misma transacción para evitar condiciones de carrera.”

### 1:40 – 2:40 · Tema 5.2: patrón Outbox

> “El flujo es *outbox first*: el formulario no hace `fetch` directo. Primero llama a `Outbox.enqueue`, que crea un registro `pendiente` en IndexedDB. Si el envío falla, el pedido ya está a salvo. La cola se puede ver, reintentar, purgar o vaciar.
>
> Cada registro guarda `clientId`, un UUID único, para que el backend pueda descartar duplicados. El estado puede ser `pendiente`, `sincronizando`, `enviado` o `error`, y `attempts` limita los reintentos automáticos a cinco.”

### 2:40 – 4:00 · Demo en vivo

1. Mostrar **Application → IndexedDB → outbox-db → outbox**.
2. Activar **“Simular caída de red”**.
3. Crear un pedido.
4. Mostrar el registro `pendiente`, su payload y `attempts: 0`.
5. Desactivar la simulación y pulsar **Sincronizar ahora**.
6. Mostrar cómo pasa a `enviado` y cómo el **Registro de actividad** evidencia el `postMessage`.

### 4:00 – 5:00 · Tema 5.3: Background Sync y cierre

> “El motor de sincronización vive en `sw.js`, no en la página. La página solo encola y dispara.
>
> En Chromium registro un sync con el tag `outbox-sync`; el navegador despierta al Service Worker cuando hay red. El SW procesa la cola en FIFO, hace el `POST`, actualiza IndexedDB y avisa a las pestañas con `clients.matchAll()` + `client.postMessage()`.
>
> En Safari no existe `SyncManager`, así que el evento `online` de la página actúa como respaldo y pide el vaciado por `postMessage`. La misma lógica del SW se reutiliza; no está duplicada.”

---

## Demo en 6 pasos (por si el profesor pide “muéstralo”)

1. **Application → IndexedDB → `outbox-db` → `outbox`**.
2. Activa **Simular caída de red** (o Network → Offline).
3. Crea un pedido con el formulario.
4. Verifica: estado `pendiente`, `attempts 0`, payload completo.
5. Desactiva la simulación. Pulsa **Sincronizar ahora**.
6. Verifica: estado `enviado`, contador actualizado, mensaje del SW en el log.

**Prueba de error:** con la red simulada caída, pulsa **Sincronizar ahora** → el registro pasa a `error` con `lastError`. Desactiva la simulación y pulsa **Reintentar** → vuelve a `pendiente` y se envía.

---

## Preguntas frecuentes

### 1. ¿Diferencia entre localStorage, Cache API e IndexedDB?

- **localStorage:** síncrono, solo texto, ~5 MB, bloquea el hilo principal. Sirve para preferencias pequeñas.
- **Cache API:** almacena pares `Request`/`Response`; es para el app shell y respuestas HTTP, no para datos de negocio consultables.
- **IndexedDB:** base NoSQL transaccional, asíncrona, con índices y consultas. Es la adecuada para una cola de pedidos.

### 2. ¿Qué es `onupgradeneeded` y cuándo se ejecuta?

Es el evento donde se define el esquema. Se dispara cuando se abre la base con una versión mayor a la existente (o cuando no existe). Ahí se crean los object stores y los índices. No se ejecuta en cada apertura.

### 3. ¿Diferencia entre transacción `readonly` y `readwrite`?

`readonly` permite leer en paralelo y no bloquea a otras lectoras. `readwrite` permite crear, modificar y borrar, y serializa la escritura. En la app, `DB.get`, `DB.getAll` y `DB.count` usan `readonly`; `add`, `put`, `delete`, `clear` y `update` usan `readwrite`.

### 4. ¿Por qué promisificaste IndexedDB?

Porque su API nativa es event-based (`onsuccess`, `onerror`). El wrapper convierte cada request en una promesa y resuelve la transacción en `oncomplete`, no en el `onsuccess` del request. Eso permite encadenar con `.then()` y manejar errores con `.catch()` sin anidar callbacks.

### 5. ¿Dónde está el `POST`?

En `js/api.js`, función `Api.post()`. La usa únicamente `sw.js`. La página nunca hace el `POST` directo: solo encola y notifica al Service Worker. Así el envío sobrevive al cierre de la pestaña.

### 6. ¿Qué es el patrón Outbox?

Una cola local de operaciones pendientes. La aplicación escribe primero en la base local y luego intenta publicar. Si falla, el registro queda con su estado y se reintenta después. Es la base de la consistencia eventual en arquitecturas offline-first.

### 7. ¿Por qué guardar primero y enviar después?

Porque garantiza que el dato del usuario no se pierda ante un fallo de red, un timeout o un cierre de pestaña. La respuesta al usuario es inmediata y la sincronización es responsable del resto.

### 8. ¿Cómo evitas pedidos duplicados?

Dos mecanismos:

- `clientId` único con índice `unique: true` en IndexedDB, que impide reencolar el mismo identificador.
- El backend puede usar ese `clientId` como clave de idempotencia.

Además, `activeSync` evita que dos disparos concurrentes procesen la misma cola.

### 9. ¿Qué pasa si el usuario cierra la pestaña?

El registro ya está en IndexedDB. En Chromium, el sync registrado despierta al Service Worker cuando hay red. En Safari, el respaldo se ejecuta la próxima vez que se abre la app y hay conexión (evento `online` o sincronización al arrancar).

### 10. ¿Cómo se registra Background Sync?

```js
registration.sync.register('outbox-sync');
```

El tag debe coincidir con el que escucha el SW:

```js
self.addEventListener('sync', function (event) {
  if (event.tag === 'outbox-sync') { /* vaciar cola */ }
});
```

### 11. ¿Qué hace `event.waitUntil()`?

Le dice al navegador que mantenga vivo al Service Worker hasta que la promesa termine. Sin él, el SW podría suspenderse antes de completar el envío o el `postMessage`.

### 12. ¿Qué pasa en Safari o iOS?

No existe `SyncManager`. La app lo detecta con `'SyncManager' in window`. En ese caso, el evento `online` de la página pide el vaciado al SW con `postMessage`. La lógica de envío sigue viviendo en el SW; no se duplica en la página.

### 13. ¿Cómo se comunican el SW y la página?

- Página → SW: `worker.postMessage({ type: 'FLUSH_OUTBOX' })`.
- SW → página: `clients.matchAll()` y `client.postMessage({ type: 'OUTBOX_SYNC_RESULT', summary })`.
- La página escucha con `navigator.serviceWorker.addEventListener('message', ...)`.

### 14. ¿Por qué no cacheas los `POST`?

Porque la Cache API está pensada para respuestas `GET` reutilizables. Cachear un `POST` rompería la semántica HTTP: un pedido debe llegar al servidor, no reproducirse desde una copia local. En el handler de `fetch` se ignora todo lo que no sea `GET` del mismo origen.

### 15. ¿Qué es el scope del Service Worker y por qué `sw.js` está en la raíz?

El scope define qué URLs controla el SW. Por defecto es la carpeta donde está el script. Al poner `sw.js` en la raíz y registrar con `scope: './'`, controla toda la aplicación, incluidas las rutas del subdirectorio de GitHub Pages.

### 16. ¿Cómo manejas los reintentos?

Cada fallo incrementa `attempts` y guarda `lastError`. `listRetryable()` solo devuelve `pendiente` o `error` con `attempts < 5`. El reintento manual (`resetForRetry`) vuelve a `pendiente` y reinicia el contador.

### 17. ¿Cómo garantizas el orden de envío?

`listRetryable()` ordena por `id` ascendente y el SW procesa con un `reduce` que encadena una promesa por registro. Es FIFO: el pedido más antiguo se envía primero.

### 18. ¿Qué pasa si el SW se actualiza?

El nuevo SW se instala, `skipWaiting()` lo activa y `clients.claim()` toma el control. En `activate` se eliminan las cachés viejas que empiezan con `outbox-`. Los datos de IndexedDB no se tocan: la versión del esquema es independiente de la versión del SW.

### 19. ¿Qué guardas en el store `meta`?

Banderas compartidas entre página y SW, como `demoOffline`. Es la forma de que el interruptor de demostración afecte también al motor de sincronización, que no tiene acceso a `localStorage` de la página.

### 20. ¿Cómo probaste que IndexedDB guarda de verdad?

En DevTools → Application → IndexedDB → `outbox-db` → `outbox`, verificando el registro con su payload, estado, `attempts` y fechas. Además, la UI refleja el mismo dato tras cada `postMessage`.

### 21. ¿Por qué GitHub Pages necesita rutas relativas?

Porque el sitio se publica en `https://usuario.github.io/repo/`, no en la raíz del dominio. Una ruta absoluta como `/styles.css` buscaría `https://usuario.github.io/styles.css` y daría 404. Con `./styles.css` se resuelve dentro de `/repo/`.

### 22. ¿Qué pasa si el backend responde 500?

`Api.post` valida `response.ok`. Un 500 lanza un error, el SW marca el registro como `error`, guarda el mensaje y sigue con el siguiente. No se pierde la cola ni se bloquea el resto.

### 23. ¿Cómo funciona el bloqueo `activeSync`?

Si llega un evento `sync` y, casi al mismo tiempo, un `FLUSH_OUTBOX`, el segundo reutiliza la promesa del primero. Así no se procesan dos veces los mismos registros ni se duplican los `postMessage`.

### 24. ¿Qué mejorarías para producción?

- Autenticación y validación del lado del servidor.
- Idempotencia real usando `clientId` como clave única en el backend.
- Backoff exponencial y `Retry-After`.
- Cifrado o expiración de datos sensibles en IndexedDB.
- `AbortController` para cancelar el `fetch` del timeout.
- Métricas y alertas de pedidos que superan el máximo de intentos.

### 25. ¿Por qué no usaste una librería como Dexie o Workbox?

Porque la consigna lo prohíbe y porque el objetivo es demostrar el dominio de la API nativa: `indexedDB.open`, `onupgradeneeded`, transacciones, índices, `sync`, `clients.matchAll` y `postMessage`. El wrapper propio hace visible esa mecánica.

---

## Trampas que debes evitar en la defensa

- No digas que el `POST` está en `app.js`: está en `api.js` y lo ejecuta `sw.js`.
- No confundas `Cache API` con IndexedDB: una guarda respuestas HTTP, la otra datos.
- No digas que Background Sync funciona en Safari: no existe allí; por eso está el respaldo `online`.
- No afirmes que `onupgradeneeded` corre siempre: solo al cambiar la versión.
- No digas que `localStorage` es asíncrono: es síncrono y bloquea.
- Si te preguntan por la regla de sintaxis: “toda la asincronía está con `new Promise`, `.then`, `.catch` y `Promise.all`; no hay funciones asíncronas modernas”.
- Si el profesor abre el código, muestra `db-helper.js` y `sw.js`: ahí está lo importante.

---

## Frases clave para cerrar

> “El pedido se guarda antes de intentar salir: eso es el Outbox.”

> “El Service Worker es el único dueño del motor de envío; la página solo lo despierta.”

> “Background Sync cubre Chromium y el evento `online` cubre Safari: una sola lógica, dos disparadores.”

> “IndexedDB no es un caché: es la fuente de verdad local mientras no haya red.”
