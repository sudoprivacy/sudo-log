import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthConfig } from '../config/appConfig.js';

export interface JwtClaims {
  iss: string;
  sub: string;
  username: string;
  email: string;
  role: string;
  permissions: string[];
  jti: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function base64UrlJson(value: unknown): string {
  return base64UrlEncode(JSON.stringify(value));
}

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

export class JwtService {
  public constructor(private readonly config: AuthConfig) {}

  public issue(input: { subject: string; username: string; email: string; role: string; permissions: string[] }): { token: string; claims: JwtClaims } {
    const now = Math.floor(Date.now() / 1000);
    const claims: JwtClaims = {
      iss: this.config.jwtIssuer,
      sub: input.subject,
      username: input.username,
      email: input.email,
      role: input.role,
      permissions: input.permissions,
      jti: randomUUID(),
      iat: now,
      exp: now + this.config.accessTokenTtlSeconds,
    };

    const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
    const payload = base64UrlJson(claims);
    const signature = sign(`${header}.${payload}`, this.config.jwtSecret);
    return {
      token: `${header}.${payload}.${signature}`,
      claims,
    };
  }

  public verify(token: string): JwtClaims {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw Object.assign(new Error('Invalid token'), { statusCode: 401 });
    }

    const [header, payload, signature] = parts;
    const expected = sign(`${header}.${payload}`, this.config.jwtSecret);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      throw Object.assign(new Error('Invalid token signature'), { statusCode: 401 });
    }

    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    if (parsed.iss !== this.config.jwtIssuer) {
      throw Object.assign(new Error('Invalid token issuer'), { statusCode: 401 });
    }
    if (!parsed.jti || !parsed.sub || parsed.exp <= now) {
      throw Object.assign(new Error('Token expired'), { statusCode: 401 });
    }
    return parsed;
  }
}
