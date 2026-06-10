# Sudo Log 第三方写入接入说明

本文只面向第三方应用写入日志。Sudo Log 日志上报接口：

```http
POST /v1/logs/batch
```

## 1. 接入前置

业务方接入前需要先向 Sudo Log 管理员申请接入配置：

1. 申请租户 ID，例如 `sudo`。
2. 申请该租户下的产品 ID，例如 `sudowork`。
3. 获取该租户的 API Key。

管理员会在 Sudo Log 控制台维护租户、产品和 API Key。API Key 在租户创建时生成或指定，创建后只能复制使用，不能在控制台修改。默认初始化配置为：

| 配置 | 默认值 |
| --- | --- |
| 租户 | `sudo` |
| 产品 | `sudowork` |
| API Key | `DEFAULT_API_KEY` 对应的值 |

接入方拿到以下参数后再开始开发：

| 参数 | 说明 | 示例 |
| --- | --- | --- |
| `base_url` | 日志网关地址 | `https://logs.example.com` |
| `api_key_header` | API key 请求头名 | `X-API-Key` |
| `api_key` | 写入接口密钥 | 由管理员提供，禁止写入代码仓库 |
| `tenant_id` | 租户、组织或客户标识 | `acme` |
| `product` | 第三方应用产品标识 | `acme-console` |
| `environment` | 环境标识 | `production` |

`tenant_id` 和 `product` 必须和管理员配置一致。写入时网关会同时校验 API Key、租户和产品；未知租户、未知产品、API Key 不匹配都会返回明确错误。

API key 是服务端机密。后端服务、CLI、桌面应用主进程可以持有；浏览器前端不要直接携带 API key，应通过自己的后端代理写入日志。

## 2. 接入方式选择

Sudo Log 支持两种接入方式：

| 方式 | 适用场景 | 说明 |
| --- | --- | --- |
| SDK 对接 | 推荐给 Python、Go、Node.js 服务端应用 | SDK 封装 `/v1/logs/batch`，统一注入 `tenant_id`、`product`、`environment`，内置超时、批量限制和失败重试 |
| API 对接 | 其他语言、已有日志框架或网关转发场景 | 业务侧自行构造 HTTP 请求并处理超时、重试、降级和字段校验 |

优先使用 SDK 对接。SDK 只适合运行在服务端、CLI、桌面主进程等可信环境，不要在浏览器前端使用 SDK 或直接暴露 API Key。

## 3. SDK 对接

SDK 源码位置：

| 语言 | 目录 |
| --- | --- |
| Node.js | `sdk/nodejs` |
| Python | `sdk/python` |
| Go | `sdk/go` |

三套 SDK 的行为保持一致：

- 封装 `POST /v1/logs/batch`。
- client 初始化时配置 `base_url`、`api_key`、`tenant_id`、`product`、`environment`。
- 单条日志未填写 `tenant_id`、`product`、`environment` 时自动使用 client 默认值。
- 如果单条日志显式传入的 `tenant_id` 或 `product` 与 client 配置不一致，SDK 会直接报错，避免串租户或串产品写入。
- 单批最多 50 条，空数组和超过 50 条会在本地直接报错。
- 网络失败或 `5xx` 默认退避重试；`4xx` 不重试，应修正请求或配置。
- 收到 `200` 且 `accepted: true` 后不要重试同一批；服务端当前不做幂等去重，重复发送会产生重复事件。

### 3.1 Node.js SDK

适用于服务端 Node.js 18+。当前 SDK 使用原生 `fetch`，不依赖第三方包。

安装方式：

```bash
npm install ./sdk/nodejs
```

完整调用示例见 `sdk/nodejs/examples/batch-all-fields.mjs`。示例从环境变量读取 `SUDO_LOG_BASE_URL`、`SUDO_LOG_API_KEY`、`SUDO_LOG_TENANT_ID`、`SUDO_LOG_PRODUCT`，不会在代码中硬编码 API Key。

### 3.2 Python SDK

Python SDK 使用标准库 `urllib.request`，适用于 Python 3.9+。

安装方式：

```bash
pip install ./sdk/python
```

完整调用示例见 `sdk/python/examples/batch_all_fields.py`。示例从环境变量读取 `SUDO_LOG_BASE_URL`、`SUDO_LOG_API_KEY`、`SUDO_LOG_TENANT_ID`、`SUDO_LOG_PRODUCT`，不会在代码中硬编码 API Key。

### 3.3 Go SDK

Go SDK 使用标准库 `net/http`，适用于 Go 1.22+。

如果 SDK 尚未发布到模块仓库，可在业务项目 `go.mod` 中临时使用本地 replace：

```go
require github.com/sudowork/sudo-log/sdk/go v0.0.0

replace github.com/sudowork/sudo-log/sdk/go => /path/to/sudo-log/sdk/go
```

