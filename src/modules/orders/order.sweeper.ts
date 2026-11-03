import { logger } from "../../config/logger.js";
import {
  getOrderExpirationSeconds,
  getOrderSweeperBatchSize,
  getOrderSweeperIntervalMs,
} from "../../config/env.js";
import { orderRepository } from "./order.repository.js";
import {
  ADVISORY_LOCK_IDS,
  PostgresAdvisoryLock,
} from "../../shared/advisory-lock.js";

export interface SweepOptions {
  olderThanSeconds?: number | undefined;
  batchLimit?: number | undefined;
  maxOrdersPerSweep?: number | undefined;
}

export interface SweepResult {
  discovered: number;
  processed: number;
  skipped: number;
  failed: number;
  orderIds: string[];
  cutoff: string;
  durationMs: number;
}

export interface SweeperScheduleOptions extends SweepOptions {
  intervalMs?: number | undefined;
  runImmediately?: boolean | undefined;
  useDistributedLock?: boolean | undefined;
  advisoryLock?: PostgresAdvisoryLock | undefined;
}

export class OrderSweeper {
  private isRunningState = false;
  private isSweepingState = false;
  private timer: NodeJS.Timeout | null = null;
  private advisoryLock: PostgresAdvisoryLock | null = null;

  /**
   * Indicates whether the periodic sweeper loop is actively running.
   */
  public isRunning(): boolean {
    return this.isRunningState;
  }

  /**
   * Indicates whether a sweep cycle is currently in progress.
   */
  public isSweeping(): boolean {
    return this.isSweepingState;
  }

  /**
   * Returns the active PostgresAdvisoryLock instance if distributed locking is enabled.
   */
  public getAdvisoryLock(): PostgresAdvisoryLock | null {
    return this.advisoryLock;
  }

