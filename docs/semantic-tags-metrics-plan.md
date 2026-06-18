# Semantic Tags and Metrics Plan

## Background

Third-party applications currently send structured fields through `tags` and `attributes`. Sudo Log treats `tags` as dimensions: it expands every `key:value` pair into tag rows and builds Grafana tag marts that only contain `events`, `errors`, and `fatals` counters.

This works for panels such as event volume by feature or error count by provider, but it does not support numeric panels such as duration P95 or total token usage. Putting numeric values directly into tags creates high-cardinality tag values and still only produces counts for each exact value.

The integration experience should remain simple: producers should be able to send fields in `tags` without understanding whether each field is a dimension or a metric. Sudo Log should infer and route fields internally.

## Goals

- Keep the existing `/v1/logs/batch` API compatible.
- Preserve existing tag search and Grafana count panels.
- Infer numeric tag values as metrics by default.
- Keep string and boolean tag values as dimensions by default.
- Avoid treating common numeric identifiers or status-like values as metrics.
- Add Grafana mart tables that support numeric aggregations such as sum, average, min, max, and P95.

## Non-goals

- Do not require producers to learn a new field taxonomy before integrating.
- Do not remove existing `tags` behavior for string and boolean values.
- Do not break already-ingested data or existing custom panels.
- Do not aggregate arbitrary nested attributes in this phase.

## Inference Rules

Sudo Log will split incoming `tags` into dimensions and metrics before it stringifies tag values.

Default rules:

1. `number` values become metrics when they are finite.
2. `string` and `boolean` values become dimension tags.
3. Numeric values whose key looks like an identifier or category remain dimensions.
4. Unknown object, array, null, or undefined tag values are rejected as before.

Dimension key patterns for numeric values:

- Exact keys: `status`, `status_code`, `http_status`, `http_status_code`, `code`, `error_code`, `exit_code`, `port`.
- Suffixes: `_id`, `.id`, `-id`, `_code`, `.code`, `-code`, `_status`, `.status`, `-status`, `_version`, `.version`, `-version`, `_level`, `.level`, `-level`.

Examples:

```json
{
  "tags": {
    "sw_event_type": "turn",
    "sw_model_id": "gpt-4.1",
    "sw_status": "success",
    "duration_ms": 1234,
    "input_tokens": 100,
    "output_tokens": 800,
    "http_status_code": 429
  }
}
```

Internal split:

```json
{
  "dimensions": {
    "sw_event_type": "turn",
    "sw_model_id": "gpt-4.1",
    "sw_status": "success",
    "http_status_code": "429"
  },
  "metrics": {
    "duration_ms": 1234,
    "input_tokens": 100,
    "output_tokens": 800
  }
}
```

## Data Model

Existing tables remain unchanged for log rows and tag dimensions:

- `sudo_logs`
- `sudo_error_logs`
- `sudo_log_event_lookup`
- `sudo_log_tags`
- `grafana_log_events`
- `grafana_tag_events`
- `grafana_log_metrics_1m`
- `grafana_tag_metrics_1m`
- `grafana_tag_keys_1d`
- `grafana_tag_values_1d`

New tables:

### `sudo_log_metrics`

Metric detail table, one row per numeric metric on a log event.

Important fields:

- Event and tenant/product fields for filtering and drilldown.
- `metric_key` and `metric_value`.
- Common dimensions such as `topic`, `environment`, `level`, `component`, `version`, `platform`, and `arch`.
- User/session/trace hash fields for correlation.

### `grafana_metric_events`

Optional detail projection for Grafana when detail events are enabled.

### `grafana_metric_metrics_1m`

One-minute metric aggregate by metric key and common log dimensions.

Columns include:

- `events`
- `errors`
- `fatals`
- `value_count`
- `value_sum`
- `value_min`
- `value_max`
- `value_p95_state AggregateFunction(quantileTDigest(0.95), Float64)`

### `grafana_tag_metric_metrics_1m`

One-minute metric aggregate by metric key plus a dimension tag key/value. This supports panels such as duration P95 by model or token sum by agent.

Columns mirror `grafana_metric_metrics_1m` and add:

- `tag_key`
- `tag_value`
- `tag_kv_hash`

## Query Patterns

Average duration:

```sql
SELECT
  $__timeInterval(interval_start) AS time,
  sum(value_sum) / nullIf(sum(value_count), 0) AS value
FROM grafana_metric_metrics_1m
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND metric_key = 'duration_ms'
  AND $__timeFilter(interval_start)
GROUP BY time
ORDER BY time
```

P95 duration by model:

```sql
SELECT
  $__timeInterval(interval_start) AS time,
  tag_value AS metric,
  quantileTDigestMerge(0.95)(value_p95_state) AS value
FROM grafana_tag_metric_metrics_1m
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND metric_key = 'duration_ms'
  AND tag_key = 'sw_model_id'
  AND $__timeFilter(interval_start)
GROUP BY time, metric
ORDER BY time
```

Total output tokens by model:

```sql
SELECT
  tag_value AS metric,
  sum(value_sum) AS value
FROM grafana_tag_metric_metrics_1m
WHERE tenant_id = '${tenant_id}'
  AND product = '${product}'
  AND metric_key = 'output_tokens'
  AND tag_key = 'sw_model_id'
  AND $__timeFilter(interval_start)
GROUP BY metric
ORDER BY value DESC
LIMIT 20
```

## Rollout

1. Add metric split logic in normalization while preserving dimension tags.
2. Add metric detail and Grafana mart table creation.
3. Insert metric rows from the queue worker together with existing log/tag rows.
4. Allow custom panels to query the new metric mart tables.
5. Update integration docs with the automatic inference behavior.
6. Keep existing error-log ingestion and existing tag count panels unchanged.

