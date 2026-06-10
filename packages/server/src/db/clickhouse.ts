import type { ClickHouseConfig } from '../config/appConfig.js';
import type { NormalizedLogRow, NormalizedLogTagRow } from '../types/log.js';

export interface TagFilter {
  key: string;
  value: string;
}

export type TagSearchMode = 'all' | 'any';

function assertIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function authHeader(config: ClickHouseConfig): string {
  return `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`;
}

async function request(config: ClickHouseConfig, sql: string, database?: string): Promise<string> {
  const url = new URL(config.url);
  if (database) url.searchParams.set('database', database);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: authHeader(config),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: sql,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ClickHouse request failed: ${response.status} ${text}`);
  }
  return text;
}

export function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function toMinute(value: string): string {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(date.getTime())) return value.slice(0, 16).replace('T', ' ') + ':00';
  date.setUTCSeconds(0, 0);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function toDate(value: string): string {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(date.getTime())) return value.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export class ClickHouseRepository {
  private readonly database: string;
  private readonly grafanaDatabase: string;

  public constructor(private readonly config: ClickHouseConfig) {
    this.database = assertIdentifier(config.database, 'CLICKHOUSE_DATABASE');
    this.grafanaDatabase = assertIdentifier(config.grafanaDatabase, 'GRAFANA_CLICKHOUSE_DATABASE');
  }

  public async initialize(): Promise<void> {
    await request(this.config, `CREATE DATABASE IF NOT EXISTS ${this.database}`);
    await request(this.config, `CREATE DATABASE IF NOT EXISTS ${this.grafanaDatabase}`);
    await request(this.config, this.createLogsTableSql('sudo_logs'));
    await request(this.config, this.createLogsTableSql('sudo_error_logs'));
    await request(this.config, this.createLogsTableSql('sudo_log_event_lookup', '(tenant_id, event_id)'));
    await request(this.config, this.createLogTagsTableSql());
    await request(this.config, this.createGrafanaLogEventsTableSql());
    await request(this.config, this.createGrafanaTagEventsTableSql());
    await request(this.config, this.createGrafanaLogMetricsTableSql());
    await request(this.config, this.createGrafanaTagMetricsTableSql());
    await request(this.config, this.createGrafanaTagKeysTableSql());
    await request(this.config, this.createGrafanaTagValuesTableSql());
    await this.ensureGrafanaReaderUser();
  }

  public async health(): Promise<boolean> {
    await request(this.config, 'SELECT 1');
    return true;
  }

  public async insertRows(rows: NormalizedLogRow[]): Promise<void> {
    if (rows.length === 0) return;

    await this.insertInto('sudo_logs', rows);
    await this.insertInto('sudo_log_event_lookup', rows);

    const errorRows = rows.filter((row) => row.level === 'error' || row.level === 'fatal');
    if (errorRows.length > 0) {
      await this.insertInto('sudo_error_logs', errorRows);
    }

    const tagRows = rows.flatMap((row) => this.toTagRows(row));
    if (tagRows.length > 0) {
      await this.insertTagRows(tagRows);
    }

    await this.insertGrafanaRows(rows, tagRows);
  }

  public async search(sqlWhere: string, limit: number, errorsOnly: boolean): Promise<unknown[]> {
    const table = errorsOnly ? 'sudo_error_logs' : 'sudo_logs';
    const sql = `
      SELECT
        timestamp,
        received_at,
        event_id,
        tenant_id,
        product,
        topic,
        environment,
        level,
        user_identifier_hash,
        user_id_hash,
        device_id_hash,
        session_id,
        conversation_id,
        trace_id,
        component,
        version,
        platform,
        arch,
        message,
        error_name,
        error_message,
        error_hash,
        stack_hash,
        stack_ref,
        raw_ref,
        tags_json,
        tags_kv,
        attributes_json
      FROM ${this.database}.${table}
      WHERE ${sqlWhere}
      ORDER BY timestamp DESC, event_id DESC
      LIMIT ${limit}
      FORMAT JSON
    `;
    return this.selectJson(sql);
  }

  public async searchByTags(
    sqlWhere: string,
    limit: number,
    errorsOnly: boolean,
    tags: TagFilter[],
    tagMode: TagSearchMode,
  ): Promise<unknown[]> {
    const table = errorsOnly ? 'sudo_error_logs' : 'sudo_log_event_lookup';
    const candidateLimit = Math.min(Math.max(limit * 20, limit), 10_000);
    const sql = `
      SELECT
        timestamp,
        received_at,
        event_id,
        tenant_id,
        product,
        topic,
        environment,
        level,
        user_identifier_hash,
        user_id_hash,
        device_id_hash,
        session_id,
        conversation_id,
        trace_id,
        component,
        version,
        platform,
        arch,
        message,
        error_name,
        error_message,
        error_hash,
        stack_hash,
        stack_ref,
        raw_ref,
        tags_json,
        tags_kv,
        attributes_json
      FROM ${this.database}.${table}
      WHERE ${sqlWhere}
        AND event_id IN (
          ${this.tagCandidateSubquery(sqlWhere, tags, tagMode, candidateLimit)}
        )
      ORDER BY timestamp DESC, event_id DESC
      LIMIT ${limit}
      FORMAT JSON
    `;
    return this.selectJson(sql);
  }

  public async findEvent(tenantId: string, eventId: string): Promise<unknown | null> {
    const sql = `
      SELECT *
      FROM ${this.database}.sudo_log_event_lookup
      WHERE tenant_id = ${sqlString(tenantId)}
        AND event_id = ${sqlString(eventId)}
      LIMIT 1
      FORMAT JSON
    `;
    const rows = await this.selectJson(sql);
    return rows[0] ?? null;
  }

  public async errorSummary(sqlWhere: string, limit: number): Promise<unknown[]> {
    const sql = `
      SELECT
        error_hash,
        any(error_name) AS error_name,
        any(error_message) AS error_message,
        any(component) AS component,
        any(version) AS version,
        count() AS occurrences,
        min(timestamp) AS first_seen,
        max(timestamp) AS last_seen
      FROM ${this.database}.sudo_error_logs
      WHERE ${sqlWhere}
        AND error_hash != ''
      GROUP BY error_hash
      ORDER BY last_seen DESC
      LIMIT ${limit}
      FORMAT JSON
    `;
    return this.selectJson(sql);
  }

  public async errorSummaryByTags(sqlWhere: string, limit: number, tags: TagFilter[], tagMode: TagSearchMode): Promise<unknown[]> {
    const sql = `
      SELECT
        error_hash,
        any(error_name) AS error_name,
        any(error_message) AS error_message,
        any(component) AS component,
        any(version) AS version,
        count() AS occurrences,
        min(timestamp) AS first_seen,
        max(timestamp) AS last_seen
      FROM ${this.database}.sudo_error_logs
      WHERE ${sqlWhere}
        AND error_hash != ''
        AND event_id IN (
          ${this.tagCandidateSubquery(sqlWhere, tags, tagMode)}
        )
      GROUP BY error_hash
      ORDER BY last_seen DESC
      LIMIT ${limit}
      FORMAT JSON
    `;
    return this.selectJson(sql);
  }

  public async grafanaTagKeys(tenantId: string, product: string, limit = 100): Promise<string[]> {
    const sql = `
      SELECT tag_key
      FROM ${this.grafanaDatabase}.grafana_tag_keys_1d
      WHERE tenant_id = ${sqlString(tenantId)}
        AND product = ${sqlString(product)}
        AND day >= toDate(now() - INTERVAL 30 DAY)
      GROUP BY tag_key
      ORDER BY sum(events) DESC
      LIMIT ${limit}
      FORMAT JSON
    `;
    const rows = (await this.selectJson(sql)) as Array<{ tag_key?: string }>;
    return rows.map((row) => row.tag_key || '').filter(Boolean);
  }

  public async grafanaTagValues(tenantId: string, product: string, tagKey: string, limit = 100): Promise<string[]> {
    if (!tagKey) return [];
    const sql = `
      SELECT tag_value
      FROM ${this.grafanaDatabase}.grafana_tag_values_1d
      WHERE tenant_id = ${sqlString(tenantId)}
        AND product = ${sqlString(product)}
        AND tag_key = ${sqlString(tagKey)}
        AND day >= toDate(now() - INTERVAL 30 DAY)
      GROUP BY tag_value
      ORDER BY sum(events) DESC
      LIMIT ${limit}
      FORMAT JSON
    `;
    const rows = (await this.selectJson(sql)) as Array<{ tag_value?: string }>;
    return rows.map((row) => row.tag_value || '').filter(Boolean);
  }

  public async grafanaQueryPreview(sql: string, limit = 20): Promise<unknown[]> {
    const safeLimit = Math.max(1, Math.min(Math.round(limit), 100));
    return this.selectJson(
      `
      SELECT *
      FROM (
        ${sql}
      )
      LIMIT ${safeLimit}
      FORMAT JSON
    `,
      this.grafanaDatabase,
    );
  }

  private async selectJson(sql: string, database?: string): Promise<unknown[]> {
    const text = await request(this.config, sql, database);
    const parsed = JSON.parse(text) as { data?: unknown[] };
    return parsed.data ?? [];
  }

  private async insertInto(table: string, rows: NormalizedLogRow[]): Promise<void> {
    await this.insertJsonEachRow(table, rows);
  }

  private async insertTagRows(rows: NormalizedLogTagRow[]): Promise<void> {
    await this.insertJsonEachRow('sudo_log_tags', rows);
  }

  private async insertGrafanaRows(rows: NormalizedLogRow[], tagRows: NormalizedLogTagRow[]): Promise<void> {
    if (this.config.grafanaDetailEventsEnabled) {
      await this.insertJsonEachRow('grafana_log_events', rows.map((row) => this.toGrafanaLogEvent(row)), this.grafanaDatabase);
    }
    if (tagRows.length > 0) {
      if (this.config.grafanaDetailEventsEnabled) {
        await this.insertJsonEachRow('grafana_tag_events', tagRows, this.grafanaDatabase);
      }
      await this.insertJsonEachRow('grafana_tag_metrics_1m', tagRows.map((row) => this.toGrafanaTagMetric(row)), this.grafanaDatabase);
      await this.insertJsonEachRow('grafana_tag_keys_1d', tagRows.map((row) => this.toGrafanaTagKey(row)), this.grafanaDatabase);
      await this.insertJsonEachRow('grafana_tag_values_1d', tagRows.map((row) => this.toGrafanaTagValue(row)), this.grafanaDatabase);
    }
    await this.insertJsonEachRow('grafana_log_metrics_1m', rows.map((row) => this.toGrafanaLogMetric(row)), this.grafanaDatabase);
  }

  private async insertJsonEachRow<T extends object>(table: string, rows: T[], database = this.database): Promise<void> {
    if (rows.length === 0) return;
    const payload = rows.map((row) => JSON.stringify(row)).join('\n');
    await request(this.config, `INSERT INTO ${database}.${table} FORMAT JSONEachRow\n${payload}`);
  }

  private toTagRows(row: NormalizedLogRow): NormalizedLogTagRow[] {
    const tags = JSON.parse(row.tags_json) as Record<string, string>;
    return Object.entries(tags).map(([tagKey, tagValue]) => ({
      timestamp: row.timestamp,
      received_at: row.received_at,
      event_id: row.event_id,
      tenant_id: row.tenant_id,
      product: row.product,
      tag_key: tagKey,
      tag_value: tagValue,
      tag_kv: `${tagKey}\x1F${tagValue}`,
      level: row.level,
      topic: row.topic,
      environment: row.environment,
      component: row.component,
      version: row.version,
      platform: row.platform,
      arch: row.arch,
      user_identifier_hash: row.user_identifier_hash,
      user_id_hash: row.user_id_hash,
      device_id_hash: row.device_id_hash,
      session_id: row.session_id,
      conversation_id: row.conversation_id,
      trace_id: row.trace_id,
      error_hash: row.error_hash,
    }));
  }

  private toGrafanaLogEvent(row: NormalizedLogRow): object {
    return {
      timestamp: row.timestamp,
      received_at: row.received_at,
      event_id: row.event_id,
      tenant_id: row.tenant_id,
      product: row.product,
      topic: row.topic,
      environment: row.environment,
      level: row.level,
      component: row.component,
      version: row.version,
      platform: row.platform,
      arch: row.arch,
      user_identifier_hash: row.user_identifier_hash,
      user_id_hash: row.user_id_hash,
      device_id_hash: row.device_id_hash,
      session_id: row.session_id,
      conversation_id: row.conversation_id,
      trace_id: row.trace_id,
      message: row.message,
      error_name: row.error_name,
      error_message: row.error_message,
      error_hash: row.error_hash,
      tags_json: row.tags_json,
      tags_kv: row.tags_kv,
    };
  }

  private toGrafanaLogMetric(row: NormalizedLogRow): object {
    return {
      interval_start: toMinute(row.timestamp),
      tenant_id: row.tenant_id,
      product: row.product,
      topic: row.topic,
      environment: row.environment,
      level: row.level,
      component: row.component,
      version: row.version,
      platform: row.platform,
      arch: row.arch,
      events: 1,
      errors: row.level === 'error' ? 1 : 0,
      fatals: row.level === 'fatal' ? 1 : 0,
    };
  }

  private toGrafanaTagMetric(row: NormalizedLogTagRow): object {
    return {
      interval_start: toMinute(row.timestamp),
      tenant_id: row.tenant_id,
      product: row.product,
      tag_key: row.tag_key,
      tag_value: row.tag_value,
      topic: row.topic,
      environment: row.environment,
      level: row.level,
      component: row.component,
      version: row.version,
      platform: row.platform,
      arch: row.arch,
      events: 1,
      errors: row.level === 'error' ? 1 : 0,
      fatals: row.level === 'fatal' ? 1 : 0,
    };
  }

  private toGrafanaTagKey(row: NormalizedLogTagRow): object {
    return {
      day: toDate(row.timestamp),
      tenant_id: row.tenant_id,
      product: row.product,
      tag_key: row.tag_key,
      events: 1,
    };
  }

  private toGrafanaTagValue(row: NormalizedLogTagRow): object {
    return {
      day: toDate(row.timestamp),
      tenant_id: row.tenant_id,
      product: row.product,
      tag_key: row.tag_key,
      tag_value: row.tag_value,
      events: 1,
    };
  }

  private tagCandidateSubquery(sqlWhere: string, tags: TagFilter[], tagMode: TagSearchMode, limit?: number): string {
    const tagPredicate = tags
      .map(
        (tag) => `(
          tag_key = ${sqlString(tag.key)}
          AND tag_kv_hash = cityHash64(${sqlString(tag.key)}, ${sqlString(tag.value)})
          AND tag_value = ${sqlString(tag.value)}
        )`,
      )
      .join('\n          OR ');
    const having = tagMode === 'all' ? `HAVING countDistinct(tag_kv) = ${tags.length}` : '';
    const orderAndLimit = limit ? `ORDER BY last_timestamp DESC, event_id DESC\n          LIMIT ${limit}` : '';
    return `
          SELECT event_id
          FROM (
            SELECT
              event_id,
              max(timestamp) AS last_timestamp
            FROM ${this.database}.sudo_log_tags
            WHERE ${sqlWhere}
              AND (
                ${tagPredicate}
              )
            GROUP BY event_id
            ${having}
            ${orderAndLimit}
          )`;
  }

  private createLogsTableSql(
    table: string,
    orderBy = '(tenant_id, product, level, user_identifier_hash, user_id_hash, timestamp, component, error_hash)',
  ): string {
    return `
      CREATE TABLE IF NOT EXISTS ${this.database}.${table}
      (
        timestamp DateTime64(3, 'UTC'),
        received_at DateTime64(3, 'UTC') DEFAULT now64(3),
        event_id String,
        tenant_id LowCardinality(String),
        product LowCardinality(String),
        topic LowCardinality(String),
        environment LowCardinality(String),
        level LowCardinality(String),
        user_identifier_hash String,
        user_id_hash String,
        device_id_hash String,
        session_id String,
        conversation_id String,
        trace_id String,
        component LowCardinality(String),
        version LowCardinality(String),
        platform LowCardinality(String),
        arch LowCardinality(String),
        message String,
        error_name LowCardinality(String),
        error_message String,
        error_hash String,
        stack_hash String,
        stack_ref String,
        raw_ref String,
        tags_json String,
        tags_kv Array(String),
        attributes_json String,
        created_at DateTime64(3, 'UTC') DEFAULT now64(3),
        INDEX idx_tags_kv tags_kv TYPE bloom_filter(0.01) GRANULARITY 4
      )
      ENGINE = MergeTree
      PARTITION BY toDate(timestamp)
      ORDER BY ${orderBy}
      TTL toDateTime(timestamp) + INTERVAL 30 DAY
    `;
  }

  private createLogTagsTableSql(): string {
    return `
      CREATE TABLE IF NOT EXISTS ${this.database}.sudo_log_tags
      (
        timestamp DateTime64(3, 'UTC'),
        received_at DateTime64(3, 'UTC') DEFAULT now64(3),
        event_id String,
        tenant_id LowCardinality(String),
        product LowCardinality(String),
        tag_key LowCardinality(String),
        tag_value String,
        tag_kv String,
        tag_kv_hash UInt64 MATERIALIZED cityHash64(tag_key, tag_value),
        level LowCardinality(String),
        topic LowCardinality(String),
        environment LowCardinality(String),
        component LowCardinality(String),
        version LowCardinality(String),
        platform LowCardinality(String),
        arch LowCardinality(String),
        user_identifier_hash String,
        user_id_hash String,
        device_id_hash String,
        session_id String,
        conversation_id String,
        trace_id String,
        error_hash String
      )
      ENGINE = MergeTree
      PARTITION BY toDate(timestamp)
      ORDER BY (tenant_id, product, tag_key, tag_kv_hash, timestamp, event_id)
      TTL toDateTime(timestamp) + INTERVAL 30 DAY
    `;
  }

  private createGrafanaLogEventsTableSql(): string {
    return `
      CREATE TABLE IF NOT EXISTS ${this.grafanaDatabase}.grafana_log_events
      (
        timestamp DateTime64(3, 'UTC'),
        received_at DateTime64(3, 'UTC'),
        event_id String,
        tenant_id LowCardinality(String),
        product LowCardinality(String),
        topic LowCardinality(String),
        environment LowCardinality(String),
        level LowCardinality(String),
        component LowCardinality(String),
        version LowCardinality(String),
        platform LowCardinality(String),
        arch LowCardinality(String),
        user_identifier_hash String,
        user_id_hash String,
        device_id_hash String,
        session_id String,
        conversation_id String,
        trace_id String,
        message String,
        error_name LowCardinality(String),
        error_message String,
        error_hash String,
        tags_json String,
        tags_kv Array(String)
      )
      ENGINE = MergeTree
      PARTITION BY toDate(timestamp)
      ORDER BY (tenant_id, product, timestamp, level, event_id)
      TTL toDateTime(timestamp) + INTERVAL ${this.config.grafanaDetailTtlDays} DAY
    `;
  }

  private createGrafanaTagEventsTableSql(): string {
    return `
      CREATE TABLE IF NOT EXISTS ${this.grafanaDatabase}.grafana_tag_events
      (
        timestamp DateTime64(3, 'UTC'),
        received_at DateTime64(3, 'UTC'),
        event_id String,
        tenant_id LowCardinality(String),
        product LowCardinality(String),
        tag_key LowCardinality(String),
        tag_value String,
        tag_kv String,
        tag_kv_hash UInt64 MATERIALIZED cityHash64(tag_key, tag_value),
        level LowCardinality(String),
        topic LowCardinality(String),
        environment LowCardinality(String),
        component LowCardinality(String),
        version LowCardinality(String),
        platform LowCardinality(String),
        arch LowCardinality(String),
        user_identifier_hash String,
        user_id_hash String,
        device_id_hash String,
        session_id String,
        conversation_id String,
        trace_id String,
        error_hash String
      )
      ENGINE = MergeTree
      PARTITION BY toDate(timestamp)
      ORDER BY (tenant_id, product, tag_key, tag_kv_hash, timestamp, event_id)
      TTL toDateTime(timestamp) + INTERVAL ${this.config.grafanaDetailTtlDays} DAY
    `;
  }

  private createGrafanaLogMetricsTableSql(): string {
    return `
      CREATE TABLE IF NOT EXISTS ${this.grafanaDatabase}.grafana_log_metrics_1m
      (
        interval_start DateTime('UTC'),
        tenant_id LowCardinality(String),
        product LowCardinality(String),
        topic LowCardinality(String),
        environment LowCardinality(String),
        level LowCardinality(String),
        component LowCardinality(String),
        version LowCardinality(String),
        platform LowCardinality(String),
        arch LowCardinality(String),
        events UInt64,
        errors UInt64,
        fatals UInt64
      )
      ENGINE = SummingMergeTree
      PARTITION BY toDate(interval_start)
      ORDER BY (tenant_id, product, interval_start, level, topic, environment, component, version, platform, arch)
      TTL interval_start + INTERVAL ${this.config.grafanaMetricsTtlDays} DAY
    `;
  }

  private createGrafanaTagMetricsTableSql(): string {
    return `
      CREATE TABLE IF NOT EXISTS ${this.grafanaDatabase}.grafana_tag_metrics_1m
      (
        interval_start DateTime('UTC'),
        tenant_id LowCardinality(String),
        product LowCardinality(String),
        tag_key LowCardinality(String),
        tag_value String,
        tag_kv_hash UInt64 MATERIALIZED cityHash64(tag_key, tag_value),
        topic LowCardinality(String),
        environment LowCardinality(String),
        level LowCardinality(String),
        component LowCardinality(String),
        version LowCardinality(String),
        platform LowCardinality(String),
        arch LowCardinality(String),
        events UInt64,
        errors UInt64,
        fatals UInt64
      )
      ENGINE = SummingMergeTree
      PARTITION BY toDate(interval_start)
      ORDER BY (tenant_id, product, tag_key, tag_kv_hash, interval_start, level, topic, environment, component, version, platform, arch)
      TTL interval_start + INTERVAL ${this.config.grafanaMetricsTtlDays} DAY
    `;
  }

  private createGrafanaTagKeysTableSql(): string {
    return `
      CREATE TABLE IF NOT EXISTS ${this.grafanaDatabase}.grafana_tag_keys_1d
      (
        day Date,
        tenant_id LowCardinality(String),
        product LowCardinality(String),
        tag_key LowCardinality(String),
        events UInt64
      )
      ENGINE = SummingMergeTree
      PARTITION BY day
      ORDER BY (tenant_id, product, day, tag_key)
      TTL day + INTERVAL ${this.config.grafanaMetricsTtlDays} DAY
    `;
  }

  private createGrafanaTagValuesTableSql(): string {
    return `
      CREATE TABLE IF NOT EXISTS ${this.grafanaDatabase}.grafana_tag_values_1d
      (
        day Date,
        tenant_id LowCardinality(String),
        product LowCardinality(String),
        tag_key LowCardinality(String),
        tag_value String,
        tag_kv_hash UInt64 MATERIALIZED cityHash64(tag_key, tag_value),
        events UInt64
      )
      ENGINE = SummingMergeTree
      PARTITION BY day
      ORDER BY (tenant_id, product, tag_key, day, tag_kv_hash)
      TTL day + INTERVAL ${this.config.grafanaMetricsTtlDays} DAY
    `;
  }

  private async ensureGrafanaReaderUser(): Promise<void> {
    const user = assertIdentifier(this.config.grafanaReaderUser, 'GRAFANA_CLICKHOUSE_USER');
    const role = assertIdentifier(`${user}_role`, 'GRAFANA_CLICKHOUSE_USER role');
    try {
      await request(this.config, `CREATE ROLE IF NOT EXISTS ${role}`);
      await request(this.config, `GRANT SELECT ON ${this.grafanaDatabase}.* TO ${role}`);
      await request(
        this.config,
        `CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY ${sqlString(this.config.grafanaReaderPassword)}
         SETTINGS readonly = 2, max_execution_time = 15, max_result_rows = 100000, max_memory_usage = 536870912, result_overflow_mode = 'break'`,
      );
      await request(
        this.config,
        `ALTER USER ${user} IDENTIFIED BY ${sqlString(this.config.grafanaReaderPassword)}
         SETTINGS readonly = 2, max_execution_time = 15, max_result_rows = 100000, max_memory_usage = 536870912, result_overflow_mode = 'break'`,
      );
      await request(this.config, `GRANT ${role} TO ${user}`);
      await request(this.config, `SET DEFAULT ROLE ${role} TO ${user}`);
    } catch (error) {
      console.warn('sudo-log could not ensure Grafana ClickHouse reader user', error);
    }
  }
}
