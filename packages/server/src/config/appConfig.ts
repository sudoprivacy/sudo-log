export interface ClickHouseConfig {
  url: string;
  database: string;
  grafanaDatabase: string;
  grafanaReaderUser: string;
  grafanaReaderPassword: string;
  grafanaDetailEventsEnabled: boolean;
  grafanaDetailTtlDays: number;
  grafanaMetricsTtlDays: number;
  user: string;
  password: string;
}

export interface RedisConfig {
  url: string;
  keyPrefix: string;
}

export interface PostgresConfig {
  url: string;
}

export interface AuthConfig {
  jwtSecret: string;
  jwtIssuer: string;
  accessTokenTtlSeconds: number;
  adminUsername: string;
  adminEmail: string;
  adminPassword: string;
  adminPasswordHash: string;
}

export interface GrafanaConfig {
  enabled: boolean;
  publicBasePath: string;
  internalUrl: string;
  datasourceUid: string;
  apiUser: string;
  apiPassword: string;
  publishEnabled: boolean;
  orgId: string;
  authProxyHeader: string;
  defaultTagKey: string;
  defaultTagValue: string;
}

export interface AppConfig {
  port: number;
  adminStaticDir: string;
  apiKeyHeader: string;
  defaultApiKey: string;
  queue: QueueConfig;
  clickhouse: ClickHouseConfig;
  redis: RedisConfig;
  postgres: PostgresConfig;
  auth: AuthConfig;
  grafana: GrafanaConfig;
  blobDir: string;
  maxBodyBytes: number;
}

export interface QueueConfig {
  name: string;
  batchSize: number;
  pollIntervalMs: number;
  retryDelayMs: number;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readPositiveInt(name: string, fallback: number): number {
  return Math.max(1, readInt(name, fallback));
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function loadConfig(): AppConfig {
  const clickhouseDatabase = process.env.CLICKHOUSE_DATABASE ?? 'sudo_log';
  return {
    port: readInt('SUDO_LOG_PORT', 8080),
    adminStaticDir: readString('SUDO_LOG_ADMIN_STATIC_DIR', './packages/admin/src'),
    apiKeyHeader: readString('API_KEY_HEADER', 'X-API-Key'),
    defaultApiKey: readString('DEFAULT_API_KEY', 'sk-8f3a2b1c9d5e7f6a4b3c2d1e8f9a0b7c'),
    queue: {
      name: readString('SUDO_LOG_QUEUE_NAME', 'logs'),
      batchSize: readInt('SUDO_LOG_QUEUE_BATCH_SIZE', 200),
      pollIntervalMs: readInt('SUDO_LOG_QUEUE_POLL_INTERVAL_MS', 500),
      retryDelayMs: readInt('SUDO_LOG_QUEUE_RETRY_DELAY_MS', 3000),
    },
    clickhouse: {
      url: process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123',
      database: clickhouseDatabase,
      grafanaDatabase: readString('GRAFANA_CLICKHOUSE_DATABASE', `${clickhouseDatabase}_grafana`),
      grafanaReaderUser: readString('GRAFANA_CLICKHOUSE_USER', 'grafana_reader'),
      grafanaReaderPassword: readString('GRAFANA_CLICKHOUSE_PASSWORD', 'grafana_reader_password'),
      grafanaDetailEventsEnabled: readBoolean('GRAFANA_DETAIL_EVENTS_ENABLED', false),
      grafanaDetailTtlDays: readPositiveInt('GRAFANA_DETAIL_TTL_DAYS', 7),
      grafanaMetricsTtlDays: readPositiveInt('GRAFANA_METRICS_TTL_DAYS', 30),
      user: process.env.CLICKHOUSE_USER ?? 'sudo',
      password: process.env.CLICKHOUSE_PASSWORD ?? 'sudo_log_dev_password',
    },
    redis: {
      url: readString('REDIS_URL', 'redis://127.0.0.1:6380/0'),
      keyPrefix: readString('SUDO_LOG_REDIS_KEY_PREFIX', 'sudo-log'),
    },
    postgres: {
      url: readString('POSTGRES_URL', 'postgres://sudo@127.0.0.1:5433/sudo_log'),
    },
    auth: {
      jwtSecret: readString('SUDO_LOG_JWT_SECRET', 'sudo-log-dev-secret-change-me'),
      jwtIssuer: readString('SUDO_LOG_JWT_ISSUER', 'sudo-log'),
      accessTokenTtlSeconds: readInt('SUDO_LOG_ACCESS_TOKEN_TTL_SECONDS', 8 * 60 * 60),
      adminUsername: readString('SUDO_LOG_ADMIN_USERNAME', 'admin'),
      adminEmail: readString('SUDO_LOG_ADMIN_EMAIL', 'admin@sudoprivacy.com'),
      adminPassword: readString('SUDO_LOG_ADMIN_PASSWORD', 'admin123'),
      adminPasswordHash: readString('SUDO_LOG_ADMIN_PASSWORD_HASH', ''),
    },
    grafana: {
      enabled: readBoolean('GRAFANA_ENABLED', false),
      publicBasePath: readString('GRAFANA_PUBLIC_BASE_PATH', '/grafana'),
      internalUrl: readString('GRAFANA_INTERNAL_URL', 'http://127.0.0.1:3000'),
      datasourceUid: readString('GRAFANA_DATASOURCE_UID', 'sudo-log-clickhouse'),
      apiUser: readString('GRAFANA_API_USER', 'admin'),
      apiPassword: readString('GRAFANA_API_PASSWORD', 'admin'),
      publishEnabled: readBoolean('GRAFANA_PUBLISH_ENABLED', true),
      orgId: readString('GRAFANA_ORG_ID', '1'),
      authProxyHeader: readString('GRAFANA_AUTH_PROXY_HEADER', 'X-WEBAUTH-USER'),
      defaultTagKey: readString('GRAFANA_DEFAULT_TAG_KEY', 'feature'),
      defaultTagValue: readString('GRAFANA_DEFAULT_TAG_VALUE', ''),
    },
    blobDir: process.env.SUDO_LOG_BLOB_DIR ?? './data/blobs',
    maxBodyBytes: readInt('SUDO_LOG_MAX_BODY_BYTES', 2 * 1024 * 1024),
  };
}
