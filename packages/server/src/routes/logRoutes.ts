import type { IncomingMessage, ServerResponse } from 'node:http';
import { ClickHouseRepository, sqlString, type TagFilter, type TagSearchMode } from '../db/clickhouse.js';
import type { AppConfig } from '../config/appConfig.js';
import { readJsonBody, sendJson } from '../http/http.js';
import { LogQueueService } from '../services/logQueueService.js';
import { normalizeLogEvent } from '../services/logNormalizer.js';
import { SettingsStore } from '../services/settingsStore.js';
import { BlobStore } from '../storage/blobStore.js';
import type { BatchRequest, IncomingLogEvent } from '../types/log.js';
import { sha256 } from '../utils/hash.js';

const TAG_KEY_PATTERN = /^[a-z0-9_.-]+$/;
const MAX_TAG_QUERY_COUNT = 5;
const MAX_TAG_KEY_LENGTH = 64;
const MAX_TAG_VALUE_LENGTH = 256;
const MAX_TAG_SEARCH_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

function requireTimeRange(searchParams: URLSearchParams): { start: string; end: string } {
  const start = searchParams.get('start_time');
  const end = searchParams.get('end_time');
  if (!start || !end) {
    throw Object.assign(new Error('start_time and end_time are required'), { statusCode: 400 });
  }
  if (!Number.isFinite(new Date(start).getTime()) || !Number.isFinite(new Date(end).getTime())) {
    throw Object.assign(new Error('start_time and end_time must be valid ISO timestamps'), { statusCode: 400 });
  }
  return { start, end };
}

function toClickHouseTime(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').replace('Z', '');
}

