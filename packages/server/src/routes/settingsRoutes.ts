import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../config/appConfig.js';
import { readJsonBody, sendJson } from '../http/http.js';
import { SettingsStore } from '../services/settingsStore.js';
import type { CreateProductInput, CreateTenantInput, UpdateProductInput, UpdateTenantInput } from '../types/settings.js';

interface TenantBody {
  tenantId?: unknown;
  name?: unknown;
  apiKey?: unknown;
  enabled?: unknown;
}

interface ProductBody {
  product?: unknown;
  name?: unknown;
  enabled?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function tenantIdFromPath(url: URL): string {
  const match = /^\/api\/settings\/tenants\/([^/]+)$/.exec(url.pathname);
  if (!match) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });
  return decodeURIComponent(match[1]);
}

function productPath(url: URL): { tenantId: string; product: string } {
  const match = /^\/api\/settings\/tenants\/([^/]+)\/products\/([^/]+)$/.exec(url.pathname);
  if (!match) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
  return {
    tenantId: decodeURIComponent(match[1]),
    product: decodeURIComponent(match[2]),
  };
}

function productTenantIdFromPath(url: URL): string {
  const match = /^\/api\/settings\/tenants\/([^/]+)\/products$/.exec(url.pathname);
  if (!match) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });
  return decodeURIComponent(match[1]);
}

export class SettingsRoutes {
  public constructor(
    private readonly config: AppConfig,
    private readonly settings: SettingsStore,
  ) {}

  public async list(response: ServerResponse, includeApiKey: boolean): Promise<void> {
    sendJson(response, 200, { success: true, data: await this.settings.list(includeApiKey) });
  }

  public async createTenant(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody<TenantBody>(request, this.config.maxBodyBytes);
    if (typeof body.tenantId !== 'string') {
      throw Object.assign(new Error('tenantId is required'), { statusCode: 400 });
    }
    const input: CreateTenantInput = {
      tenantId: body.tenantId,
      name: optionalString(body.name),
      apiKey: optionalString(body.apiKey),
      enabled: optionalBoolean(body.enabled),
    };
    const tenant = await this.settings.createTenant(input);
    sendJson(response, 201, { success: true, data: tenant });
  }

  public async updateTenant(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> {
    const tenantId = tenantIdFromPath(url);
    const body = await readJsonBody<TenantBody>(request, this.config.maxBodyBytes);
    if (body.apiKey !== undefined) {
      throw Object.assign(new Error('apiKey cannot be updated'), { statusCode: 400 });
    }
    const input: UpdateTenantInput = {
      name: optionalString(body.name),
      enabled: optionalBoolean(body.enabled),
    };
    const tenant = await this.settings.updateTenant(tenantId, input);
    sendJson(response, 200, { success: true, data: tenant });
  }

  public async deleteTenant(url: URL, response: ServerResponse): Promise<void> {
    await this.settings.deleteTenant(tenantIdFromPath(url));
    sendJson(response, 200, { success: true });
  }

  public async createProduct(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> {
    const tenantId = productTenantIdFromPath(url);
    const body = await readJsonBody<ProductBody>(request, this.config.maxBodyBytes);
    if (typeof body.product !== 'string') {
      throw Object.assign(new Error('product is required'), { statusCode: 400 });
    }
    const input: CreateProductInput = {
      tenantId,
      product: body.product,
      name: optionalString(body.name),
      enabled: optionalBoolean(body.enabled),
    };
    const product = await this.settings.createProduct(input);
    sendJson(response, 201, { success: true, data: product });
  }

  public async updateProduct(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> {
    const { tenantId, product } = productPath(url);
    const body = await readJsonBody<ProductBody>(request, this.config.maxBodyBytes);
    const input: UpdateProductInput = {
      name: optionalString(body.name),
      enabled: optionalBoolean(body.enabled),
    };
    const updated = await this.settings.updateProduct(tenantId, product, input);
    sendJson(response, 200, { success: true, data: updated });
  }

  public async deleteProduct(url: URL, response: ServerResponse): Promise<void> {
    const { tenantId, product } = productPath(url);
    await this.settings.deleteProduct(tenantId, product);
    sendJson(response, 200, { success: true });
  }
}
