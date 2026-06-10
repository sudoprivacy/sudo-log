const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_BATCH_SIZE = 50;

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status >= 500 && status <= 599;
}

function mergeObject(left, right) {
  return {
    ...(left && typeof left === 'object' && !Array.isArray(left) ? left : {}),
    ...(right && typeof right === 'object' && !Array.isArray(right) ? right : {}),
  };
}

export class SudoLogError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SudoLogError';
    this.status = options.status || 0;
    this.response = options.response || null;
    this.body = options.body || null;
    this.cause = options.cause;
  }
}

export class SudoLogClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey || '';
    this.tenantId = options.tenantId || '';
    this.product = options.product || '';
    this.environment = options.environment || 'production';
    this.apiKeyHeader = options.apiKeyHeader || 'X-API-Key';
    this.timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    this.maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES;
    this.defaultTags = mergeObject(options.defaultTags);
    this.defaultAttributes = mergeObject(options.defaultAttributes);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;

    if (!this.baseUrl) throw new SudoLogError('baseUrl is required');
    if (!this.apiKey) throw new SudoLogError('apiKey is required');
    if (!this.tenantId) throw new SudoLogError('tenantId is required');
    if (!this.product) throw new SudoLogError('product is required');
    if (typeof this.fetchImpl !== 'function') {
      throw new SudoLogError('fetch is not available; use Node.js 18+ or pass fetchImpl');
    }
  }

  endpoint() {
    return `${this.baseUrl}/v1/logs/batch`;
  }

  withDefaults(log) {
    if (!log || typeof log !== 'object' || Array.isArray(log)) {
      throw new SudoLogError('log must be an object');
    }
    if (log.tenant_id && log.tenant_id !== this.tenantId) {
      throw new SudoLogError(`log tenant_id does not match client tenantId: ${log.tenant_id}`);
    }
    if (log.product && log.product !== this.product) {
      throw new SudoLogError(`log product does not match client product: ${log.product}`);
    }

    return {
      ...log,
      tenant_id: this.tenantId,
      product: this.product,
      environment: log.environment || this.environment,
      tags: mergeObject(this.defaultTags, log.tags),
      attributes: mergeObject(this.defaultAttributes, log.attributes),
    };
  }

  async sendBatch(logs, options = {}) {
    if (!Array.isArray(logs)) throw new SudoLogError('logs must be an array');
    if (logs.length === 0) throw new SudoLogError('logs must not be empty');
    if (logs.length > MAX_BATCH_SIZE) {
      throw new SudoLogError(`logs must contain no more than ${MAX_BATCH_SIZE} entries`);
    }

    const body = JSON.stringify({ logs: logs.map((log) => this.withDefaults(log)) });
    const timeoutMs = Number(options.timeoutMs || this.timeoutMs);
    const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : this.maxRetries;
    const headers = {
      'content-type': 'application/json',
      [this.apiKeyHeader]: this.apiKey,
      ...(options.headers || {}),
    };

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetchImpl(this.endpoint(), {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        const text = await response.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { raw: text };
        }
        if (response.ok && data.success !== false) return data;

        const error = new SudoLogError(data.error || `Sudo Log request failed with ${response.status}`, {
          status: response.status,
          response,
          body: data,
        });
        if (isRetryableStatus(response.status) && attempt < maxRetries) {
          lastError = error;
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw error;
      } catch (error) {
        const normalized =
          error instanceof SudoLogError
            ? error
            : new SudoLogError(error?.name === 'AbortError' ? 'Sudo Log request timed out' : 'Sudo Log request failed', {
              cause: error,
            });
        if (!(error instanceof SudoLogError) && attempt < maxRetries) {
          lastError = normalized;
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw normalized;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new SudoLogError('Sudo Log request failed');
  }

  async log(log, options = {}) {
    return this.sendBatch([log], options);
  }
}

export default SudoLogClient;
