import type { AppConfig } from '../config/appConfig.js';
import type { GrafanaCustomPanelRecord, GrafanaPanelType } from '../types/settings.js';

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

function panelFormat(panelType: GrafanaPanelType): number {
  return panelType === 'timeseries' ? 0 : 1;
}

function gridHeight(panel: GrafanaCustomPanelRecord): number {
  return Math.max(7, Math.min(16, Math.round(panel.height / 40)));
}

function fieldConfig(panelType: GrafanaPanelType): object {
  if (panelType === 'stat') {
    return { defaults: { unit: 'short' }, overrides: [] };
  }
  return { defaults: {}, overrides: [] };
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

export class GrafanaDashboardPublisher {
  public constructor(private readonly config: AppConfig) {}

  public async publish(panel: GrafanaCustomPanelRecord): Promise<boolean> {
    if (!this.config.grafana.enabled || !this.config.grafana.publishEnabled) return false;
    const response = await fetch(new URL(`${grafanaBasePath(this.config.grafana.publicBasePath)}/api/dashboards/db`, this.config.grafana.internalUrl), {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.grafana.apiUser}:${this.config.grafana.apiPassword}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        dashboard: this.dashboard(panel),
        overwrite: true,
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Grafana dashboard publish failed: ${response.status} ${text}`);
    }
    return true;
  }

  public async delete(panel: GrafanaCustomPanelRecord): Promise<void> {
    if (!this.config.grafana.enabled || !this.config.grafana.publishEnabled) return;
    const response = await fetch(
      new URL(
        `${grafanaBasePath(this.config.grafana.publicBasePath)}/api/dashboards/uid/${encodeURIComponent(panel.dashboardUid)}`,
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

  private dashboard(panel: GrafanaCustomPanelRecord): object {
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
          fieldConfig: fieldConfig(panel.panelType),
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
          { current: { selected: false, text: 'production', value: 'production' }, hide: 0, name: 'environment', query: 'production', type: 'textbox' },
          {
            current: { selected: false, text: this.config.grafana.defaultTagKey, value: this.config.grafana.defaultTagKey },
            hide: 0,
            name: 'tag_key',
            query: this.config.grafana.defaultTagKey,
            type: 'textbox',
          },
          { current: { selected: false, text: this.config.grafana.defaultTagValue, value: this.config.grafana.defaultTagValue }, hide: 0, name: 'tag_value', query: this.config.grafana.defaultTagValue, type: 'textbox' },
        ],
      },
      time: { from: 'now-6h', to: 'now' },
      timezone: 'browser',
      title: `Sudowork Custom - ${panel.tenantId}/${panel.product} - ${panel.title}`,
      uid: panel.dashboardUid,
      version: 1,
    };
  }
}
