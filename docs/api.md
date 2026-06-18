# API

Authentication model:

- `/v1/logs/batch` accepts only the configured API key header.
- The API key must belong to the `tenant_id` in each reported log, and each `product` must exist under that tenant.
- Read APIs accept only an admin JWT with `logs:read`.
- Admin JWTs are issued by `/api/auth/login` and must have a matching Redis session record.

```http
Authorization: Bearer <admin-jwt>
```

## GET /health

Response:

```json
{ "ok": true }
```

## GET /console

Built-in Sudo Log console. The page is served by the gateway and uses the same origin API.

The console signs in through `/api/auth/login`, stores the JWT in browser local storage, and sends it to protected endpoints. It supports:

- event discovery
- timeline overview
- error group summary
- event detail drawer
- stack blob inspection
- user and role management
- tenant, product, and API key management
- system health

## POST /api/auth/login

Create a JWT access token and register the session in Redis.

Request:

```json
{
  "login": "admin",
  "password": "admin123"
}
```

`login` accepts the username. Email remains accepted for compatibility, but local bootstrap creates the default admin username as `admin`.

Response:

```json
{
  "success": true,
  "data": {
    "accessToken": "...",
    "expiresAt": "2026-06-03T16:00:00.000Z",
    "user": {
      "id": "...",
      "username": "admin",
      "email": "admin@sudoprivacy.com",
      "displayName": "Administrator",
      "role": "admin",
      "enabled": true,
      "permissions": ["logs:read", "logs:write", "system:read", "settings:write", "users:manage"],
      "lastLoginAt": "2026-06-03T16:00:00.000Z",
      "createdAt": "2026-06-03T08:00:00.000Z",
      "updatedAt": "2026-06-03T16:00:00.000Z"
    }
  }
}
```

## GET /api/auth/me

Return the current authenticated admin user.

## POST /api/auth/logout

Revoke the current Redis session.

## POST /api/auth/logout-all

Revoke all Redis sessions for the current user.

## POST /api/auth/change-password

Change the current user's password and revoke all of that user's Redis sessions.

Request:

```json
{
  "currentPassword": "admin123",
  "newPassword": "new-password"
}
```

## GET /api/users

List users. Requires `users:manage`.

## POST /api/users

Create a user. Requires `users:manage`.

Request:

```json
{
  "username": "operator",
  "email": "operator@sudo-log.local",
  "displayName": "Operator",
  "password": "operator-password",
  "role": "operator",
  "enabled": true
}
```

Roles:

- `admin`: full console access, user management, system health, log read/write
- `operator`: log read/write and system health
- `viewer`: log read only

## PUT /api/users/:id

Update username, email, display name, role, or enabled state. Requires `users:manage`. Changing a user's role or enabled state revokes that user's Redis sessions. The current user cannot disable their own account or change their own role.

Request:

```json
{
  "username": "operator",
  "email": "operator@sudo-log.local",
  "displayName": "Operator",
  "role": "operator",
  "enabled": true
}
```

## PUT /api/users/:id/password

Reset a user's password. Requires `users:manage` and revokes that user's Redis sessions.

Request:

```json
{
  "password": "new-password"
}
```

## DELETE /api/users/:id

Delete a user and revoke all of their Redis sessions. Requires `users:manage`. The current user cannot delete their own account.

## GET /api/system/health

Protected system health endpoint. Requires `system:read`.

Response:

```json
{
  "success": true,
  "data": {
    "clickhouse": true,
    "postgres": true,
    "redis": true,
    "auth": true,
    "queue": true
  }
}
```

## GET /api/settings/tenants

List configured tenants and products. Requires `logs:read`. Users with `settings:write` also receive tenant API keys; read-only users do not.

## POST /api/settings/tenants

Create a tenant. Requires `settings:write`. If `apiKey` is omitted, the gateway generates one.

```json
{
  "tenantId": "acme",
  "name": "Acme",
  "apiKey": "sk-optional-custom-key",
  "enabled": true
}
```

## PUT /api/settings/tenants/:tenant_id

