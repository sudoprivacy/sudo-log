import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readJsonBody<T>(request: IncomingMessage, maxBytes: number): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown, headers: Record<string, string | string[]> = {}): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

export function sendError(response: ServerResponse, error: unknown): void {
  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode
      : 500;
  const message = error instanceof Error ? error.message : 'Internal server error';
  sendJson(response, statusCode, { success: false, error: message });
}

export function getBearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (!header) return '';
  return header.replace(/^Bearer\s+/i, '').trim();
}
