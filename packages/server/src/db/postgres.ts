import { Pool, type QueryResultRow } from 'pg';
import type { PostgresConfig } from '../config/appConfig.js';

export type PgRow = Record<string, string | null>;

function normalizePgValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return String(value);
}

function normalizePgRow(row: QueryResultRow): PgRow {
  const normalized: PgRow = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizePgValue(value);
  }
  return normalized;
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
  private readonly pool: Pool;

  public constructor(config: PostgresConfig) {
    this.pool = new Pool({
      connectionString: config.url,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      max: 10,
      query_timeout: 5000,
    });
  }

  public async health(): Promise<boolean> {
    await this.query('SELECT 1');
    return true;
  }

  public async query(sql: string): Promise<PgRow[]> {
    const result = await this.pool.query(sql);
    return result.rows.map(normalizePgRow);
  }
}
