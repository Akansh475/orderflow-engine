import pg from "pg";
const { Client } = pg;
import { logger } from "../config/logger.js";

export const ADVISORY_LOCK_IDS = {
  ORDER_SWEEPER: 100_001,
  OUTBOX_PUBLISHER: 100_002,
} as const;

export type AdvisoryLockId = (typeof ADVISORY_LOCK_IDS)[keyof typeof ADVISORY_LOCK_IDS] | number;

export interface AdvisoryLockOptions {
  lockId: AdvisoryLockId;
  name?: string | undefined;
  connectionString?: string | undefined;
}

export interface LockExecutionResult<T> {
  acquired: boolean;
  result?: T | undefined;
  skippedReason?: string | undefined;
}

/**
 * Distributed mutual exclusion using PostgreSQL Session-Level Advisory Locks.
 *
 * Architecture & Connection Ownership:
 * - PostgreSQL session-level advisory locks (pg_try_advisory_lock) belong strictly
 *   to a dedicated database session/connection.
 * - Unlike Prisma pooled queries, which rotate connections across queries,
 *   PostgresAdvisoryLock maintains a single, dedicated `pg.Client` TCP connection.
 * - This guarantees that the connection acquiring the lock is the exact same connection
 *   holding it throughout the protected operation and releasing it in `finally`.
 * - If the process terminates, crashes, or the TCP connection drops, PostgreSQL's
 *   backend automatically releases all session-level advisory locks held by that session.
 */
export class PostgresAdvisoryLock {
  private readonly lockId: number;
  private readonly name: string;
  private readonly connectionString: string;
  private client: pg.Client | null = null;
  private isConnectedState = false;
  private isLockedState = false;

  constructor(options: AdvisoryLockOptions) {
    this.lockId = options.lockId;
    this.name = options.name ?? `lock-${options.lockId}`;
    this.connectionString = options.connectionString ?? process.env.DATABASE_URL ?? "";
  }

  public getLockId(): number {
    return this.lockId;
  }

  public getName(): string {
    return this.name;
  }

  public isConnected(): boolean {
    return this.isConnectedState && this.client !== null;
  }

  public isLocked(): boolean {
    return this.isLockedState;
  }

  /**
   * Connects the dedicated PostgreSQL client for the lock session.
   * Attaches an error handler to absorb transient connection drops safely.
   */
  public async connect(): Promise<void> {
    if (this.isConnectedState && this.client) {
      return;
    }

    try {
      this.client = new Client({
        connectionString: this.connectionString,
      });

      this.client.on("error", (err) => {
        logger.warn(
          { err: err.message, name: this.name, lockId: this.lockId },
          "Advisory lock dedicated connection error; resetting session state",
        );
        this.isConnectedState = false;
        this.isLockedState = false;
      });

      await this.client.connect();
      this.isConnectedState = true;
    } catch (error) {
      this.isConnectedState = false;
      this.isLockedState = false;
      this.client = null;
      logger.error(
        { err: error, name: this.name, lockId: this.lockId },
        "Failed to establish dedicated connection for advisory lock",
      );
      throw error;
    }
  }

  /**
   * Attempts non-blocking acquisition of the session-level advisory lock.
   * Returns `true` if acquired by this session, `false` if already held by another session/instance.
   */
  public async acquire(): Promise<boolean> {
    if (this.isLockedState) {
      return true;
    }

    try {
      if (!this.isConnectedState || !this.client) {
        await this.connect();
      }

      if (!this.client) {
        return false;
      }

      // Explicit cast to bigint ensures PostgreSQL matches pg_try_advisory_lock(bigint)
      const res = await this.client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [this.lockId.toString()],
      );

      const acquired = res.rows[0]?.acquired === true;
      this.isLockedState = acquired;

      if (acquired) {
        logger.debug(
          { name: this.name, lockId: this.lockId },
          "Acquired distributed PostgreSQL advisory lock",
        );
      } else {
        logger.info(
          { name: this.name, lockId: this.lockId },
          "Advisory lock is currently held by another worker instance; skipping execution cycle",
        );
      }

      return acquired;
    } catch (error) {
      logger.error(
        { err: error, name: this.name, lockId: this.lockId },
        "Error attempting to acquire advisory lock; failing closed (safe skip)",
      );
      this.isLockedState = false;
      return false;
    }
  }

  /**
   * Releases the session-level advisory lock.
   * Returns `true` if released, `false` otherwise.
   */
  public async release(): Promise<boolean> {
    if (!this.isLockedState) {
      return true;
    }

    if (!this.isConnectedState || !this.client) {
      this.isLockedState = false;
      return true;
    }

    try {
      const res = await this.client.query<{ released: boolean }>(
        "SELECT pg_advisory_unlock($1::bigint) AS released",
        [this.lockId.toString()],
      );

      const released = res.rows[0]?.released === true;
      this.isLockedState = false;

      logger.debug(
        { name: this.name, lockId: this.lockId, released },
        "Released distributed PostgreSQL advisory lock",
      );

      return released;
    } catch (error) {
      logger.error(
        { err: error, name: this.name, lockId: this.lockId },
        "Error releasing advisory lock",
      );
      this.isLockedState = false;
      return false;
    }
  }

  /**
   * Executes a protected operation within the advisory lock.
   * If the lock is held by another instance, the operation is skipped non-blockingly.
   * The lock is strictly released in the `finally` block upon completion or error.
   */
  public async withLock<T>(action: () => Promise<T>): Promise<LockExecutionResult<T>> {
    const acquired = await this.acquire();
    if (!acquired) {
      return {
        acquired: false,
        skippedReason: "LOCK_HELD_BY_ANOTHER_INSTANCE",
      };
    }

    try {
      const result = await action();
      return {
        acquired: true,
        result,
      };
    } finally {
      await this.release();
    }
  }

  /**
   * Gracefully shuts down the lock session by releasing any active lock
   * and closing the dedicated PostgreSQL connection.
   */
  public async disconnect(): Promise<void> {
    try {
      if (this.isLockedState) {
        await this.release();
      }
    } catch (err) {
      logger.warn({ err, name: this.name }, "Ignored error during advisory lock release on disconnect");
    }

    try {
      if (this.client) {
        await this.client.end();
      }
    } catch (err) {
      logger.warn({ err, name: this.name }, "Ignored error during dedicated client disconnect");
    } finally {
      this.client = null;
      this.isConnectedState = false;
      this.isLockedState = false;
    }
  }
}
