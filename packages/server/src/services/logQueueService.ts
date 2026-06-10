import type { QueueConfig, RedisConfig } from '../config/appConfig.js';
import type { ClickHouseRepository } from '../db/clickhouse.js';
import type { NormalizedLogRow } from '../types/log.js';
import { RedisClient } from './redisClient.js';

export interface LogQueueStatus {
  pending: number;
  workerRunning: boolean;
  lastFlushAt: string;
  lastError: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class LogQueueService {
  private readonly redis: RedisClient;
  private readonly queueKey: string;
  private running = false;
  private stopped = false;
  private lastFlushAt = '';
  private lastError = '';

  public constructor(
    redisConfig: RedisConfig,
    private readonly queueConfig: QueueConfig,
    private readonly repository: ClickHouseRepository,
  ) {
    this.redis = new RedisClient(redisConfig.url);
    this.queueKey = `${redisConfig.keyPrefix}:queue:${queueConfig.name}`;
  }

  public async health(): Promise<boolean> {
    await this.redis.ping();
    return true;
  }

  public async enqueue(rows: NormalizedLogRow[]): Promise<void> {
    await this.redis.lpushMany(
      this.queueKey,
      rows.map((row) => JSON.stringify(row)),
    );
  }

  public async pending(): Promise<number> {
    return this.redis.llen(this.queueKey);
  }

  public async status(): Promise<LogQueueStatus> {
    return {
      pending: await this.pending().catch(() => -1),
      workerRunning: this.running && !this.stopped,
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
    };
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    void this.run();
  }

  public stop(): void {
    this.stopped = true;
  }

  public async flushOnce(): Promise<number> {
    const rawRows = await this.redis.rpopCount(this.queueKey, this.queueConfig.batchSize);
    const rows = rawRows.map((raw) => JSON.parse(raw) as NormalizedLogRow);

    if (rows.length === 0) return 0;

    try {
      await this.repository.insertRows(rows);
      this.lastFlushAt = new Date().toISOString();
      this.lastError = '';
      return rows.length;
    } catch (error) {
      await this.requeueFront(rows);
      this.lastError = error instanceof Error ? error.message : 'Unknown log queue flush error';
      throw error;
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const flushed = await this.flushOnce();
        await sleep(flushed > 0 ? 0 : this.queueConfig.pollIntervalMs);
      } catch (error) {
        console.error('sudo-log queue flush failed', error);
        await sleep(this.queueConfig.retryDelayMs);
      }
    }
    this.running = false;
  }

  private async requeueFront(rows: NormalizedLogRow[]): Promise<void> {
    await this.redis.rpushMany(
      this.queueKey,
      rows
        .slice()
        .reverse()
        .map((row) => JSON.stringify(row)),
    );
  }
}
