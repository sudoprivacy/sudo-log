# Tags Search 最终方案

## 1. 背景

业务侧需要在日志上报时传入自定义 tags，并在日志系统内通过 `key:value` 精确搜索日志。

tags 和当前 `attributes` 都是业务上下文，但职责不同：

- `tags`：用于检索、筛选、聚合，必须受约束。
- `attributes`：用于详情展示和排障上下文，不承诺高效搜索。

最终方案不把 tags 继续塞进 JSON 后运行时解析，而是把 tags 作为 ClickHouse 内的倒排索引数据建模。

## 2. 目标

- 支持业务上报自定义 tags。
- 支持按一个或多个 `tag_key:tag_value` 搜索日志。
- 支持大数据量下稳定检索，不依赖扫描 `attributes_json`。
- 查询结果继续返回完整日志行。
- 不考虑历史数据迁移，只对新增数据生效。

## 3. 非目标

- 不做 tags 模糊搜索。
- 不做 tag value substring 搜索。
- 不做无时间范围的全量 tag 搜索。
- 不把任意 JSON path 查询纳入 tags 能力。
- 不用 tags 替代已有结构化字段，例如 `tenant_id`、`product`、`level`、`timestamp`、`user_identifier_hash`、`trace_id`。

## 4. API 设计

### 4.1 写入

`POST /v1/logs/batch`

```json
{
  "logs": [
    {
      "tenant_id": "sudo",
      "product": "sudocode",
      "level": "info",
      "message": "model request completed",
      "tags": {
        "feature": "chat",
        "channel": "beta",
        "plan": "pro"
      },
      "attributes": {
        "prompt_tokens": 1200,
        "completion_tokens": 300
      }
    }
  ]
}
```

服务端归一化后写入：

- 主日志表：完整日志行，包含 `tags_json` 和 `tags_kv`。
- error 专用表：error/fatal 日志子集，包含同样 tags 字段。
- event lookup 表：按 `event_id` 查详情，包含同样 tags 字段。
- tags 倒排表：每个 tag 展开成一行，用于搜索。

### 4.2 搜索

推荐查询参数：

```http
GET /v1/logs/search?tenant_id=sudo&product=sudocode&start_time=...&end_time=...&tag=feature:chat&tag=plan:pro
```

默认语义：

```text
tag=feature:chat AND tag=plan:pro
```

后续可以扩展：

```http
tag_mode=all
tag_mode=any
```

其中：

- `all`：所有 tags 都必须命中，默认值。
- `any`：任意一个 tag 命中即可。

## 5. 数据建模

### 5.1 主日志表新增字段

现有三张日志表都新增：

```sql
tags_json String,
tags_kv Array(String),
INDEX idx_tags_kv tags_kv TYPE bloom_filter(0.01) GRANULARITY 4
```

字段用途：

- `tags_json`：详情页展示原始 tags。
- `tags_kv`：轻量返回、调试和辅助过滤。
- `idx_tags_kv`：辅助型 Bloom skip index，不作为 tags search 主路径。

`tags_kv` 使用稳定编码，避免 `:`、`=` 等业务字符造成歧义：

```text
key\x1Fvalue
```

其中 `\x1F` 是 ASCII Unit Separator。

### 5.2 Tags 倒排表

tags search 的主路径使用独立倒排表。

```sql
CREATE TABLE IF NOT EXISTS sudo_log_tags
(
  timestamp DateTime64(3, 'UTC'),
  received_at DateTime64(3, 'UTC') DEFAULT now64(3),
  event_id String,

  tenant_id LowCardinality(String),
  product LowCardinality(String),

  tag_key LowCardinality(String),
  tag_value String,
  tag_kv String,
  tag_kv_hash UInt64 MATERIALIZED cityHash64(tag_key, tag_value),

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
TTL toDateTime(timestamp) + INTERVAL 30 DAY;
```

设计原因：

- `tenant_id`、`product` 放在最前面，贴合多租户和产品维度查询。
- `tag_key`、`tag_kv_hash` 紧跟其后，服务 `key:value` 精确检索。
- `timestamp` 放入排序键，服务时间范围裁剪和按时间倒序返回。
- `event_id` 保证同一时间戳下排序稳定，也作为回表键。
- `tag_kv_hash` 由 `tag_key` 和 `tag_value` 计算，降低长字符串比较成本。
- `tag_kv`、`tag_key`、`tag_value` 保留原值，用于精确校验和返回。
- 常用过滤列在倒排表中冗余，避免 tags 查询后再回主表才能过滤。

