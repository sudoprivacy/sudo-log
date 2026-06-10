import { createHash } from 'node:crypto';
import { SudoworkLogClient } from '../index.js';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(String(value).trim()).digest('hex');
}

const tenantId = requiredEnv('SUDO_LOG_TENANT_ID');
const product = requiredEnv('SUDO_LOG_PRODUCT');
const environment = process.env.SUDO_LOG_ENVIRONMENT || 'production';

const client = new SudoworkLogClient({
  baseUrl: requiredEnv('SUDO_LOG_BASE_URL'),
  apiKey: requiredEnv('SUDO_LOG_API_KEY'),
  tenantId,
  product,
  environment,
  defaultTags: {
    sdk: 'nodejs',
    source: 'sdk-example',
  },
  defaultAttributes: {
    sdk_language: 'nodejs',
    example: 'batch-all-fields',
  },
});

const logs = [
  {
    timestamp: new Date().toISOString(),
    tenant_id: tenantId,
    product,
    topic: 'error',
    environment,
    level: 'error',
    component: 'NodeSdkExample',
    version: '1.2.3-node',
    platform: 'darwin',
    arch: 'arm64',
    login_mode: 'password',
    user_identifier: 'node-user@example.invalid',
    user_identifier_hash: sha256('node-user@example.invalid'),
    user_id: 'node-user-001',
    user_id_hash: sha256('node-user-001'),
    device_id: 'node-device-001',
    device_id_hash: sha256('node-device-001'),
    session_id: 'node-session-001',
    conversation_id: 'node-conversation-001',
    trace_id: 'node-trace-001',
    message: 'node sdk example log covers all batch fields',
    error: {
      name: 'NodeExampleError',
      message: 'fake node sdk error',
      stack: 'NodeExampleError: fake node sdk error\n    at runExample (/app/src/node-example.js:10:3)',
    },
    error_name: 'NodeExampleFallbackError',
    error_message: 'fake node fallback error message',
    stack_trace: 'NodeExampleFallbackError: fake fallback stack\n    at fallback (/app/src/node-example.js:20:3)',
    tags: {
      feature: 'sdk-example',
      provider: 'fake-provider',
      plan: 'pro',
      scenario: 'all-fields',
    },
    attributes: {
      route: '/sdk/nodejs/example',
      http_status: 502,
      retryable: true,
      order_id: 'fake-node-order-001',
      payload_shape: { covered: true, language: 'nodejs' },
    },
  },
  {
    timestamp: new Date(Date.now() - 1000).toISOString(),
    topic: 'error',
    level: 'error',
    component: 'NodeSdkExample',
    user_identifier: 'node-secondary-user@example.invalid',
    message: 'node sdk secondary error example log',
    error: {
      name: 'NodeSecondaryExampleError',
      message: 'fake secondary node sdk error',
      stack: 'NodeSecondaryExampleError: fake secondary node sdk error\n    at secondary (/app/src/node-example.js:30:3)',
    },
    tags: {
      feature: 'sdk-example',
      scenario: 'secondary-error',
      provider: 'fake-provider',
    },
    attributes: {
      route: '/sdk/nodejs/secondary',
      http_status: 500,
      cache_hit: false,
    },
  },
  {
    timestamp: new Date(Date.now() - 2000).toISOString(),
    topic: 'error',
    level: 'error',
    component: 'NodeSdkExample',
    user_identifier: 'node-tertiary-user@example.invalid',
    message: 'node sdk tertiary error example log',
    error: {
      name: 'NodeTertiaryExampleError',
      message: 'fake tertiary node sdk error',
      stack: 'NodeTertiaryExampleError: fake tertiary node sdk error\n    at tertiary (/app/src/node-example.js:40:3)',
    },
    tags: {
      feature: 'sdk-example',
      scenario: 'tertiary-error',
      provider: 'fake-provider',
    },
    attributes: {
      route: '/sdk/nodejs/tertiary',
      http_status: 409,
      warning_code: 'fake-conflict',
    },
  },
];

const response = await client.sendBatch(logs);
console.log(JSON.stringify({ language: 'nodejs', response }, null, 2));