Update tenant name or enabled state. Requires `settings:write`. Tenant API keys cannot be updated after creation; use the console copy action to distribute the existing key.

## DELETE /api/settings/tenants/:tenant_id

Delete a tenant and its product configs. Requires `settings:write`.

## POST /api/settings/tenants/:tenant_id/products

Create a product under a tenant. Requires `settings:write`.

```json
{
  "product": "acme-console",
  "name": "Acme Console",
  "enabled": true
}
```

## PUT /api/settings/tenants/:tenant_id/products/:product

Update product name or enabled state. Requires `settings:write`.

## DELETE /api/settings/tenants/:tenant_id/products/:product

Delete a product config. Requires `settings:write`.

## POST /v1/logs/batch

Batch ingest endpoint. The gateway validates, normalizes, redacts, and enqueues rows into Redis before responding. A successful response means the logs were accepted into the queue; a background worker flushes queued rows to ClickHouse in batches.

Headers:

```http
X-API-Key: key_exp
Content-Type: application/json
```

Request:

```json
{
  "logs": [
    {
      "timestamp": "2026-06-03T10:00:00.000Z",
      "tenant_id": "sudo",
      "level": "error",
      "product": "sudowork",
      "topic": "error",
      "environment": "production",
      "version": "0.2.4",
      "platform": "darwin",
      "arch": "arm64",
      "user_identifier": "user@example.com",
      "user_id": "raw-user-id",
      "device_id": "raw-device-id",
      "session_id": "session-id",
      "conversation_id": "conversation-id",
      "trace_id": "trace-id",
      "component": "CrashReporter",
      "message": "Renderer exception captured",
      "error": {
        "name": "TypeError",
        "message": "Cannot read properties of undefined",
        "stack": "TypeError: Cannot read properties of undefined\n    at demo (/Users/alice/app.ts:10:5)"
      },
      "tags": {
        "feature": "settings",
        "plan": "pro"
      },
      "attributes": {
        "route": "/settings"
      }
    }
  ]
}
```

Response:

```json
{
  "success": true,
  "accepted": true,
  "received": 1,
  "event_ids": ["..."]
}
```

Rules:

- `logs` must be an array.
- Max batch size is 50.
- Max request body defaults to 2MB.
- Successful responses use HTTP `200 OK`.
- Each log must include `tenant_id`, `product`, and `user_identifier` or `user_identifier_hash`.
- `tenant_id` must exist, `product` must exist under that tenant, and `X-API-Key` must belong to that tenant.
- ClickHouse writes are asynchronous; query APIs may not show the events immediately under load.
- `timestamp` accepts an ISO 8601 string or a Unix epoch millisecond timestamp. Numeric timestamps are always parsed as milliseconds; nanosecond numeric timestamps are not supported.
- `received_at` is generated by the gateway when the event is accepted into the Redis queue.
- `created_at` is generated by ClickHouse when the row is inserted.
- `user_identifier`, `user_id`, and `device_id` are hashed server-side as `lowercase_hex_sha256(trim(raw-id))`.
- `user_identifier_hash`, `user_id_hash`, and `device_id_hash` can be sent directly if already hashed, but they must be 64-character lowercase hex SHA-256 strings without a `sha256:` prefix or user/device lookups will not match.
- `error.stack` or `stack_trace` is required when `level` is `error` or `fatal`.
- `tags` is an optional flat object used for `key:value` search and metric inference. String and boolean values become dimension tags. Finite number values become numeric metrics by default.
- Numeric tag values whose keys look like identifiers or categories remain dimension tags. This includes exact keys such as `status`, `status_code`, `http_status`, `http_status_code`, `code`, `error_code`, `exit_code`, and suffixes such as `_id`, `_code`, `_status`, `_version`, and `_level`.
- Inferred dimension tags are stored in `tags_json` and support `tag=key:value` search. Inferred numeric metrics are stored in `metrics_json` and metric mart tables for Grafana aggregations such as sum, average, min, max, and P95.
- Each log may contain at most 20 tags. Tag keys are normalized to lowercase and may contain only lowercase letters, numbers, underscore, dot, and dash.
- Tag keys may not contain `:` because search uses `tag=key:value` query syntax.
- Tag key length must be <= 64 characters. Tag value length must be <= 256 characters. Serialized `tags` must be <= 4096 bytes.
- Reserved structured field names such as `tenant_id`, `product`, `timestamp`, `level`, `trace_id`, `session_id`, `error_hash`, `attributes`, and `tags` cannot be used as tag keys.

