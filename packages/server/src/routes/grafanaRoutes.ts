import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import type { AppConfig } from '../config/appConfig.js';
import type { ClickHouseRepository } from '../db/clickhouse.js';
import { readJsonBody, sendJson } from '../http/http.js';
import type { Principal } from '../services/authService.js';
import { GrafanaDashboardPublisher } from '../services/grafanaDashboardPublisher.js';
import { isGrafanaPanelType, renderGrafanaPanelTestQuery, validateGrafanaPanelQuery } from '../services/grafanaPanelSql.js';
import type { GrafanaPanelStore } from '../services/grafanaPanelStore.js';
import type { SettingsStore } from '../services/settingsStore.js';
import type { CreateGrafanaCustomPanelInput, GrafanaCustomPanelExportItem, GrafanaCustomPanelRecord, GrafanaPanelType } from '../types/settings.js';

const EMBED_COOKIE = 'sudowork_grafana_embed';
const EMBED_COOKIE_TTL_SECONDS = 60 * 60;
const TAG_KEY_PATTERN = /^[a-z0-9_.-]{1,64}$/;

interface CustomPanelBody {
  tenant_id?: unknown;
  product?: unknown;
  title?: unknown;
  description?: unknown;
  panel_type?: unknown;
  query_sql?: unknown;
  height?: unknown;
  unit?: unknown;
  enabled?: unknown;
  from?: unknown;
  to?: unknown;
  environment?: unknown;
  tag_key?: unknown;
  tag_value?: unknown;
}

interface CustomPanelImportBody {
  mode?: unknown;
  confirm_replace?: unknown;
  tenant_id?: unknown;
  product?: unknown;
  panels?: unknown;
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim() || '/grafana';
  return trimmed.startsWith('/') ? trimmed.replace(/\/+$/, '') || '/grafana' : `/${trimmed.replace(/\/+$/, '')}`;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    try {
      cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
    } catch {
      cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
  }
  return cookies;
}

function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function grafanaEmbedUsername(principal: Principal): string {
  return `swlog_embed_${principal.id.replace(/[^a-zA-Z0-9]/g, '')}`;
}

function grafanaPreviewUid(principal: Principal): string {
  const suffix = principal.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || principal.username.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  return `sw-preview-${suffix || 'panel'}`;
}

function createEmbedToken(config: AppConfig, principal: Principal): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      sub: principal.id,
      grafana_username: grafanaEmbedUsername(principal),
      sudowork_username: principal.username,
      email: principal.email,
      exp: Math.floor(Date.now() / 1000) + EMBED_COOKIE_TTL_SECONDS,
    }),
  ).toString('base64url');
  return `${payload}.${signPayload(config.auth.jwtSecret, payload)}`;
}

function verifyEmbedToken(config: AppConfig, token: string): { grafanaUsername: string } | null {
  try {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = signPayload(config.auth.jwtSecret, payload);
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { grafana_username?: string; exp?: number; v?: number };
    if (parsed.v !== 2 || !parsed.grafana_username || !parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return { grafanaUsername: parsed.grafana_username };
  } catch {
    return null;
  }
}

function selectedTimeRange(value: string | null): { from: string; to: string; label: string } {
  const ranges = timeRanges();
  return ranges.find((item) => item.from === value) || ranges[1];
}

function timeRanges(): Array<{ label: string; from: string; to: string }> {
  return [
    { label: '最近 1 小时', from: 'now-1h', to: 'now' },
    { label: '最近 6 小时', from: 'now-6h', to: 'now' },
    { label: '最近 24 小时', from: 'now-24h', to: 'now' },
    { label: '最近 7 天', from: 'now-7d', to: 'now' },
  ];
}

function safeVariable(value: string, fallback = ''): string {
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_.:/@ -]{0,256}$/.test(trimmed) ? trimmed : fallback;
}

function safeTagKey(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase();
  return TAG_KEY_PATTERN.test(normalized) ? normalized : fallback;
}

