export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogErrorDetail {
  name?: string;
  message?: string;
  stack?: string;
}

export interface LogEvent {
  timestamp?: string | number | Date;
  tenant_id?: string;
  product?: string;
  topic?: string;
  environment?: string;
  level?: LogLevel;
  component?: string;
  version?: string;
  platform?: string;
  arch?: string;
  login_mode?: string;
  user_identifier?: string;
  user_identifier_hash?: string;
  user_id?: string;
  user_id_hash?: string;
  device_id?: string;
  device_id_hash?: string;
  session_id?: string;
  conversation_id?: string;
  trace_id?: string;
  message?: string;
  error?: LogErrorDetail;
  error_name?: string;
  error_message?: string;
  stack_trace?: string;
  tags?: Record<string, string | number | boolean>;
  attributes?: Record<string, unknown>;
}

export interface BatchResponse {
  success: boolean;
  accepted?: boolean;
  received?: number;
  event_ids?: string[];
  [key: string]: unknown;
}

export interface SudoworkLogClientOptions {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  product: string;
  environment?: string;
  apiKeyHeader?: string;
  timeoutMs?: number;
  maxRetries?: number;
  defaultTags?: Record<string, string | number | boolean>;
  defaultAttributes?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
}

export class SudoworkLogError extends Error {
  status: number;
  response: Response | null;
  body: unknown;
  cause: unknown;
}

export class SudoworkLogClient {
  constructor(options: SudoworkLogClientOptions);
  endpoint(): string;
  withDefaults(log: LogEvent): LogEvent;
  sendBatch(logs: LogEvent[], options?: RequestOptions): Promise<BatchResponse>;
  log(log: LogEvent, options?: RequestOptions): Promise<BatchResponse>;
}

export default SudoworkLogClient;
