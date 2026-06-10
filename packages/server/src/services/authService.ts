import type { IncomingMessage } from 'node:http';
import type { AppConfig } from '../config/appConfig.js';
import { getBearerToken } from '../http/http.js';
import {
  permissionsForRole,
  toPublicUser,
  type Permission,
  type PublicUser,
  type UserRole,
} from '../types/auth.js';
import { JwtService } from './jwtService.js';
import { verifyPassword } from './passwordService.js';
import { SessionService, type SessionRecord } from './sessionService.js';
import { UserStore } from './userStore.js';

export interface Principal {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  permissions: Set<Permission>;
  sessionId: string;
}

export interface LoginResult {
  accessToken: string;
  expiresAt: string;
  user: PublicUser;
}

export class AuthService {
  private readonly jwt: JwtService;

  public constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionService,
    private readonly users: UserStore,
  ) {
    this.jwt = new JwtService(config.auth);
  }

  public async bootstrap(): Promise<void> {
    await this.users.ensureBootstrapAdmin(this.config.auth);
  }

  public async login(login: string, password: string, request: IncomingMessage): Promise<LoginResult> {
    const user = await this.users.findByLogin(login);
    if (!user || !user.enabled) {
      throw Object.assign(new Error('Invalid login or password'), { statusCode: 401 });
    }

    const validPassword = await verifyPassword(password, user.passwordHash);

    if (!validPassword) {
      throw Object.assign(new Error('Invalid login or password'), { statusCode: 401 });
    }

    const permissions = permissionsForRole(user.role);
    const { token, claims } = this.jwt.issue({
      subject: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      permissions,
    });

    const session: SessionRecord = {
      jti: claims.jti,
      userId: user.id,
      username: user.username,
      email: claims.email,
      role: claims.role,
      permissions: claims.permissions,
      ipAddress: this.ipAddress(request),
      userAgent: this.userAgent(request),
      issuedAt: new Date(claims.iat * 1000).toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
    await this.sessions.create(session, this.config.auth.accessTokenTtlSeconds);
    await this.users.updateLastLogin(user.id);
    const publicUser = toPublicUser({ ...user, lastLoginAt: new Date().toISOString() });

    return {
      accessToken: token,
      expiresAt: session.expiresAt,
      user: publicUser,
    };
  }

  public async authenticateRequest(request: IncomingMessage): Promise<Principal> {
    const token = getBearerToken(request);
    if (!token) {
      throw Object.assign(new Error('Authorization token is required'), { statusCode: 401 });
    }

    const claims = this.jwt.verify(token);
    const session = await this.sessions.find(claims.sub, claims.jti);
    if (!session) {
      throw Object.assign(new Error('Session expired'), { statusCode: 401 });
    }

    const user = await this.users.findById(claims.sub);
    if (!user || !user.enabled) {
      throw Object.assign(new Error('User not found or disabled'), { statusCode: 401 });
    }

    const permissions = permissionsForRole(user.role);
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      permissions: new Set(permissions),
      sessionId: claims.jti,
    };
  }

  public async logout(request: IncomingMessage): Promise<void> {
    const principal = await this.authenticateRequest(request);
    await this.sessions.revoke(principal.id, principal.sessionId);
  }

  public async logoutAll(request: IncomingMessage): Promise<number> {
    const principal = await this.authenticateRequest(request);
    return this.sessions.revokeUserSessions(principal.id);
  }

  public async changePassword(request: IncomingMessage, currentPassword: string, newPassword: string): Promise<void> {
    const principal = await this.authenticateRequest(request);
    const user = await this.users.findById(principal.id);
    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 401 });
    }

    const validPassword = await verifyPassword(currentPassword, user.passwordHash);
    if (!validPassword) {
      throw Object.assign(new Error('Current password is invalid'), { statusCode: 400 });
    }

    await this.users.updatePassword(principal.id, newPassword);
    await this.sessions.revokeUserSessions(principal.id);
  }

  public async authorize(request: IncomingMessage, permission: Permission): Promise<Principal> {
    const principal = await this.authenticateRequest(request);
    if (!principal.permissions.has(permission)) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    return principal;
  }

  private ipAddress(request: IncomingMessage): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
    const realIp = request.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
    return request.socket.remoteAddress ?? 'unknown';
  }

  private userAgent(request: IncomingMessage): string {
    const value = request.headers['user-agent'];
    if (Array.isArray(value)) return value.join(' ');
    return value?.trim() || 'unknown';
  }
}