function isAllowedGrafanaPath(pathname: string, basePath: string): boolean {
  if (!pathname.startsWith(`${basePath}/`) && pathname !== basePath) return false;
  const path = pathname.slice(basePath.length) || '/';
  const readOnlyApiPaths = new Set([
    '/api/access-control/user/permissions',
    '/api/ds/query',
    '/api/featuremgmt',
    '/api/frontend/settings',
    '/api/login/ping',
    '/api/navtree',
    '/api/org',
    '/api/org/preferences',
    '/api/user',
    '/api/user/preferences',
  ]);
  if (path === '/' || path === '/login') return true;
  return (
    path.startsWith('/d-solo/') ||
    path.startsWith('/d/') ||
    path.startsWith('/apis/') ||
    path.startsWith('/public/') ||
    path.startsWith('/avatar/') ||
    path.startsWith('/api/dashboards/uid/') ||
    path.startsWith('/api/datasources/correlations') ||
    path.startsWith('/api/datasources/uid/') ||
    path === '/api/frontend/assets' ||
    path === '/api/live/ws' ||
    path.startsWith('/api/gnet/plugins/') ||
    path.startsWith('/api/plugins/') ||
    path.startsWith('/api/prometheus/grafana/api/v1/rules') ||
    path === '/api/query-history' ||
    path.startsWith('/api/search') ||
    path.startsWith('/api/annotations') ||
    path.startsWith('/api/folders') ||
    path === '/api/frontend-metrics' ||
    readOnlyApiPaths.has(path)
  );
}

function isAllowedGrafanaPostPath(path: string): boolean {
  return (
    path === '/api/ds/query' ||
    path === '/api/frontend-metrics' ||
    path === '/api/query-history' ||
    /^\/apis\/features\.grafana\.app\/[^/]+\/namespaces\/[^/]+\/ofrep\/v\d+\/evaluate\/flags$/.test(path)
  );
}

function isBlockedProxyResponseHeader(name: string): boolean {
  return [
    'connection',
    'content-encoding',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'set-cookie',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ].includes(name);
}

function customPanelImportItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as { panels?: unknown }).panels)) {
    return (value as { panels: unknown[] }).panels;
  }
  throw Object.assign(new Error('import JSON must be an array or contain panels array'), { statusCode: 400 });
}

function customPanelImportItem(value: unknown): GrafanaCustomPanelExportItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('each imported panel must be an object'), { statusCode: 400 });
  }
  const item = value as Record<string, unknown>;
  if (typeof item.title !== 'string' || !item.title.trim()) {
    throw Object.assign(new Error('imported panel title is required'), { statusCode: 400 });
  }
  if (typeof item.querySql !== 'string' || !item.querySql.trim()) {
    throw Object.assign(new Error(`imported panel ${item.title} querySql is required`), { statusCode: 400 });
  }
  return {
    title: item.title,
    description: typeof item.description === 'string' ? item.description : '',
    panelType: isGrafanaPanelType(item.panelType) ? item.panelType : 'timeseries',
    querySql: item.querySql,
    height: typeof item.height === 'number' ? item.height : undefined,
    unit: typeof item.unit === 'string' ? item.unit : undefined,
    enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
    from: typeof item.from === 'string' ? item.from : undefined,
    to: typeof item.to === 'string' ? item.to : undefined,
    environment: typeof item.environment === 'string' ? item.environment : undefined,
    tagKey: typeof item.tagKey === 'string' ? item.tagKey : undefined,
    tagValue: typeof item.tagValue === 'string' ? item.tagValue : undefined,
  };
}

function proxiedGrafanaPath(pathname: string, basePath: string): string {
  return pathname.slice(basePath.length) || '/';
}

function customPanelIdFromPath(url: URL, suffix = ''): string {
  const pattern = suffix
    ? new RegExp(`^/api/grafana/custom-panels/([^/]+)/${suffix}$`)
    : /^\/api\/grafana\/custom-panels\/([^/]+)$/;
  const match = pattern.exec(url.pathname);
  if (!match) throw Object.assign(new Error('Custom panel not found'), { statusCode: 404 });
  return decodeURIComponent(match[1]);
}