  /**
   * Executes a single sweep cycle to discover and reclaim stale order reservations.
   *
   * Concurrency & Idempotency:
   * - Queries pending orders whose reservation expiration window has elapsed using an indexed range scan.
   * - Delegates each order cancellation to `orderRepository.expireOrder`, which uses atomic PostgreSQL
   *   transactions and CAS conditional updates (`status = 'PENDING'`).
   * - If a concurrent BullMQ worker or customer payment transitions the order first, `expireOrder`
   *   safely rejects with "Order is not eligible for expiration", which the sweeper counts as `skipped`.
   * - Any unexpected error on an individual order increments `failed` without halting the sweep for remaining orders.
   */
  public async sweep(options?: SweepOptions): Promise<SweepResult> {
    if (this.isSweepingState) {
      logger.warn("Sweep execution already active; skipping overlapping invocation");
      return {
        discovered: 0,
        processed: 0,
        skipped: 0,
        failed: 0,
        orderIds: [],
        cutoff: new Date().toISOString(),
        durationMs: 0,
      };
    }

    this.isSweepingState = true;
    const startTime = Date.now();

    const ttlSeconds =
      options?.olderThanSeconds !== undefined && options.olderThanSeconds > 0
        ? options.olderThanSeconds
        : getOrderExpirationSeconds();

    const batchLimit =
      options?.batchLimit !== undefined && options.batchLimit > 0
        ? options.batchLimit
        : getOrderSweeperBatchSize();

    const maxOrders = options?.maxOrdersPerSweep ?? 500;
    const cutoff = new Date(Date.now() - ttlSeconds * 1000);

    let discoveredCount = 0;
    let processedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const expiredIds: string[] = [];
    const excludedIds: string[] = [];

    try {
      while (discoveredCount < maxOrders) {
        const batchTake = Math.min(batchLimit, maxOrders - discoveredCount);
        const staleOrders = await orderRepository.findStalePendingOrders(
          cutoff,
          batchTake,
          excludedIds,
        );

        if (staleOrders.length === 0) {
          break;
        }

        discoveredCount += staleOrders.length;

        for (const order of staleOrders) {
          try {
            await orderRepository.expireOrder(order.id);
            processedCount++;
            expiredIds.push(order.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (
              message === "Order is not eligible for expiration" ||
              message === "Order not found"
            ) {
              // Order was concurrently confirmed, cancelled, or expired by another worker
              skippedCount++;
              logger.debug(
                { orderId: order.id, reason: message },
                "Order reservation was skipped (concurrent state transition)",
              );
            } else {
              // Unexpected failure (e.g. database error, inventory constraint mismatch)
              failedCount++;
              logger.error(
                { orderId: order.id, err: error },
                "Unexpected failure expiring stale order reservation",
              );
            }
          } finally {
            // Exclude this ID in subsequent batches to prevent infinite loops if an order fails
            excludedIds.push(order.id);
          }
        }

        if (staleOrders.length < batchTake) {
          break;
        }
      }

      const durationMs = Date.now() - startTime;
      const result: SweepResult = {
        discovered: discoveredCount,
        processed: processedCount,
        skipped: skippedCount,
        failed: failedCount,
        orderIds: expiredIds,
        cutoff: cutoff.toISOString(),
        durationMs,
      };

      if (discoveredCount > 0 || failedCount > 0) {
        logger.info(
          {
            discovered: discoveredCount,
            processed: processedCount,
            skipped: skippedCount,
            failed: failedCount,
            durationMs,
          },
          "Stale order reservation sweep completed",
        );
      } else {
        logger.debug(
          { durationMs, cutoff: cutoff.toISOString() },
          "Stale order reservation sweep finished (no eligible orders)",
        );
      }

      return result;
    } finally {
      this.isSweepingState = false;
    }
  }

  /**
   * Starts the periodic background sweeper loop.
   *
   * Operational Behavior:
   * - Guarantees single-loop execution: duplicate calls to `start()` are ignored.
   * - Runs immediately at startup by default.
   * - Uses a non-overlapping scheduling pattern so that long-running sweeps do not stack.
   */
  public start(options?: SweeperScheduleOptions): void {
    if (this.isRunningState) {
      logger.warn("Order reservation sweeper is already running; ignoring duplicate start request");
      return;
    }

    this.isRunningState = true;

    if (options?.useDistributedLock ?? false) {
      this.advisoryLock =
        options?.advisoryLock ??
        new PostgresAdvisoryLock({
          lockId: ADVISORY_LOCK_IDS.ORDER_SWEEPER,
          name: "order-sweeper",
        });
    }

    const intervalMs =
      options?.intervalMs !== undefined && options.intervalMs > 0
        ? options.intervalMs
        : getOrderSweeperIntervalMs();

    logger.info(
      {
        intervalMs,
        ttlSeconds: options?.olderThanSeconds ?? getOrderExpirationSeconds(),
        batchLimit: options?.batchLimit ?? getOrderSweeperBatchSize(),
        distributedLockEnabled: this.advisoryLock !== null,
      },
      "Starting periodic order reservation sweeper runner",
    );

    const executeSweepSafely = async (): Promise<void> => {
      if (!this.isRunningState) return;

      try {
        if (this.advisoryLock) {
          const lockResult = await this.advisoryLock.withLock(async () => {
            await this.sweep(options);
          });

          if (!lockResult.acquired) {
            logger.info(
              { lockId: this.advisoryLock.getLockId() },
              "Order reservation sweeper advisory lock held by another worker instance; skipping scheduled interval",
            );
          }
        } else {
          await this.sweep(options);
        }
      } catch (error) {
        logger.error({ err: error }, "Unhandled error during scheduled reservation sweep");
      }
    };

    if (options?.runImmediately ?? true) {
      void executeSweepSafely();
    }

    this.timer = setInterval(() => {
      void executeSweepSafely();
    }, intervalMs);
  }

  /**
   * Stops the background sweeper loop and waits for any active sweep to complete.
   */
  public async stop(): Promise<void> {
    if (!this.isRunningState) return;

    logger.info("Stopping order reservation sweeper...");
    this.isRunningState = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Await active sweep completion to ensure clean shutdown
    while (this.isSweepingState) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (this.advisoryLock) {
      await this.advisoryLock.disconnect();
      this.advisoryLock = null;
    }

    logger.info("Order reservation sweeper stopped");
  }
}

export const orderSweeper = new OrderSweeper();