function parseLimit(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function isErrorLevel(value: unknown): boolean {
  return typeof value === 'string' && ['error', 'fatal'].includes(value.toLowerCase());
}

function hasErrorStack(value: IncomingLogEvent): boolean {
  const stack = value.error?.stack ?? value.stack_trace;
  return typeof stack === 'string' && stack.trim().length > 0;
}

function validateIncomingLogEvent(value: IncomingLogEvent): void {
  if (isErrorLevel(value.level) && !hasErrorStack(value)) {
    throw Object.assign(new Error('error.stack or stack_trace is required when level is error or fatal'), {
      statusCode: 400,
    });
  }
  const userIdentifier = typeof value.user_identifier === 'string' ? value.user_identifier.trim() : '';
  const userIdentifierHash = typeof value.user_identifier_hash === 'string' ? value.user_identifier_hash.trim() : '';
  if (!userIdentifier && !/^[a-f0-9]{64}$/.test(userIdentifierHash)) {
    throw Object.assign(new Error('user_identifier or user_identifier_hash is required'), { statusCode: 400 });
  }
}

function toIncomingLogEvent(value: unknown): IncomingLogEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('each log must be an object'), { statusCode: 400 });
  }
  return value as IncomingLogEvent;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${label} is required`), { statusCode: 400 });
  }
  return value.trim();
}

function parseTagMode(value: string | null): TagSearchMode {
  if (!value) return 'all';
  const normalized = value.toLowerCase();
  if (normalized === 'all' || normalized === 'any') return normalized;
  throw badRequest('tag_mode must be all or any');
}

function parseTagFilters(searchParams: URLSearchParams): TagFilter[] {
  const rawTags = searchParams
    .getAll('tag')
    .flatMap((value) => value.split(/[\n,]+/))
    .map((value) => value.trim())
    .filter(Boolean);

  if (rawTags.length === 0) return [];
  if (rawTags.length > MAX_TAG_QUERY_COUNT) {
    throw badRequest(`tag query supports at most ${MAX_TAG_QUERY_COUNT} tags`);
  }

  const seen = new Set<string>();
  return rawTags.map((rawTag) => {
    const separatorIndex = rawTag.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex === rawTag.length - 1) {
      throw badRequest('tag must use key:value format');
    }

    const key = rawTag.slice(0, separatorIndex).trim().toLowerCase();
    const value = rawTag.slice(separatorIndex + 1).trim();
    if (!key || !value) throw badRequest('tag key and value must not be empty');
    if (key.length > MAX_TAG_KEY_LENGTH) throw badRequest(`tag key must be <= ${MAX_TAG_KEY_LENGTH} characters`);
    if (value.length > MAX_TAG_VALUE_LENGTH) throw badRequest(`tag value must be <= ${MAX_TAG_VALUE_LENGTH} characters`);
    if (!TAG_KEY_PATTERN.test(key)) throw badRequest('tag key may contain only lowercase letters, numbers, underscore, dot, and dash');

    const fingerprint = `${key}\x1F${value}`;
    if (seen.has(fingerprint)) throw badRequest(`duplicate tag query: ${rawTag}`);
    seen.add(fingerprint);
    return { key, value };
  });
}

function headerValue(request: IncomingMessage, headerName: string): string {
  const value = request.headers[headerName.toLowerCase()];
  if (Array.isArray(value)) return value[0]?.trim() || '';
  return value?.trim() || '';
}

function buildWhere(searchParams: URLSearchParams): { where: string; errorsOnly: boolean; tags: TagFilter[]; tagMode: TagSearchMode } {
  const { start, end } = requireTimeRange(searchParams);
  const tags = parseTagFilters(searchParams);
  if (tags.length > 0) {
    if (!searchParams.get('tenant_id')?.trim()) throw badRequest('tenant_id is required for tag search');
    if (!searchParams.get('product')?.trim()) throw badRequest('product is required for tag search');
    if (new Date(end).getTime() - new Date(start).getTime() > MAX_TAG_SEARCH_RANGE_MS) {
      throw badRequest('tag search time range must be <= 7 days');
    }
  }

  const clauses = [
    `timestamp >= toDateTime64(${sqlString(toClickHouseTime(start))}, 3, 'UTC')`,
    `timestamp < toDateTime64(${sqlString(toClickHouseTime(end))}, 3, 'UTC')`,
  ];

  const tenantId = searchParams.get('tenant_id') ?? 'sudo';
  clauses.push(`tenant_id = ${sqlString(tenantId)}`);

  const fields: Array<[string, string]> = [
    ['product', 'product'],
    ['topic', 'topic'],
    ['environment', 'environment'],
    ['level', 'level'],
    ['component', 'component'],
    ['version', 'version'],
    ['error_hash', 'error_hash'],
    ['session_id', 'session_id'],
    ['trace_id', 'trace_id'],
  ];

  const rawUserIdentifier = searchParams.get('user_identifier')?.trim();
  if (rawUserIdentifier) {
    clauses.push(`user_identifier_hash = ${sqlString(sha256(rawUserIdentifier))}`);
  } else {
    const userIdentifierHash = searchParams.get('user_identifier_hash')?.trim();
    if (userIdentifierHash) clauses.push(`user_identifier_hash = ${sqlString(userIdentifierHash)}`);
  }

  const rawUserId = searchParams.get('user_id')?.trim();
  if (rawUserId) {
    clauses.push(`user_id_hash = ${sqlString(sha256(rawUserId))}`);
  } else {
    const userIdHash = searchParams.get('user_id_hash')?.trim();
    if (userIdHash) clauses.push(`user_id_hash = ${sqlString(userIdHash)}`);
  }

  for (const [queryName, fieldName] of fields) {
    const value = searchParams.get(queryName);
    if (value) clauses.push(`${fieldName} = ${sqlString(value)}`);
  }

  const cursorTimestamp = searchParams.get('cursor_timestamp')?.trim();
  const cursorEventId = searchParams.get('cursor_event_id')?.trim();
  if (cursorTimestamp || cursorEventId) {
    if (!cursorTimestamp || !cursorEventId) {
      throw badRequest('cursor_timestamp and cursor_event_id must be provided together');
    }
    if (!Number.isFinite(new Date(cursorTimestamp).getTime())) {
      throw badRequest('cursor_timestamp must be a valid ISO timestamp');
    }
    clauses.push(`(
      timestamp < toDateTime64(${sqlString(toClickHouseTime(cursorTimestamp))}, 3, 'UTC')
      OR (
        timestamp = toDateTime64(${sqlString(toClickHouseTime(cursorTimestamp))}, 3, 'UTC')
        AND event_id < ${sqlString(cursorEventId)}
      )
    )`);
  }

  const level = searchParams.get('level')?.toLowerCase();
  const errorsOnly = level === 'error' || level === 'fatal' || searchParams.get('topic') === 'error';

  return {
    where: clauses.join('\n        AND '),
    errorsOnly,
    tags,
    tagMode: parseTagMode(searchParams.get('tag_mode')),
  };
}

export class Routes {
  public constructor(
    private readonly config: AppConfig,
    private readonly repository: ClickHouseRepository,
    private readonly blobStore: BlobStore,
    private readonly queue: LogQueueService,
    private readonly settings: SettingsStore,
  ) {}

  public async ingest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody<BatchRequest>(request, this.config.maxBodyBytes);
    if (!Array.isArray(body.logs)) {
      throw Object.assign(new Error('logs must be an array'), { statusCode: 400 });
    }
    const receivedCount = body.logs.length;
    console.info(`sudo-log ingest received ${receivedCount} log${receivedCount === 1 ? '' : 's'}`);
    if (receivedCount > 50) {
      throw Object.assign(new Error('batch size must be <= 50'), { statusCode: 400 });
    }

    const logs = body.logs.map(toIncomingLogEvent);
    for (const log of logs) {
      validateIncomingLogEvent(log);
      const tenantId = requiredString(log.tenant_id, 'tenant_id').toLowerCase();
      const product = requiredString(log.product, 'product').toLowerCase();
      await this.settings.validateIngest(headerValue(request, this.config.apiKeyHeader), tenantId, product);
      log.tenant_id = tenantId;
      log.product = product;
    }

    const rows = await Promise.all(logs.map((item) => normalizeLogEvent(item, this.blobStore, '')));

    await this.queue.enqueue(rows);
    sendJson(response, 200, {
      success: true,
      accepted: true,
      received: rows.length,
      event_ids: rows.map((row) => row.event_id),
    });
  }

  public async search(url: URL, response: ServerResponse): Promise<void> {
    const limit = parseLimit(url.searchParams.get('limit'), 100, 500);
    const { where, errorsOnly, tags, tagMode } = buildWhere(url.searchParams);
    const rows =
      tags.length > 0
        ? await this.repository.searchByTags(where, limit, errorsOnly, tags, tagMode)
        : await this.repository.search(where, limit, errorsOnly);
    sendJson(response, 200, { success: true, data: rows });
  }

  public async eventDetail(url: URL, response: ServerResponse): Promise<void> {
    const eventId = url.pathname.split('/').pop() ?? '';
    const tenantId = url.searchParams.get('tenant_id') ?? 'sudo';
    if (!eventId) {
      throw Object.assign(new Error('event_id is required'), { statusCode: 400 });
    }
    const row = await this.repository.findEvent(tenantId, eventId);
    if (!row) {
      throw Object.assign(new Error('event not found'), { statusCode: 404 });
    }
    sendJson(response, 200, { success: true, data: row });
  }

  public async errorSummary(url: URL, response: ServerResponse): Promise<void> {
    const limit = parseLimit(url.searchParams.get('limit'), 50, 200);
    const { where, tags, tagMode } = buildWhere(url.searchParams);
    const rows =
      tags.length > 0
        ? await this.repository.errorSummaryByTags(where, limit, tags, tagMode)
        : await this.repository.errorSummary(where, limit);
    sendJson(response, 200, { success: true, data: rows });
  }

  public async blob(url: URL, response: ServerResponse): Promise<void> {
    const ref = url.searchParams.get('ref');
    if (!ref) {
      throw Object.assign(new Error('ref is required'), { statusCode: 400 });
    }

    const content = await this.blobStore.readText(ref);
    sendJson(response, 200, {
      success: true,
      data: {
        ref,
        content,
      },
    });
  }
}