完整调用示例见 `sdk/go/examples/basic/main.go`。示例从环境变量读取 `SUDO_LOG_BASE_URL`、`SUDO_LOG_API_KEY`、`SUDO_LOG_TENANT_ID`、`SUDO_LOG_PRODUCT`，不会在代码中硬编码 API Key。

## 4. API 对接

如果业务方不使用 SDK，可以直接调用 HTTP API。直接 API 对接时，业务方必须自行处理：

- API Key header。
- `tenant_id`、`product`、`environment` 默认值和一致性校验。
- 单批最大 50 条。
- 2 到 5 秒超时。
- 网络失败或 `5xx` 退避重试。
- 本地降级缓存，避免日志服务异常影响主业务链路。

### 4.1 认证方式

写入接口支持 API key header：

```http
X-API-Key: <api_key>
Content-Type: application/json
```

### 4.2 写入接口

```http
POST /v1/logs/batch
```

请求体：

```json
{
  "logs": [
    {
      "timestamp": "2026-06-04T03:00:00.000Z",
      "tenant_id": "acme",
      "product": "acme-console",
      "topic": "error",
      "environment": "production",
      "level": "error",
      "component": "CheckoutService",
      "version": "1.4.2",
      "user_identifier": "user@example.com",
      "user_id": "user-123",
      "session_id": "sess_123",
      "trace_id": "trace_123",
      "message": "checkout request failed",
      "error": {
        "name": "PaymentProviderError",
        "message": "provider returned 502",
        "stack": "PaymentProviderError: provider returned 502\n    at charge (/app/src/payments.ts:42:11)"
      },
      "tags": {
        "feature": "checkout",
        "provider": "stripe",
        "plan": "pro"
      },
      "attributes": {
        "route": "/checkout",
        "http_status": 502,
        "order_id": "ord_123"
      }
    }
  ]
}
```

成功响应是 HTTP `200 OK`：

```json
{
  "success": true,
  "accepted": true,
  "received": 1,
  "event_ids": ["b3b676c4-4c2f-4e31-8a0f-7d29e3c5cbb1"]
}
```

`accepted: true` 表示日志已进入队列，后台 worker 会异步批量写入 ClickHouse。刚收到响应时，日志可能还没有完成落库。

### 4.3 curl 示例

```bash
: "${SUDO_LOG_BASE_URL:?SUDO_LOG_BASE_URL is required}"
: "${SUDO_LOG_API_KEY:?SUDO_LOG_API_KEY is required}"

curl -s "$SUDO_LOG_BASE_URL/v1/logs/batch" \
  -H "X-API-Key: $SUDO_LOG_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "logs": [
      {
        "tenant_id": "acme",
        "product": "acme-console",
        "topic": "error",
        "environment": "production",
        "level": "error",
        "component": "bootstrap",
        "version": "1.4.2",
        "user_identifier": "user@example.com",
        "message": "service failed to start",
        "error": {
          "name": "BootstrapError",
          "message": "dependency check failed",
          "stack": "BootstrapError: dependency check failed\n    at bootstrap (/app/src/bootstrap.ts:42:11)"
        },
        "tags": {
          "feature": "bootstrap",
          "region": "ap-east-1"
        },
        "attributes": {
          "region": "ap-east-1"
        }
      }
    ]
  }'
```

## 5. 必填字段

每条日志都必须发送：

| 字段 | 说明 |
| --- | --- |
| `tenant_id` | 已申请并配置的租户 ID |
| `product` | 已申请并配置在该租户下的产品 ID |
| `environment` | `production`、`staging`、`development` 等 |
| `topic` | `app`、`error`、`perf`、`audit` 等 |
| `level` | `trace`、`debug`、`info`、`warn`、`error`、`fatal` |
| `component` | 服务、模块、页面或类名 |
| `user_identifier` | 全局唯一用户标识，例如手机号、邮箱、账号名、统一用户中心 ID；服务端只存 hash |
| `message` | 简短、已脱敏的日志描述 |

当 `level` 为 `error` 或 `fatal` 时，错误堆栈必填：

| 字段 | 说明 |
| --- | --- |
| `error.name` | 错误类型，建议填写 |
| `error.message` | 错误消息，建议填写 |
| `error.stack` | 已脱敏堆栈，必填 |

可选关联字段：

