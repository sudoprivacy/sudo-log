import { createConnection } from 'node:net';

type RedisValue = string | number | null | RedisValue[];

interface ParsedRedisUrl {
  host: string;
  port: number;
  password: string;
  database: string;
}

function parseRedisUrl(rawUrl: string): ParsedRedisUrl {
  const url = new URL(rawUrl);
  if (url.protocol !== 'redis:') {
    throw new Error(`Unsupported Redis protocol: ${url.protocol}`);
  }

  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    password: decodeURIComponent(url.password || ''),
    database: url.pathname.replace(/^\//, '') || '0',
  };
}

function encodeCommand(parts: Array<string | number>): string {
  return parts
    .map((part) => {
      const value = String(part);
      return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
    })
    .join('')
    .replace(/^/, `*${parts.length}\r\n`);
}

function parseResponse(buffer: Buffer, offset = 0): { value: RedisValue; offset: number } | null {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;
  const line = buffer.subarray(offset + 1, lineEnd).toString('utf-8');
  const nextOffset = lineEnd + 2;

  if (type === '+') return { value: line, offset: nextOffset };
  if (type === '-') throw new Error(`Redis error: ${line}`);
  if (type === ':') return { value: Number.parseInt(line, 10), offset: nextOffset };

  if (type === '$') {
    const length = Number.parseInt(line, 10);
    if (length === -1) return { value: null, offset: nextOffset };
    const end = nextOffset + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.subarray(nextOffset, end).toString('utf-8'), offset: end + 2 };
  }

  if (type === '*') {
    const count = Number.parseInt(line, 10);
    if (count === -1) return { value: null, offset: nextOffset };
    const values: RedisValue[] = [];
    let currentOffset = nextOffset;
    for (let index = 0; index < count; index += 1) {
      const parsed = parseResponse(buffer, currentOffset);
      if (!parsed) return null;
      values.push(parsed.value);
      currentOffset = parsed.offset;
    }
    return { value: values, offset: currentOffset };
  }

  throw new Error(`Unsupported Redis response type: ${type}`);
}

export class RedisClient {
  private readonly parsedUrl: ParsedRedisUrl;

  public constructor(redisUrl: string) {
    this.parsedUrl = parseRedisUrl(redisUrl);
  }

  public async ping(): Promise<boolean> {
    const response = await this.command('PING');
    return response === 'PONG';
  }

  public async get(key: string): Promise<string | null> {
    const response = await this.command('GET', key);
    return typeof response === 'string' ? response : null;
  }

  public async setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.command('SETEX', key, ttlSeconds, value);
  }

  public async set(key: string, value: string): Promise<void> {
    await this.command('SET', key, value);
  }

  public async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const response = await this.command('DEL', ...keys);
    return typeof response === 'number' ? response : 0;
  }

  public async sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    const response = await this.command('SADD', key, ...members);
    return typeof response === 'number' ? response : 0;
  }

  public async srem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    const response = await this.command('SREM', key, ...members);
    return typeof response === 'number' ? response : 0;
  }

  public async smembers(key: string): Promise<string[]> {
    const response = await this.command('SMEMBERS', key);
    return Array.isArray(response) ? response.filter((value): value is string => typeof value === 'string') : [];
  }

  public async lpush(key: string, value: string): Promise<void> {
    await this.command('LPUSH', key, value);
  }

  public async lpushMany(key: string, values: string[]): Promise<number> {
    if (values.length === 0) return 0;
    const response = await this.command('LPUSH', key, ...values);
    return typeof response === 'number' ? response : 0;
  }

  public async rpush(key: string, value: string): Promise<void> {
    await this.command('RPUSH', key, value);
  }

  public async rpushMany(key: string, values: string[]): Promise<number> {
    if (values.length === 0) return 0;
    const response = await this.command('RPUSH', key, ...values);
    return typeof response === 'number' ? response : 0;
  }

  public async llen(key: string): Promise<number> {
    const response = await this.command('LLEN', key);
    return typeof response === 'number' ? response : 0;
  }

  public async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const response = await this.command('EXPIRE', key, ttlSeconds);
    return response === 1;
  }

  public async rpop(key: string): Promise<string | null> {
    const response = await this.command('RPOP', key);
    return typeof response === 'string' ? response : null;
  }

  public async rpopCount(key: string, count: number): Promise<string[]> {
    if (count <= 0) return [];
    const response = await this.command('RPOP', key, count);
    if (typeof response === 'string') return [response];
    return Array.isArray(response) ? response.filter((value): value is string => typeof value === 'string') : [];
  }

  private async command(...parts: Array<string | number>): Promise<RedisValue> {
    const authParts: Array<Array<string | number>> = [];
    if (this.parsedUrl.password) authParts.push(['AUTH', this.parsedUrl.password]);
    if (this.parsedUrl.database !== '0') authParts.push(['SELECT', this.parsedUrl.database]);

    const commands = [...authParts, parts].map(encodeCommand).join('');
    const socket = createConnection({
      host: this.parsedUrl.host,
      port: this.parsedUrl.port,
    });

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let expectedReplies = authParts.length + 1;

      socket.setTimeout(3000);
      socket.on('connect', () => {
        socket.write(commands);
      });
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        try {
          const buffer = Buffer.concat(chunks);
          let offset = 0;
          let result: RedisValue = null;
          for (let index = 0; index < expectedReplies; index += 1) {
            const parsed = parseResponse(buffer, offset);
            if (!parsed) return;
            result = parsed.value;
            offset = parsed.offset;
          }
          expectedReplies = 0;
          socket.destroy();
          resolve(result);
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      });
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Redis request timed out'));
      });
      socket.on('error', reject);
    });
  }
}
