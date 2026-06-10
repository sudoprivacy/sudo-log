import { randomBytes, randomUUID } from 'node:crypto';
import { pgBoolean, pgString, type PgRow, type PostgresClient } from '../db/postgres.js';
import type {
  CreateProductInput,
  CreateTenantInput,
  ProductRecord,
  PublicTenantWithProducts,
  TenantRecord,
  TenantWithProducts,
  UpdateProductInput,
  UpdateTenantInput,
} from '../types/settings.js';

const DEFAULT_TENANT_ID = 'sudo';
const DEFAULT_PRODUCT_ID = 'sudowork';

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9_.-]{1,62}[a-z0-9]$/.test(value)) {
    throw Object.assign(new Error(`${label} must be 3-64 chars and contain lowercase letters, numbers, dot, dash, or underscore`), {
      statusCode: 400,
    });
  }
}

function assertApiKey(value: string): void {
  if (!/^sk-[a-zA-Z0-9._-]{16,128}$/.test(value)) {
    throw Object.assign(new Error('apiKey must start with sk- and contain 16-128 key characters'), { statusCode: 400 });
  }
}

function pgBool(value: string | null): boolean {
  return value === 't' || value === 'true';
}

function rowToTenant(row: PgRow): TenantRecord {
  return {
    id: row.id || '',
    tenantId: row.tenant_id || '',
    name: row.name || '',
    apiKey: row.api_key || '',
    enabled: pgBool(row.enabled),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function rowToProduct(row: PgRow): ProductRecord {
  return {
    id: row.id || '',
    tenantId: row.tenant_id || '',
    product: row.product || '',
    name: row.name || '',
    enabled: pgBool(row.enabled),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function publicTenant(tenant: TenantWithProducts, includeApiKey: boolean): PublicTenantWithProducts {
  const result: PublicTenantWithProducts = {
    id: tenant.id,
    tenantId: tenant.tenantId,
    name: tenant.name,
    enabled: tenant.enabled,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
    products: tenant.products,
  };
  if (includeApiKey) result.apiKey = tenant.apiKey;
  return result;
}

export class SettingsStore {
  private tenantsById = new Map<string, TenantWithProducts>();
  private tenantIdByApiKey = new Map<string, string>();
  private cacheLoaded = false;
  private cacheGeneration = 0;
  private cacheRefreshPromise: Promise<void> | null = null;

  public constructor(private readonly postgres: PostgresClient) {}

  public async initialize(defaultApiKey: string): Promise<void> {
    await this.postgres.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL UNIQUE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    await this.postgres.query(`
      CREATE TABLE IF NOT EXISTS tenant_products (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        product TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, product)
      )
    `);
    await this.ensureDefaultConfig(defaultApiKey);
  }

  public async health(): Promise<boolean> {
    await this.postgres.health();
    return true;
  }

  public async list(includeApiKey: boolean): Promise<PublicTenantWithProducts[]> {
    await this.ensureCache('list tenants');
    return [...this.tenantsById.values()]
      .sort((a, b) => a.tenantId.localeCompare(b.tenantId))
      .map((tenant) => publicTenant(tenant, includeApiKey));
  }

  public async validateIngest(apiKey: string, tenantId: string, product: string): Promise<void> {
    await this.ensureCache('validate ingest');
    const normalizedTenantId = normalizeIdentifier(tenantId);
    const normalizedProduct = normalizeIdentifier(product);
    const tenant = this.tenantsById.get(normalizedTenantId);
    if (!tenant || !tenant.enabled) {
      throw Object.assign(new Error(`Unknown tenant: ${tenantId}`), { statusCode: 404 });
    }

    const productConfig = tenant.products.find((item) => item.product === normalizedProduct && item.enabled);
    if (!productConfig) {
      throw Object.assign(new Error(`Unknown product: ${product}`), { statusCode: 404 });
    }

    if (!apiKey) {
      throw Object.assign(new Error('API key is required'), { statusCode: 401 });
    }
    const apiKeyTenantId = this.tenantIdByApiKey.get(apiKey);
    if (!apiKeyTenantId) {
      throw Object.assign(new Error('Invalid API key'), { statusCode: 401 });
    }
    if (apiKeyTenantId !== normalizedTenantId) {
      throw Object.assign(new Error('API key does not match tenant'), { statusCode: 401 });
    }
  }

  public async requireEnabledProduct(tenantId: string, product: string): Promise<ProductRecord> {
    await this.ensureCache(`require enabled product ${tenantId}/${product}`);
    const normalizedTenantId = normalizeIdentifier(tenantId);
    const normalizedProduct = normalizeIdentifier(product);
    const tenant = this.tenantsById.get(normalizedTenantId);
    if (!tenant || !tenant.enabled) {
      throw Object.assign(new Error(`Unknown tenant: ${tenantId}`), { statusCode: 404 });
    }
    const productConfig = tenant.products.find((item) => item.product === normalizedProduct && item.enabled);
    if (!productConfig) {
      throw Object.assign(new Error(`Unknown product: ${product}`), { statusCode: 404 });
    }
    return productConfig;
  }

  public async createTenant(input: CreateTenantInput): Promise<PublicTenantWithProducts> {
    const tenantId = normalizeIdentifier(input.tenantId);
    assertIdentifier(tenantId, 'tenantId');
    const apiKey = input.apiKey?.trim() || this.generateApiKey();
    assertApiKey(apiKey);
    const existing = await this.postgres.query(
      `SELECT tenant_id, api_key FROM tenants WHERE tenant_id = ${pgString(tenantId)} OR api_key = ${pgString(apiKey)} LIMIT 1`,
    );
    if (existing[0]?.tenant_id === tenantId) {
      throw Object.assign(new Error('Tenant already exists'), { statusCode: 409 });
    }
    if (existing[0]?.api_key === apiKey) {
      throw Object.assign(new Error('API key already exists'), { statusCode: 409 });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const name = input.name?.trim() || tenantId;
    const enabled = input.enabled ?? true;
    await this.postgres.query(`
      INSERT INTO tenants (id, tenant_id, name, api_key, enabled, created_at, updated_at)
      VALUES (
        ${pgString(id)},
        ${pgString(tenantId)},
        ${pgString(name)},
        ${pgString(apiKey)},
        ${pgBoolean(enabled)},
        ${pgString(now)},
        ${pgString(now)}
      )
    `);
    this.invalidateCache(`tenant created: ${tenantId}`);
    return publicTenant({ id, tenantId, name, apiKey, enabled, createdAt: now, updatedAt: now, products: [] }, true);
  }

  public async updateTenant(tenantId: string, input: UpdateTenantInput): Promise<PublicTenantWithProducts> {
    const normalizedTenantId = normalizeIdentifier(tenantId);
    if (normalizedTenantId === DEFAULT_TENANT_ID) {
      throw Object.assign(new Error('Default tenant cannot be modified'), { statusCode: 400 });
    }
    await this.ensureCache(`update tenant ${normalizedTenantId}`);
    const existing = this.tenantsById.get(normalizedTenantId);
    if (!existing) {
      throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });
    }
    const updatedName = input.name?.trim() || existing.name;
    const updatedEnabled = input.enabled ?? existing.enabled;
    const updatedAt = new Date().toISOString();
    await this.postgres.query(`
      UPDATE tenants
      SET name = ${pgString(updatedName)},
          enabled = ${pgBoolean(updatedEnabled)},
          updated_at = ${pgString(updatedAt)}
      WHERE tenant_id = ${pgString(normalizedTenantId)}
    `);
    this.invalidateCache(`tenant updated: ${normalizedTenantId}`);
    return publicTenant({ ...existing, name: updatedName, enabled: updatedEnabled, updatedAt }, true);
  }

  public async deleteTenant(tenantId: string): Promise<void> {
    const normalizedTenantId = normalizeIdentifier(tenantId);
    if (normalizedTenantId === DEFAULT_TENANT_ID) {
      throw Object.assign(new Error('Default tenant cannot be deleted'), { statusCode: 400 });
    }
    await this.ensureCache(`delete tenant ${normalizedTenantId}`);
    const existing = this.tenantsById.get(normalizedTenantId);
    if (!existing) {
      throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });
    }
    await this.postgres.query(`DELETE FROM tenants WHERE tenant_id = ${pgString(normalizedTenantId)}`);
    this.invalidateCache(`tenant deleted: ${normalizedTenantId}`);
  }

  public async createProduct(input: CreateProductInput): Promise<ProductRecord> {
    const tenantId = normalizeIdentifier(input.tenantId);
    const product = normalizeIdentifier(input.product);
    assertIdentifier(tenantId, 'tenantId');
    assertIdentifier(product, 'product');
    await this.ensureCache(`create product ${tenantId}/${product}`);
    if (!this.tenantsById.has(tenantId)) {
      throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });
    }
    const existing = this.tenantsById.get(tenantId)?.products.find((item) => item.product === product);
    if (existing) {
      throw Object.assign(new Error('Product already exists'), { statusCode: 409 });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const name = input.name?.trim() || product;
    const enabled = input.enabled ?? true;
    await this.postgres.query(`
      INSERT INTO tenant_products (id, tenant_id, product, name, enabled, created_at, updated_at)
      VALUES (
        ${pgString(id)},
        ${pgString(tenantId)},
        ${pgString(product)},
        ${pgString(name)},
        ${pgBoolean(enabled)},
        ${pgString(now)},
        ${pgString(now)}
      )
    `);
    this.invalidateCache(`product created: ${tenantId}/${product}`);
    return { id, tenantId, product, name, enabled, createdAt: now, updatedAt: now };
  }

  public async updateProduct(tenantId: string, product: string, input: UpdateProductInput): Promise<ProductRecord> {
    const normalizedTenantId = normalizeIdentifier(tenantId);
    const normalizedProduct = normalizeIdentifier(product);
    if (normalizedTenantId === DEFAULT_TENANT_ID && normalizedProduct === DEFAULT_PRODUCT_ID) {
      throw Object.assign(new Error('Default product cannot be modified'), { statusCode: 400 });
    }
    await this.ensureCache(`update product ${normalizedTenantId}/${normalizedProduct}`);
    const existing = this.tenantsById.get(normalizedTenantId)?.products.find((item) => item.product === normalizedProduct);
    if (!existing) {
      throw Object.assign(new Error('Product not found'), { statusCode: 404 });
    }
    const updatedAt = new Date().toISOString();
    const updatedName = input.name?.trim() || existing.name;
    const updatedEnabled = input.enabled ?? existing.enabled;
    await this.postgres.query(`
      UPDATE tenant_products
      SET name = ${pgString(updatedName)},
          enabled = ${pgBoolean(updatedEnabled)},
          updated_at = ${pgString(updatedAt)}
      WHERE tenant_id = ${pgString(normalizedTenantId)}
        AND product = ${pgString(normalizedProduct)}
    `);
    this.invalidateCache(`product updated: ${normalizedTenantId}/${normalizedProduct}`);
    return { ...existing, name: updatedName, enabled: updatedEnabled, updatedAt };
  }

  public async deleteProduct(tenantId: string, product: string): Promise<void> {
    const normalizedTenantId = normalizeIdentifier(tenantId);
    const normalizedProduct = normalizeIdentifier(product);
    if (normalizedTenantId === DEFAULT_TENANT_ID && normalizedProduct === DEFAULT_PRODUCT_ID) {
      throw Object.assign(new Error('Default product cannot be deleted'), { statusCode: 400 });
    }
    await this.ensureCache(`delete product ${normalizedTenantId}/${normalizedProduct}`);
    const existing = this.tenantsById.get(normalizedTenantId)?.products.find((item) => item.product === normalizedProduct);
    if (!existing) {
      throw Object.assign(new Error('Product not found'), { statusCode: 404 });
    }
    await this.postgres.query(`
      DELETE FROM tenant_products
      WHERE tenant_id = ${pgString(normalizedTenantId)}
        AND product = ${pgString(normalizedProduct)}
    `);
    this.invalidateCache(`product deleted: ${normalizedTenantId}/${normalizedProduct}`);
  }

  public async refreshCache(reason = 'manual'): Promise<void> {
    await this.loadCache(reason, this.cacheGeneration);
  }

  private async loadCache(reason: string, generation: number): Promise<void> {
    console.info(`sudo-log settings cache refresh started: ${reason}`);
    const [tenantRows, productRows] = await Promise.all([
      this.postgres.query('SELECT * FROM tenants ORDER BY tenant_id ASC'),
      this.postgres.query('SELECT * FROM tenant_products ORDER BY tenant_id ASC, product ASC'),
    ]);
    const tenants = tenantRows.map(rowToTenant);
    const products = productRows.map(rowToProduct);
    const nextTenantsById = new Map<string, TenantWithProducts>();
    const nextTenantIdByApiKey = new Map<string, string>();
    const productsByTenantId = new Map<string, ProductRecord[]>();

    for (const product of products) {
      const tenantProducts = productsByTenantId.get(product.tenantId) || [];
      tenantProducts.push(product);
      productsByTenantId.set(product.tenantId, tenantProducts);
    }

    if (generation !== this.cacheGeneration) {
      console.info(`sudo-log settings cache refresh skipped: stale refresh for ${reason}`);
      return;
    }

    for (const tenant of tenants) {
      nextTenantsById.set(tenant.tenantId, { ...tenant, products: productsByTenantId.get(tenant.tenantId) || [] });
      if (tenant.enabled) nextTenantIdByApiKey.set(tenant.apiKey, tenant.tenantId);
    }

    this.tenantsById = nextTenantsById;
    this.tenantIdByApiKey = nextTenantIdByApiKey;
    this.cacheLoaded = true;
    console.info(`sudo-log settings cache refresh completed: tenants=${tenants.length}, products=${products.length}`);
  }

  private async ensureDefaultConfig(defaultApiKey: string): Promise<void> {
    const existingTenant = await this.postgres.query(`SELECT tenant_id FROM tenants WHERE tenant_id = '${DEFAULT_TENANT_ID}' LIMIT 1`);
    if (existingTenant.length === 0) {
      await this.createTenant({
        tenantId: DEFAULT_TENANT_ID,
        name: DEFAULT_TENANT_ID,
        apiKey: defaultApiKey || this.generateApiKey(),
        enabled: true,
      });
    }
    const existingProduct = await this.postgres.query(
      `SELECT product FROM tenant_products WHERE tenant_id = '${DEFAULT_TENANT_ID}' AND product = '${DEFAULT_PRODUCT_ID}' LIMIT 1`,
    );
    if (existingProduct.length === 0) {
      await this.createProduct({
        tenantId: DEFAULT_TENANT_ID,
        product: DEFAULT_PRODUCT_ID,
        name: DEFAULT_PRODUCT_ID,
        enabled: true,
      });
    }
  }

  private async ensureCache(reason: string): Promise<void> {
    while (!this.cacheLoaded) {
      if (!this.cacheRefreshPromise) {
        const generation = this.cacheGeneration;
        this.cacheRefreshPromise = this.loadCache(reason, generation).finally(() => {
          this.cacheRefreshPromise = null;
        });
      }
      await this.cacheRefreshPromise;
    }
  }

  private invalidateCache(reason: string): void {
    this.cacheGeneration += 1;
    this.tenantsById = new Map();
    this.tenantIdByApiKey = new Map();
    this.cacheLoaded = false;
    console.info(`sudo-log settings cache invalidated: ${reason}`);
  }

  private generateApiKey(): string {
    return `sk-${randomBytes(24).toString('hex')}`;
  }
}