## 6. 写入策略

每条日志写入时，服务端执行：

1. 校验并归一化 `tags`。
2. 写入主日志表。
3. 如果是 error/fatal，写入 error 专用表。
4. 写入 event lookup 表。
5. 将 tags 展开写入 `sudo_log_tags`。

示例：

```json
{
  "event_id": "evt-1",
  "tags": {
    "feature": "chat",
    "plan": "pro"
  }
}
```

写入倒排表：

```text
event_id=evt-1, tag_key=feature, tag_value=chat, tag_kv=feature\x1Fchat
event_id=evt-1, tag_key=plan,    tag_value=pro,  tag_kv=plan\x1Fpro
```

写入放大：

```text
tag_rows = log_rows * avg_tags_per_log
```

例如：

```text
1 亿 logs/day * 平均 5 个 tags = 5 亿 tag rows/day
```

这是 tags 检索能力的主要成本。这个成本必须显式接受，因为 tags search 本质上是倒排索引问题。

## 7. 查询策略

### 7.1 单 tag 查询

第一步，从倒排表取候选事件：

```sql
SELECT
  event_id,
  timestamp
FROM sudo_log_tags
WHERE tenant_id = 'sudo'
  AND product = 'sudocode'
  AND tag_key = 'feature'
  AND tag_kv_hash = cityHash64('feature', 'chat')
  AND tag_value = 'chat'
  AND timestamp >= toDateTime64('2026-06-08 00:00:00', 3, 'UTC')
  AND timestamp < toDateTime64('2026-06-09 00:00:00', 3, 'UTC')
ORDER BY timestamp DESC, event_id DESC
LIMIT 500;
```

第二步，使用 `event_id` 回 `sudo_log_event_lookup` 查完整日志：

```sql
SELECT *
FROM sudo_log_event_lookup
WHERE tenant_id = 'sudo'
  AND event_id IN (...)
ORDER BY timestamp DESC, event_id DESC
LIMIT 500;
```

服务端应优先采用两段式查询，而不是直接对主日志表扫 `tags_json`。

### 7.2 多 tag AND 查询

例如：

```text
feature:chat AND plan:pro
```

候选事件查询：

```sql
SELECT
  event_id,
  max(timestamp) AS last_timestamp
FROM sudo_log_tags
WHERE tenant_id = 'sudo'
  AND product = 'sudocode'
  AND timestamp >= toDateTime64('2026-06-08 00:00:00', 3, 'UTC')
  AND timestamp < toDateTime64('2026-06-09 00:00:00', 3, 'UTC')
  AND (
    (
      tag_key = 'feature'
      AND tag_kv_hash = cityHash64('feature', 'chat')
      AND tag_value = 'chat'
    )
    OR
    (
      tag_key = 'plan'
      AND tag_kv_hash = cityHash64('plan', 'pro')
      AND tag_value = 'pro'
    )
  )
GROUP BY event_id
HAVING countDistinct(tag_kv_hash) = 2
ORDER BY last_timestamp DESC, event_id DESC
LIMIT 500;
```

然后按 `event_id` 回表获取完整日志。

前提：

- 单条日志内 tag key 必须唯一。
- 查询中的 tags 必须先在服务端去重。

### 7.3 多 tag OR 查询

例如：

```text
feature:chat OR plan:pro
```

查询方式和 AND 类似，但不需要 `HAVING countDistinct(...) = N`：

```sql
SELECT
  event_id,
  max(timestamp) AS last_timestamp
FROM sudo_log_tags
WHERE tenant_id = 'sudo'
  AND product = 'sudocode'
  AND timestamp >= toDateTime64('2026-06-08 00:00:00', 3, 'UTC')
  AND timestamp < toDateTime64('2026-06-09 00:00:00', 3, 'UTC')
  AND (
    (
      tag_key = 'feature'
      AND tag_kv_hash = cityHash64('feature', 'chat')
      AND tag_value = 'chat'
    )
    OR
    (
      tag_key = 'plan'
      AND tag_kv_hash = cityHash64('plan', 'pro')
      AND tag_value = 'pro'
    )
  )
GROUP BY event_id
ORDER BY last_timestamp DESC, event_id DESC
LIMIT 500;
```

