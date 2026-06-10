# Sudowork Log 实施方案

## 1. 背景

Sudowork 产品体系需要一套统一日志系统。当前优先级是先把 `sudo-log` 建成独立、专业、可自服务排障的日志系统，再接入 Sudowork、SudoRouter、SudoCode、内部服务与第三方系统。

当前目标不是复制完整 ELK/CLS，而是先做一套可控、低复杂度、可演进的日志底座：

- 结构化日志采集
- 可配置日志等级
- error/fatal 堆栈详情
- 按用户、时间、产品、组件、版本检索
- 内置日志控制台，支持事件检索、时间线、错误聚合与详情排查
- 登录、权限、JWT access token、Redis session registry
- PostgreSQL 配置库存储用户、租户、产品和 API Key
- 后续可接 Kafka、OpenTelemetry、Quickwit/OpenSearch、告警与三方 Webhook

## 2. 推荐架构

```text
Sudowork / SudoRouter / SudoCode / Third-party SDK
        |
        v
Sudowork Log Gateway
- 鉴权
- 租户与产品线映射
- schema 校验
- 脱敏
- 限流
- error 归一化
        |
        +--> Sudowork Log Console
        |    - Discover 查询
        |    - Timeline 概览
        |    - Error groups
        |    - Event detail / stack
        |
        v
Kafka / Redpanda
- v1 可跳过
- 中规模生产引入
- 削峰、重试、回放、解耦写入
        |
        v
ClickHouse
- 结构化日志主存储
- 高频查询
- 聚合统计
- 告警查询
        |
        v
Redis
- JWT session registry
- 管理端会话撤销
- Redis 日志队列
        |
        v
PostgreSQL
- 用户配置
- 租户 / 产品 / API Key 配置
        |
        v
Object Storage / Blob Storage
- 完整 stack
- 大 payload
- 原始上下文冷存储
```

v1 的实际部署先采用：

```text
Client / curl / future SDK -> Sudowork Log Gateway -> Redis queue -> ClickHouse
                           -> PostgreSQL config
                           -> local blob volume
                           -> built-in console
```

这样先把日志系统本身闭环：能写入、能查询、能聚合、能在控制台排查。Sudowork 和其他系统后续只需要作为日志生产方接入。

## 3. 为什么选择 ClickHouse

Sudowork Log 的核心查询是：

- 某个用户某时间段的 error 日志
- 某版本/平台/组件的错误趋势
- 某个 error_hash 的聚合次数和影响用户数
- 某个 session_id/trace_id 的上下文日志

这些都是典型的 “时间范围 + 结构化字段过滤 + 聚合” 查询。ClickHouse 的列式存储、MergeTree 排序键、分区、稀疏主键索引和跳数索引适合这个场景。

关键点是：不要把字段塞进一段 JSON 再运行时解析。`tenant_id`、`product`、`level`、`user_identifier_hash`、`user_id_hash`、`timestamp`、`component`、`error_hash`、`session_id`、`trace_id` 必须是独立列。

## 4. v1 能力范围

必须完成：

