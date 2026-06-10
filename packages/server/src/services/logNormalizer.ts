import { randomUUID } from 'node:crypto';
import { BlobStore } from '../storage/blobStore.js';
import { sha256, stableErrorHash } from '../utils/hash.js';
import { redactString, sanitizeAttributes, sanitizeScalar } from '../utils/redaction.js';
import type { IncomingLogEvent, LogLevel, NormalizedLogRow } from '../types/log.js';

const LEVELS = new Set<LogLevel>(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const TAG_SEPARATOR = '\x1F';
const MAX_TAG_COUNT = 20;
const MAX_TAG_KEY_LENGTH = 64;
const MAX_TAG_VALUE_LENGTH = 256;
const MAX_TAGS_JSON_BYTES = 4096;
const TAG_KEY_PATTERN = /^[a-z0-9_.-]+$/;
const RESERVED_TAG_KEYS = new Set([
  'tenant_id',
  'product',
  'timestamp',
  'level',
  'topic',
  'environment',
  'user_identifier',
  'user_identifier_hash',
  'user_id',
  'user_id_hash',
  'device_id',
  'device_id_hash',
  'session_id',
  'conversation_id',
  'trace_id',
  'component',
  'version',
  'platform',
  'arch',
  'message',
  'error_hash',
  'stack_hash',
  'attributes',
  'tags',
]);

function normalizeLevel(raw: unknown): LogLevel {
  const level = typeof raw === 'string' ? raw.toLowerCase() : 'info';
  return LEVELS.has(level as LogLevel) ? (level as LogLevel) : 'info';
}

function normalizeTimestamp(raw: unknown): string {
  const date =
    typeof raw === 'number'
      ? new Date(raw)
      : typeof raw === 'string'
        ? new Date(raw)
        : new Date();

  const validDate = Number.isFinite(date.getTime()) ? date : new Date();
  return validDate.toISOString().replace('T', ' ').replace('Z', '');
}

function normalizeHash(rawHash: unknown, rawValue: unknown): string {
  if (typeof rawHash === 'string' && /^[a-f0-9]{64}$/.test(rawHash)) {
    return rawHash;
  }
  if (typeof rawValue === 'string' && rawValue.trim()) {
    return sha256(rawValue.trim());
  }
  return '';
}

function validationError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function normalizeTags(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw validationError('tags must be a flat object');
  }

  const entries = Object.entries(raw);
  if (entries.length > MAX_TAG_COUNT) {
    throw validationError(`tags must contain no more than ${MAX_TAG_COUNT} entries`);
  }

  const tags: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim().toLowerCase();
    if (!key) throw validationError('tag key must not be empty');
    if (key.length > MAX_TAG_KEY_LENGTH) throw validationError(`tag key must be <= ${MAX_TAG_KEY_LENGTH} characters`);
    if (!TAG_KEY_PATTERN.test(key)) throw validationError('tag key may contain only lowercase letters, numbers, underscore, dot, and dash');
    if (RESERVED_TAG_KEYS.has(key)) throw validationError(`tag key is reserved: ${key}`);
    if (Object.hasOwn(tags, key)) throw validationError(`duplicate tag key: ${key}`);
    if (rawValue === undefined || rawValue === null || typeof rawValue === 'object') {
      throw validationError(`tag value for ${key} must be a string, number, or boolean`);
    }

    const value = redactString(String(rawValue)).trim();
    if (!value) throw validationError(`tag value for ${key} must not be empty`);
    if (value.length > MAX_TAG_VALUE_LENGTH) {
      throw validationError(`tag value for ${key} must be <= ${MAX_TAG_VALUE_LENGTH} characters`);
    }
    tags[key] = value;
  }

  if (Buffer.byteLength(JSON.stringify(tags), 'utf8') > MAX_TAGS_JSON_BYTES) {
    throw validationError(`tags JSON must be <= ${MAX_TAGS_JSON_BYTES} bytes`);
  }

  return tags;
}

function tagsKv(tags: Record<string, string>): string[] {
  return Object.entries(tags)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${TAG_SEPARATOR}${value}`);
}

export async function normalizeLogEvent(
  input: IncomingLogEvent,
  blobStore: BlobStore,
  defaultTenantId: string,
): Promise<NormalizedLogRow> {
  const eventId = randomUUID();
  const level = normalizeLevel(input.level);
  const errorName = sanitizeScalar(input.error?.name ?? input.error_name);
  const errorMessage = sanitizeScalar(input.error?.message ?? input.error_message);
  const stackTrace = sanitizeScalar(input.error?.stack ?? input.stack_trace);
  const stackRef = stackTrace ? await blobStore.writeText('stacks', eventId, redactString(stackTrace)) : '';
  const stackHash = stackTrace ? sha256(redactString(stackTrace)) : '';
  const errorHash = errorName || errorMessage || stackTrace ? stableErrorHash(errorName, errorMessage, redactString(stackTrace)) : '';

  const attributes = sanitizeAttributes(input.attributes);
  const tags = normalizeTags(input.tags);
  const receivedAt = new Date().toISOString().replace('T', ' ').replace('Z', '');

  return {
    timestamp: normalizeTimestamp(input.timestamp),
    received_at: receivedAt,
    event_id: eventId,
    tenant_id: sanitizeScalar(input.tenant_id, defaultTenantId) || defaultTenantId,
    product: sanitizeScalar(input.product, 'sudowork') || 'sudowork',
    topic: sanitizeScalar(input.topic, level === 'error' || level === 'fatal' ? 'error' : 'app') || 'app',
    environment: sanitizeScalar(input.environment, 'production') || 'production',
    level,
    user_identifier_hash: normalizeHash(input.user_identifier_hash, input.user_identifier),
    user_id_hash: normalizeHash(input.user_id_hash, input.user_id),
    device_id_hash: normalizeHash(input.device_id_hash, input.device_id),
    session_id: sanitizeScalar(input.session_id),
    conversation_id: sanitizeScalar(input.conversation_id),
    trace_id: sanitizeScalar(input.trace_id),
    component: sanitizeScalar(input.component, 'unknown') || 'unknown',
    version: sanitizeScalar(input.version),
    platform: sanitizeScalar(input.platform),
    arch: sanitizeScalar(input.arch),
    message: sanitizeScalar(input.message),
    error_name: errorName,
    error_message: errorMessage,
    error_hash: errorHash,
    stack_hash: stackHash,
    stack_ref: stackRef,
    raw_ref: '',
    tags_json: JSON.stringify(tags),
    tags_kv: tagsKv(tags),
    attributes_json: JSON.stringify(attributes),
  };
}
