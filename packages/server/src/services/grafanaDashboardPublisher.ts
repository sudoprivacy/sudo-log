import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/appConfig.js';
import type { GrafanaCustomPanelRecord, GrafanaPanelType } from '../types/settings.js';

interface DashboardFilters {
  from: string;
  to: string;
  environment: string;
  tagKey: string;
  tagValue: string;
}

interface LayoutItem {
  panel: GrafanaCustomPanelRecord;
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function datasource(config: AppConfig): { type: string; uid: string } {
  return {
    type: 'grafana-clickhouse-datasource',
    uid: config.grafana.datasourceUid,
  };
}

function grafanaBasePath(value: string): string {
  const trimmed = value.trim() || '/grafana';
  return trimmed.startsWith('/') ? trimmed.replace(/\/+$/, '') || '/grafana' : `/${trimmed.replace(/\/+$/, '')}`;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function uidPart(value: string, fallback: string): string {
  return slugify(value, fallback).slice(0, 12) || fallback;
}

export function grafanaProductDashboardUid(tenantId: string, product: string): string {
  const hash = createHash('sha1').update(`${tenantId}:${product}`).digest('hex').slice(0, 8);
  return `sw-${uidPart(tenantId, 'tenant')}-${uidPart(product, 'product')}-${hash}`.slice(0, 40);
}

export function grafanaProductDashboardSlug(tenantId: string, product: string): string {
  return slugify(`sudo-log-${tenantId}-${product}`, 'sudo-log-dashboard');
}

function panelFormat(panelType: GrafanaPanelType): number {
  return panelType === 'timeseries' ? 0 : 1;
}

function gridHeight(panel: GrafanaCustomPanelRecord): number {
  return Math.max(7, Math.min(16, Math.round(panel.height / 40)));
}

function fieldConfig(panelType: GrafanaPanelType, unit: string): object {
  if (panelType === 'stat') {
    return { defaults: { unit }, overrides: [] };
  }
  return { defaults: unit && unit !== 'short' ? { unit } : {}, overrides: [] };
}

function panelOptions(panelType: GrafanaPanelType): object {
  if (panelType === 'timeseries') {
    return {
      legend: { displayMode: 'list', placement: 'bottom' },
      tooltip: { mode: 'single', sort: 'none' },
    };
  }
  if (panelType === 'table') return { showHeader: true };
  return {};
}

function layoutPanels(panels: GrafanaCustomPanelRecord[]): LayoutItem[] {
  const columnHeights = [0, 0];
  return panels.map((panel, index) => {
    const column = index % 2;
    const h = gridHeight(panel);
    const item: LayoutItem = {
      panel,
      id: index + 1,
      x: column * 12,
      y: columnHeights[column],
      w: 12,
      h,
    };
    columnHeights[column] += h;
    return item;
  });
}

export function grafanaProductDashboardHeight(panels: GrafanaCustomPanelRecord[]): number {
  const rows = layoutPanels(panels).reduce((max, item) => Math.max(max, item.y + item.h), 0);
  return Math.max(520, Math.min(8000, rows * 40 + 160));
}

export class GrafanaDashboardPublisher {
  public constructor(private readonly config: AppConfig) { }

  public async publishProductDashboard(
    tenantId: string,
    product: string,
    panels: GrafanaCustomPanelRecord[],
    filters: DashboardFilters,
  ): Promise<boolean> {
    if (!this.config.grafana.enabled || !this.config.grafana.publishEnabled) return false;
    if (!panels.length) {
      await this.deleteProductDashboard(tenantId, product);
      return true;
    }
    return this.saveDashboard(this.productDashboard(tenantId, product, panels, filters));
  }

  public async publishPreview(panel: GrafanaCustomPanelRecord): Promise<boolean> {
    return this.saveDashboard(this.singlePanelDashboard(panel));
  }

  public async deleteProductDashboard(tenantId: string, product: string): Promise<void> {
    await this.deleteDashboard(grafanaProductDashboardUid(tenantId, product));
  }

  public async deletePanelDashboard(panel: GrafanaCustomPanelRecord): Promise<void> {
    await this.deleteDashboard(panel.dashboardUid);
  }

  private async saveDashboard(dashboard: object): Promise<boolean> {
    if (!this.config.grafana.enabled || !this.config.grafana.publishEnabled) return false;
    const response = await fetch(new URL(`${grafanaBasePath(this.config.grafana.publicBasePath)}/api/dashboards/db`, this.config.grafana.internalUrl), {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.grafana.apiUser}:${this.config.grafana.apiPassword}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        dashboard,
        overwrite: true,
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Grafana dashboard publish failed: ${response.status} ${text}`);
    }
    return true;
  }

  private async deleteDashboard(uid: string): Promise<void> {
    if (!this.config.grafana.enabled || !this.config.grafana.publishEnabled) return;
    const response = await fetch(
      new URL(
        `${grafanaBasePath(this.config.grafana.publicBasePath)}/api/dashboards/uid/${encodeURIComponent(uid)}`,
        this.config.grafana.internalUrl,
      ),
      {
        method: 'DELETE',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.config.grafana.apiUser}:${this.config.grafana.apiPassword}`).toString('base64')}`,
        },
      },
    );
    if (response.status === 404) return;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Grafana dashboard delete failed: ${response.status} ${text}`);
    }
  }

  private productDashboard(tenantId: string, product: string, panels: GrafanaCustomPanelRecord[], filters: DashboardFilters): object {
    const ds = datasource(this.config);
    const dashboardTitle = `Sudo Log - ${tenantId}/${product}`;
    return {
      annotations: { list: [] },
      editable: false,
      graphTooltip: 0,
      id: null,
      links: [],
      panels: layoutPanels(panels).map(({ panel, id, x, y, w, h }) => ({
        datasource: ds,
        fieldConfig: fieldConfig(panel.panelType, panel.unit || 'short'),
        gridPos: { h, w, x, y },
        id,
        options: panelOptions(panel.panelType),
        targets: [
          {
            datasource: ds,
            editorType: 'sql',
            format: panelFormat(panel.panelType),
            queryType: 'sql',
            rawSql: panel.querySql,
            refId: 'A',
          },
        ],
        title: panel.title,
        type: panel.panelType,
      })),
      refresh: '30s',
      schemaVersion: 39,
      tags: ['sudo-log', 'custom-dashboard', tenantId, product],
      templating: {
        list: [
          { current: { selected: false, text: tenantId, value: tenantId }, hide: 2, name: 'tenant_id', query: tenantId, type: 'constant' },
          { current: { selected: false, text: product, value: product }, hide: 2, name: 'product', query: product, type: 'constant' },
          { current: { selected: false, text: filters.environment, value: filters.environment }, hide: 0, name: 'environment', query: filters.environment, type: 'textbox' },
          {
            current: { selected: false, text: filters.tagKey || this.config.grafana.defaultTagKey, value: filters.tagKey || this.config.grafana.defaultTagKey },
            hide: 0,
            name: 'tag_key',
            query: filters.tagKey || this.config.grafana.defaultTagKey,
            type: 'textbox',
          },
          { current: { selected: false, text: filters.tagValue, value: filters.tagValue }, hide: 0, name: 'tag_value', query: filters.tagValue, type: 'textbox' },
        ],
      },
      time: { from: filters.from, to: filters.to },
      timezone: 'browser',
      title: dashboardTitle,
      uid: grafanaProductDashboardUid(tenantId, product),
      version: 1,
    };
  }

  private singlePanelDashboard(panel: GrafanaCustomPanelRecord): object {
    const ds = datasource(this.config);
    return {
      annotations: { list: [] },
      editable: false,
      graphTooltip: 0,
      id: null,
      links: [],
      panels: [
        {
          datasource: ds,
          fieldConfig: fieldConfig(panel.panelType, panel.unit || 'short'),
          gridPos: { h: gridHeight(panel), w: 24, x: 0, y: 0 },
          id: 1,
          options: panelOptions(panel.panelType),
          targets: [
            {
              datasource: ds,
              editorType: 'sql',
              format: panelFormat(panel.panelType),
              queryType: 'sql',
              rawSql: panel.querySql,
              refId: 'A',
            },
          ],
          title: panel.title,
          type: panel.panelType,
        },
      ],
      refresh: '',
      schemaVersion: 39,
      tags: ['sudo-log', 'custom-panel', panel.tenantId, panel.product],
      templating: {
        list: [
          { current: { selected: false, text: panel.tenantId, value: panel.tenantId }, hide: 2, name: 'tenant_id', query: panel.tenantId, type: 'constant' },
          { current: { selected: false, text: panel.product, value: panel.product }, hide: 2, name: 'product', query: panel.product, type: 'constant' },
          { current: { selected: false, text: panel.environment, value: panel.environment }, hide: 0, name: 'environment', query: panel.environment, type: 'textbox' },
          {
            current: { selected: false, text: panel.tagKey || this.config.grafana.defaultTagKey, value: panel.tagKey || this.config.grafana.defaultTagKey },
            hide: 0,
            name: 'tag_key',
            query: panel.tagKey || this.config.grafana.defaultTagKey,
            type: 'textbox',
          },
          { current: { selected: false, text: panel.tagValue, value: panel.tagValue }, hide: 0, name: 'tag_value', query: panel.tagValue, type: 'textbox' },
        ],
      },
      time: { from: panel.from, to: panel.to },
      timezone: 'browser',
      title: `Sudo Custom - ${panel.tenantId}/${panel.product} - ${panel.title}`,
      uid: panel.dashboardUid,
      version: 1,
    };
  }
}
