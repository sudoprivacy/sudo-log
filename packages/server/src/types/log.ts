export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface IncomingErrorDetail {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}

export interface IncomingLogEvent {
  timestamp?: unknown;
  level?: unknown;
  tenant_id?: unknown;
  product?: unknown;
  topic?: unknown;
  environment?: unknown;
  version?: unknown;
  platform?: unknown;
  arch?: unknown;
  login_mode?: unknown;
  user_identifier?: unknown;
  user_identifier_hash?: unknown;
  user_id?: unknown;
  user_id_hash?: unknown;
  device_id?: unknown;
  device_id_hash?: unknown;
  session_id?: unknown;
  conversation_id?: unknown;
  trace_id?: unknown;
  component?: unknown;
  message?: unknown;
  error?: IncomingErrorDetail;
  error_name?: unknown;
  error_message?: unknown;
  stack_trace?: unknown;
  tags?: unknown;
  attributes?: unknown;
}

export interface BatchRequest {
  logs?: unknown;
}

export interface NormalizedLogRow {
  timestamp: string;
  received_at: string;
  event_id: string;
  tenant_id: string;
  product: string;
  topic: string;
  environment: string;
  level: LogLevel;
  user_identifier_hash: string;
  user_id_hash: string;
  device_id_hash: string;
  session_id: string;
  conversation_id: string;
  trace_id: string;
  component: string;
  version: string;
  platform: string;
  arch: string;
  message: string;
  error_name: string;
  error_message: string;
  error_hash: string;
  stack_hash: string;
  stack_ref: string;
  raw_ref: string;
  tags_json: string;
  tags_kv: string[];
  attributes_json: string;
}

export interface NormalizedLogTagRow {
  timestamp: string;
  received_at: string;
  event_id: string;
  tenant_id: string;
  product: string;
  tag_key: string;
  tag_value: string;
  tag_kv: string;
  level: LogLevel;
  topic: string;
  environment: string;
  component: string;
  version: string;
  platform: string;
  arch: string;
  user_identifier_hash: string;
  user_id_hash: string;
  device_id_hash: string;
  session_id: string;
  conversation_id: string;
  trace_id: string;
  error_hash: string;
}

export interface SearchParams {
  tenantId: string;
  product?: string;
  level?: string;
  userIdentifierHash?: string;
  userIdHash?: string;
  component?: string;
  errorHash?: string;
  startTime: string;
  endTime: string;
  limit: number;
}
