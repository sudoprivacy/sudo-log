import { randomUUID } from 'node:crypto';
import { pgBoolean, pgString, type PgRow, type PostgresClient } from '../db/postgres.js';
import type {
  CreateGrafanaCustomPanelInput,
  GrafanaCustomPanelExportData,
  GrafanaCustomPanelExportItem,
  GrafanaCustomPanelRecord,
  GrafanaPanelType,
  UpdateGrafanaCustomPanelInput,
} from '../types/settings.js';

function pgBool(value: string | null): boolean {
  return value === 't' || value === 'true';
}

function panelType(value: string | null): GrafanaPanelType {
  if (value === 'table' || value === 'barchart' || value === 'stat') return value;
  return 'timeseries';
}

function toPanel(row: PgRow): GrafanaCustomPanelRecord {
  return {
    id: row.id || '',
    tenantId: row.tenant_id || '',
    product: row.product || '',
    from: row.filter_from || 'now-6h',
    to: row.filter_to || 'now',
    environment: row.environment || 'production',
    tagKey: row.tag_key || '',
    tagValue: row.tag_value || '',
    title: row.title || '',
    description: row.description || '',
    panelType: panelType(row.panel_type),
    querySql: row.query_sql || '',
    height: Number.parseInt(row.height || '320', 10),
    unit: row.unit || 'short',
    enabled: pgBool(row.enabled),
    dashboardUid: row.dashboard_uid || '',
    dashboardSlug: row.dashboard_slug || '',
    createdBy: row.created_by || '',
    updatedBy: row.updated_by || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    publishedAt: row.published_at || '',
    publishError: row.publish_error || '',
  };
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeDescription(value: string | undefined): string {
  return value?.trim() || '';
}

function normalizeOptionalText(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function normalizeHeight(value: number | undefined): number {
  if (!Number.isFinite(value)) return 320;
  return Math.max(220, Math.min(Math.round(value || 320), 640));
}

function normalizeUnit(value: string | undefined): string {
  const unit = value?.trim() || 'short';
  return /^[a-zA-Z0-9_.$/%:-]{1,64}$/.test(unit) ? unit : 'short';
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'custom-panel';
}

function toExportItem(panel: GrafanaCustomPanelRecord): GrafanaCustomPanelExportItem {
  return {
    title: panel.title,
    description: panel.description,
    panelType: panel.panelType,
    querySql: panel.querySql,
    height: panel.height,
    unit: panel.unit,
    enabled: panel.enabled,
    from: panel.from,
    to: panel.to,
    environment: panel.environment,
    tagKey: panel.tagKey,
    tagValue: panel.tagValue,
  };
}

export class GrafanaPanelStore {
  public constructor(private readonly postgres: PostgresClient) {}

  public async initialize(): Promise<void> {
    await this.postgres.query(`
      CREATE TABLE IF NOT EXISTS grafana_custom_panels (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        product TEXT NOT NULL,
        filter_from TEXT NOT NULL DEFAULT 'now-6h',
        filter_to TEXT NOT NULL DEFAULT 'now',
        environment TEXT NOT NULL DEFAULT 'production',
        tag_key TEXT NOT NULL DEFAULT '',
        tag_value TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        panel_type TEXT NOT NULL,
        query_sql TEXT NOT NULL,
        height INTEGER NOT NULL,
        unit TEXT NOT NULL DEFAULT 'short',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        dashboard_uid TEXT NOT NULL UNIQUE,
        dashboard_slug TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_at TEXT NOT NULL DEFAULT '',
        publish_error TEXT NOT NULL DEFAULT ''
      )
    `);
    await this.postgres.query("ALTER TABLE grafana_custom_panels ADD COLUMN IF NOT EXISTS filter_from TEXT NOT NULL DEFAULT 'now-6h'");
    await this.postgres.query("ALTER TABLE grafana_custom_panels ADD COLUMN IF NOT EXISTS filter_to TEXT NOT NULL DEFAULT 'now'");
    await this.postgres.query("ALTER TABLE grafana_custom_panels ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'production'");
    await this.postgres.query("ALTER TABLE grafana_custom_panels ADD COLUMN IF NOT EXISTS tag_key TEXT NOT NULL DEFAULT ''");
    await this.postgres.query("ALTER TABLE grafana_custom_panels ADD COLUMN IF NOT EXISTS tag_value TEXT NOT NULL DEFAULT ''");
    await this.postgres.query("ALTER TABLE grafana_custom_panels ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'short'");
  }

  public async list(tenantId: string, product: string, enabledOnly = false): Promise<GrafanaCustomPanelRecord[]> {
    const enabledWhere = enabledOnly ? 'AND enabled = TRUE AND published_at != \'\'' : '';
    const rows = await this.postgres.query(`
      SELECT *
      FROM grafana_custom_panels
      WHERE tenant_id = ${pgString(normalizeIdentifier(tenantId))}
        AND product = ${pgString(normalizeIdentifier(product))}
        ${enabledWhere}
      ORDER BY updated_at DESC, created_at DESC
    `);
    return rows.map(toPanel);
  }

  public async find(id: string): Promise<GrafanaCustomPanelRecord | null> {
    const rows = await this.postgres.query(`SELECT * FROM grafana_custom_panels WHERE id = ${pgString(id)} LIMIT 1`);
    return rows[0] ? toPanel(rows[0]) : null;
  }

  public async export(tenantId: string, product: string): Promise<GrafanaCustomPanelExportData> {
    const normalizedTenantId = normalizeIdentifier(tenantId);
    const normalizedProduct = normalizeIdentifier(product);
    const panels = await this.list(normalizedTenantId, normalizedProduct);
    return {
      version: 1,
      kind: 'sudo-log.grafana-custom-panels',
      exportedAt: new Date().toISOString(),
      tenantId: normalizedTenantId,
      product: normalizedProduct,
      panels: panels.map(toExportItem),
    };
  }

  public async findByTitle(tenantId: string, product: string, title: string): Promise<GrafanaCustomPanelRecord | null> {
    const normalizedTenantId = normalizeIdentifier(tenantId);
    const normalizedProduct = normalizeIdentifier(product);
    const normalizedTitle = normalizeTitle(title);
    const rows = await this.postgres.query(`
      SELECT *
      FROM grafana_custom_panels
      WHERE tenant_id = ${pgString(normalizedTenantId)}
        AND product = ${pgString(normalizedProduct)}
        AND title = ${pgString(normalizedTitle)}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `);
    return rows[0] ? toPanel(rows[0]) : null;
  }

  public async upsertByTitle(input: CreateGrafanaCustomPanelInput): Promise<{ panel: GrafanaCustomPanelRecord; created: boolean }> {
    const existing = await this.findByTitle(input.tenantId, input.product, input.title);
    if (!existing) {
      return { panel: await this.create(input), created: true };
    }

    return {
      panel: await this.update(existing.id, {
        tenantId: input.tenantId,
        product: input.product,
        from: input.from,
        to: input.to,
        environment: input.environment,
        tagKey: input.tagKey,
        tagValue: input.tagValue,
        title: input.title,
        description: input.description,
        panelType: input.panelType,
        querySql: input.querySql,
        height: input.height,
        unit: input.unit,
        enabled: input.enabled,
        actor: input.actor,
      }),
      created: false,
    };
  }

  public async create(input: CreateGrafanaCustomPanelInput): Promise<GrafanaCustomPanelRecord> {
    const id = randomUUID();
    const tenantId = normalizeIdentifier(input.tenantId);
    const product = normalizeIdentifier(input.product);
    const title = normalizeTitle(input.title);
    if (!title) throw Object.assign(new Error('title is required'), { statusCode: 400 });
    const now = new Date().toISOString();
    const dashboardUid = `sw-${id.replace(/-/g, '').slice(0, 24)}`;
    const dashboardSlug = slugify(title);
    const panel: GrafanaCustomPanelRecord = {
      id,
      tenantId,
      product,
      from: normalizeOptionalText(input.from, 'now-6h'),
      to: normalizeOptionalText(input.to, 'now'),
      environment: normalizeOptionalText(input.environment, 'production'),
      tagKey: normalizeOptionalText(input.tagKey, ''),
      tagValue: normalizeOptionalText(input.tagValue, ''),
      title,
      description: normalizeDescription(input.description),
      panelType: input.panelType || 'timeseries',
      querySql: input.querySql.trim(),
      height: normalizeHeight(input.height),
      unit: normalizeUnit(input.unit),
      enabled: input.enabled ?? true,
      dashboardUid,
      dashboardSlug,
      createdBy: input.actor,
      updatedBy: input.actor,
      createdAt: now,
      updatedAt: now,
      publishedAt: '',
      publishError: '',
    };
    await this.postgres.query(`
      INSERT INTO grafana_custom_panels (
        id,
        tenant_id,
        product,
        filter_from,
        filter_to,
        environment,
        tag_key,
        tag_value,
        title,
        description,
        panel_type,
        query_sql,
        height,
        unit,
        enabled,
        dashboard_uid,
        dashboard_slug,
        created_by,
        updated_by,
        created_at,
        updated_at,
        published_at,
        publish_error
      )
      VALUES (
        ${pgString(panel.id)},
        ${pgString(panel.tenantId)},
        ${pgString(panel.product)},
        ${pgString(panel.from)},
        ${pgString(panel.to)},
        ${pgString(panel.environment)},
        ${pgString(panel.tagKey)},
        ${pgString(panel.tagValue)},
        ${pgString(panel.title)},
        ${pgString(panel.description)},
        ${pgString(panel.panelType)},
        ${pgString(panel.querySql)},
        ${panel.height},
        ${pgString(panel.unit)},
        ${pgBoolean(panel.enabled)},
        ${pgString(panel.dashboardUid)},
        ${pgString(panel.dashboardSlug)},
        ${pgString(panel.createdBy)},
        ${pgString(panel.updatedBy)},
        ${pgString(panel.createdAt)},
        ${pgString(panel.updatedAt)},
        '',
        ''
      )
    `);
    return panel;
  }

  public async update(id: string, input: UpdateGrafanaCustomPanelInput): Promise<GrafanaCustomPanelRecord> {
    const existing = await this.find(id);
    if (!existing) throw Object.assign(new Error('Custom panel not found'), { statusCode: 404 });
    const title = input.title === undefined ? existing.title : normalizeTitle(input.title);
    if (!title) throw Object.assign(new Error('title is required'), { statusCode: 400 });
    const panel: GrafanaCustomPanelRecord = {
      ...existing,
      tenantId: input.tenantId === undefined ? existing.tenantId : normalizeIdentifier(input.tenantId),
      product: input.product === undefined ? existing.product : normalizeIdentifier(input.product),
      from: input.from === undefined ? existing.from : normalizeOptionalText(input.from, 'now-6h'),
      to: input.to === undefined ? existing.to : normalizeOptionalText(input.to, 'now'),
      environment: input.environment === undefined ? existing.environment : normalizeOptionalText(input.environment, 'production'),
      tagKey: input.tagKey === undefined ? existing.tagKey : normalizeOptionalText(input.tagKey, ''),
      tagValue: input.tagValue === undefined ? existing.tagValue : normalizeOptionalText(input.tagValue, ''),
      title,
      description: input.description === undefined ? existing.description : normalizeDescription(input.description),
      panelType: input.panelType || existing.panelType,
      querySql: input.querySql === undefined ? existing.querySql : input.querySql.trim(),
      height: input.height === undefined ? existing.height : normalizeHeight(input.height),
      unit: input.unit === undefined ? existing.unit : normalizeUnit(input.unit),
      enabled: input.enabled ?? existing.enabled,
      dashboardSlug: input.title === undefined ? existing.dashboardSlug : slugify(title),
      updatedBy: input.actor,
      updatedAt: new Date().toISOString(),
      publishedAt: '',
      publishError: '',
    };
    await this.postgres.query(`
      UPDATE grafana_custom_panels
      SET tenant_id = ${pgString(panel.tenantId)},
          product = ${pgString(panel.product)},
          filter_from = ${pgString(panel.from)},
          filter_to = ${pgString(panel.to)},
          environment = ${pgString(panel.environment)},
          tag_key = ${pgString(panel.tagKey)},
          tag_value = ${pgString(panel.tagValue)},
          title = ${pgString(panel.title)},
          description = ${pgString(panel.description)},
          panel_type = ${pgString(panel.panelType)},
          query_sql = ${pgString(panel.querySql)},
          height = ${panel.height},
          unit = ${pgString(panel.unit)},
          enabled = ${pgBoolean(panel.enabled)},
          dashboard_slug = ${pgString(panel.dashboardSlug)},
          updated_by = ${pgString(panel.updatedBy)},
          updated_at = ${pgString(panel.updatedAt)},
          published_at = '',
          publish_error = ''
      WHERE id = ${pgString(id)}
    `);
    return panel;
  }

  public async markPublished(id: string): Promise<GrafanaCustomPanelRecord> {
    const publishedAt = new Date().toISOString();
    await this.postgres.query(`
      UPDATE grafana_custom_panels
      SET published_at = ${pgString(publishedAt)},
          publish_error = ''
      WHERE id = ${pgString(id)}
    `);
    const panel = await this.find(id);
    if (!panel) throw Object.assign(new Error('Custom panel not found'), { statusCode: 404 });
    return panel;
  }

  public async markPublishError(id: string, error: string): Promise<GrafanaCustomPanelRecord> {
    await this.postgres.query(`
      UPDATE grafana_custom_panels
      SET published_at = '',
          publish_error = ${pgString(error.slice(0, 1000))}
      WHERE id = ${pgString(id)}
    `);
    const panel = await this.find(id);
    if (!panel) throw Object.assign(new Error('Custom panel not found'), { statusCode: 404 });
    return panel;
  }

  public async delete(id: string): Promise<GrafanaCustomPanelRecord> {
    const existing = await this.find(id);
    if (!existing) throw Object.assign(new Error('Custom panel not found'), { statusCode: 404 });
    await this.postgres.query(`DELETE FROM grafana_custom_panels WHERE id = ${pgString(id)}`);
    return existing;
  }

  public async deleteByProduct(tenantId: string, product: string): Promise<GrafanaCustomPanelRecord[]> {
    const normalizedTenantId = normalizeIdentifier(tenantId);
    const normalizedProduct = normalizeIdentifier(product);
    const existing = await this.list(normalizedTenantId, normalizedProduct);
    await this.postgres.query(`
      DELETE FROM grafana_custom_panels
      WHERE tenant_id = ${pgString(normalizedTenantId)}
        AND product = ${pgString(normalizedProduct)}
    `);
    return existing;
  }
}
