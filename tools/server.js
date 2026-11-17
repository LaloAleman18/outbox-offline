'use strict';

/* tools/server.js — Servidor local sin dependencias.
   Sirve el proyecto y expone POST /api/pedidos como mock del backend.
   Uso: node tools/server.js  ->  http://localhost:8765 */

var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var PORT = Number(process.env.PORT || 8765);
var received = [];

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Outbox-Client');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, data) {
  var body = JSON.stringify(data);
  cors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;

    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  var decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Ruta inválida');
    return;
  }

  var target = path.join(ROOT, decoded);
  if (path.relative(ROOT, target).startsWith('..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Prohibido');
    return;
  }

  fs.stat(target, function (statError, stats) {
    if (!statError && stats.isDirectory()) {
      target = path.join(target, 'index.html');
    }

    fs.readFile(target, function (readError, buffer) {
      if (readError) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 · No encontrado: ' + decoded);
        return;
      }

      var ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': buffer.length,
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : buffer);
    });
  });
}

var server = http.createServer(function (req, res) {
  var pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('URL inválida');
    return;
  }

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/pedidos' && req.method === 'GET') {
    sendJson(res, 200, { total: received.length, pedidos: received });
    return;
  }

  if (pathname === '/api/pedidos' && req.method === 'POST') {
    readBody(req, 1024 * 1024)
      .then(function (raw) {
        var data;
        try {
          data = JSON.parse(raw || '{}');
        } catch (error) {
          sendJson(res, 400, { error: 'JSON inválido' });
          return;
        }

        if (!data.cliente || !data.producto) {
          sendJson(res, 422, { error: 'Faltan campos obligatorios: cliente y producto' });
          return;
        }

        var pedido = {
          id: received.length + 1,
          recibidoEn: new Date().toISOString(),
          eco: data
        };
        received.push(pedido);

        console.log(
          '[mock-api] Pedido #' + pedido.id + ' recibido: ' +
          data.cliente + ' · ' + data.producto + ' ×' + data.cantidad
        );

        setTimeout(function () {
          sendJson(res, 201, pedido);
        }, 350);
      })
      .catch(function (error) {
        sendJson(res, 413, { error: error.message });
      });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Método no permitido');
});

server.listen(PORT, function () {
  console.log('');
  console.log('  Tostaduría Andina · servidor local');
  console.log('  App:      http://localhost:' + PORT + '/');
  console.log('  Mock API: http://localhost:' + PORT + '/api/pedidos');
  console.log('  Pedidos:  http://localhost:' + PORT + '/api/pedidos (GET)');
  console.log('');
  console.log('  Ctrl + C para detener.');
  console.log('');
});
