import { createServer } from 'node:http';
import { loadEnvFile } from 'node:process';
import { loadConfig } from './config/appConfig.js';
import { ClickHouseRepository } from './db/clickhouse.js';
import { PostgresClient } from './db/postgres.js';
import { sendError, sendJson } from './http/http.js';
import { AuthRoutes } from './routes/authRoutes.js';
import { GrafanaRoutes } from './routes/grafanaRoutes.js';
import { Routes as LogRoutes } from './routes/logRoutes.js';
import { SettingsRoutes } from './routes/settingsRoutes.js';
import { StaticRoutes } from './routes/staticRoutes.js';
import { SystemRoutes } from './routes/systemRoutes.js';
import { UserRoutes } from './routes/userRoutes.js';
import { AuthService } from './services/authService.js';
import { GrafanaPanelStore } from './services/grafanaPanelStore.js';
import { LogQueueService } from './services/logQueueService.js';
import { SessionService } from './services/sessionService.js';
import { SettingsStore } from './services/settingsStore.js';
import { UserStore } from './services/userStore.js';
import { BlobStore } from './storage/blobStore.js';

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw error;
  }
}

const config = loadConfig();
const repository = new ClickHouseRepository(config.clickhouse);
const postgres = new PostgresClient(config.postgres);
const blobStore = new BlobStore(config.blobDir);
const logQueue = new LogQueueService(config.redis, config.queue, repository);
const sessions = new SessionService(config.redis);
const users = new UserStore(postgres);
const settings = new SettingsStore(postgres);
const grafanaPanels = new GrafanaPanelStore(postgres);
const auth = new AuthService(config, sessions, users);
const logRoutes = new LogRoutes(config, repository, blobStore, logQueue, settings);
const authRoutes = new AuthRoutes(config, auth);
const userRoutes = new UserRoutes(config, users, sessions);
const settingsRoutes = new SettingsRoutes(config, settings);
const systemRoutes = new SystemRoutes(repository, postgres, sessions, logQueue);
const grafanaRoutes = new GrafanaRoutes(config, repository, settings, grafanaPanels);
const staticRoutes = new StaticRoutes(config);

await repository.initialize();
await users.initialize();
await settings.initialize(config.defaultApiKey);
await grafanaPanels.initialize();
await auth.bootstrap();
logQueue.start();

