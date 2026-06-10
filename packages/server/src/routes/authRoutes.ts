import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../config/appConfig.js';
import { readJsonBody, sendJson } from '../http/http.js';
import { AuthService } from '../services/authService.js';

interface LoginRequest {
  login?: unknown;
  email?: unknown;
  username?: unknown;
  password?: unknown;
}

interface ChangePasswordRequest {
  currentPassword?: unknown;
  newPassword?: unknown;
}

export class AuthRoutes {
  public constructor(
    private readonly config: AppConfig,
    private readonly auth: AuthService,
  ) {}

  public async login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody<LoginRequest>(request, this.config.maxBodyBytes);
    const login = typeof body.login === 'string' ? body.login : typeof body.email === 'string' ? body.email : body.username;
    if (typeof login !== 'string' || typeof body.password !== 'string') {
      throw Object.assign(new Error('login and password are required'), { statusCode: 400 });
    }

    const result = await this.auth.login(login, body.password, request);
    sendJson(response, 200, { success: true, data: result });
  }

  public async me(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const principal = await this.auth.authenticateRequest(request);
    sendJson(response, 200, {
      success: true,
      data: {
        id: principal.id,
        username: principal.username,
        email: principal.email,
        role: principal.role,
        permissions: [...principal.permissions],
      },
    });
  }

  public async logout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await this.auth.logout(request);
    sendJson(response, 200, { success: true });
  }

  public async logoutAll(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const revoked = await this.auth.logoutAll(request);
    sendJson(response, 200, { success: true, data: { revoked } });
  }

  public async changePassword(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody<ChangePasswordRequest>(request, this.config.maxBodyBytes);
    if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
      throw Object.assign(new Error('currentPassword and newPassword are required'), { statusCode: 400 });
    }

    await this.auth.changePassword(request, body.currentPassword, body.newPassword);
    sendJson(response, 200, { success: true });
  }
}