- `POST /v1/logs/batch` 批量写入
- `GET /v1/logs/search` 结构化检索
- `GET /v1/logs/events/:event_id` 详情查询
- `GET /v1/logs/errors/summary` error 聚合
- `GET /v1/logs/blobs?ref=...` stack blob 读取
- 内置 `/console` 日志控制台
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/logout-all`
- `POST /api/auth/change-password`
- `/api/users` 用户管理 API
- `/api/settings/tenants` 租户、产品和 API Key 管理 API
- `GET /api/system/health`
- Redis session registry
- PostgreSQL 配置库与内存配置缓存
- error stack 提取与存储
- token 鉴权
- 基础脱敏
- Docker Compose 一键部署

暂不做：

- 多租户控制台权限体系
- Kafka 生产链路
- Quickwit/OpenSearch 全文搜索
- 告警通知
- SSO/企业管理员权限体系
- 高可用集群部署

## 5. 数据模型

### 标准日志事件

```json
{
  "event_id": "uuid",
  "timestamp": "2026-06-03T10:00:00.000Z",
  "level": "error",
  "tenant_id": "sudo",
  "product": "sudowork",
  "topic": "error",
  "environment": "production",
  "version": "0.2.4",
  "platform": "darwin",
  "arch": "arm64",
  "user_identifier_hash": "64-char-lowercase-sha256",
  "user_id_hash": "64-char-lowercase-sha256",
  "device_id_hash": "64-char-lowercase-sha256",
  "session_id": "optional",
  "conversation_id": "optional",
  "trace_id": "optional",
  "component": "CrashReporter",
  "message": "Renderer exception captured",
  "error_name": "TypeError",
  "error_message": "Cannot read properties of undefined",
  "error_hash": "64-char-lowercase-sha256",
  "stack_hash": "64-char-lowercase-sha256",
  "stack_ref": "blob://stacks/...",
  "attributes": {}
}
```

### ClickHouse 主表

`sudo_logs` 保存所有日志。

排序键：

```sql
ORDER BY (tenant_id, product, level, user_identifier_hash, user_id_hash, timestamp, component, error_hash)
```

这个顺序服务于第一期主路径：

```sql
WHERE tenant_id = ?
  AND product = ?
  AND level = 'error'
  AND user_identifier_hash = ?
  AND user_id_hash = ?
  AND timestamp >= ?
  AND timestamp < ?
```

### Error 专用表

`sudo_error_logs` 保存 error/fatal 子集。error 是诊断系统核心路径，不建议每次都从全量表里过滤。

### Event Lookup 表

`sudo_log_event_lookup` 按 `(tenant_id, event_id)` 排序，给详情页用。否则按 event_id 查全量日志不走主排序键，长期会变慢。

## 6. API 设计

### 批量上报

`POST /v1/logs/batch`

请求：

```json
{
  "logs": [
    {
      "level": "error",
      "tenant_id": "sudo",
      "product": "sudowork",
      "component": "CrashReporter",
      "message": "Renderer exception captured",
      "user_identifier": "user@example.com",
      "user_id": "raw-user-id",
      "error": {
        "name": "TypeError",
        "message": "Cannot read properties of undefined",
        "stack": "..."
      }
    }
  ]
}
```

响应：

```json
{
  "success": true,
  "received": 1,
  "event_ids": ["..."]
}
```

### 检索

`GET /v1/logs/search`

必须带：

- `tenant_id`
- `start_time`
- `end_time`

可选：

- `product`
- `level`
- `user_identifier`，后端 hash 后查询
- `user_id`，后端 hash 后查询
- `component`
- `session_id`
- `trace_id`
- `limit`

### 详情

`GET /v1/logs/events/:event_id?tenant_id=sudo`

### Error 聚合

`GET /v1/logs/errors/summary`

聚合维度第一期按 `error_hash`。

### Stack blob

`GET /v1/logs/blobs?ref=blob://stacks/<event_id>.txt`

第一期只允许读取 Gateway 自己写出的 stack blob，避免把 blob API 变成任意文件读取能力。

### Auth

控制台使用登录态，不复用租户 API Key 作为人机访问凭证。

```text
Browser -> /api/auth/login -> JWT access token
                         -> Redis session:<user_id>:<jti>
Browser -> /v1/logs/search Authorization: Bearer <jwt>
Gateway -> verify JWT signature + exp
        -> check Redis session exists
        -> check user exists and enabled
        -> check permission
```

第一期权限：

- `logs:read`
- `logs:write`
- `system:read`
- `settings:write`
- `users:manage`

Redis 负责 session registry 和日志队列。PostgreSQL 负责用户、租户、产品和 API Key 配置。租户配置会在 Gateway 内存缓存，配置增删改后同步刷新缓存，避免每次上报查询 PostgreSQL。

## 7. 控制台设计

`/console` 是 sudo-log 自带的专业日志系统页面，不依赖 Sudowork 或其他产品项目。

第一期控制台能力：