| 字段 | 说明 |
| --- | --- |
| `timestamp` | 事件发生时间，支持 ISO 8601 字符串或 Unix epoch 毫秒级时间戳；数字类型一律按毫秒解析 |
| `version` | 应用版本、镜像 tag 或 git sha |
| `user_identifier_hash` | 用户标识哈希，格式必须是 64 位小写 hex SHA-256 字符串；仅当不能上报明文 `user_identifier` 时使用 |
| `user_id` | 业务内部用户 ID；服务端会 hash 后入库，作为辅助关联字段 |
| `user_id_hash` | 用户 ID 哈希，格式必须是 64 位小写 hex SHA-256 字符串 |
| `device_id` | 设备 ID；服务端会 hash 后入库 |
| `device_id_hash` | 设备 ID 哈希，格式必须是 64 位小写 hex SHA-256 字符串 |
| `session_id` | 会话 ID |
| `trace_id` | 链路 ID |
| `tags` | 用于检索和 Grafana panel 的业务标签 |
| `attributes` | 小体积结构化上下文 |

## 5.1 Tags

`tags` 用于后续按 `key:value` 精确检索和业务自助 dashboard，不要把任意上下文都放进 tags。

Tags 是日志系统里的高价值检索和聚合维度，不是普通上下文字段。每新增一个 tag，log 端都需要额外保存 `key:value`，并为 tag search、Grafana 变量、Grafana 聚合 mart 做相应的数据展开和聚合维护。因此 tags 会带来明确的存储成本、写入放大和查询维护成本；业务侧应只把“确实需要按维度过滤、分组、聚合展示或长期排障检索”的字段放入 tags。

如果某个字段只是为了在日志详情里辅助定位问题，或者只会偶尔查看，不需要按它做 Dashboard、趋势图、TopN、错误率分组或高频检索，应放在 `attributes`，不要放在 `tags`。保持 tags 简洁稳定，是保障日志写入成本、ClickHouse 查询效率和 Grafana 面板性能的关键。

推荐 tags：

```json
{
  "feature": "checkout",
  "provider": "stripe",
  "plan": "pro"
}
```

适合进入 tags 的字段通常满足以下条件：

| 条件 | 说明 |
| --- | --- |
| 有聚合展示需求 | 需要在 Grafana panel 中按该字段筛选、分组、TopN 或看趋势 |
| 有高频检索需求 | 运维或业务人员会经常用 `key:value` 定位一类日志 |
| 取值相对稳定 | value 集合可控，不会随着请求、用户、订单等快速膨胀 |
| 业务语义清晰 | 字段含义稳定，跨版本不会频繁变更 |
| 可长期维护 | 业务侧愿意把它当作日志分析维度持续维护 |

不适合进入 tags 的字段：

| 字段类型 | 应放位置 | 原因 |
| --- | --- | --- |
| 订单号、请求 ID、流水号 | `attributes` | 高基数，几乎不适合聚合展示 |
| 原始手机号、邮箱、token、地址等敏感信息 | 不要上报；必要时脱敏后放 `attributes` | 避免隐私和安全风险 |
| 大段文本、错误详情、请求体、响应体 | `message`、`error` 或 `attributes` | 会放大存储，且不适合作为检索维度 |
| 临时实验字段、一次性调试字段 | `attributes` | 语义不稳定，会污染 tag 体系 |
| 已有结构化字段 | 使用已有字段 | 例如 `environment`、`component`、`version` 不要重复放 tags |

硬规则：

| 规则 | 说明 |
| --- | --- |
| 先有用途再加 tag | 只有存在 Dashboard、聚合展示、TopN、错误率分组或高频检索需求时才加入 tags |
| 控制数量 | 单条日志 tags 越少越好，推荐 3 到 8 个；不要为了“以后可能用”批量加入 |
| 控制基数 | 避免把用户 ID、订单 ID、session ID、trace ID 等高基数字段作为 tag |
| 保持稳定 | tag key 一旦接入应长期稳定，避免频繁改名或同义 key 并存 |
| 优先复用 | 同类业务使用统一 key，例如统一使用 `feature`，不要混用 `feature_name`、`module_feature` |
| attributes 兜底 | 不确定是否需要聚合展示时，先放 `attributes`，确认有稳定分析需求后再提升为 tag |

规则：

| 规则 | 说明 |
| --- | --- |
| 类型 | 只能是一层对象 |
| value 类型 | 只允许 string、number、boolean |
| 单条日志 tags 数量 | 最多 20 个 |
| key 长度 | 最多 64 字符 |
| value 长度 | 最多 256 字符 |
| key 字符 | 小写字母、数字、下划线、点、短横线 |
| key 大小写 | 服务端会转为小写 |
| 查询语法 | `tag=feature:checkout` |

不要使用这些字段作为 tag key：`tenant_id`、`product`、`timestamp`、`level`、`topic`、`environment`、`user_identifier`、`user_id`、`device_id`、`session_id`、`conversation_id`、`trace_id`、`component`、`version`、`platform`、`arch`、`message`、`error_hash`、`attributes`、`tags`。

