import type { ClickHouseConfig } from '../config/appConfig.js';
import type { GrafanaPanelType } from '../types/settings.js';

const BASE_ALLOWED_TABLES = new Set([
  'grafana_log_metrics_1m',
  'grafana_tag_metrics_1m',
  'grafana_tag_keys_1d',
  'grafana_tag_values_1d',
]);

const DETAIL_ALLOWED_TABLES = new Set(['grafana_log_events', 'grafana_tag_events']);

const FORBIDDEN_TOKENS = [
  'alter',
  'attach',
  'create',
  'delete',
  'detach',
  'drop',
  'grant',
  'insert',
  'kill',
  'optimize',
  'rename',
  'replace',
  'revoke',
  'set',
  'system',
  'truncate',
  'update',
  'use',
];

export interface ValidatedGrafanaQuery {
  sql: string;
  tables: string[];
}

export interface GrafanaPanelQueryTestVariables {
  tenantId: string;
  product: string;
  environment: string;
  tagKey: string;
  tagValue: string;
  from: string;
  to: string;
}

export function isGrafanaPanelType(value: unknown): value is GrafanaPanelType {
  return value === 'timeseries' || value === 'table' || value === 'barchart' || value === 'stat';
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ');
}

function maskStringLiterals(sql: string): string {
  return sql
    .replace(/'(?:''|\\'|[^'])*'/g, "''")
    .replace(/"(?:\\"|[^"])*"/g, '""')
    .replace(/`(?:``|[^`])*`/g, '``');
}

function compact(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function extractTables(sql: string, grafanaDatabase: string): string[] {
  const tables = new Set<string>();
  const pattern = /\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    const identifier = match[1] || '';
    const parts = identifier.split('.');
    if (parts.length === 1) {
      tables.add(parts[0]);
      continue;
    }
    if (parts.length === 2 && parts[0] === grafanaDatabase) {
      tables.add(parts[1]);
      continue;
    }
    throw Object.assign(new Error(`Only ${grafanaDatabase} mart tables are allowed`), { statusCode: 400 });
  }
  return [...tables];
}

function allowedTables(config: ClickHouseConfig): Set<string> {
  const result = new Set(BASE_ALLOWED_TABLES);
  if (config.grafanaDetailEventsEnabled) {
    for (const table of DETAIL_ALLOWED_TABLES) result.add(table);
  }
  return result;
}

function requirePattern(sql: string, pattern: RegExp, message: string): void {
  if (!pattern.test(sql)) {
    throw Object.assign(new Error(message), { statusCode: 400 });
  }
}

function parseRangeTime(value: string, fallback: Date): Date {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'now') return new Date();
  const relative = /^now-(\d+)([mhdw])$/.exec(trimmed);
  if (relative) {
    const amount = Number.parseInt(relative[1] || '0', 10);
    const unit = relative[2];
    const multipliers: Record<string, number> = {
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
    };
    return new Date(Date.now() - amount * multipliers[unit]);
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function clickhouseDateTime(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

function intervalSeconds(from: Date, to: Date): number {
  const durationMs = Math.max(60_000, to.getTime() - from.getTime());
  if (durationMs <= 6 * 60 * 60 * 1000) return 60;
  if (durationMs <= 24 * 60 * 60 * 1000) return 300;
  if (durationMs <= 7 * 24 * 60 * 60 * 1000) return 3600;
  return 86400;
}

function escapeVariableValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function replaceVariables(sql: string, variables: GrafanaPanelQueryTestVariables): string {
  const values: Record<string, string> = {
    tenant_id: variables.tenantId,
    product: variables.product,
    environment: variables.environment,
    tag_key: variables.tagKey,
    tag_value: variables.tagValue,
  };
  let rendered = sql;
  for (const [name, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`\${${name}}`, escapeVariableValue(value));
  }
  return rendered;
}

function replaceTimeMacros(sql: string, variables: GrafanaPanelQueryTestVariables): string {
  const now = new Date();
  const to = parseRangeTime(variables.to || 'now', now);
  const from = parseRangeTime(variables.from || 'now-6h', new Date(to.getTime() - 6 * 60 * 60 * 1000));
  const bucketSeconds = intervalSeconds(from, to);
  const fromSql = `toDateTime64('${clickhouseDateTime(from)}', 3, 'UTC')`;
  const toSql = `toDateTime64('${clickhouseDateTime(to)}', 3, 'UTC')`;
  return sql
    .replace(/\$__timeFilter\s*\(\s*([^)]+?)\s*\)/gi, (_match, column: string) => `${column.trim()} >= ${fromSql} AND ${column.trim()} <= ${toSql}`)
    .replace(
      /\$__timeInterval\s*\(\s*([^)]+?)\s*\)/gi,
      (_match, column: string) => `toStartOfInterval(${column.trim()}, INTERVAL ${bucketSeconds} SECOND)`,
    )
    .replace(/\$__fromTime\b/gi, fromSql)
    .replace(/\$__toTime\b/gi, toSql);
}

export function renderGrafanaPanelTestQuery(sql: string, variables: GrafanaPanelQueryTestVariables): string {
  const rendered = replaceTimeMacros(replaceVariables(stripComments(sql).trim(), variables), variables);
  if (/\$__|\$\{/.test(rendered)) {
    throw Object.assign(new Error('QL test contains unsupported Grafana variables or macros'), { statusCode: 400 });
  }
  return rendered;
}

export function validateGrafanaPanelQuery(sql: string, panelType: GrafanaPanelType, config: ClickHouseConfig): ValidatedGrafanaQuery {
  const normalizedSql = compact(stripComments(sql || ''));
  if (!normalizedSql) {
    throw Object.assign(new Error('querySql is required'), { statusCode: 400 });
  }
  if (normalizedSql.length > 10_000) {
    throw Object.assign(new Error('querySql is too long'), { statusCode: 400 });
  }
  if (normalizedSql.includes(';')) {
    throw Object.assign(new Error('Only one SELECT statement is allowed'), { statusCode: 400 });
  }

  const lowerSql = normalizedSql.toLowerCase();
  const masked = compact(maskStringLiterals(normalizedSql)).toLowerCase();
  if (!masked.startsWith('select ')) {
    throw Object.assign(new Error('Only SELECT queries are allowed'), { statusCode: 400 });
  }
  if (/\bselect\s+\*/i.test(masked) || /,\s*\*/.test(masked)) {
    throw Object.assign(new Error('SELECT * is not allowed'), { statusCode: 400 });
  }
  if (/\bformat\b/i.test(masked) || /\binto\s+outfile\b/i.test(masked)) {
    throw Object.assign(new Error('FORMAT and INTO OUTFILE are not allowed'), { statusCode: 400 });
  }
  for (const token of FORBIDDEN_TOKENS) {
    if (new RegExp(`\\b${token}\\b`, 'i').test(masked)) {
      throw Object.assign(new Error(`Forbidden SQL token: ${token}`), { statusCode: 400 });
    }
  }

  const tables = extractTables(masked, config.grafanaDatabase);
  if (tables.length === 0) {
    throw Object.assign(new Error('At least one Grafana mart table is required'), { statusCode: 400 });
  }
  const tableAllowlist = allowedTables(config);
  for (const table of tables) {
    if (!tableAllowlist.has(table)) {
      throw Object.assign(new Error(`Table is not allowed for custom panels: ${table}`), { statusCode: 400 });
    }
  }

  requirePattern(lowerSql, /\btenant_id\s*=\s*['"]\$\{tenant_id\}['"]/, "querySql must filter tenant_id = '${tenant_id}'");
  requirePattern(lowerSql, /\bproduct\s*=\s*['"]\$\{product\}['"]/, "querySql must filter product = '${product}'");
  requirePattern(lowerSql, /\$__timefilter\s*\(/, 'querySql must include $__timeFilter(...)');

  if (tables.includes('grafana_tag_metrics_1m') && /\btag_value\b/.test(masked)) {
    requirePattern(masked, /\btag_key\s*=/, 'Queries that use tag_value must filter tag_key');
  }
  if ((tables.includes('grafana_log_events') || tables.includes('grafana_tag_events')) && !/\blimit\s+\d+\b/.test(masked)) {
    throw Object.assign(new Error('Detail table queries must include LIMIT'), { statusCode: 400 });
  }
  if (panelType === 'timeseries') {
    requirePattern(masked, /\bas\s+time\b|\btime,|\btime\s+from\b/, 'Time series queries must return a time column');
  }

  return { sql: normalizedSql, tables };
}
