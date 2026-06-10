import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const port = Number.parseInt(process.env.SUDO_LOG_ADMIN_PORT || '5180', 10);
const apiBase = process.env.SUDO_LOG_API_BASE || 'http://127.0.0.1:8080';
const rootDir = new URL('./src/', import.meta.url);

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

function isApiPath(pathname) {
  return pathname === '/health' || pathname.startsWith('/api/') || pathname.startsWith('/v1/') || pathname.startsWith('/grafana/');
}

async function proxy(request, response, url) {
  const target = new URL(`${url.pathname}${url.search}`, apiBase);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request;
  const upstream = await fetch(target, {
    method: request.method,
    headers: request.headers,
    body,
    duplex: body ? 'half' : undefined,
  });

  response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
  if (upstream.body) {
    for await (const chunk of upstream.body) response.write(chunk);
  }
  response.end();
}

function writeUpgradeError(socket, statusCode, message) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function proxyUpgrade(request, socket, head) {
  const url = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${port}`}`);
  if (!url.pathname.startsWith('/grafana/')) {
    writeUpgradeError(socket, 404, 'Not Found');
    return;
  }

  const target = new URL(`${url.pathname}${url.search}`, apiBase);
  if (target.protocol !== 'http:') {
    writeUpgradeError(socket, 502, 'Bad Gateway');
    return;
  }

  const upstream = createConnection({ host: target.hostname, port: Number.parseInt(target.port || '80', 10) });
  upstream.on('connect', () => {
    const headers = { ...request.headers, host: target.host };
    const lines = [`${request.method || 'GET'} ${target.pathname}${target.search} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => writeUpgradeError(socket, 502, 'Bad Gateway'));
  socket.on('error', () => upstream.destroy());
}

async function serveStatic(pathname, response) {
  const assetPath =
    pathname === '/' || pathname === '/console'
      ? 'index.html'
      : pathname === '/assets/app.js'
        ? 'app.js'
        : pathname === '/assets/styles.css'
          ? 'styles.css'
          : pathname === '/favicon.svg'
            ? 'favicon.svg'
            : null;

  if (!assetPath) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const content = await readFile(join(rootDir.pathname, assetPath));
  response.writeHead(200, {
    'content-type': contentTypes.get(extname(assetPath)) || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  response.end(content);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${port}`}`);
    if (isApiPath(url.pathname)) {
      await proxy(request, response, url);
      return;
    }
    await serveStatic(url.pathname, response);
  } catch (error) {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Admin dev server error' }));
  }
});

server.on('upgrade', proxyUpgrade);

server.listen(port, () => {
  console.log(`sudo-log-admin listening on http://127.0.0.1:${port}`);
  console.log(`proxying API requests to ${apiBase}`);
});