### 7.4 分页

tags search 不支持 offset 分页，只支持 search-after 游标。

第一页：

```sql
ORDER BY timestamp DESC, event_id DESC
LIMIT 500
```

下一页增加：

```sql
AND (
  timestamp < toDateTime64('2026-06-08 12:00:00.123', 3, 'UTC')
  OR (
    timestamp = toDateTime64('2026-06-08 12:00:00.123', 3, 'UTC')
    AND event_id < 'last-event-id'
  )
)
```

游标内容：

```json
{
  "timestamp": "2026-06-08 12:00:00.123",
  "event_id": "last-event-id"
}
```

## 8. 硬规则

这些规则必须由服务端 enforce，不能只写在文档里。

### 8.1 写入规则

- `tags` 只能是一层对象。
- tag key 必须是字符串。
- tag value 只允许 `string`、`number`、`boolean`。
- tag value 不允许对象、数组、null。
- tag key 归一化为小写。
- tag key 去除首尾空格。
- string tag value 去除首尾空格。
- 空 key 和空 value 直接拒绝。
- 单条日志最多允许 20 个 tags。
- tag key 最长 64 字符。
- tag value 最长 256 字符。
- 单条日志 tags JSON 序列化后最大 4096 字节。
- 单条日志内 tag key 必须唯一。
- tag key 只允许匹配：`^[a-z0-9_.-]+$`。
- tag key 不允许包含 `:`，因为查询 API 使用 `tag=key:value` 语法。
- 保留字段不能作为 tag key：
  - `tenant_id`
  - `product`
  - `timestamp`
  - `level`
  - `topic`
  - `environment`
  - `user_identifier`
  - `user_identifier_hash`
  - `user_id`
  - `user_id_hash`
  - `device_id`
  - `device_id_hash`
  - `session_id`
  - `conversation_id`
  - `trace_id`
  - `component`
  - `version`
  - `platform`
  - `arch`
  - `message`
  - `error_hash`
  - `stack_hash`
  - `attributes`
  - `tags`

### 8.2 建模规则

- 高频固定字段必须建独立列，不允许长期伪装成 tag。
- `level`、`environment`、`product` 这类字段必须继续走结构化列。
- `trace_id`、`session_id`、`conversation_id` 这类链路字段必须继续走结构化列。
- 大文本、payload、嵌套对象必须放 `attributes` 或 blob，不允许放 tags。
- 高唯一性业务 ID 如果会高频检索，应评估建独立列，而不是无限制放 tags。
- tags 不做脱敏豁免，仍然走敏感信息校验和脱敏策略。

### 8.3 查询规则

- tags search 必须带 `tenant_id`。
- tags search 必须带 `start_time` 和 `end_time`。
- tags search 默认必须带 `product`。
- 不带 `product` 的跨产品 tags search 默认拒绝。
- 如确实需要跨产品查询，必须单独建设跨产品倒排表或 projection。
- 单次查询时间范围默认最大 7 天。
- 管理员或内部任务可以放宽到 30 天，但必须显式配置。
- 单次查询最多允许 5 个 tags 条件。
- tag 条件必须是完整 `key:value`。
- 不支持只按 tag key 搜索。
- 不支持只按 tag value 搜索。
- 不支持 tag value 模糊搜索。
- 默认 `tag_mode=all`。
- `tag_mode=any` 需要显式传入。
- `limit` 默认 100，最大 500。
- 不支持 offset。
- 必须使用 `(timestamp, event_id)` search-after 游标分页。
- 对低选择性 tag 不承诺低延迟，例如 `env:prod`、`plan:free`、`channel:stable`。
- 如果查询命中候选量过大，API 应返回可理解的 400/422 错误，要求用户缩小时间范围或增加过滤条件。

### 8.4 运维规则

