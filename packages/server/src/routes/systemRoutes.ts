import type { ServerResponse } from 'node:http';
import { ClickHouseRepository } from '../db/clickhouse.js';
import { PostgresClient } from '../db/postgres.js';
import { sendJson } from '../http/http.js';
import { LogQueueService } from '../services/logQueueService.js';
import { SessionService } from '../services/sessionService.js';

export class SystemRoutes {
  public constructor(
    private readonly repository: ClickHouseRepository,
    private readonly postgres: PostgresClient,
    private readonly sessions: SessionService,
    private readonly queue: LogQueueService,
  ) {}

  public async health(response: ServerResponse): Promise<void> {
    const [clickhouse, postgres, redis, queueHealthy, queueStatus] = await Promise.all([
      this.repository.health().catch(() => false),
      this.postgres.health().catch(() => false),
      this.sessions.health().catch(() => false),
      this.queue.health().catch(() => false),
      this.queue.status().catch(() => ({
        pending: -1,
        workerRunning: false,
        lastFlushAt: '',
        lastError: 'queue status unavailable',
      })),
    ]);
    const healthy = clickhouse && postgres && redis && queueHealthy && queueStatus.workerRunning;
    sendJson(response, healthy ? 200 : 503, {
      success: healthy,
      data: {
        clickhouse,
        postgres,
        redis,
        auth: redis,
        queue: queueHealthy,
        queuePending: queueStatus.pending,
        queueWorkerRunning: queueStatus.workerRunning,
        queueLastFlushAt: queueStatus.lastFlushAt,
        queueLastError: queueStatus.lastError,
      },
    });
  }
}