## GET /v1/logs/search

Search structured logs.

Required query params:

- `tenant_id`
- `start_time`
- `end_time`

Optional query params:

- `product`
- `topic`
- `environment`
- `level`
- `user_identifier`: 明文用户标识，例如手机号、邮箱或统一用户中心 ID，后端会按 `lowercase_hex_sha256(trim(raw-id))` 转成 `user_identifier_hash` 后检索。
- `user_id`：明文用户 ID，后端会按 `lowercase_hex_sha256(trim(raw-id))` 转成 `user_id_hash` 后检索。
- `component`
- `version`
- `session_id`
- `trace_id`
- `tag`: repeatable `key:value` filter. Multiple `tag` params default to AND semantics.
- `tag_mode`: `all` or `any`; defaults to `all`.
- `cursor_timestamp` and `cursor_event_id`: optional search-after cursor returned from the last row on the previous page. These two params must be provided together.
- `limit`

`error_hash` is an internal stable grouping key generated by Sudo Log. It is used for error-group drilldown, but should not be exposed as a manual search field.

When `tag` is present:

- `tenant_id`, `product`, `start_time`, and `end_time` are required.
- The time range must be <= 7 days.
- At most 5 tags can be used in one query.
- Only exact `key:value` matching is supported. Tag key-only, value-only, substring, and fuzzy matching are not supported.
- Pagination uses search-after. Use the last row's `timestamp` and `event_id` as `cursor_timestamp` and `cursor_event_id`; offset pagination is not supported.

Example:

```bash
curl -s 'http://127.0.0.1:8088/v1/logs/search?tenant_id=sudo&product=sudowork&level=error&user_identifier=user%40example.com&start_time=2026-06-03T00:00:00.000Z&end_time=2026-06-04T00:00:00.000Z&limit=100' \
  -H 'authorization: Bearer <admin-jwt>'
```

Tag search example:

```bash
curl -s 'http://127.0.0.1:8088/v1/logs/search?tenant_id=sudo&product=sudowork&start_time=2026-06-03T00:00:00.000Z&end_time=2026-06-04T00:00:00.000Z&tag=feature:settings&tag=plan:pro&tag_mode=all&limit=100' \
  -H 'authorization: Bearer <admin-jwt>'
```

## GET /v1/logs/events/:event_id

Fetch one event by `event_id`.

Example:

```bash
curl -s 'http://127.0.0.1:8088/v1/logs/events/ef4988d8-9f52-4573-9db1-8186979fe182?tenant_id=sudo' \
  -H 'authorization: Bearer <admin-jwt>'
```

## GET /v1/logs/blobs

Fetch a gateway-managed blob, currently limited to stack blobs such as `blob://stacks/<event_id>.txt`.

Query params:

- `ref`

Example:

```bash
curl -s 'http://127.0.0.1:8088/v1/logs/blobs?ref=blob%3A%2F%2Fstacks%2Fef4988d8-9f52-4573-9db1-8186979fe182.txt' \
  -H 'authorization: Bearer <admin-jwt>'
```

## GET /v1/logs/errors/summary

Aggregate errors by `error_hash`.

Required query params:

- `tenant_id`
- `start_time`
- `end_time`

Optional query params:

- `product`
- `component`
- `version`
- `limit`

Example:

```bash
curl -s 'http://127.0.0.1:8088/v1/logs/errors/summary?tenant_id=sudo&product=sudowork&start_time=2026-06-03T00:00:00.000Z&end_time=2026-06-04T00:00:00.000Z' \
  -H 'authorization: Bearer <admin-jwt>'
```
