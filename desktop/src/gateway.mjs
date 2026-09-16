import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function forwardedHeaders(headers) {
  const result = { ...headers };
  for (const key of [...hopHeaders, ...(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]) delete result[key];
  return result;
}

/** Serve the desktop UI without starting, stopping, or modifying its backend. */
export async function startGateway({ backendUrl, distDir, port = 5176 }) {
  const backend = new URL(backendUrl);
  if (backend.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname) || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) {
    throw new Error('Desktop backend must be a loopback HTTP origin.');
  }
  const root = await realpath(distDir);
  await stat(path.join(root, 'index.html'));
  const sockets = new Set();
  const requests = new Set();
  let origin;
  let closing = false;

  function allowed(req) {
    return req.headers.host === new URL(origin).host && (!req.headers.origin || req.headers.origin === origin) && !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
  }
  function track(socket) {
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  }
  function requestBackend(req, upgrade = false) {
    const headers = upgrade ? { ...req.headers } : forwardedHeaders(req.headers);
    headers.host = backend.host;
    const upstream = http.request({ hostname: backend.hostname.replace(/^\[|\]$/g, ''), port: backend.port || 80, method: req.method, path: req.url, headers });
    upstream.on('socket', socket => {
      socket.setNoDelay(true);
      if (!socket.connecting) return;
      // Bound connection establishment only: terminal and SSE streams may stay open indefinitely.
      const timer = setTimeout(() => upstream.destroy(new Error('Backend connection timed out')), 5000);
      timer.unref();
      const clear = () => clearTimeout(timer);
      socket.once('connect', clear);
      socket.once('error', clear);
      socket.once('close', clear);
    });
    requests.add(upstream);
    upstream.once('close', () => requests.delete(upstream));
    return upstream;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (closing || !allowed(req)) { res.writeHead(403).end('Forbidden'); return; }
    let pathname;
    try {
      // Decode before resolving so encoded separators cannot escape the UI root.
      pathname = decodeURIComponent(new URL(req.url, origin).pathname);
      if (pathname.includes('\0') || pathname.includes('\\')) throw new Error();
    } catch { res.writeHead(400).end('Bad request'); return; }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const upstream = requestBackend(req);
      upstream.on('response', response => {
        res.writeHead(response.statusCode, {
          ...forwardedHeaders(response.headers),
          // Raw backend files must never execute active content in the desktop UI origin.
          'content-security-policy': "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
        });
        res.flushHeaders();
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502).end('Backend unavailable');
        else res.destroy();
      });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (pathname === '/ws' || pathname.startsWith('/ws/')) { res.writeHead(404).end('Not found'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    try {
      let file = path.resolve(root, '.' + pathname);
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
      try {
        if (!(await stat(file)).isFile()) throw Object.assign(new Error(), { code: 'ENOENT' });
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        if (path.extname(pathname)) { res.writeHead(404).end('Not found'); return; }
        file = path.join(root, 'index.html');
      }
      file = await realpath(file);
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
      const info = await stat(file);
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' ${origin.replace('http:', 'ws:')}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Content-Length', info.size);
      res.setHeader('Cache-Control', 'no-cache');
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { if (!res.headersSent) res.writeHead(500).end('Unable to load desktop UI'); else res.destroy(); }
  });
  server.on('connection', track);
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, origin).pathname; } catch { socket.destroy(); return; }
    if (closing || !allowed(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (!/^\/ws\/(?:h\/[A-Za-z0-9-]+\/)?terminal\/[^/]+$/.test(pathname)) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const upstream = requestBackend(req, true);
    upstream.on('upgrade', (response, remote, remoteHead) => {
      track(remote);
      const headers = response.rawHeaders;
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${headers.reduce((s, key, i) => i % 2 ? s + key + '\r\n' : s + key + ': ', '')}\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
      socket.once('close', () => remote.destroy());
      remote.once('close', () => socket.destroy());
    });
    upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Backend rejected upgrade\r\nConnection: close\r\n\r\n`); });
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); origin = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  let closePromise;
  return { url: origin, close() {
    if (!closePromise) {
      closing = true;
      closePromise = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        for (const request of requests) request.destroy();
        for (const socket of sockets) socket.destroy();
      });
    }
    return closePromise;
  } };
}
