# Deployment

## Local / POC

```bash
docker compose up --build
```

Services:

| Service | URL |
| --- | --- |
| Sudo Log | `http://127.0.0.1:8088` |
| Console | `http://127.0.0.1:8088/console` |
| Embedded Grafana | `http://127.0.0.1:8088/grafana` |

Only the Sudo Log service port is published to the host by default. Grafana is reached through the Sudo Log `/grafana/*` proxy; ClickHouse, Redis, PostgreSQL, and Grafana are otherwise available only on the internal Compose network.

The default local console login is:

```text
admin / admin123
```

For host-local service development, run ClickHouse, Redis, and PostgreSQL in Compose and start Node locally. Create an ignored `docker-compose.override.yml` first if you need to publish dependency ports to the host:

```yaml
services:
  clickhouse:
    ports:
      - "8123:8123"
      - "9000:9000"
  redis:
    ports:
      - "6380:6379"
  postgres:
    ports:
      - "5433:5432"
  grafana:
    ports:
      - "3000:3000"
```

```bash
docker compose up -d clickhouse redis postgres
SUDO_LOG_PORT=8080 \
CLICKHOUSE_URL=http://127.0.0.1:8123 \
REDIS_URL=redis://127.0.0.1:6380/0 \
POSTGRES_URL=postgres://sudo@127.0.0.1:5433/sudo_log \
SUDO_LOG_ADMIN_USERNAME=admin \
npm run dev
```

Then open:

```text
http://127.0.0.1:8080/console
```

For host-local Grafana development, start `grafana` in Compose and enable the proxy in the Node process:

```bash
GRAFANA_ROOT_URL=http://127.0.0.1:5180/grafana/ \
GRAFANA_LIVE_ALLOWED_ORIGINS=http://localhost:8088,http://127.0.0.1:8088,http://localhost:8080,http://127.0.0.1:8080,http://localhost:5180,http://127.0.0.1:5180 \
docker compose up -d clickhouse redis postgres grafana
GRAFANA_ENABLED=true \
GRAFANA_INTERNAL_URL=http://127.0.0.1:3000 \
GRAFANA_PUBLIC_BASE_PATH=/grafana \
npm run dev
```

`GRAFANA_ROOT_URL` must match the public URL that loads the iframe. `GRAFANA_LIVE_ALLOWED_ORIGINS` must include every local console origin used for debugging; otherwise Grafana Live keeps reconnecting to `/grafana/api/live/ws` and Grafana logs `Request Origin is not authorized`.

## Production-lite

Use the same service shape, but change:

- Strong tenant API Keys
- Strong `SUDO_LOG_JWT_SECRET`
- Strong admin password or `SUDO_LOG_ADMIN_PASSWORD_HASH`
- Persistent Docker volumes or host paths
- Reverse proxy TLS
- ClickHouse backup
- PostgreSQL backup
- Redis persistence and backup policy
- Grafana admin password, root URL, and auth proxy trusted network
- ClickHouse `grafana_reader` password or per-tenant Grafana datasource users
- Grafana ClickHouse users must use `readonly=2` plus `GRANT SELECT` only; `readonly=1` blocks datasource query settings such as `max_execution_time`
- Embedded Grafana sessions must use the Sudo Log proxy-generated Viewer identity, not Grafana `admin`, and annotation writes stay blocked
- Longer retention based on topic
- Console access policy at the reverse proxy layer

Example environment:

```env
API_KEY_HEADER=X-API-Key
DEFAULT_API_KEY=replace-with-initial-sudo-tenant-api-key
SUDO_LOG_JWT_SECRET=replace-with-random-secret
SUDO_LOG_ADMIN_USERNAME=ops
SUDO_LOG_ADMIN_EMAIL=ops@example.com
SUDO_LOG_ADMIN_PASSWORD_HASH=scrypt$...
REDIS_URL=redis://redis:6379/0
POSTGRES_URL=postgres://sudo@postgres:5432/sudo_log
CLICKHOUSE_PASSWORD=replace-with-strong-password
GRAFANA_ENABLED=true
GRAFANA_INTERNAL_URL=http://grafana:3000
GRAFANA_PUBLIC_BASE_PATH=/grafana
GRAFANA_DATASOURCE_UID=sudo-log-clickhouse
GRAFANA_API_USER=admin
GRAFANA_API_PASSWORD=replace-with-strong-grafana-admin-password
GRAFANA_PUBLISH_ENABLED=true
GRAFANA_ROOT_URL=https://logs.example.com/grafana/
GRAFANA_LIVE_ALLOWED_ORIGINS=https://logs.example.com
GRAFANA_CLICKHOUSE_DATABASE=sudo_log_grafana
GRAFANA_CLICKHOUSE_USER=grafana_reader
GRAFANA_CLICKHOUSE_PASSWORD=replace-with-strong-grafana-reader-password
GRAFANA_DETAIL_EVENTS_ENABLED=false
GRAFANA_DETAIL_TTL_DAYS=7
GRAFANA_METRICS_TTL_DAYS=30
SUDO_LOG_BLOB_DIR=/data/sudo-log/blobs
SUDO_LOG_QUEUE_BATCH_SIZE=100
SUDO_LOG_QUEUE_POLL_INTERVAL_MS=500
SUDO_LOG_QUEUE_RETRY_DELAY_MS=3000
```

## Optional Redpanda

Redpanda is not wired into the v1 service yet. The compose file is included to reserve the deployment path:

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.redpanda.yml up --build
```

The intended v2 flow:

```text
Sudo Log -> Redpanda topic -> ClickHouse consumer
                         -> Quickwit/OpenSearch consumer
                         -> Alert consumer
```

## Capacity Notes

For standalone v1 validation, one ClickHouse node, one Redis node, and one PostgreSQL node are enough to validate:

- Redis-backed asynchronous ingestion
- PostgreSQL-backed users, tenants, products, and API Keys
- user/time/level/component queries
- error summary
- detail lookup
- console login and session revocation

The v1 service writes accepted log rows to a Redis list first, then an in-process worker flushes rows to ClickHouse in batches. This buffers short ClickHouse slowdowns and keeps client write latency mostly tied to Redis. If ClickHouse writes fail, the worker requeues the batch and retries after `SUDO_LOG_QUEUE_RETRY_DELAY_MS`.

Move to Kafka/Redpanda when any of these become true:

- Redis list durability or single-worker throughput is not enough
- ingestion bursts need replayable buffering
- logs need replay into new tables/indexes
- multiple downstream consumers are required
