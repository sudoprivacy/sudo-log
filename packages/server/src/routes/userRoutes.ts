import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../config/appConfig.js';
import { readJsonBody, sendJson } from '../http/http.js';
import type { Principal } from '../services/authService.js';
import { SessionService } from '../services/sessionService.js';
import { UserStore } from '../services/userStore.js';
import { isUserRole, type CreateUserInput, type UpdateUserInput } from '../types/auth.js';

interface UserBody {
  username?: unknown;
  email?: unknown;
  password?: unknown;
  displayName?: unknown;
  role?: unknown;
  enabled?: unknown;
}

interface PasswordBody {
  password?: unknown;
}

function userIdFromPath(url: URL, action?: 'password'): string {
  const pattern = action === 'password' ? /^\/api\/users\/([^/]+)\/password$/ : /^\/api\/users\/([^/]+)$/;
  const match = pattern.exec(url.pathname);
  if (!match) {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }
  return decodeURIComponent(match[1]);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export class UserRoutes {
  public constructor(
    private readonly config: AppConfig,
    private readonly users: UserStore,
    private readonly sessions: SessionService,
  ) {}

  public async list(response: ServerResponse): Promise<void> {
    const users = await this.users.list();
    sendJson(response, 200, { success: true, data: users });
  }

  public async create(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody<UserBody>(request, this.config.maxBodyBytes);
    if (typeof body.username !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') {
      throw Object.assign(new Error('username, email, and password are required'), { statusCode: 400 });
    }
    const role = body.role ?? 'viewer';
    if (!isUserRole(role)) {
      throw Object.assign(new Error('Invalid role'), { statusCode: 400 });
    }

    const input: CreateUserInput = {
      username: body.username,
      email: body.email,
      password: body.password,
      displayName: optionalString(body.displayName),
      role,
      enabled: optionalBoolean(body.enabled),
    };
    const user = await this.users.create(input);
    sendJson(response, 201, { success: true, data: user });
  }

  public async update(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    principal: Principal,
  ): Promise<void> {
    const id = userIdFromPath(url);
    const body = await readJsonBody<UserBody>(request, this.config.maxBodyBytes);
    const role = body.role;
    if (role !== undefined && !isUserRole(role)) {
      throw Object.assign(new Error('Invalid role'), { statusCode: 400 });
    }
    if (principal.id === id && body.enabled === false) {
      throw Object.assign(new Error('You cannot disable your own user'), { statusCode: 400 });
    }
    if (principal.id === id && body.role !== undefined && body.role !== principal.role) {
      throw Object.assign(new Error('You cannot change your own role'), { statusCode: 400 });
    }

    const input: UpdateUserInput = {
      username: optionalString(body.username),
      email: optionalString(body.email),
      displayName: optionalString(body.displayName),
      role,
      enabled: optionalBoolean(body.enabled),
    };
    const user = await this.users.update(id, input);
    if (body.role !== undefined || body.enabled !== undefined) {
      await this.sessions.revokeUserSessions(id);
    }
    sendJson(response, 200, { success: true, data: user });
  }

  public async resetPassword(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> {
    const id = userIdFromPath(url, 'password');
    const body = await readJsonBody<PasswordBody>(request, this.config.maxBodyBytes);
    if (typeof body.password !== 'string') {
      throw Object.assign(new Error('password is required'), { statusCode: 400 });
    }

    await this.users.updatePassword(id, body.password);
    await this.sessions.revokeUserSessions(id);
    sendJson(response, 200, { success: true });
  }

  public async delete(url: URL, response: ServerResponse, principal: Principal): Promise<void> {
    const id = userIdFromPath(url);
    if (principal.id === id) {
      throw Object.assign(new Error('You cannot delete your own user'), { statusCode: 400 });
    }

    await this.users.delete(id);
    await this.sessions.revokeUserSessions(id);
    sendJson(response, 200, { success: true });
  }
}