如果某个字段会被高频检索并且是日志系统通用字段，应优先申请成为结构化列，而不是作为 tag 长期使用。

## 6. 用户标识与设备哈希

Sudo Log 存储的是 `user_identifier_hash`、`user_id_hash` 和 `device_id_hash`，不保存原始用户标识、用户 ID 或设备 ID。

`user_identifier` 是每条日志必填的用户定位字段。它应该是业务侧最容易拿到、能全局唯一定位用户的字符串，例如手机号、邮箱、统一用户中心 ID 或账号名。控制台搜索时输入同一个明文 `user_identifier`，后端会按统一算法 hash 后查询。Sudo Log 不落库保存明文 `user_identifier`，但传输链路仍应使用 HTTPS，并把 API Key 仅放在服务端。

推荐直接上报明文 `user_identifier` / `user_id` / `device_id`，由 Sudo Log 服务端按统一算法 hash 后入库。

哈希算法必须和服务端保持一致：

```text
lowercase_hex_sha256(trim(raw_id))
```

Node.js 示例：

```js
import { createHash } from "node:crypto";

function sudoLogHash(value) {
  return createHash("sha256").update(value.trim()).digest("hex");
}

const user_id_hash = sudoLogHash("user-123");
const user_identifier_hash = sudoLogHash("user@example.com");
const device_id_hash = sudoLogHash("device-abc");
```

如果接入方自己上报 `user_identifier_hash` / `user_id_hash` / `device_id_hash`，必须使用上述算法和格式。结果必须是 64 位小写 hex 字符串，不要拼接 `sha256:` 前缀。算法、大小写、前缀或原始 ID 规范不一致，后续按用户或设备排查时会查询不到对应日志。

## 7. 批量限制

| 规则 | 当前值 |
| --- | --- |
| `logs` | 必须是数组 |
| 单批最大条数 | `50` |
| 请求体最大大小 | 默认 `2MB` |
| 成功状态码 | `200` |
| `event_id` | 服务端生成，客户端不能指定 |

建议单批不超过 50 条，单次请求超时 2 到 5 秒。收到 `200` 且 `accepted: true` 后不要重试同一批；网络失败或 `5xx` 可指数退避重试。当前服务端不做幂等去重，重复重试可能产生重复事件。

## 8. 时间字段

第三方只需要上报 `timestamp`，表示日志事件真实发生时间。

Sudo Log 会自动补充：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `received_at` | Sudo Log Gateway | 网关接收并写入 Redis 队列的时间 |
| `created_at` | ClickHouse | 后台 worker 写入 ClickHouse 的时间 |

如果 `timestamp` 缺失或无效，网关会使用当前时间兜底。排障时间线优先看 `timestamp`；排查上报延迟或队列堆积时看 `received_at` 和 `created_at`。

## 9. 脱敏要求

第三方应用必须先在本地脱敏，再发送日志。

禁止上传：

- API key、Token、Cookie、Authorization header
- 密码、私钥、数据库连接串
- prompt 全文、模型完整响应
- 文件正文、请求体全文、HTML 全文
- 身份证、银行卡、手机号、邮箱等个人敏感信息

推荐上传：

- 明文 `user_identifier`、`user_id`、`device_id`，由 Sudo Log 服务端统一 hash；或按本文算法生成的 `user_identifier_hash`、`user_id_hash`、`device_id_hash`
- `session_id`、`trace_id`、`request_id`
- 脱敏后的错误名、错误消息和 stack
- 版本、平台、组件、状态码等小字段

## 10. 常见错误

| 状态码 | 含义 | 处理方式 |
| --- | --- | --- |
| `400` | 请求格式错误 | 检查 JSON 和 `logs` 数组 |
| `401` | API Key 缺失、错误或不属于该租户 | 检查 `X-API-Key`、租户和网关配置 |
| `404` | 租户或产品不存在 / 未启用 | 确认已完成租户和产品申请 |
| `413` | 请求体过大 | 减少 batch 条数或裁剪字段 |
| `5xx` | 网关、Redis 或内部错误 | 本地缓存并退避重试 |

## 11. 接入验收

上线前确认：

- 已完成租户、产品和 API Key 申请。
- `POST /v1/logs/batch` 使用 `X-API-Key`、正确 `tenant_id`、正确 `product` 返回 HTTP `200`。
- 响应包含 `success: true`、`accepted: true`、`received` 和 `event_ids`。
- 日志包含正确的 `tenant_id`、`product`、`environment`、`topic`、`level`、`component`、`user_identifier`。
- `error` / `fatal` 日志包含非空 `error.stack`。
- 客户端已实现超时、失败重试和本地降级。
- 已确认不会上传密钥、Cookie、prompt 全文、文件正文或个人敏感信息。