const server = createServer(async (request, response) => {
  try {
    const host = request.headers.host ?? `127.0.0.1:${config.port}`;
    const url = new URL(request.url ?? '/', `http://${host}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/grafana/embed-config') {
      const principal = await auth.authorize(request, 'logs:read');
      await grafanaRoutes.embedConfig(url, response, principal);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/grafana/custom-panels') {
      await auth.authorize(request, 'logs:read');
      await grafanaRoutes.listCustomPanels(url, response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/grafana/custom-panels/export') {
      await auth.authorize(request, 'dashboards:write');
      await grafanaRoutes.exportCustomPanels(url, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/grafana/custom-panels/import') {
      const principal = await auth.authorize(request, 'dashboards:write');
      await grafanaRoutes.importCustomPanels(request, response, principal);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/grafana/custom-panels/test') {
      await auth.authorize(request, 'dashboards:write');
      await grafanaRoutes.testCustomPanel(request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/grafana/custom-panels/preview') {
      const principal = await auth.authorize(request, 'dashboards:write');
      await grafanaRoutes.previewCustomPanel(request, response, principal);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/grafana/custom-panels') {
      const principal = await auth.authorize(request, 'dashboards:write');
      await grafanaRoutes.createCustomPanel(request, response, principal);
      return;
    }

    if (request.method === 'PUT' && /^\/api\/grafana\/custom-panels\/[^/]+$/.test(url.pathname)) {
      const principal = await auth.authorize(request, 'dashboards:write');
      await grafanaRoutes.updateCustomPanel(request, url, response, principal);
      return;
    }

    if (request.method === 'POST' && /^\/api\/grafana\/custom-panels\/[^/]+\/publish$/.test(url.pathname)) {
      await auth.authorize(request, 'dashboards:write');
      await grafanaRoutes.publishCustomPanel(url, response);
      return;
    }

    if (request.method === 'DELETE' && /^\/api\/grafana\/custom-panels\/[^/]+$/.test(url.pathname)) {
      await auth.authorize(request, 'dashboards:write');
      await grafanaRoutes.deleteCustomPanel(url, response);
      return;
    }

    if (grafanaRoutes.matches(url.pathname)) {
      await grafanaRoutes.proxy(request, response, url);
      return;
    }

    if (request.method === 'GET' && (await staticRoutes.admin(url.pathname, response))) {
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      await authRoutes.login(request, response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      await authRoutes.me(request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      await authRoutes.logout(request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout-all') {
      await authRoutes.logoutAll(request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/change-password') {
      await authRoutes.changePassword(request, response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/users') {
      await auth.authorize(request, 'users:manage');
      await userRoutes.list(response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/users') {
      await auth.authorize(request, 'users:manage');
      await userRoutes.create(request, response);
      return;
    }

    if (request.method === 'PUT' && /^\/api\/users\/[^/]+$/.test(url.pathname)) {
      const principal = await auth.authorize(request, 'users:manage');
      await userRoutes.update(request, url, response, principal);
      return;
    }

    if (request.method === 'PUT' && /^\/api\/users\/[^/]+\/password$/.test(url.pathname)) {
      await auth.authorize(request, 'users:manage');
      await userRoutes.resetPassword(request, url, response);
      return;
    }

    if (request.method === 'DELETE' && /^\/api\/users\/[^/]+$/.test(url.pathname)) {
      const principal = await auth.authorize(request, 'users:manage');
      await userRoutes.delete(url, response, principal);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/system/health') {
      await auth.authorize(request, 'system:read');
      await systemRoutes.health(response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/settings/tenants') {
      const principal = await auth.authorize(request, 'logs:read');
      await settingsRoutes.list(response, principal.permissions.has('settings:write'));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings/tenants') {
      await auth.authorize(request, 'settings:write');
      await settingsRoutes.createTenant(request, response);
      return;
    }

    if (request.method === 'PUT' && /^\/api\/settings\/tenants\/[^/]+$/.test(url.pathname)) {
      await auth.authorize(request, 'settings:write');
      await settingsRoutes.updateTenant(request, url, response);
      return;
    }

    if (request.method === 'DELETE' && /^\/api\/settings\/tenants\/[^/]+$/.test(url.pathname)) {
      await auth.authorize(request, 'settings:write');
      await settingsRoutes.deleteTenant(url, response);
      return;
    }

    if (request.method === 'POST' && /^\/api\/settings\/tenants\/[^/]+\/products$/.test(url.pathname)) {
      await auth.authorize(request, 'settings:write');
      await settingsRoutes.createProduct(request, url, response);
      return;
    }

    if (request.method === 'PUT' && /^\/api\/settings\/tenants\/[^/]+\/products\/[^/]+$/.test(url.pathname)) {
      await auth.authorize(request, 'settings:write');
      await settingsRoutes.updateProduct(request, url, response);
      return;
    }

    if (request.method === 'DELETE' && /^\/api\/settings\/tenants\/[^/]+\/products\/[^/]+$/.test(url.pathname)) {
      await auth.authorize(request, 'settings:write');
      await settingsRoutes.deleteProduct(url, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/logs/batch') {
      await logRoutes.ingest(request, response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/logs/search') {
      await auth.authorize(request, 'logs:read');
      await logRoutes.search(url, response);
      return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/logs/events/')) {
      await auth.authorize(request, 'logs:read');
      await logRoutes.eventDetail(url, response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/logs/errors/summary') {
      await auth.authorize(request, 'logs:read');
      await logRoutes.errorSummary(url, response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/logs/blobs') {
      await auth.authorize(request, 'logs:read');
      await logRoutes.blob(url, response);
      return;
    }

    sendJson(response, 404, { success: false, error: 'Not found' });
  } catch (error) {
    sendError(response, error);
  }
});

server.on('upgrade', (request, socket, head) => {
  try {
    const host = request.headers.host ?? `127.0.0.1:${config.port}`;
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (grafanaRoutes.matches(url.pathname)) {
      grafanaRoutes.proxyUpgrade(request, socket, head, url);
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  } catch {
    socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  }
});

server.listen(config.port, () => {
  console.log(`sudo-log listening on :${config.port}`);
});