- Discover：按 tenant、product、topic、environment、level、user、session、trace、时间范围查询事件；tenant 与 product 级联下拉，来自 PostgreSQL 配置缓存。
- Timeline：按当前查询结果展示时间分布，并区分 error/fatal。
- Event detail：查看结构化字段、message、attributes、原始行数据。
- Stack inspection：通过受保护的 blob API 查看脱敏后的 stack。
- Error Groups：按 `error_hash` 聚合，展示 occurrences、last_seen、error_name、error_message、component、version。
- Users：管理用户名、邮箱、角色、启停状态和密码重置。
- Settings：管理租户、产品和 API Key。
- System：查看 ClickHouse、PostgreSQL、Redis session、JWT auth、Redis queue 基础状态。

控制台的边界：

- 它是 sudo-log 的内置运维/排障 UI，不是某个业务产品的设置页。
- 控制台使用用户名密码登录、JWT access token 和 Redis session registry；机器写入只使用租户 API Key。
- 当前提供基础角色权限；SSO、组织级多租户授权放到后续阶段。
- 当前主查询依赖 ClickHouse 结构化字段；自由文本全文搜索放到 Quickwit/OpenSearch 阶段。

## 8. Sudowork 客户端接入

Sudowork 接入应发生在 sudo-log 自身日志系统能力稳定之后。Sudowork 只作为日志生产方和部分诊断入口，不承担 sudo-log 控制台职责。

### 主进程

改造现有 main logger：

- 保留本地文件写入
- 新增 `LogBatchReporter`
- error/fatal 自动上传
- warn/info/debug 由远程配置控制
- 本地缓存 7 天或 50MB

### Renderer

通过 preload 暴露：

- `logError`
- `logWarn`
- `addLogContext`

采集：

- ErrorBoundary
- `window.onerror`
- `unhandledrejection`
- 渲染进程崩溃事件

### 采集等级

默认：

```text
error: on
warn/info/debug: off
trace: disabled
```

用户设置页：

```text
诊断日志
- 关闭
- 仅 Error
- Warn 及以上
- Info 及以上
- Debug 及以上
```

## 9. 脱敏规则

客户端和 Gateway 都必须做脱敏，不能只依赖客户端。

默认禁止上传：

- prompt 全文
- 文件正文
- 模型完整响应
- API Key
- Authorization header
- Cookie
- Secret
- 用户 home 目录完整路径

允许上传：

- 明文用户标识 / 用户 ID / 设备 ID，由 Gateway hash 后入库
- 或按统一算法生成的用户标识 hash / 用户 ID hash / 设备 ID hash
- session/conversation/trace ID
- 脱敏 stack
- error name/message/top frame
- 版本、平台、架构

## 10. 后续演进

### V2 引入 Kafka/Redpanda

```text
Gateway -> Redpanda -> ClickHouse Consumer
                  -> Quickwit Consumer
                  -> Alert Consumer
```

收益：

- 削峰
- 重放
- 重建索引
- 多下游分发

### V3 引入 Quickwit/OpenSearch

用于：

- 自由文本 message 搜索
- stack 函数名搜索
- 长期冷数据全文搜索

ClickHouse 仍做结构化主查询。

### V4 三方接入

- TypeScript SDK
- Rust SDK
- 租户级 API Key
- OpenTelemetry Collector OTLP logs
- Fluent Bit / Vector adapter
- Webhook sink
- MCP Server for AI troubleshooting

## 11. 里程碑

### M1: 独立日志系统 POC

- Compose 启动
- 批量写入
- 查询
- error 详情
- error summary
- 内置 `/console`
- stack blob 查看

### M2: 日志系统完善

- 查询体验增强
- error 聚合页增强
- 字段字典与保存视图
- 脱敏审计
- 反向代理访问策略

### M3: Sudowork 接入

- mainLogger 适配
- CrashReporter 适配
- Renderer error bridge
- 设置页诊断等级

### M4: 内部验证

- 个人模式灰度
- sudo-log 控制台排障流程验证
- 脱敏审计

### M5: 多产品线

- SudoRouter 接入
- SudoCode model-call topic 接入
- Kafka/Redpanda 上线