- tags 倒排表 TTL 必须和主日志表保持一致。
- tags 倒排表必须按天分区。
- tags 倒排表写入失败时，本批日志应按整体失败或进入重试队列，不能出现主日志成功但 tag 索引永久缺失。
- tags 查询必须记录 `read_rows`、`read_bytes`、`query_duration_ms`、`result_rows`。
- 上线后必须用 `EXPLAIN indexes=1` 验证 tags 查询是否命中主键裁剪。
- 查询监控中发现低选择性 tags 高频出现时，应推动业务改成结构化字段或加更窄过滤条件。
- 不允许对 `attributes_json` 做生产级 tags search。

## 9. 大数据量支撑策略

### 9.1 单机阶段

单机 ClickHouse 可以先承载中小规模 tags search，前提是：

- 查询贴合排序键。
- 强制时间范围。
- 强制租户和产品。
- 控制 tag 数量和 tag value 长度。
- 查询限制返回条数。

主瓶颈不是 ClickHouse 是否能扫，而是低选择性 tag 会产生巨大候选集。

### 9.2 集群阶段

当 tag rows 达到亿级/天或单机磁盘、CPU、查询延迟接近上限时，升级为：

```text
Distributed table
  -> ReplicatedMergeTree local table on shard 1
  -> ReplicatedMergeTree local table on shard 2
  -> ...
```

分片建议：

- 多租户且租户规模较均匀：按 `cityHash64(tenant_id, product)` 分片。
- 少数大租户占绝大多数流量：按 `cityHash64(tenant_id, product, event_id)` 分片，避免热点 shard。

取舍：

- 按 `tenant_id, product` 分片可以减少跨 shard 查询，但容易遇到大租户热点。
- 加 `event_id` 分片能摊平写入和存储，但查询会广播到更多 shard。

无论使用哪种分片，本地表仍然使用同样的 `ORDER BY`，保证每个 shard 内可以用排序键裁剪。

## 10. 为什么不用其他方案

### 10.1 不只用 attributes_json

`attributes_json` 适合详情展示，不适合稳定检索。运行时解析 JSON 会让查询成本随数据量线性上升，无法作为 tags search 主路径。

### 10.2 不只用 Map(String, String)

`Map` 适合表达 key/value，但不是最终检索优化手段。对动态 key/value 的高频精确搜索，倒排表更稳定。

### 10.3 不只用 Array(String) + Bloom index

`Array(String) + bloom_filter` 可以作为辅助优化，但 Bloom skip index 只能跳过 granule，不是行级倒排索引。

如果某个 tag 出现在大多数 granule，Bloom index 的收益会明显下降。最终主路径仍然应该是倒排表。

### 10.4 不引入 OpenSearch/Quickwit 作为 v1 tags 主路径

当前需求是结构化 `key:value` 精确搜索，不是全文检索。ClickHouse 倒排表可以在现有架构内解决，不需要为 tags search 单独引入新的搜索系统。

全文搜索、message 搜索、模糊搜索可以后续由 Quickwit/OpenSearch 承担。

## 11. 推荐落地顺序

1. 在类型层新增 `tags` 入参。
2. 新增 tags 校验、归一化和脱敏。
3. 主日志表、error 表、event lookup 表新增 `tags_json`、`tags_kv`。
4. 新增 `sudo_log_tags` 倒排表。
5. 写入队列 flush 时同时写主表和倒排表。
6. `GET /v1/logs/search` 支持 `tag` 和 `tag_mode`。
7. `GET /v1/logs/errors/summary` 支持同样的 tags 过滤。
8. 查询路径改为 tags 倒排表取候选 `event_id`，再回 event lookup 表。
9. 控制台增加 tags 输入和详情展示。
10. 增加 tags 查询监控指标。
11. 用生产形态数据压测单 tag、多 tag AND、多 tag OR 查询。

## 12. 最终结论

最终 tags 方案是：

```text
写入：
  logs.tags -> tags_json + tags_kv
            -> sudo_log_tags 展开行

查询：
  tag key:value -> sudo_log_tags 倒排检索
                -> event_id
                -> sudo_log_event_lookup 回表

规则：
  强制 tenant_id + product + time range
  限制 tag 数量、长度、查询范围和分页方式
  attributes 只做上下文，不做 tags search
```

这个方案把 tags search 的成本前置到写入和存储上，换取大数据量下更稳定的查询效率。
