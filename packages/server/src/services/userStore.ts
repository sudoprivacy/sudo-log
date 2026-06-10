import { randomUUID } from 'node:crypto';
import type { AuthConfig } from '../config/appConfig.js';
import { pgBoolean, pgNullableString, pgString, type PgRow, type PostgresClient } from '../db/postgres.js';
import {
  isUserRole,
  toPublicUser,
  type CreateUserInput,
  type PublicUser,
  type UpdateUserInput,
  type UserRecord,
  type UserRole,
} from '../types/auth.js';
import { hashPassword } from './passwordService.js';

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function assertEmail(value: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw Object.assign(new Error('Invalid email'), { statusCode: 400 });
  }
}

function assertUsername(value: string): void {
  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(value)) {
    throw Object.assign(new Error('username must be 3-64 chars and contain only letters, numbers, dot, dash, and underscore'), {
      statusCode: 400,
    });
  }
}

function assertPassword(value: string): void {
  if (value.length < 8) {
    throw Object.assign(new Error('password must be at least 8 characters'), { statusCode: 400 });
  }
}

function pgBool(value: string | null): boolean {
  return value === 't' || value === 'true';
}

function rowToUser(row: PgRow): UserRecord {
  return {
    id: row.id || '',
    username: row.username || '',
    email: row.email || '',
    displayName: row.display_name || '',
    passwordHash: row.password_hash || '',
    role: (row.role || 'viewer') as UserRole,
    enabled: pgBool(row.enabled),
    lastLoginAt: row.last_login_at || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

export class UserStore {
  public constructor(private readonly postgres: PostgresClient) {}

  public async initialize(): Promise<void> {
    await this.postgres.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        last_login_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  public async ensureBootstrapAdmin(authConfig: AuthConfig): Promise<void> {
    const rows = await this.postgres.query('SELECT id FROM admin_users LIMIT 1');
    if (rows.length > 0) return;

    const email = normalizeEmail(authConfig.adminEmail);
    const username = normalizeUsername(authConfig.adminUsername || 'admin');
    assertUsername(username);
    assertEmail(email);
    const now = new Date().toISOString();
    const passwordHash = authConfig.adminPasswordHash || (await hashPassword(authConfig.adminPassword));
    const user: UserRecord = {
      id: randomUUID(),
      username,
      email,
      displayName: 'Administrator',
      passwordHash,
      role: 'admin',
      enabled: true,
      lastLoginAt: '',
      createdAt: now,
      updatedAt: now,
    };

    await this.saveNewUser(user);
  }

  public async list(): Promise<PublicUser[]> {
    const rows = await this.postgres.query('SELECT * FROM admin_users ORDER BY created_at DESC');
    return rows.map(rowToUser).map(toPublicUser);
  }

  public async findById(id: string): Promise<UserRecord | null> {
    const rows = await this.postgres.query(`SELECT * FROM admin_users WHERE id = ${pgString(id)} LIMIT 1`);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  public async findByLogin(login: string): Promise<UserRecord | null> {
    const normalized = login.trim().toLowerCase();
    const rows = await this.postgres.query(`
      SELECT *
      FROM admin_users
      WHERE email = ${pgString(normalized)}
         OR username = ${pgString(normalized)}
      LIMIT 1
    `);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  public async create(input: CreateUserInput): Promise<PublicUser> {
    const username = normalizeUsername(input.username);
    const email = normalizeEmail(input.email);
    const role = input.role ?? 'viewer';
    assertUsername(username);
    assertEmail(email);
    assertPassword(input.password);
    if (!isUserRole(role)) {
      throw Object.assign(new Error('Invalid role'), { statusCode: 400 });
    }

    await this.assertUnique(username, email);

    const now = new Date().toISOString();
    const user: UserRecord = {
      id: randomUUID(),
      username,
      email,
      displayName: input.displayName?.trim() || username,
      passwordHash: await hashPassword(input.password),
      role,
      enabled: input.enabled ?? true,
      lastLoginAt: '',
      createdAt: now,
      updatedAt: now,
    };

    await this.saveNewUser(user);
    return toPublicUser(user);
  }

  public async update(id: string, input: UpdateUserInput): Promise<PublicUser> {
    const user = await this.findById(id);
    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    if (input.username !== undefined) {
      const username = normalizeUsername(input.username);
      assertUsername(username);
      await this.assertUsernameAvailable(username, id);
      user.username = username;
    }

    if (input.email !== undefined) {
      const email = normalizeEmail(input.email);
      assertEmail(email);
      await this.assertEmailAvailable(email, id);
      user.email = email;
    }

    if (input.displayName !== undefined) user.displayName = input.displayName.trim() || user.username;
    if (input.role !== undefined) {
      if (!isUserRole(input.role)) {
        throw Object.assign(new Error('Invalid role'), { statusCode: 400 });
      }
      user.role = input.role;
    }
    if (input.enabled !== undefined) user.enabled = input.enabled;
    user.updatedAt = new Date().toISOString();

    await this.saveUser(user);
    return toPublicUser(user);
  }

  public async updatePassword(id: string, password: string): Promise<void> {
    assertPassword(password);
    const user = await this.findById(id);
    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }
    user.passwordHash = await hashPassword(password);
    user.updatedAt = new Date().toISOString();
    await this.saveUser(user);
  }

  public async updateLastLogin(id: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) return;
    const now = new Date().toISOString();
    user.lastLoginAt = now;
    user.updatedAt = now;
    await this.saveUser(user);
  }

  public async delete(id: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    await this.postgres.query(`DELETE FROM admin_users WHERE id = ${pgString(id)}`);
  }

  private async assertUnique(username: string, email: string): Promise<void> {
    await this.assertUsernameAvailable(username);
    await this.assertEmailAvailable(email);
  }

  private async assertUsernameAvailable(username: string, exceptId = ''): Promise<void> {
    const rows = await this.postgres.query(`SELECT id FROM admin_users WHERE username = ${pgString(username)} LIMIT 1`);
    if (rows[0]?.id && rows[0].id !== exceptId) {
      throw Object.assign(new Error('Username already exists'), { statusCode: 409 });
    }
  }

  private async assertEmailAvailable(email: string, exceptId = ''): Promise<void> {
    const rows = await this.postgres.query(`SELECT id FROM admin_users WHERE email = ${pgString(email)} LIMIT 1`);
    if (rows[0]?.id && rows[0].id !== exceptId) {
      throw Object.assign(new Error('Email already exists'), { statusCode: 409 });
    }
  }

  private async saveNewUser(user: UserRecord): Promise<void> {
    await this.postgres.query(`
      INSERT INTO admin_users (
        id, username, email, display_name, password_hash, role, enabled, last_login_at, created_at, updated_at
      )
      VALUES (
        ${pgString(user.id)},
        ${pgString(user.username)},
        ${pgString(user.email)},
        ${pgString(user.displayName)},
        ${pgString(user.passwordHash)},
        ${pgString(user.role)},
        ${pgBoolean(user.enabled)},
        ${pgNullableString(user.lastLoginAt)},
        ${pgString(user.createdAt)},
        ${pgString(user.updatedAt)}
      )
    `);
  }

  private async saveUser(user: UserRecord): Promise<void> {
    await this.postgres.query(`
      UPDATE admin_users
      SET username = ${pgString(user.username)},
          email = ${pgString(user.email)},
          display_name = ${pgString(user.displayName)},
          password_hash = ${pgString(user.passwordHash)},
          role = ${pgString(user.role)},
          enabled = ${pgBoolean(user.enabled)},
          last_login_at = ${pgString(user.lastLoginAt)},
          updated_at = ${pgString(user.updatedAt)}
      WHERE id = ${pgString(user.id)}
    `);
  }
}
