# Grafana Tags 接入第二步执行方案

## 1. 背景

第一步 tags 方案已经确定继续使用 ClickHouse，并通过 `sudo_log_tags` 倒排表支持 `key:value` 精确检索。

第二步需要支持业务侧把 tags 随日志 push 到日志系统后，可以在 Grafana 中自行配置 panel，例如：

- 按业务 tag 查看请求量、错误量、错误率。
- 按 tag value 拆分时间序列。
- 查看某个 tag 条件下的最近日志。
- 在 Grafana dashboard 中用变量选择 `tenant_id`、`product`、`tag_key`、`tag_value`。

本方案目标不是把 Grafana 变成日志系统的唯一 UI，而是让 Grafana 承担 dashboard、监控和业务自助分析；日志详情、stack、原始事件排查仍然优先回到 Sudo Log Console。

## 2. 总体方案

采用官方 Grafana ClickHouse data source 插件连接 ClickHouse，但不直接开放原始日志表。

最终架构：

```text
Business SDK / Service
  -> POST /v1/logs/batch with tags
  -> Sudo Log Gateway
  -> Redis queue
  -> ClickHouse raw tables
       - sudo_logs
       - sudo_error_logs
       - sudo_log_event_lookup
       - sudo_log_tags
  -> ClickHouse Grafana mart
       - grafana_log_events (optional detail mart, short TTL)
       - grafana_log_metrics_1m
       - grafana_tag_events (optional detail mart, short TTL)
       - grafana_tag_metrics_1m
       - grafana_tag_keys_1d
       - grafana_tag_values_1d
  -> Grafana ClickHouse datasource
  -> Business dashboards
```

核心原则：

- ClickHouse 仍然是日志和 tags 的权威存储。
- Grafana 只读 ClickHouse。
- Grafana 默认查询聚合表，不扫原始日志表。
- 业务用户只面向稳定的 Grafana mart 表配置 panel。
- 原始日志详情通过 `event_id` 跳转回 Sudo Log Console。
- Sudo Log Console 内新增 Dashboard 菜单，嵌入 Grafana panel，但不向浏览器暴露 Grafana 数据源账号、API token 或管理接口。

## 3. 为什么需要 Grafana Mart

不能让业务用户直接查询原始表，原因是：

- Grafana SQL editor 可以执行任意 SQL，安全边界必须在 ClickHouse 权限层。
- 原始表包含更多内部字段，未来 schema 也更容易变化。
- 原始 tags 表是倒排检索表，适合查候选日志，不适合作为所有 panel 的默认数据源。
- dashboard 会频繁刷新，如果每个 panel 都扫原始日志，容易把日志系统查询资源打满。
- Grafana 面向业务自助时，需要稳定、可解释、低成本的数据表。

因此第二步新增一层 Grafana mart：

```text
raw tables -> materialized view / async writer -> grafana mart tables -> Grafana
```

## 4. 数据集设计

推荐单独创建数据库：

```sql
CREATE DATABASE IF NOT EXISTS sudo_log_grafana;
```

也可以先放在现有 `sudo_log` 数据库中，用 `grafana_` 前缀区分。生产推荐单独数据库，便于权限隔离。

### 4.1 `grafana_log_events`

用途：

- Grafana Logs/Table panel 展示最近日志。
- 提供 `event_id`，用于跳转回 Sudo Log Console。
- 提供基础过滤字段和 `tags_json`。

不建议暴露完整 `attributes_json`。如果必须暴露，应先确认脱敏策略和字段大小限制。

```sql
CREATE TABLE IF NOT EXISTS sudo_log_grafana.grafana_log_events
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
TTL toDateTime(timestamp) + INTERVAL 7 DAY;
```

填充方式：

- 存储优化后的 v1 默认不写入该表。
- 只有 `GRAFANA_DETAIL_EVENTS_ENABLED=true` 时由日志 queue flush 同步写入。
- 该表只用于 Recent logs/drilldown 类 panel，默认 TTL 建议 3-7 天。
- 如果后续使用 ClickHouse materialized view，需要确保主日志表 insert 路径稳定，并验证写入失败处理。

### 4.2 `grafana_tag_events`

用途：

- 提供 Grafana 明细 drilldown 使用的 tags 原始倒排查询。
- 存储优化后不作为默认 dashboard 依赖。
- 只有 `GRAFANA_DETAIL_EVENTS_ENABLED=true` 时写入，默认 TTL 建议 3-7 天。

结构和第一步 `sudo_log_tags` 保持一致或作为其稳定投影。

```sql
CREATE TABLE IF NOT EXISTS sudo_log_grafana.grafana_tag_events
(
  timestamp DateTime64(3, 'UTC'),
  received_at DateTime64(3, 'UTC'),
  event_id String,

  tenant_id LowCardinality(String),
  product LowCardinality(String),

  tag_key LowCardinality(String),
  tag_value String,
  tag_kv String,
  tag_kv_hash UInt64,

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
TTL toDateTime(timestamp) + INTERVAL 7 DAY;
```

### 4.3 `grafana_log_metrics_1m`

用途：

- 不带 tag 维度的基础日志指标。
- 支撑总量、错误率、按 level/topic/environment/component/version/platform 拆分。

```sql
CREATE TABLE IF NOT EXISTS sudo_log_grafana.grafana_log_metrics_1m
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
ORDER BY (
  tenant_id,
  product,
  interval_start,
  level,
  topic,
  environment,
  component,
  version,
  platform,
  arch
)
TTL interval_start + INTERVAL 30 DAY;
```

物化视图草案：

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS sudo_log_grafana.mv_grafana_log_metrics_1m
TO sudo_log_grafana.grafana_log_metrics_1m
AS
SELECT
  toStartOfMinute(timestamp) AS interval_start,
  tenant_id,
  product,
  topic,
  environment,
  level,
  component,
  version,
  platform,
  arch,
  count() AS events,
  countIf(level = 'error') AS errors,
  countIf(level = 'fatal') AS fatals
