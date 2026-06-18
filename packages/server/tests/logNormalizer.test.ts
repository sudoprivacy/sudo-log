import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeLogEvent } from '../src/services/logNormalizer.js';

const blobStore = {
  writeText: async () => 'blob://test',
};

describe('logNormalizer semantic tags', () => {
  it('splits dimension tags and numeric metrics before stringifying tags', async () => {
    const row = await normalizeLogEvent(
      {
        timestamp: '2026-06-17T00:00:00.000Z',
        tenant_id: 'sudo',
        product: 'sudowork',
        level: 'info',
        user_identifier: 'user@example.com',
        component: 'TelemetryReporter',
        message: 'turn completed',
        tags: {
          sw_event_type: 'turn',
          sw_model_id: 'gpt-4.1',
          sw_status: 'success',
          duration_ms: 1234,
          input_tokens: 100,
          output_tokens: 800,
          http_status_code: 429,
          cached: true,
        },
      },
      blobStore,
      'sudo',
    );

    assert.deepEqual(JSON.parse(row.tags_json), {
      cached: 'true',
      http_status_code: '429',
      sw_event_type: 'turn',
      sw_model_id: 'gpt-4.1',
      sw_status: 'success',
    });
    assert.deepEqual(JSON.parse(row.metrics_json), {
      duration_ms: 1234,
      input_tokens: 100,
      output_tokens: 800,
    });
  });
});
