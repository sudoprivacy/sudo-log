# Sudowork Log

Sudowork Log is a standalone ClickHouse-backed log system for Sudowork products and future third-party integrations.

The first implementation focuses on making Sudowork Log useful as its own professional log console before product-specific integrations:

- Structured log ingestion through `POST /v1/logs/batch`
- Error stack extraction and blob storage
- ClickHouse optimized queries by tenant, product, level, user, and time range
- PostgreSQL-backed users, tenants, products, and tenant API Keys
- Error summary and event detail APIs
- Built-in admin console for event discovery, timelines, error groups, stack inspection, user management, and system health
- Username login, role permissions, JWT access tokens, and Redis-backed session storage
- Docker Compose deployment for local and small-scale production validation

## Project Structure

```text
packages/
  server/   # Node.js service, auth, log APIs, PostgreSQL config, ClickHouse logs, Redis sessions/queue
  admin/    # Browser admin console served by the same service
  shared/   # Shared API and domain types reserved for future use
docs/       # Architecture, API, schema, and deployment notes
deploy/     # Optional deployment overlays
```

## Quick Start

```bash
docker compose up --build
```

Service:

```text
http://127.0.0.1:8088
```

Console:

```text
http://127.0.0.1:8088/console
```

Default local login:

```text
admin / admin123
```

ClickHouse:

```text
Internal Docker Compose service only
```

Default tenant/product/API Key:

```text
tenant_id=sudo
product=sudowork
api_key=DEFAULT_API_KEY
```

## Local Mode

Use local mode when developing the service on the host machine while keeping ClickHouse, Redis, and PostgreSQL in Docker.

Prerequisites:

- Node.js 22 or newer
- Docker Compose

Install dependencies once:

```bash
npm install
```

Start dependencies:

```bash
docker compose up -d clickhouse redis postgres
```

The default Compose file publishes only the application port. For host-local service development, create an ignored `docker-compose.override.yml` with temporary dependency ports:

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
```

Start the service locally:

```bash
SUDO_LOG_PORT=8080 \
API_KEY_HEADER=X-API-Key \
DEFAULT_API_KEY=sk-8f3a2b1c9d5e7f6a4b3c2d1e8f9a0b7c \
CLICKHOUSE_URL=http://127.0.0.1:8123 \
CLICKHOUSE_DATABASE=sudo_log \
CLICKHOUSE_USER=sudo \
CLICKHOUSE_PASSWORD=sudo_log_dev_password \
REDIS_URL=redis://127.0.0.1:6380/0 \
POSTGRES_URL=postgres://sudo@127.0.0.1:5433/sudo_log \
SUDO_LOG_ADMIN_USERNAME=admin \
SUDO_LOG_ADMIN_EMAIL=admin@sudoprivacy.com \
SUDO_LOG_ADMIN_PASSWORD=admin123 \
SUDO_LOG_JWT_SECRET=sudo-log-dev-secret-change-me \
SUDO_LOG_BLOB_DIR=./data/blobs \
SUDO_LOG_MAX_BODY_BYTES=2097152 \
SUDO_LOG_QUEUE_BATCH_SIZE=100 \
SUDO_LOG_QUEUE_POLL_INTERVAL_MS=500 \
SUDO_LOG_QUEUE_RETRY_DELAY_MS=3000 \
npm run dev
```

Local service:

```text
http://127.0.0.1:8080
```

Local console:

```text
http://127.0.0.1:8080/console
```

## Admin Development

The admin console lives in `packages/admin`. In production and simple local mode, the service serves it at `/console`.

For admin-focused development, run the service and admin dev server as two processes.

Terminal 1, start dependencies and the service:

```bash
docker compose up -d clickhouse redis postgres
SUDO_LOG_PORT=8080 \
API_KEY_HEADER=X-API-Key \
DEFAULT_API_KEY=sk-8f3a2b1c9d5e7f6a4b3c2d1e8f9a0b7c \
CLICKHOUSE_URL=http://127.0.0.1:8123 \
CLICKHOUSE_DATABASE=sudo_log \
CLICKHOUSE_USER=sudo \
CLICKHOUSE_PASSWORD=sudo_log_dev_password \
REDIS_URL=redis://127.0.0.1:6380/0 \
POSTGRES_URL=postgres://sudo@127.0.0.1:5433/sudo_log \
SUDO_LOG_ADMIN_USERNAME=admin \
SUDO_LOG_ADMIN_EMAIL=admin@sudoprivacy.com \
SUDO_LOG_ADMIN_PASSWORD=admin123 \
SUDO_LOG_JWT_SECRET=sudo-log-dev-secret-change-me \
npm run dev:server
```

Terminal 2, start the admin dev server:

```bash
SUDO_LOG_ADMIN_PORT=5180 \
SUDO_LOG_API_BASE=http://127.0.0.1:8080 \
npm run dev:admin
```

Admin dev URL:

```text
http://127.0.0.1:5180/console
```

The admin dev server serves static files from `packages/admin/src` and proxies `/api/*`, `/v1/*`, and `/health` to `SUDO_LOG_API_BASE`.

Stop local mode:

```bash
# Stop the local service with Ctrl+C first.
docker compose stop clickhouse redis postgres
```

## Smoke Test

Set the service URL first. Use `8088` after `docker compose up --build`, or `8080` after starting the service in local mode.

```bash
BASE_URL=http://127.0.0.1:8088
# BASE_URL=http://127.0.0.1:8080
```

```bash
curl -s "$BASE_URL/health"
```

Login and store a console JWT:

```bash
ACCESS_TOKEN=$(
  curl -s "$BASE_URL/api/auth/login" \
    -H 'content-type: application/json' \
    -d '{"login":"admin","password":"admin123"}' \
    | node -e "let raw=''; process.stdin.on('data', c => raw += c); process.stdin.on('end', () => console.log(JSON.parse(raw).data.accessToken));"
)
```

```bash
curl -s "$BASE_URL/v1/logs/batch" \
  -H 'X-API-Key: sk-8f3a2b1c9d5e7f6a4b3c2d1e8f9a0b7c' \
  -H 'content-type: application/json' \
  -d '{
    "logs": [
      {
        "tenant_id": "sudo",
        "level": "error",
        "product": "sudowork",
        "topic": "error",
        "component": "CrashReporter",
        "message": "Renderer exception captured",
        "user_identifier": "user@example.com",
        "user_id": "demo-user",
        "error": {
          "name": "TypeError",
          "message": "Cannot read properties of undefined",
          "stack": "TypeError: Cannot read properties of undefined\n    at demo (/Users/alice/project/app.ts:10:5)"
        }
      }
    ]
  }'
```

Then query with a time range:

```bash
curl -s "$BASE_URL/v1/logs/search?tenant_id=sudo&product=sudowork&level=error&user_identifier=user%40example.com&start_time=2026-01-01T00:00:00.000Z&end_time=2027-01-01T00:00:00.000Z" \
  -H "authorization: Bearer $ACCESS_TOKEN"
```

## Documentation

- [Implementation Plan](docs/implementation-plan.md)
- [Third-Party Integration](docs/third-party-integration.md)
- [API](docs/api.md)
- [Schema](docs/schema.md)
- [Deployment](docs/deployment.md)
