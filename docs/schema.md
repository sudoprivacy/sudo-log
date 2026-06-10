# Schema

Sudo Log uses PostgreSQL for configuration and users, Redis for sessions/queue, and ClickHouse only for log events.

## PostgreSQL Tables

The gateway creates these configuration tables on startup:

- `admin_users`: console users, password hashes, roles, enabled state, and login metadata.
- `tenants`: tenant ID, display name, tenant API Key, and enabled state.
- `tenant_products`: products configured under each tenant.

Default bootstrap data:

| Table | Default |
| --- | --- |
| `tenants` | `tenant_id = sudo`, API Key from `DEFAULT_API_KEY` |
| `tenant_products` | `tenant_id = sudo`, `product = sudowork` |
| `admin_users` | admin user from `SUDO_LOG_ADMIN_*` |

Tenant and product configuration is cached in process memory. Mutating APIs refresh the cache immediately after successful PG writes. The ingest endpoint validates `tenant_id`, `product`, and API Key against this cache before logs are enqueued.

## ClickHouse Tables

The gateway creates these tables on startup:

- `sudo_logs`
- `sudo_error_logs`
- `sudo_log_event_lookup`
- `sudo_log_tags`

## Common Columns

| Column | Type | Purpose |
| --- | --- | --- |
| `timestamp` | `DateTime64(3, 'UTC')` | Event time reported by the client or producer |
| `received_at` | `DateTime64(3, 'UTC')` | Gateway receive/enqueue time |
| `event_id` | `String` | Server-generated event ID |
| `tenant_id` | `LowCardinality(String)` | Tenant or org |
| `product` | `LowCardinality(String)` | `sudowork`, `sudorouter`, `sudocode` |
| `topic` | `LowCardinality(String)` | `app`, `error`, `perf`, `audit`, `model_call` |
| `environment` | `LowCardinality(String)` | `production`, `development`, `staging` |
| `level` | `LowCardinality(String)` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `user_identifier_hash` | `String` | 64-character lowercase hex SHA-256 hash of the required user identifier |
| `user_id_hash` | `String` | 64-character lowercase hex SHA-256 user ID hash |
| `device_id_hash` | `String` | 64-character lowercase hex SHA-256 device ID hash |
| `session_id` | `String` | Session correlation |
| `conversation_id` | `String` | Sudowork conversation correlation |
| `trace_id` | `String` | Cross-system trace correlation |
| `component` | `LowCardinality(String)` | Component or module |
| `version` | `LowCardinality(String)` | Product version |
| `platform` | `LowCardinality(String)` | `darwin`, `win32`, `linux` |
| `arch` | `LowCardinality(String)` | `arm64`, `x64`, `x86` |
| `message` | `String` | Redacted message |
| `error_name` | `LowCardinality(String)` | Error class |
| `error_message` | `String` | Redacted error message |
| `error_hash` | `String` | Stable grouping hash |
| `stack_hash` | `String` | Stack hash |
| `stack_ref` | `String` | Blob reference |
| `raw_ref` | `String` | Future raw payload reference |
| `tags_json` | `String` | Redacted search tags as JSON |
| `tags_kv` | `Array(String)` | Stable `key\x1Fvalue` tag strings for lightweight filtering/debugging |
| `attributes_json` | `String` | Redacted attributes |
| `created_at` | `DateTime64(3, 'UTC')` | ClickHouse insert time |

## Sorting Keys

General logs:

```sql
ORDER BY (tenant_id, product, level, user_identifier_hash, user_id_hash, timestamp, component, error_hash)
```

Event lookup:

```sql
ORDER BY (tenant_id, event_id)
```

Tags inverted table:

```sql
ORDER BY (tenant_id, product, tag_key, tag_kv_hash, timestamp, event_id)
```

These keys are chosen for the first high-frequency query path:

```text
tenant + product + level + user identifier + time range
```

`sudo_log_tags` is the primary path for tags search. Each normalized tag on a log event is expanded into one row with the same `event_id`, timestamp, tenant, product, and common filter columns. Search queries first filter this table by `tenant_id + product + tag_key + tag_kv_hash + timestamp`, then use `event_id` to read complete rows from `sudo_log_event_lookup`.

## Tags Rules

- Tags are optional on ingest.
- Tags must be a flat object of `string | number | boolean` values.
- Tag keys are normalized to lowercase.
- Tag keys may contain only lowercase letters, numbers, underscore, dot, and dash.
- Tag keys may not contain `:` because the query API uses `tag=key:value`.
- Each event can have at most 20 tags.
- A tags search can include at most 5 tag filters.
- Tags search requires `tenant_id`, `product`, `start_time`, and `end_time`; the time range must be <= 7 days.

## Retention

The default TTL is 30 days:

```sql
TTL toDateTime(timestamp) + INTERVAL 30 DAY
```

Production should make TTL configurable per topic:

| Topic | Suggested Retention |
| --- | --- |
| `error` | 30-90 days |
| `app` | 7-30 days |
| `debug` | 1-7 days |
| `audit` | 180-365 days |
| `model_call` | 30-180 days |