async function requestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export class GrafanaRoutes {
  private readonly basePath: string;
  private readonly publisher: GrafanaDashboardPublisher;

  public constructor(
    private readonly config: AppConfig,
    private readonly repository: ClickHouseRepository,
    private readonly settings: SettingsStore,
    private readonly panelsStore: GrafanaPanelStore,
  ) {
    this.basePath = normalizeBasePath(config.grafana.publicBasePath);
    this.publisher = new GrafanaDashboardPublisher(config);
  }

  public matches(pathname: string): boolean {
    return pathname === this.basePath || pathname.startsWith(`${this.basePath}/`);
  }

  public async embedConfig(url: URL, response: ServerResponse, principal: Principal): Promise<void> {
    if (!this.config.grafana.enabled) {
      sendJson(response, 200, { success: true, data: { enabled: false, panels: [] } });
      return;
    }

    const tenantId = safeVariable(url.searchParams.get('tenant_id') || 'sudo', 'sudo').toLowerCase();
    const product = safeVariable(url.searchParams.get('product') || 'sudowork', 'sudowork').toLowerCase();
    await this.settings.requireEnabledProduct(tenantId, product);

    const tagKeys = await this.repository.grafanaTagKeys(tenantId, product);
    const defaultTagKey = safeTagKey(this.config.grafana.defaultTagKey, 'feature');
    const rawTagKey = url.searchParams.has('tag_key') ? url.searchParams.get('tag_key') || '' : '';
    const requestedTagKey = rawTagKey ? safeTagKey(rawTagKey, defaultTagKey) : '';
    const selectedTagKey =
      !requestedTagKey || tagKeys.includes(requestedTagKey) || requestedTagKey === defaultTagKey
        ? requestedTagKey
        : tagKeys[0] || defaultTagKey;
    const tagValues = selectedTagKey ? await this.repository.grafanaTagValues(tenantId, product, selectedTagKey) : [];
    const rawTagValue = url.searchParams.has('tag_value') ? url.searchParams.get('tag_value') || '' : '';
    const requestedTagValue = safeVariable(rawTagValue, '');
    const selectedTagValue = requestedTagValue ? (tagValues.includes(requestedTagValue) ? requestedTagValue : tagValues[0] || '') : '';
    const normalizedTagKeys = [...new Set([selectedTagKey, ...tagKeys, defaultTagKey].filter(Boolean))];
    const normalizedTagValues = [...new Set([selectedTagValue, ...tagValues].filter(Boolean))];
    const customPanels = await this.panelsStore.list(tenantId, product, true);

    sendJson(
      response,
      200,
      {
        success: true,
        data: {
          enabled: true,
          tenant_id: tenantId,
          product,
          time_ranges: timeRanges(),
          tag_keys: normalizedTagKeys,
          tag_values: normalizedTagValues,
          selected: {
            from: '',
            to: '',
            environment: '',
            tag_key: selectedTagKey,
            tag_value: selectedTagValue,
          },
          panels: customPanels.map((panel) =>
            this.customPanel(panel, {
              from: panel.from,
              to: panel.to,
              environment: panel.environment,
              tagKey: panel.tagKey,
              tagValue: panel.tagValue,
            }),
          ),
        },
      },
      {
        'set-cookie': `${EMBED_COOKIE}=${encodeURIComponent(createEmbedToken(this.config, principal))}; HttpOnly; SameSite=Lax; Path=${this.basePath}; Max-Age=${EMBED_COOKIE_TTL_SECONDS}`,
      },
    );
  }

  public async listCustomPanels(url: URL, response: ServerResponse): Promise<void> {
    const tenantId = safeVariable(url.searchParams.get('tenant_id') || 'sudo', 'sudo').toLowerCase();
    const product = safeVariable(url.searchParams.get('product') || 'sudowork', 'sudowork').toLowerCase();
    await this.settings.requireEnabledProduct(tenantId, product);
    sendJson(response, 200, { success: true, data: await this.panelsStore.list(tenantId, product) });
  }

  public async exportCustomPanels(url: URL, response: ServerResponse): Promise<void> {
    const tenantId = safeVariable(url.searchParams.get('tenant_id') || 'sudo', 'sudo').toLowerCase();
    const product = safeVariable(url.searchParams.get('product') || 'sudowork', 'sudowork').toLowerCase();
    await this.settings.requireEnabledProduct(tenantId, product);
    sendJson(response, 200, { success: true, data: await this.panelsStore.export(tenantId, product) });
  }

  public async createCustomPanel(request: IncomingMessage, response: ServerResponse, principal: Principal): Promise<void> {
    const body = await readJsonBody<CustomPanelBody>(request, this.config.maxBodyBytes);
    const tenantId = typeof body.tenant_id === 'string' ? safeVariable(body.tenant_id, 'sudo').toLowerCase() : 'sudo';
    const product = typeof body.product === 'string' ? safeVariable(body.product, 'sudowork').toLowerCase() : 'sudowork';
    await this.settings.requireEnabledProduct(tenantId, product);
    const input = this.customPanelInput(body, tenantId, product, principal.username);
    const panel = await this.panelsStore.create(input);
    sendJson(response, 201, { success: true, data: await this.publishAndRecord(panel) });
  }

  public async importCustomPanels(request: IncomingMessage, response: ServerResponse, principal: Principal): Promise<void> {
    const body = await readJsonBody<CustomPanelImportBody>(request, this.config.maxBodyBytes);
    const tenantId = typeof body.tenant_id === 'string' ? safeVariable(body.tenant_id, 'sudo').toLowerCase() : 'sudo';
    const product = typeof body.product === 'string' ? safeVariable(body.product, 'sudowork').toLowerCase() : 'sudowork';
    await this.settings.requireEnabledProduct(tenantId, product);

    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    if (mode === 'replace' && body.confirm_replace !== true) {
      throw Object.assign(new Error('confirm_replace is required for full replacement import'), { statusCode: 400 });
    }

    const items = customPanelImportItems(body).map(customPanelImportItem);
    if (items.length > 200) {
      throw Object.assign(new Error('import supports at most 200 panels'), { statusCode: 400 });
    }

    const inputs = items.map((item) => this.importPanelInput(item, tenantId, product, principal.username));
    if (mode === 'replace') {
      const deletedPanels = await this.panelsStore.deleteByProduct(tenantId, product);
      for (const panel of deletedPanels) {
        try {
          await this.publisher.delete(panel);
        } catch (error) {
          console.warn('sudo-log could not delete replaced custom Grafana dashboard', error);
        }
      }
    }

    const panels: GrafanaCustomPanelRecord[] = [];
    let created = 0;
    let updated = 0;
    for (const input of inputs) {
      const result = mode === 'replace' ? { panel: await this.panelsStore.create(input), created: true } : await this.panelsStore.upsertByTitle(input);
      created += result.created ? 1 : 0;
      updated += result.created ? 0 : 1;
      panels.push(await this.publishAndRecord(result.panel));
    }

    sendJson(response, 200, {
      success: true,
      data: {
        mode,
        received: items.length,
        created,
        updated,
        replaced: mode === 'replace',
        panels,
      },
    });
  }

  public async testCustomPanel(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody<CustomPanelBody>(request, this.config.maxBodyBytes);
    const tenantId = typeof body.tenant_id === 'string' ? safeVariable(body.tenant_id, 'sudo').toLowerCase() : 'sudo';
    const product = typeof body.product === 'string' ? safeVariable(body.product, 'sudowork').toLowerCase() : 'sudowork';
    await this.settings.requireEnabledProduct(tenantId, product);
    const panelType = this.panelType(body.panel_type, 'timeseries');
    if (typeof body.query_sql !== 'string') {
      throw Object.assign(new Error('query_sql is required'), { statusCode: 400 });
    }

    const validation = validateGrafanaPanelQuery(body.query_sql, panelType, this.config.clickhouse);
    const renderedSql = renderGrafanaPanelTestQuery(body.query_sql, {
      tenantId,
      product,
      environment:
        typeof body.environment === 'string'
          ? safeVariable(body.environment, 'production')
          : 'production',
      tagKey: typeof body.tag_key === 'string' ? safeTagKey(body.tag_key, '') : this.config.grafana.defaultTagKey,
      tagValue: typeof body.tag_value === 'string' ? safeVariable(body.tag_value, this.config.grafana.defaultTagValue) : this.config.grafana.defaultTagValue,
      from: typeof body.from === 'string' ? safeVariable(body.from, 'now-6h') : 'now-6h',
      to: typeof body.to === 'string' ? safeVariable(body.to, 'now') : 'now',
    });
    const startedAt = Date.now();
    const rows = await this.repository.grafanaQueryPreview(renderedSql, 20);
    sendJson(response, 200, {
      success: true,
      data: {
        valid: true,
        tables: validation.tables,
        row_count: rows.length,
        elapsed_ms: Date.now() - startedAt,
        rows,
      },
    });
  }

  public async previewCustomPanel(request: IncomingMessage, response: ServerResponse, principal: Principal): Promise<void> {
    if (!this.config.grafana.enabled) {
      throw Object.assign(new Error('Grafana is not enabled'), { statusCode: 400 });
    }
    if (!this.config.grafana.publishEnabled) {
      throw Object.assign(new Error('Grafana publishing is disabled'), { statusCode: 400 });
    }

    const body = await readJsonBody<CustomPanelBody>(request, this.config.maxBodyBytes);
    const tenantId = typeof body.tenant_id === 'string' ? safeVariable(body.tenant_id, 'sudo').toLowerCase() : 'sudo';
    const product = typeof body.product === 'string' ? safeVariable(body.product, 'sudowork').toLowerCase() : 'sudowork';
    await this.settings.requireEnabledProduct(tenantId, product);
    const input = this.customPanelInput(body, tenantId, product, principal.username);
    const now = new Date().toISOString();
    const panel: GrafanaCustomPanelRecord = {
      id: 'preview',
      tenantId: input.tenantId,
      product: input.product,
      from: input.from || 'now-6h',
      to: input.to || 'now',
      environment: input.environment || 'production',
      tagKey: input.tagKey || '',
      tagValue: input.tagValue || '',
      title: input.title || 'Preview panel',
      description: input.description || '',
      panelType: input.panelType || 'timeseries',
      querySql: input.querySql,
      height: input.height || 320,
      unit: input.unit || 'short',
      enabled: true,
      dashboardUid: grafanaPreviewUid(principal),
      dashboardSlug: 'preview-panel',
      createdBy: principal.username,
      updatedBy: principal.username,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
      publishError: '',
    };
    const published = await this.publisher.publish(panel);
    if (!published) {
      throw Object.assign(new Error('Grafana preview publish failed'), { statusCode: 400 });
    }

    const preview = this.customPanel(panel, {
      from: typeof body.from === 'string' ? safeVariable(body.from, 'now-6h') : 'now-6h',
      to: typeof body.to === 'string' ? safeVariable(body.to, 'now') : 'now',
      environment: typeof body.environment === 'string' ? safeVariable(body.environment, 'production') : 'production',
      tagKey: typeof body.tag_key === 'string' ? safeTagKey(body.tag_key, '') : this.config.grafana.defaultTagKey,
      tagValue: typeof body.tag_value === 'string' ? safeVariable(body.tag_value, '') : '',
    });
    const separator = preview.iframe_url.includes('?') ? '&' : '?';
    sendJson(response, 200, { success: true, data: { ...preview, iframe_url: `${preview.iframe_url}${separator}_preview=${Date.now()}` } });
  }

  public async updateCustomPanel(request: IncomingMessage, url: URL, response: ServerResponse, principal: Principal): Promise<void> {
    const id = customPanelIdFromPath(url);
    const existing = await this.requireCustomPanel(id);
    const body = await readJsonBody<CustomPanelBody>(request, this.config.maxBodyBytes);
    const tenantId = typeof body.tenant_id === 'string' ? safeVariable(body.tenant_id, existing.tenantId).toLowerCase() : existing.tenantId;
    const product = typeof body.product === 'string' ? safeVariable(body.product, existing.product).toLowerCase() : existing.product;
    await this.settings.requireEnabledProduct(tenantId, product);
    const panelType = body.panel_type === undefined ? existing.panelType : this.panelType(body.panel_type);
    const querySql = typeof body.query_sql === 'string' ? body.query_sql : existing.querySql;
    validateGrafanaPanelQuery(querySql, panelType, this.config.clickhouse);
    const filters = this.customPanelFilters(body, existing);
    const panel = await this.panelsStore.update(id, {
      tenantId,
      product,
      ...filters,
      title: typeof body.title === 'string' ? body.title : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      panelType,
      querySql,
      height: typeof body.height === 'number' ? body.height : undefined,
      unit: typeof body.unit === 'string' ? body.unit : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      actor: principal.username,
    });
    sendJson(response, 200, { success: true, data: await this.publishAndRecord(panel) });
  }

  public async publishCustomPanel(url: URL, response: ServerResponse): Promise<void> {
    const panel = await this.requireCustomPanel(customPanelIdFromPath(url, 'publish'));
    this.requireGrafanaPublishing(panel);
    validateGrafanaPanelQuery(panel.querySql, panel.panelType, this.config.clickhouse);
    sendJson(response, 200, { success: true, data: await this.publishAndRecord(panel) });
  }

  public async pinCustomPanel(url: URL, response: ServerResponse, principal: Principal): Promise<void> {
    const panel = await this.requireCustomPanel(customPanelIdFromPath(url, 'pin'));
    sendJson(response, 200, { success: true, data: await this.panelsStore.pin(panel.id, principal.username) });
  }

  public async deleteCustomPanel(url: URL, response: ServerResponse): Promise<void> {
    const panel = await this.panelsStore.delete(customPanelIdFromPath(url));
    try {
      await this.publisher.delete(panel);
    } catch (error) {
      console.warn('sudo-log could not delete custom Grafana dashboard', error);
    }
    sendJson(response, 200, { success: true });
  }

  public async proxy(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!this.config.grafana.enabled) {
      sendJson(response, 404, { success: false, error: 'Grafana is not enabled' });
      return;
    }
    if (!isAllowedGrafanaPath(url.pathname, this.basePath)) {
      console.warn(`sudo-log blocked Grafana proxy path: ${request.method || 'GET'} ${url.pathname}`);
      sendJson(response, 403, { success: false, error: 'Grafana path is not allowed' });
      return;
    }
    const grafanaPath = proxiedGrafanaPath(url.pathname, this.basePath);
    if (!['GET', 'HEAD', 'POST'].includes(request.method || 'GET')) {
      sendJson(response, 405, { success: false, error: 'Grafana method is not allowed' });
      return;
    }
    if (
      request.method === 'POST' &&
      !isAllowedGrafanaPostPath(grafanaPath)
    ) {
      sendJson(response, 403, { success: false, error: 'Grafana write path is not allowed' });
      return;
    }

    const token = parseCookies(request.headers.cookie).get(EMBED_COOKIE);
    const principal = token ? verifyEmbedToken(this.config, token) : null;
    if (!principal) {
      sendJson(response, 401, { success: false, error: 'Grafana embed session is required' });
      return;
    }
    if (request.method === 'POST' && grafanaPath === '/api/query-history') {
      sendJson(response, 200, { result: 'ok' });
      return;
    }

    const upstream = new URL(`${url.pathname}${url.search}`, this.config.grafana.internalUrl);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (!value) continue;
      const lowerName = name.toLowerCase();
      if (['host', 'content-length', 'authorization', 'cookie', this.config.grafana.authProxyHeader.toLowerCase()].includes(lowerName)) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set(this.config.grafana.authProxyHeader, principal.grafanaUsername);
    headers.set('x-forwarded-user', principal.grafanaUsername);
    if (request.headers.host) headers.set('x-forwarded-host', request.headers.host);
    headers.set('x-forwarded-proto', String(request.headers['x-forwarded-proto'] || 'http'));
    headers.set('x-forwarded-prefix', this.basePath);

    const body = await requestBody(request);
    const upstreamResponse = await fetch(upstream, {
      method: request.method,
      headers,
      body: body ? toArrayBuffer(body) : undefined,
      redirect: 'manual',
    });

    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => {
      const lowerName = name.toLowerCase();
      if (isBlockedProxyResponseHeader(lowerName)) return;
      responseHeaders[name] = value;
    });
    const responseBody =
      request.method === 'HEAD' || upstreamResponse.status === 204 || upstreamResponse.status === 304
        ? null
        : Buffer.from(await upstreamResponse.arrayBuffer());
    if (responseBody) responseHeaders['content-length'] = String(responseBody.byteLength);
    response.writeHead(upstreamResponse.status, responseHeaders);
    if (!responseBody) {
      response.end();
      return;
    }
    response.end(responseBody);
  }

  public proxyUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    if (!this.config.grafana.enabled) {
      writeUpgradeError(socket, 404, 'Not Found');
      return;
    }
    if (proxiedGrafanaPath(url.pathname, this.basePath) !== '/api/live/ws') {
      writeUpgradeError(socket, 403, 'Forbidden');
      return;
    }
    if (!isAllowedGrafanaPath(url.pathname, this.basePath)) {
      console.warn(`sudo-log blocked Grafana proxy upgrade path: ${request.method || 'GET'} ${url.pathname}`);
      writeUpgradeError(socket, 403, 'Forbidden');
      return;
    }

    const token = parseCookies(request.headers.cookie).get(EMBED_COOKIE);
    const principal = token ? verifyEmbedToken(this.config, token) : null;
    if (!principal) {
      writeUpgradeError(socket, 401, 'Unauthorized');
      return;
    }

    const upstreamUrl = new URL(`${url.pathname}${url.search}`, this.config.grafana.internalUrl);
    if (upstreamUrl.protocol !== 'http:') {
      writeUpgradeError(socket, 502, 'Bad Gateway');
      return;
    }

    const upstream = createConnection({
      host: upstreamUrl.hostname,
      port: Number.parseInt(upstreamUrl.port || '80', 10),
    });
    upstream.on('connect', () => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (!value) continue;
        const lowerName = name.toLowerCase();
        if (['host', 'content-length', 'authorization', 'cookie', this.config.grafana.authProxyHeader.toLowerCase()].includes(lowerName)) continue;
        headers[name] = value;
      }
      headers.host = upstreamUrl.host;
      headers[this.config.grafana.authProxyHeader] = principal.grafanaUsername;
      headers['x-forwarded-user'] = principal.grafanaUsername;
      if (request.headers.host) headers['x-forwarded-host'] = request.headers.host;
      headers['x-forwarded-proto'] = String(request.headers['x-forwarded-proto'] || 'http');
      headers['x-forwarded-prefix'] = this.basePath;

      const lines = [`${request.method || 'GET'} ${upstreamUrl.pathname}${upstreamUrl.search} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
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

  private customPanel(
    panel: GrafanaCustomPanelRecord,
    input: { from: string; to: string; environment: string; tagKey: string; tagValue: string },
  ): { id: string; title: string; height: number; iframe_url: string; custom: boolean } {
    const params = new URLSearchParams({
      orgId: this.config.grafana.orgId,
      panelId: '1',
      from: input.from,
      to: input.to,
      'var-tenant_id': panel.tenantId,
      'var-product': panel.product,
      'var-environment': input.environment,
      'var-tag_key': input.tagKey,
      'var-tag_value': input.tagValue,
      theme: 'light',
    });
    return {
      id: panel.id,
      title: panel.title,
      height: panel.height,
      iframe_url: `${this.basePath}/d-solo/${encodeURIComponent(panel.dashboardUid)}/${encodeURIComponent(panel.dashboardSlug)}?${params.toString()}`,
      custom: true,
    };
  }

  private customPanelFilters(
    body: CustomPanelBody,
    fallback?: Pick<GrafanaCustomPanelRecord, 'from' | 'to' | 'environment' | 'tagKey' | 'tagValue'>,
  ): Pick<CreateGrafanaCustomPanelInput, 'from' | 'to' | 'environment' | 'tagKey' | 'tagValue'> {
    const range = selectedTimeRange(typeof body.from === 'string' ? body.from : fallback?.from || null);
    return {
      from: range.from,
      to: range.to,
      environment: typeof body.environment === 'string' ? safeVariable(body.environment, 'production') : fallback?.environment || 'production',
      tagKey: typeof body.tag_key === 'string' ? safeTagKey(body.tag_key, '') : fallback?.tagKey || this.config.grafana.defaultTagKey,
      tagValue: typeof body.tag_value === 'string' ? safeVariable(body.tag_value, '') : fallback?.tagValue || '',
    };
  }

  private customPanelInput(body: CustomPanelBody, tenantId: string, product: string, actor: string): CreateGrafanaCustomPanelInput {
    const panelType = this.panelType(body.panel_type, 'timeseries');
    if (typeof body.query_sql !== 'string') {
      throw Object.assign(new Error('query_sql is required'), { statusCode: 400 });
    }
    validateGrafanaPanelQuery(body.query_sql, panelType, this.config.clickhouse);
    return {
      tenantId,
      product,
      ...this.customPanelFilters(body),
      title: typeof body.title === 'string' ? body.title : '',
      description: typeof body.description === 'string' ? body.description : undefined,
      panelType,
      querySql: body.query_sql,
      height: typeof body.height === 'number' ? body.height : undefined,
      unit: typeof body.unit === 'string' ? body.unit : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      actor,
    };
  }

  private importPanelInput(item: GrafanaCustomPanelExportItem, tenantId: string, product: string, actor: string): CreateGrafanaCustomPanelInput {
    const panelType = item.panelType || 'timeseries';
    validateGrafanaPanelQuery(item.querySql, panelType, this.config.clickhouse);
    return {
      tenantId,
      product,
      from: item.from,
      to: item.to,
      environment: item.environment,
      tagKey: item.tagKey,
      tagValue: item.tagValue,
      title: item.title,
      description: item.description,
      panelType,
      querySql: item.querySql,
      height: item.height,
      unit: item.unit,
      enabled: item.enabled,
      actor,
    };
  }

  private panelType(value: unknown, fallback?: GrafanaPanelType): GrafanaPanelType {
    if (value === undefined && fallback) return fallback;
    if (!isGrafanaPanelType(value)) {
      throw Object.assign(new Error('panel_type must be timeseries, table, barchart, or stat'), { statusCode: 400 });
    }
    return value;
  }

  private async requireCustomPanel(id: string): Promise<GrafanaCustomPanelRecord> {
    const panel = await this.panelsStore.find(id);
    if (!panel) throw Object.assign(new Error('Custom panel not found'), { statusCode: 404 });
    await this.settings.requireEnabledProduct(panel.tenantId, panel.product);
    return panel;
  }

  private requireGrafanaPublishing(panel: GrafanaCustomPanelRecord): void {
    if (!panel.enabled) {
      throw Object.assign(new Error('Custom panel is disabled'), { statusCode: 400 });
    }
    if (!this.config.grafana.enabled) {
      throw Object.assign(new Error('Grafana is not enabled'), { statusCode: 400 });
    }
    if (!this.config.grafana.publishEnabled) {
      throw Object.assign(new Error('Grafana publishing is disabled'), { statusCode: 400 });
    }
  }

  private async publishAndRecord(panel: GrafanaCustomPanelRecord): Promise<GrafanaCustomPanelRecord> {
    if (!panel.enabled) return panel;
    try {
      const published = await this.publisher.publish(panel);
      if (!published) return panel;
      return this.panelsStore.markPublished(panel.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Grafana publish failed';
      return this.panelsStore.markPublishError(panel.id, message);
    }
  }

}
