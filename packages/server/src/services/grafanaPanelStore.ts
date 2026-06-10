import { randomUUID } from 'node:crypto';
import { pgBoolean, pgString, type PgRow, type PostgresClient } from '../db/postgres.js';
import type {
  CreateGrafanaCustomPanelInput,
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
    title: row.title || '',
    description: row.description || '',
    panelType: panelType(row.panel_type),
    querySql: row.query_sql || '',
    height: Number.parseInt(row.height || '320', 10),
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

function normalizeHeight(value: number | undefined): number {
  if (!Number.isFinite(value)) return 320;
  return Math.max(220, Math.min(Math.round(value || 320), 640));
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'custom-panel';
}

export class GrafanaPanelStore {
  public constructor(private readonly postgres: PostgresClient) {}

  public async initialize(): Promise<void> {
    await this.postgres.query(`
      CREATE TABLE IF NOT EXISTS grafana_custom_panels (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        product TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        panel_type TEXT NOT NULL,
        query_sql TEXT NOT NULL,
        height INTEGER NOT NULL,
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
  }

  public async list(tenantId: string, product: string, enabledOnly = false): Promise<GrafanaCustomPanelRecord[]> {
    const enabledWhere = enabledOnly ? 'AND enabled = TRUE AND published_at != \'\'' : '';
    const rows = await this.postgres.query(`
      SELECT *
      FROM grafana_custom_panels
      WHERE tenant_id = ${pgString(normalizeIdentifier(tenantId))}
        AND product = ${pgString(normalizeIdentifier(product))}
        ${enabledWhere}
      ORDER BY title ASC, created_at ASC
    `);
    return rows.map(toPanel);
  }

  public async find(id: string): Promise<GrafanaCustomPanelRecord | null> {
    const rows = await this.postgres.query(`SELECT * FROM grafana_custom_panels WHERE id = ${pgString(id)} LIMIT 1`);
    return rows[0] ? toPanel(rows[0]) : null;
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
      title,
      description: normalizeDescription(input.description),
      panelType: input.panelType || 'timeseries',
      querySql: input.querySql.trim(),
      height: normalizeHeight(input.height),
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
        title,
        description,
        panel_type,
        query_sql,
        height,
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
        ${pgString(panel.title)},
        ${pgString(panel.description)},
        ${pgString(panel.panelType)},
        ${pgString(panel.querySql)},
        ${panel.height},
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
      title,
      description: input.description === undefined ? existing.description : normalizeDescription(input.description),
      panelType: input.panelType || existing.panelType,
      querySql: input.querySql === undefined ? existing.querySql : input.querySql.trim(),
      height: input.height === undefined ? existing.height : normalizeHeight(input.height),
      enabled: input.enabled ?? existing.enabled,
      dashboardSlug: input.title === undefined ? existing.dashboardSlug : slugify(title),
      updatedBy: input.actor,
      updatedAt: new Date().toISOString(),
      publishedAt: '',
      publishError: '',
    };
    await this.postgres.query(`
      UPDATE grafana_custom_panels
      SET title = ${pgString(panel.title)},
          description = ${pgString(panel.description)},
          panel_type = ${pgString(panel.panelType)},
          query_sql = ${pgString(panel.querySql)},
          height = ${panel.height},
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
}