FROM sudo_log.sudo_logs
GROUP BY
  interval_start,
  tenant_id,
  product,
  topic,
  environment,
  level,
  component,
  version,
  platform,
  arch;
```

### 4.4 `grafana_tag_metrics_1m`

用途：

- Grafana tags dashboard 的默认查询表。
- 支撑按 tag key/value 过滤和分组。
- 避免 Grafana panel 高频扫描 `grafana_tag_events`。

```sql
CREATE TABLE IF NOT EXISTS sudo_log_grafana.grafana_tag_metrics_1m
(
  interval_start DateTime('UTC'),

  tenant_id LowCardinality(String),
  product LowCardinality(String),

  tag_key LowCardinality(String),
  tag_value String,
  tag_kv_hash UInt64,

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
ORDER BY (
  tenant_id,
  product,
  tag_key,
  tag_kv_hash,
  interval_start,
  level,
  topic,
  environment,
  component,
  version,
  platform,
  arch
)
TTL interval_start + INTERVAL 30 DAY;
```

物化视图草案：

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS sudo_log_grafana.mv_grafana_tag_metrics_1m
TO sudo_log_grafana.grafana_tag_metrics_1m
AS
SELECT
  toStartOfMinute(timestamp) AS interval_start,
  tenant_id,
  product,
  tag_key,
  tag_value,
  tag_kv_hash,
  topic,
  environment,
  level,
  component,
  version,
  platform,
  arch,
  count() AS events,
  countIf(level = 'error') AS errors,
  countIf(level = 'fatal') AS fatals
FROM sudo_log.sudo_log_tags
GROUP BY
  interval_start,
  tenant_id,
  product,
  tag_key,
  tag_value,
  tag_kv_hash,
  topic,
  environment,
  level,
  component,
  version,
  platform,
  arch;
```

注意：

- 这张表会按 tag 维度放大。
- 不是所有 tag key 都适合进入 dashboard 分组。
- 如果高基数 tag 太多，需要引入 tag registry，只对 Grafana 允许的 tag key 进入聚合表。

### 4.5 `grafana_tag_keys_1d`

用途：

- Grafana 变量 `tag_key` 的数据源。
- 避免变量查询扫描原始 tag 表。

```sql
CREATE TABLE IF NOT EXISTS sudo_log_grafana.grafana_tag_keys_1d
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
TTL day + INTERVAL 30 DAY;
```

### 4.6 `grafana_tag_values_1d`

用途：

- Grafana 变量 `tag_value` 的数据源。
- 限制每个 tag key 下的可选 value 数量。

```sql
CREATE TABLE IF NOT EXISTS sudo_log_grafana.grafana_tag_values_1d
(
  day Date,
  tenant_id LowCardinality(String),
  product LowCardinality(String),
  tag_key LowCardinality(String),
  tag_value String,
  tag_kv_hash UInt64,
  events UInt64
)
ENGINE = SummingMergeTree
PARTITION BY day
ORDER BY (tenant_id, product, tag_key, day, tag_kv_hash)
TTL day + INTERVAL 30 DAY;
```

变量查询也可以先直接从 `grafana_tag_metrics_1m` 聚合，后续再补充 1d 表。生产推荐补齐 1d 表。

## 5. Tag Registry

为了支持业务自助配置 Grafana，又避免高基数 tags 拖垮 dashboard，需要在 PostgreSQL 配置库增加 tag registry。

建议表：

```sql
CREATE TABLE grafana_tag_registry (
  tenant_id TEXT NOT NULL,
  product TEXT NOT NULL,
  tag_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  grafana_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  groupable BOOLEAN NOT NULL DEFAULT FALSE,
  variable_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  max_variable_values INTEGER NOT NULL DEFAULT 100,
  owner TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product, tag_key)
);
```

字段含义：

- `grafana_enabled`：是否允许出现在 Grafana mart。
- `groupable`：是否允许在 panel 中 `GROUP BY tag_value`。
- `variable_enabled`：是否允许作为 Grafana 变量。
- `max_variable_values`：变量候选值上限。

默认策略：

- 新 tag 默认 searchable，但不默认进入 Grafana 聚合维度。
- 业务需要在 Grafana 中自助使用某个 tag key 时，先在 Sudo Log Console 注册并启用。
- 高基数 tag，例如 request_id、order_id、session_id，不允许 groupable。

## 6. ClickHouse 权限方案

Grafana 只能使用只读用户。

推荐按 tenant/product 创建独立 ClickHouse 用户或角色：

```sql
CREATE ROLE IF NOT EXISTS grafana_sudo_sudocode_role;

GRANT SELECT ON sudo_log_grafana.grafana_log_events TO grafana_sudo_sudocode_role;
GRANT SELECT ON sudo_log_grafana.grafana_log_metrics_1m TO grafana_sudo_sudocode_role;
GRANT SELECT ON sudo_log_grafana.grafana_tag_events TO grafana_sudo_sudocode_role;
GRANT SELECT ON sudo_log_grafana.grafana_tag_metrics_1m TO grafana_sudo_sudocode_role;
GRANT SELECT ON sudo_log_grafana.grafana_tag_keys_1d TO grafana_sudo_sudocode_role;
GRANT SELECT ON sudo_log_grafana.grafana_tag_values_1d TO grafana_sudo_sudocode_role;

CREATE ROW POLICY IF NOT EXISTS grafana_sudo_sudocode_log_events_policy
ON sudo_log_grafana.grafana_log_events
FOR SELECT
USING tenant_id = 'sudo' AND product = 'sudocode'
TO grafana_sudo_sudocode_role;

CREATE ROW POLICY IF NOT EXISTS grafana_sudo_sudocode_tag_events_policy
ON sudo_log_grafana.grafana_tag_events
FOR SELECT
USING tenant_id = 'sudo' AND product = 'sudocode'
TO grafana_sudo_sudocode_role;

CREATE USER IF NOT EXISTS grafana_sudo_sudocode
IDENTIFIED BY 'replace-with-secret'
SETTINGS
  readonly = 2,
  max_execution_time = 15,
  max_result_rows = 100000,
  result_overflow_mode = 'break';

GRANT grafana_sudo_sudocode_role TO grafana_sudo_sudocode;
SET DEFAULT ROLE grafana_sudo_sudocode_role TO grafana_sudo_sudocode;
```

所有 Grafana 物化聚合表也要加对应 row policy。上面只展示两张表，实际需要覆盖全部 Grafana mart 表。

落地验证时不能只看 datasource connection test。必须在 Grafana 中执行一次实际 panel query 和一次 alert query，确认 ClickHouse 只读 profile 没有限制插件需要设置的查询级参数，例如 `max_execution_time`。

这里必须使用 `readonly = 2`，不能使用 `readonly = 1`。`readonly = 2` 仍然禁止写查询，写权限继续由 ClickHouse `GRANT SELECT` 边界控制，但允许 Grafana ClickHouse datasource 在连接初始化或查询时设置 `max_execution_time` 等查询级参数；`readonly = 1` 会导致插件报 `failed to create ClickHouse client`。

权限硬规则：

- Grafana 用户不得拥有 raw database 的权限。
- Grafana 用户不得拥有 `INSERT`、`ALTER`、`CREATE`、`DROP` 权限。
- Grafana 用户不得访问 `sudo_logs`、`sudo_error_logs`、`sudo_log_event_lookup`、`sudo_log_tags` 原始表。
- 每个外部业务方使用独立 datasource 和独立 ClickHouse 用户。
- 内部管理员可以有跨产品 datasource，但必须和业务 datasource 分离。

## 7. Grafana 部署方案

### 7.1 Docker Compose 服务

第二步可以在现有 Compose 中增加 Grafana：

```yaml
grafana:
  image: grafana/grafana-oss:latest
  restart: unless-stopped
  environment:
    GF_INSTALL_PLUGINS: grafana-clickhouse-datasource
    GF_SECURITY_ADMIN_USER: admin
    GF_SECURITY_ADMIN_PASSWORD: admin
    GF_SERVER_ROOT_URL: https://logs.example.com/grafana/
    GF_SERVER_SERVE_FROM_SUB_PATH: "true"
    GF_LIVE_ALLOWED_ORIGINS: https://logs.example.com
  ports:
    - "3000:3000"
  volumes:
    - grafana-data:/var/lib/grafana
    - ./deploy/grafana/provisioning:/etc/grafana/provisioning
  depends_on:
    - clickhouse
```

生产环境不要使用 `latest` 和默认密码，应固定版本并接入统一认证。`GF_SERVER_ROOT_URL` 必须配置为最终对用户可见的 `/grafana/` URL；如果通过本地 5180 或线上反向代理嵌入 iframe，`GF_LIVE_ALLOWED_ORIGINS` 必须包含对应 origin，否则 Grafana Live WebSocket 会持续 403 并反复重连 `/api/live/ws`。

### 7.2 Datasource Provisioning

示例文件：

```yaml
apiVersion: 1

datasources:
  - name: Sudo Log - sudo/sudocode
    type: grafana-clickhouse-datasource
    access: proxy
    isDefault: true
    jsonData:
      server: clickhouse
      port: 8123
      protocol: http
      defaultDatabase: sudo_log_grafana
      username: grafana_sudo_sudocode
      tlsSkipVerify: false
    secureJsonData:
      password: ${GRAFANA_CLICKHOUSE_PASSWORD}
```

落地时以当前插件版本生成的 provisioning JSON/YAML 为准。这个示例表达必须配置的边界：

- 连接内网 ClickHouse。
- 使用只读用户。
- 默认 database 指向 Grafana mart。
- datasource 按 tenant/product 隔离。

## 8. Grafana 变量设计

### 8.1 `tenant_id`

业务 datasource 已经通过 row policy 固定 tenant/product 时，`tenant_id` 可以做隐藏常量：

```text
sudo
```

内部管理员 dashboard 可以用 query variable：

```sql
SELECT DISTINCT tenant_id
FROM grafana_log_metrics_1m
ORDER BY tenant_id
```

### 8.2 `product`

业务 datasource 固定 product 时，`product` 可以做隐藏常量。

内部 dashboard：

```sql
SELECT DISTINCT product
FROM grafana_log_metrics_1m
WHERE tenant_id = '${tenant_id}'
ORDER BY product
```

### 8.3 `tag_key`

只从启用的 registry 或 `grafana_tag_keys_1d` 读取。

```sql
SELECT
  tag_key
FROM grafana_tag_keys_1d
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND day >= toDate(now() - INTERVAL 30 DAY)
GROUP BY tag_key
ORDER BY sum(events) DESC
LIMIT 100
```

### 8.4 `tag_value`

依赖 `tag_key`。

```sql
SELECT
  tag_value
FROM grafana_tag_values_1d
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND tag_key = '${tag_key}'
  AND day >= toDate(now() - INTERVAL 30 DAY)
GROUP BY tag_value
ORDER BY sum(events) DESC
LIMIT 100
```

变量规则：

- `tag_value` 最多返回 100 个候选。
- 不允许对高基数 tag 开启变量。
- 不允许变量查询扫 `grafana_tag_events`。
- 变量默认不包含 All；如果必须启用 All，只能用于聚合表，不能用于 raw logs panel。

## 9. Panel 查询模板

Grafana panel 默认使用 ClickHouse SQL。

### 9.1 日志总量 Time Series

```sql
SELECT
  $__timeInterval(interval_start) AS time,
  sum(events) AS value
FROM grafana_log_metrics_1m
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND $__timeFilter(interval_start)
GROUP BY time
ORDER BY time
```

### 9.2 错误率 Time Series

```sql
SELECT
  $__timeInterval(interval_start) AS time,
  if(sum(events) = 0, 0, sum(errors + fatals) / sum(events)) AS value
FROM grafana_log_metrics_1m
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND $__timeFilter(interval_start)
GROUP BY time
ORDER BY time
```

### 9.3 按 Tag Value 拆分日志量

```sql
SELECT
  $__timeInterval(interval_start) AS time,
  tag_value AS metric,
  sum(events) AS value
FROM grafana_tag_metrics_1m
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND tag_key = '${tag_key}'
  AND tag_value IN (${tag_value:singlequote})
  AND $__timeFilter(interval_start)
GROUP BY time, metric
ORDER BY time
```

### 9.4 Top Tag Values

```sql
SELECT
  tag_value,
  sum(events) AS events,
  sum(errors + fatals) AS errors
FROM grafana_tag_metrics_1m
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND tag_key = '${tag_key}'
  AND $__timeFilter(interval_start)
GROUP BY tag_value
ORDER BY events DESC
LIMIT 20
```

### 9.5 按 Tag Value 拆分错误量

```sql
SELECT
  $__timeInterval(interval_start) AS time,
  tag_value AS metric,
  sum(errors + fatals) AS value
FROM grafana_tag_metrics_1m
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND tag_key = '${tag_key}'
  AND tag_value IN (${tag_value:singlequote})
  AND $__timeFilter(interval_start)
GROUP BY time, metric
ORDER BY time
```

### 9.6 最近日志 Table

Raw logs panel 是可选明细能力，只有 `GRAFANA_DETAIL_EVENTS_ENABLED=true` 时允许发布，并且必须限制时间范围和返回数量。

```sql
SELECT
  timestamp AS log_time,
  level,
  message,
  event_id,
  component,
  version,
  platform,
  tags_json
FROM grafana_log_events
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND $__timeFilter(timestamp)
  AND event_id IN (
    SELECT event_id
    FROM grafana_tag_events
    WHERE tenant_id = '${tenant_id}'
      AND product = '${product}'
      AND tag_key = '${tag_key}'
      AND tag_kv_hash = cityHash64('${tag_key}', '${tag_value}')
      AND tag_value = '${tag_value}'
      AND $__timeFilter(timestamp)
    ORDER BY timestamp DESC
    LIMIT 1000
  )
ORDER BY log_time DESC
LIMIT 200
```

### 9.7 跳转到 Sudo Log Console

Grafana table panel 为 `event_id` 配置 data link：

```text
https://log.sudowork.example.com/console/events/${__data.fields.event_id}?tenant_id=${tenant_id}
```

如果当前 console 详情页路径不同，按实际路由调整。

## 10. Dashboard 模板

第二步至少提供三个 dashboard 模板。

### 10.1 Product Overview

变量：

- `tenant_id`
- `product`
- `environment`
- `level`

Panels：

- Log volume
- Error volume
- Error rate
- Logs by level
- Logs by component
- Logs by version
- Recent errors

默认数据源：

- `grafana_log_metrics_1m`
- `grafana_log_events`

### 10.2 Tags Overview

变量：

- `tenant_id`
- `product`
- `tag_key`
- `tag_value`

Panels：

- Selected tag volume
- Selected tag error rate
- Top tag values
- Error count by tag value
- Recent logs for selected tag

默认数据源：

- `grafana_tag_metrics_1m`
- `grafana_tag_events`
- `grafana_log_events`

### 10.3 Error Drilldown

变量：

- `tenant_id`
- `product`
- `tag_key`
- `tag_value`
- `error_hash`

Panels：

- Errors over time
- Top components
- Top versions
- Top platforms
- Recent error logs
- Links to Sudo Log Console

## 11. Sudo Log Console 嵌入方案

### 11.1 前端菜单

在 `packages/admin` 前端增加一级菜单：

```html
<button class="nav-button" data-view="dashboard">Dashboard</button>
```

推荐放在：

```text
日志检索
错误分组
Dashboard
用户管理
配置管理
系统状态
```

新增视图：

```html
<section id="dashboardView" class="dashboard-view hidden">
  ...
</section>
```

当前控制台已经使用 `data-view` 和 `viewMeta` 控制页面切换，Dashboard 应沿用现有模式：

- `state.activeView = 'dashboard'`
- `viewMeta.dashboard`
- `dashboardView` 加入统一显隐逻辑
- Dashboard 页面不展示日志检索的 `filtersPanel`、`metricsPanel`、`timelinePanel`
- 顶部按钮改为 `刷新`，触发 iframe reload

Dashboard 页面布局：

```text
Topbar
  - title: Dashboard
  - description: Grafana panels for selected tenant/product.
  - action: Panel 管理
  - action: 刷新

Panel grid
  - 已发布的自定义 panels
```

Panel 管理页面：

```text
Left sidebar
  - 返回 Dashboard

Topbar
  - title: Panel 管理
  - description: 配置受控 ClickHouse QL，并发布为 Grafana panel。

Search controls
  - tenant select
  - product select
  - time range select
  - environment input
  - tag_key input
  - tag_value input
  - 刷新

Panel form
  - title
  - panel type
  - height
  - enabled
  - QL
  - 测试 QL
  - 保存面板

Panel table
  - 已保存 panels
  - 编辑 / 重试发布 / 删除
```

### 11.2 嵌入方式

推荐嵌入 Grafana panel，而不是整张 dashboard。

前端 iframe URL 使用后端返回的受控地址：

```html
<iframe
  src="/grafana/d-solo/sw-<panel-dashboard-uid>/<panel-slug>?orgId=1&panelId=1&from=now-6h&to=now&var-tenant_id=sudo&var-product=sudocode&theme=light"
  loading="lazy"
  referrerpolicy="no-referrer"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
></iframe>
```

注意：

- 前端不能自己拼接任意 Grafana URL。
- 前端不能拿到 Grafana service account token。
- iframe `src` 必须来自 Sudo Log 后端 allowlist。
- 所有 Grafana 请求通过 Sudo Log 同源路径 `/grafana/*` 代理。
- 生产不使用公开 snapshot 或 public dashboard 作为默认方案。

推荐采用 panel solo URL：

```text
/grafana/d-solo/{dashboard_uid}/{dashboard_slug}
  ?orgId=1
  &panelId={panel_id}
  &from={from}
  &to={to}
  &var-tenant_id={tenant_id}
  &var-product={product}
  &var-environment={environment}
  &var-tag_key={tag_key}
  &var-tag_value={tag_value}
  &theme=light
```

### 11.3 认证方案

推荐方案：

```text
Browser
  -> Sudo Log Console
  -> /api/grafana/embed-config
  -> /grafana/* reverse proxy
  -> Grafana auth proxy
  -> Grafana dashboard/panel
  -> ClickHouse read-only datasource
```

认证边界：

- 用户先登录 Sudo Log Console。
- Sudo Log 后端验证 JWT/session。
- `/api/grafana/embed-config` 根据当前用户权限返回允许嵌入的 panels。
- `/grafana/*` 代理只接受已登录用户请求。
- 代理向 Grafana 注入受信任的 auth proxy header，例如 `X-WEBAUTH-USER`。该 header 使用 `swlog_embed_<user-id>` 形式的专用嵌入用户名，不直接使用 Sudo 用户名，避免 `admin` 等用户名映射到 Grafana 内置管理员。
- 代理不向 Grafana 透传浏览器侧 Grafana cookie，也不把 Grafana `Set-Cookie` 透出给浏览器；Grafana 鉴权只依赖服务端注入的 auth proxy header。
- Grafana 只把用户当 Viewer。
- ClickHouse datasource 仍然使用 tenant/product 隔离的只读用户和 row policy。

Grafana 配置草案：

```ini
[security]
allow_embedding = true
cookie_samesite = lax

[auth.proxy]
enabled = true
header_name = X-WEBAUTH-USER
header_property = username
auto_sign_up = true

[users]
auto_assign_org_role = Viewer
```

如果 Sudo Log 和 Grafana 不是同站点部署，并且必须跨站点 iframe，应使用 HTTPS，并评估：

```ini
[security]
cookie_secure = true
cookie_samesite = none
```

默认建议通过同源 `/grafana/*` 代理规避第三方 Cookie 和跨站 iframe 问题。

不推荐方案：

- 不推荐在生产使用匿名 Grafana Viewer，除非是完全内部网络、无外部业务方、无敏感数据。
- 不允许把 Grafana API key、service account token 或 ClickHouse 密码放到前端。
- 不允许前端直接访问 Grafana 管理接口。

### 11.4 后端配置 API

新增：

```http
GET /api/grafana/embed-config?tenant_id=sudo&product=sudocode
```

返回：

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "tenant_id": "sudo",
    "product": "sudocode",
    "time_ranges": [
      { "label": "最近 1 小时", "from": "now-1h", "to": "now" },
      { "label": "最近 6 小时", "from": "now-6h", "to": "now" },
      { "label": "最近 24 小时", "from": "now-24h", "to": "now" },
      { "label": "最近 7 天", "from": "now-7d", "to": "now" }
    ],
    "defaults": {
      "from": "now-6h",
      "to": "now",
      "environment": "production",
      "tag_key": "feature",
      "tag_value": ""
    },
    "panels": []
  }
}
```

后端职责：

- 校验当前用户是否有该 tenant/product 的 dashboard 访问权限。
- 只返回用户已保存并发布的自定义 dashboard UID 和 panel ID。
- 对 `tenant_id`、`product`、`environment`、`tag_key`、`tag_value` 做严格转义和白名单校验。
- 统一拼接 iframe URL。
- 隐藏 Grafana 内部 host、datasource、凭据。

### 11.5 嵌入 Panels

Dashboard 页面不再内置默认 Grafana panels。`/api/grafana/embed-config` 只返回当前 tenant/product 下已保存并发布的自定义 panels。

业务侧需要默认视图时，应通过 Console 保存受控 QL panel，并发布为 Grafana solo panel。推荐起步模板仍可以使用以下查询方向：

- Log volume：从 `grafana_log_metrics_1m` 聚合 `sum(events)`。
- Error rate：从 `grafana_log_metrics_1m` 计算 `sum(errors + fatals) / sum(events)`。
- Top tag values：从 `grafana_tag_metrics_1m` 按 `tag_value` 聚合。
- Tag error volume：从 `grafana_tag_metrics_1m` 按 `tag_key/tag_value` 聚合错误量。

Recent logs / event_id drilldown 可以作为自定义 panel，仅在 `GRAFANA_DETAIL_EVENTS_ENABLED=true` 且明细 mart 短 TTL 开启时启用。

### 11.6 前端交互规则

- Dashboard 页面加载时请求 `/api/grafana/embed-config`。
- `Panel 管理` 页面展示 tenant/product/time range/environment/tag_key/tag_value 条件。
- 在 `Panel 管理` 中切换 tenant/product/time range/tag 后重新请求配置，并更新 Dashboard 使用的 panel iframe URL。
- 点击刷新按钮时，对每个 iframe 追加 `_refresh=<timestamp>` 触发刷新。
- 点击右上角 `Panel 管理` 进入独立配置页面，左侧 `返回 Dashboard` 回到 panels 展示页。
- iframe 加载失败时显示当前 panel 的错误占位。
- 如果 `enabled=false`，展示“Dashboard 未启用”的空状态。
- iframe 高度由配置返回，默认 260px，Recent Logs 默认 420px。
- 移动端按单列展示，桌面端 2 列网格。

### 11.7 前端硬规则

- Dashboard 页面不允许用户输入任意 iframe URL。
- Dashboard 页面不允许用户编辑 Grafana SQL；QL 编辑只在 `Panel 管理` 页面开放。
- tenant/product/time range/tag 条件只在 `Panel 管理` 页面配置，并由后端返回的配置约束。
- iframe 必须设置固定 allowlist `sandbox`。
- iframe URL 必须同源 `/grafana/*`。
- Dashboard 菜单对没有 dashboard 权限的用户隐藏。
- Dashboard 页面只能嵌入被管理员或运维用户发布的自定义 panels。
- Panel 配置变更通过后端配置或 Grafana provisioning 管理，不在浏览器本地存储。

### 11.8 具体代码改动范围

前端：

- `packages/admin/src/index.html`
  - 增加 Dashboard nav button。
  - 增加 `dashboardView`。
  - 增加 dashboard controls。
  - 增加 panel grid 容器。
- `packages/admin/src/app.js`
  - `ids` 增加 dashboard 相关元素。
  - `viewMeta` 增加 `dashboard`。
  - `setView` 处理 `dashboardView` 显隐。
  - 新增 `loadGrafanaEmbedConfig()`。
  - 新增 `renderDashboardPanels()`。
  - 新增 `refreshDashboardPanels()`。
  - 根据权限隐藏或展示 Dashboard 菜单。
- `packages/admin/src/styles.css`
  - 增加 dashboard controls 布局。
  - 增加 responsive panel grid。
  - 增加 iframe loading/error/empty 状态样式。

后端：

- 新增 Grafana 配置项：
  - `GRAFANA_ENABLED`
  - `GRAFANA_PUBLIC_BASE_PATH=/grafana`
  - `GRAFANA_INTERNAL_URL=http://grafana:3000`
  - `GRAFANA_DATASOURCE_UID`
  - `GRAFANA_ORG_ID`
- 新增 API：
  - `GET /api/grafana/embed-config`
- 新增代理：
  - `/grafana/* -> GRAFANA_INTERNAL_URL/*`
- 代理职责：
  - 校验 Sudo Log 登录态。
  - 注入 Grafana auth proxy header。
  - 去除客户端伪造的 auth proxy header。
  - 限制只代理 allowlist path，例如 `/d-solo/`、`/public/`、`/api/ds/query` 等 Grafana panel 必需路径。
  - 禁止代理 Grafana admin API。

Grafana provisioning：

- datasource provisioning：ClickHouse 只读 datasource。
- dashboard provisioning：不再创建默认 panels；自定义 panels 由后端通过 Grafana API 发布。
- folder provisioning：按 tenant/product 或业务域隔离。
- org/user provisioning：默认 Viewer 权限。

## 12. 业务自助流程

业务侧从接入到自助 dashboard 的流程：

1. 业务服务通过 `POST /v1/logs/batch` 上报 tags。
2. Sudo Log 校验 tags，写入主日志表和 tags 倒排表。
3. Grafana mart 聚合表产生 1m/1d 数据。
4. 业务负责人在 Sudo Log Console 注册需要用于 Grafana 的 tag key。
5. 管理员或自动化任务启用 `grafana_enabled`、`groupable`、`variable_enabled`。
6. 系统为该 tenant/product 准备 ClickHouse 只读用户和 Grafana datasource。
7. 业务用户在 Dashboard 页面保存受控 QL panel。
8. 后端通过 Grafana API 发布自定义 dashboard/panel。
9. Sudo Log Console 的 Dashboard 菜单通过 `/api/grafana/embed-config` 加载已发布 panels。
10. 如需要查看单条日志详情，从 `event_id` data link 跳转回 Sudo Log Console。

## 13. 硬规则

这些规则必须由服务端、ClickHouse 权限和 Grafana provisioning 共同 enforce。

### 13.1 数据权限

- Grafana datasource 必须使用只读 ClickHouse 用户。
- 业务 datasource 必须按 tenant/product 隔离。
- 业务 datasource 不允许访问 raw tables。
- 业务 datasource 只允许访问 `sudo_log_grafana`。
- 内部跨租户 datasource 必须和业务 datasource 分离。
- Grafana 用户不能共享 ClickHouse 管理员账号。
- Sudo Log Console 的 Dashboard 菜单只能展示当前用户有权访问的 tenant/product。
- `/grafana/*` 代理必须复用 Sudo Log 登录态鉴权。
- Grafana auth proxy header 只能由 Sudo Log 后端或受信任反向代理注入。
- 嵌入态 Grafana 用户必须使用专用 Viewer 身份，禁止复用 Grafana `admin` 或业务可编辑账号。
- `/grafana/*` 代理不允许 annotation 写接口；tooltip 中的 `Add annotation` 这类编辑能力必须对嵌入用户不可见。

### 13.2 查询规则

- 每个 Grafana panel 查询必须包含时间过滤。
- Time series panel 默认查询 `*_metrics_1m` 聚合表。
- Raw logs panel 只能查询 `grafana_log_events` 和 `grafana_tag_events`，且只有明细 mart 开关开启时允许发布。
- Raw logs panel 最大返回 200 行。
- Raw logs panel 默认最大时间范围 24 小时。
- 聚合 panel 默认最大时间范围 30 天。
- 不允许 dashboard panel 使用 `SELECT *`。
- 不允许 panel 查询 `attributes_json`，除非该 dashboard 被明确标记为内部排障用途。
- 不允许变量查询扫描 `grafana_tag_events`。
- 不允许对高基数 tag 做 `GROUP BY tag_value`。
- 不允许 offset 分页。

### 13.3 Tag 规则

- 只有 `grafana_enabled = true` 的 tag key 可以出现在 Grafana mart 聚合表中。
- 只有 `variable_enabled = true` 的 tag key 可以作为变量。
- 只有 `groupable = true` 的 tag key 可以用于 `GROUP BY tag_value`。
- `request_id`、`trace_id`、`session_id`、`user_id`、`device_id` 这类高基数字段默认禁止作为 groupable tag。
- 如果某个 tag value 数量超过 `max_variable_values`，变量只返回 Top N，且 dashboard 需要提示用户缩小范围。

### 13.4 刷新和资源规则

- dashboard 自动刷新最小间隔建议 30 秒，生产默认 1 分钟。
- datasource 查询超时建议 15 秒。
- ClickHouse 用户必须设置 `max_execution_time`、`max_result_rows`、`max_memory_usage`。
- Grafana 查询必须记录 query duration 和错误率。
- 慢查询需要能追溯到 dashboard、panel、datasource、ClickHouse query_id。

## 14. 监控指标

第二步上线后至少监控：

- Grafana panel query count
- Grafana panel query error rate
- Grafana panel query p95/p99 duration
- ClickHouse `read_rows`
- ClickHouse `read_bytes`
- ClickHouse query memory usage
- `grafana_tag_metrics_1m` rows/day
- `grafana_tag_values_1d` distinct values per tag key
- 变量查询耗时
- datasource 认证失败次数

这些指标用于判断：

- 哪些 dashboard 太重。
- 哪些 tag key 基数过高。
- 是否需要限制某个 tag key 进入 Grafana。
- 是否需要把 1m 聚合改成 5m 聚合。
- 是否需要给大租户单独分片或单独 datasource。

## 15. 告警建议

Grafana alerting 可以先支持基于聚合表的简单告警：

### 15.1 错误率告警

```sql
SELECT
  if(sum(events) = 0, 0, sum(errors + fatals) / sum(events)) AS error_rate
FROM grafana_log_metrics_1m
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND interval_start >= now() - INTERVAL 5 MINUTE
```

### 15.2 指定 Tag 错误数告警

```sql
SELECT
  sum(errors + fatals) AS errors
FROM grafana_tag_metrics_1m
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND tag_key = 'feature'
  AND tag_value = 'chat'
  AND interval_start >= now() - INTERVAL 5 MINUTE
```

告警规则：

- 告警只允许查聚合表。
- 告警不允许查 raw logs。
- 告警查询窗口必须固定且较短，例如 5 分钟、10 分钟、15 分钟。

## 16. 执行计划

### 阶段 1：ClickHouse Grafana Mart

- 新增 `sudo_log_grafana` database。
- 新增 `grafana_log_events` 可选明细表，默认不写入，短 TTL。
- 新增 `grafana_tag_events` 可选明细表，默认不写入，短 TTL。
- 新增 `grafana_log_metrics_1m`。
- 新增 `grafana_tag_metrics_1m`。
- 新增 `grafana_tag_keys_1d`。
- 新增 `grafana_tag_values_1d`。
- 写入链路或 materialized view 填充 mart。

### 阶段 2：权限和 datasource

- 创建 ClickHouse 只读 role/user。
- 为每个业务 tenant/product 配置 row policy。
- 新增 Grafana service。
- 安装 `grafana-clickhouse-datasource` 插件。
- 配置 datasource provisioning。
- 验证业务用户不能访问 raw tables。

### 阶段 3：Grafana Datasource 和 Panel 模板

- 提供 Product Overview QL 模板。
- 提供 Tags Overview QL 模板。
- 提供 Error Drilldown QL 模板。
- 不再 provision 默认嵌入 panels。
- 可选明细 panel 才配置 event_id data link 到 Sudo Log Console。
- 提供常用 SQL snippets。

### 阶段 4：Sudo Log Console Dashboard 菜单

- 前端新增 `Dashboard` nav。
- 前端新增 `dashboardView`。
- 前端新增 `Panel 管理` 页面入口和返回 Dashboard 按钮。
- 后端新增 `/api/grafana/embed-config`。
- 后端新增 `/grafana/*` reverse proxy。
- Grafana 启用 `allow_embedding` 和 auth proxy。
- Dashboard 页面只嵌入已发布的自定义 panels。
- Dashboard 页面支持 tenant/product/time range/tag_key/tag_value 控制。
- Dashboard 页面支持 iframe 刷新和错误占位。

### 阶段 5：Tag Registry 和自助流程

- PostgreSQL 新增 `grafana_tag_registry`。
- Console 增加 Grafana tag key 管理。
- 支持启用 `grafana_enabled`、`groupable`、`variable_enabled`。
- 变量查询只返回启用的 tag key/value。
- 增加高基数 tag 检测和提示。

### 阶段 6：上线验证

- 用生产形态数据压测 1h、24h、7d、30d 查询。
- 验证所有模板 panel 查询都走聚合表。
- 验证变量查询 p95。
- 验证 row policy。
- 验证 Grafana datasource 不能写入 ClickHouse。
- 验证 data link 可以跳转到日志详情。
- 验证 Sudo Log Console Dashboard 菜单只展示有权限的 panels。
- 验证浏览器中不存在 Grafana token、ClickHouse 密码或 datasource 凭据。

## 17. 验收标准

第二步完成后，应满足：

- 业务日志带 tags push 后，Grafana 5 分钟内可见聚合数据。
- Sudo Log Console 左侧出现 Dashboard 菜单。
- Dashboard 页面未发布自定义 panel 时不展示默认 panels。
- Dashboard 页面切换 tenant/product/time range/tag 后，已发布 panels 按选择刷新。
- `admin`/`operator` 可以在 Dashboard 页面保存自定义 QL panel，后端自动发布为 Grafana solo panel 并嵌入当前页面。
- 自定义 QL 只能查询 `sudo_log_grafana` mart allowlist 表，必须包含 tenant/product/time filter，不允许写语句、跨库查询、`SELECT *` 或多语句。
- 常规 panel 查询 p95 小于 2 秒。
- 变量查询 p95 小于 2 秒。
- 默认不开启明细 mart；只有 `GRAFANA_DETAIL_EVENTS_ENABLED=true` 时才允许自定义 QL 查询短 TTL 明细表，明细查询必须带 `LIMIT`，p95 目标小于 5 秒。
- 业务 datasource 无法访问 raw tables。
- 业务 datasource 无法跨 tenant/product 查询。
- 高基数 tag 不会默认出现在 group by panel 中。
- dashboard 能通过 `event_id` 跳转回 Sudo Log Console。
- 前端源码、localStorage、iframe URL 中不包含 Grafana token 或 ClickHouse 凭据。

## 18. 当前代码落地范围

本次代码实现覆盖阶段 1 到阶段 4 的可运行 v1：

- ClickHouse 初始化时创建 `sudo_log_grafana` mart database 和 6 张 Grafana 表。
- 日志 flush 写入 raw tables 后，默认只同步写入 Grafana 1m 聚合表和 1d tag 变量表；`grafana_log_events`/`grafana_tag_events` 仅在 `GRAFANA_DETAIL_EVENTS_ENABLED=true` 时短 TTL 写入。
- ClickHouse 自动创建 `grafana_reader` 只读用户，只授予 Grafana mart database 的 `SELECT` 权限，不授予 raw database 权限。
- Docker Compose 增加 Grafana 服务，安装 `grafana-clickhouse-datasource` 插件，启用 `allow_embedding` 和 auth proxy。
- 增加 Grafana datasource provisioning；不再 provision 默认 `Sudo Tags Overview` dashboard，也不再返回固定内置 panels。
- 后端增加 `/api/grafana/embed-config`，只为已登录且具备 `logs:read` 的用户返回 allowlist panel URL。
- 后端增加 `/grafana/*` 同源反向代理，复用 Sudo Log 登录态签发的 HttpOnly embed cookie，过滤 Grafana admin API 和 annotation 写接口，并只注入服务端可信 auth proxy header；本地 dev server 和后端都支持 `/grafana/api/live/ws` WebSocket Upgrade 代理。
- Console 增加 Dashboard 菜单和视图，支持 tenant/product/time range/environment/tag_key/tag_value 控制、iframe 刷新和 disabled/empty/error 状态。
- 存储默认策略：`GRAFANA_DETAIL_EVENTS_ENABLED=false`、`GRAFANA_DETAIL_TTL_DAYS=7`、`GRAFANA_METRICS_TTL_DAYS=30`。
- 当前没有生产数据，ClickHouse 表结构不做在线升级，启动时只执行最新 `CREATE TABLE IF NOT EXISTS` 建表语句；本地旧结构 dev 数据库需要手动删除后重建。

本次新增自定义 QL panel 能力：

- PostgreSQL 新增 `grafana_custom_panels`，保存 tenant/product 维度的自定义 panel。
- `admin` 和 `operator` 拥有 `dashboards:write`，可以在 Dashboard 页面测试、保存、编辑和删除自定义 QL panel；保存成功后后端自动发布，只有发布失败或未发布时前端才展示“重试发布”。
- 保存 QL 时服务端校验：只允许单条 `SELECT`，只允许查询 `sudo_log_grafana` mart allowlist 表，必须包含 `tenant_id = '${tenant_id}'`、`product = '${product}'` 和 `$__timeFilter(...)`。
- `测试 QL` 不落库：后端先执行同一套硬规则校验，再把 `${tenant_id}`、`${product}`、`${tag_key}`、`${tag_value}`、`${environment}` 和常用 Grafana time macros 替换为当前 Dashboard 条件，在 Grafana mart database 中包一层 `LIMIT 20` 返回样例行。
- `预览面板` 不落库：后端使用同一套 QL 硬规则校验，把当前表单发布到当前用户固定的临时 Grafana dashboard UID，并返回 solo panel iframe URL；该临时 panel 不写入 `grafana_custom_panels`，不会出现在 Dashboard 列表中。
- 默认自定义 QL 只允许聚合 mart 表；`grafana_log_events` / `grafana_tag_events` 只有 `GRAFANA_DETAIL_EVENTS_ENABLED=true` 时允许查询。
- 后端保存后通过 Grafana API 生成一个单 panel dashboard，并把该 dashboard 的 solo panel URL 合并到 `/api/grafana/embed-config` 返回结果。
- 前端不允许输入任意 iframe URL，不保存 Grafana token，不直接暴露 Grafana datasource 凭据。

当前 v1 尚未落地阶段 5 的 Tag Registry 和 tenant/product 级 datasource 自动编排，因此生产对外开放业务自助编辑 Grafana dashboard 前，仍必须补齐：

- `grafana_tag_registry` 配置表和 Console 管理入口。
- 只允许 registry 中 `grafana_enabled/groupable/variable_enabled` 的 tag key 进入 Grafana 变量和 group by。
- 按外部业务方拆分 Grafana datasource、ClickHouse user/role 和 row policy。
- 对业务 Grafana Editor 权限做独立授权，默认嵌入 Dashboard 仍按 `logs:read` 控制。

## 19. 参考资料

- Grafana ClickHouse data source plugin documentation: https://grafana.com/docs/plugins/grafana-clickhouse-datasource/latest/
- Grafana ClickHouse query builder and macros: https://clickhouse.com/docs/integrations/grafana/query-builder
- Grafana ClickHouse data source provisioning example: https://grafana.com/docs/plugins/grafana-clickhouse-datasource/latest/setup/provision/
- Grafana ClickHouse troubleshooting: https://grafana.com/docs/plugins/grafana-clickhouse-datasource/latest/troubleshooting/
- Grafana data source provisioning: https://grafana.com/docs/grafana/latest/administration/provisioning/
- Grafana share dashboards and panels: https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/
- Grafana embedded dashboard options: https://grafana.com/blog/how-to-embed-grafana-dashboards-into-web-applications/
- Grafana auth proxy: https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/auth-proxy/
- ClickHouse Grafana integration guide: https://clickhouse.com/docs/integrations/grafana
- ClickHouse row policy: https://clickhouse.com/docs/sql-reference/statements/create/row-policy
