import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import type { PostgresConfig } from '../config/appConfig.js';

export type PgRow = Record<string, string | null>;

interface ParsedPostgresUrl {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

function parsePostgresUrl(rawUrl: string): ParsedPostgresUrl {
  const url = new URL(rawUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`Unsupported PostgreSQL protocol: ${url.protocol}`);
  }

  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number.parseInt(url.port, 10) : 5432,
    user: decodeURIComponent(url.username || 'postgres'),
    password: decodeURIComponent(url.password || ''),
    database: decodeURIComponent(url.pathname.replace(/^\//, '') || url.username || 'postgres'),
  };
}

function writeInt16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value, 0);
  return buffer;
}

function writeInt32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function cString(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf-8'), Buffer.from([0])]);
}

function md5Hex(value: string | Buffer): string {
  return createHash('md5').update(value).digest('hex');
}

function md5Password(password: string, user: string, salt: Buffer): string {
  return `md5${md5Hex(Buffer.concat([Buffer.from(md5Hex(password + user), 'utf-8'), salt]))}`;
}

function parseError(payload: Buffer): string {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < payload.length && payload[offset] !== 0) {
    const code = String.fromCharCode(payload[offset]);
    offset += 1;
    const end = payload.indexOf(0, offset);
    if (end === -1) break;
    fields[code] = payload.subarray(offset, end).toString('utf-8');
    offset = end + 1;
  }
  return fields.M || 'PostgreSQL request failed';
}

function startupMessage(parsedUrl: ParsedPostgresUrl): Buffer {
  const params = Buffer.concat([
    cString('user'),
    cString(parsedUrl.user),
    cString('database'),
    cString(parsedUrl.database),
    cString('client_encoding'),
    cString('UTF8'),
    Buffer.from([0]),
  ]);
  const length = 4 + 4 + params.length;
  return Buffer.concat([writeInt32(length), writeInt32(196608), params]);
}

function passwordMessage(password: string): Buffer {
  const payload = cString(password);
  return Buffer.concat([Buffer.from('p'), writeInt32(4 + payload.length), payload]);
}

function queryMessage(sql: string): Buffer {
  const payload = cString(sql);
  return Buffer.concat([Buffer.from('Q'), writeInt32(4 + payload.length), payload]);
}

function parseRowDescription(payload: Buffer): string[] {
  const count = payload.readInt16BE(0);
  let offset = 2;
  const columns: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const end = payload.indexOf(0, offset);
    columns.push(payload.subarray(offset, end).toString('utf-8'));
    offset = end + 1 + 18;
  }
  return columns;
}

function parseDataRow(payload: Buffer, columns: string[]): PgRow {
  const count = payload.readInt16BE(0);
  let offset = 2;
  const row: PgRow = {};
  for (let index = 0; index < count; index += 1) {
    const length = payload.readInt32BE(offset);
    offset += 4;
    if (length === -1) {
      row[columns[index] ?? String(index)] = null;
      continue;
    }
    row[columns[index] ?? String(index)] = payload.subarray(offset, offset + length).toString('utf-8');
    offset += length;
  }
  return row;
}

export function pgString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function pgNullableString(value: string | undefined): string {
  return value === undefined ? 'NULL' : pgString(value);
}

export function pgBoolean(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

export class PostgresClient {
  private readonly parsedUrl: ParsedPostgresUrl;

  public constructor(private readonly config: PostgresConfig) {
    this.parsedUrl = parsePostgresUrl(config.url);
  }

  public async health(): Promise<boolean> {
    await this.query('SELECT 1');
    return true;
  }

  public async query(sql: string): Promise<PgRow[]> {
    const socket = createConnection({ host: this.parsedUrl.host, port: this.parsedUrl.port });

    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let phase: 'startup' | 'query' = 'startup';
      let columns: string[] = [];
      const rows: PgRow[] = [];

      const fail = (error: unknown) => {
        socket.destroy();
        reject(error);
      };

      const processMessages = () => {
        while (buffer.length >= 5) {
          const type = String.fromCharCode(buffer[0]);
          const length = buffer.readInt32BE(1);
          if (buffer.length < 1 + length) return;

          const payload = buffer.subarray(5, 1 + length);
          buffer = buffer.subarray(1 + length);

          if (type === 'E') {
            fail(new Error(parseError(payload)));
            return;
          }

          if (type === 'R') {
            const authType = payload.readInt32BE(0);
            if (authType === 0) continue;
            if (authType === 3) {
              if (!this.parsedUrl.password) {
                fail(new Error('PostgreSQL password is required'));
                return;
              }
              socket.write(passwordMessage(this.parsedUrl.password));
              continue;
            }
            if (authType === 5) {
              if (!this.parsedUrl.password) {
                fail(new Error('PostgreSQL password is required'));
                return;
              }
              socket.write(passwordMessage(md5Password(this.parsedUrl.password, this.parsedUrl.user, payload.subarray(4, 8))));
              continue;
            }
            fail(new Error(`Unsupported PostgreSQL authentication method: ${authType}`));
            return;
          }

          if (type === 'T') {
            columns = parseRowDescription(payload);
            continue;
          }

          if (type === 'D') {
            rows.push(parseDataRow(payload, columns));
            continue;
          }

          if (type === 'Z') {
            if (phase === 'startup') {
              phase = 'query';
              socket.write(queryMessage(sql));
              continue;
            }
            socket.end();
            resolve(rows);
            return;
          }
        }
      };

      socket.setTimeout(5000);
      socket.on('connect', () => {
        socket.write(startupMessage(this.parsedUrl));
      });
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          processMessages();
        } catch (error) {
          fail(error);
        }
      });
      socket.on('timeout', () => fail(new Error('PostgreSQL request timed out')));
      socket.on('error', fail);
    });
  }
}
