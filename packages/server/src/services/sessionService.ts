import type { RedisConfig } from '../config/appConfig.js';
import { RedisClient } from './redisClient.js';

export interface SessionRecord {
  jti: string;
  userId: string;
  username: string;
  email: string;
  role: string;
  permissions: string[];
  ipAddress: string;
  userAgent: string;
  issuedAt: string;
  expiresAt: string;
}

export class SessionService {
  private readonly redis: RedisClient;

  public constructor(private readonly config: RedisConfig) {
    this.redis = new RedisClient(config.url);
  }

  public async health(): Promise<boolean> {
    return this.redis.ping();
  }

  public async create(session: SessionRecord, ttlSeconds: number): Promise<void> {
    await this.redis.setEx(this.key(`session:${session.userId}:${session.jti}`), ttlSeconds, JSON.stringify(session));
    await this.redis.sadd(this.key(`user-sessions:${session.userId}`), session.jti);
    await this.redis.expire(this.key(`user-sessions:${session.userId}`), ttlSeconds);
  }

  public async find(userId: string, jti: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(this.key(`session:${userId}:${jti}`));
    if (!raw) return null;
    return JSON.parse(raw) as SessionRecord;
  }

  public async revoke(userId: string, jti: string): Promise<void> {
    await this.redis.del(this.key(`session:${userId}:${jti}`));
    await this.redis.srem(this.key(`user-sessions:${userId}`), jti);
  }

  public async revokeUserSessions(userId: string): Promise<number> {
    const jtis = await this.redis.smembers(this.key(`user-sessions:${userId}`));
    const keys = jtis.map((jti) => this.key(`session:${userId}:${jti}`));
    const deleted = await this.redis.del(...keys);
    await this.redis.del(this.key(`user-sessions:${userId}`));
    return deleted;
  }

  public async enqueue(queueName: string, payload: unknown): Promise<void> {
    await this.redis.lpush(this.key(`queue:${queueName}`), JSON.stringify(payload));
  }

  public async dequeue(queueName: string): Promise<unknown | null> {
    const raw = await this.redis.rpop(this.key(`queue:${queueName}`));
    return raw ? JSON.parse(raw) : null;
  }

  private key(name: string): string {
    return `${this.config.keyPrefix}:${name}`;
  }
}
