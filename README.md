# OrderFlow Engine

A distributed, high-performance E-Commerce Order & Inventory Management Engine engineered for Low-Level Design (LLD) and High-Level Design (HLD) best practices.

## Technology Stack

- **Runtime**: Node.js (ES Modules)
- **Web Framework**: Express 5
- **Language**: TypeScript
- **Database & ORM**: PostgreSQL 17, Prisma 6
- **Caching & Queues**: Redis 7, BullMQ
- **Validation**: Zod
- **Testing**: Vitest, Supertest
- **Logging**: Pino & Pino-HTTP

---

## Features

- **Product Management**: Full CRUD operations, soft-delete archival (`isArchived`), deterministic validation, pagination, filtering, sorting, and full-text search.
- **Order Processing**: Creation, idempotency protection, atomic inventory reservation with transaction retry handling, payment processing, cancellation, and fulfillment.
- **Transactional Outbox & Worker**: Guaranteed event dispatch with idempotent background worker processing.
- **Resilience & Observability**: API rate limiting, structured JSON logging with correlation IDs, health check endpoints (`/health`, `/health/db`).
- **Product Caching (Cache-Aside)**: High-speed read caching for product detail and paginated listings using Redis with automated invalidation and database fallback.
- **Order Reservation Expiration & Auto-Release**: Dual-layer reservation lifecycle management combining BullMQ delayed jobs, a dedicated automated background sweeper runner, and administrative batch reconciliation endpoints to reclaim inventory from abandoned checkouts, emit `ORDER_EXPIRED` outbox events, and prevent stock starvation.
- **Distributed Advisory Locking**: Multi-replica coordination using PostgreSQL session-level advisory locks on dedicated database connections to prevent duplicate execution across horizontally scaled container instances.
- **Dead-Letter Queue (DLQ) & Exponential Backoff**: Resilient transactional outbox retry mechanism featuring configurable exponential backoff delays with optional jitter, automated `DEAD_LETTER` transition upon exceeding maximum retry thresholds, and administrative observability endpoints (`/admin/outbox/dead-letter`) with safe manual replay capabilities.

---

## Transactional Outbox: Dead-Letter Queue (DLQ) & Exponential Backoff

### 1. The Need for Exponential Backoff & Dead-Letter Queues

In high-throughput event-driven microservices architectures, transactional outbox publishing can fail for transient or permanent reasons:
- **Transient Failures**: Redis connection timeouts, temporary message queue saturation, or short-lived network glitches.
- **Poison / Permanent Failures**: Schema incompatibilities, corrupt payload data, or downstream consumers that permanently reject an event.

Without exponential backoff and a dead-letter mechanism, unhandled failures trigger an infinite retry loop:
1. **Runner Saturation**: The publisher repeatedly queries and retries failing events every tick (every 2 seconds), starving newly created events from being published.
2. **Thundering Herd / Cascading Failures**: Hammering an already overwhelmed message broker multiplies downstream pressure.
3. **Log Flood**: Application logs are spammed with repeated stack traces every 2 seconds.

### 2. Exponential Backoff Formula & Scheduling

Failed outbox events are scheduled with exponential backoff delays persisted directly in PostgreSQL (`nextAttemptAt`), ensuring retry schedules survive process restarts:

$$\text{delay} = \min\left(\text{baseDelay} \times 2^{\text{attempts} - 1}, \text{maxDelay}\right) + \text{jitter}$$

#### Configuration Parameters

| Environment Variable | Default Value | Description |
| :--- | :--- | :--- |
| `OUTBOX_RETRY_BASE_DELAY_MS` | `5000` (5 seconds) | Initial delay after the first delivery failure |
| `OUTBOX_RETRY_MAX_DELAY_MS` | `900000` (15 minutes) | Maximum delay cap for exponential backoff progression |
| `OUTBOX_MAX_ATTEMPTS` | `5` | Maximum delivery attempts before transitioning to `DEAD_LETTER` |
| `OUTBOX_RETRY_JITTER_ENABLED` | `false` | When enabled, adds bounded random noise to prevent synchronized retries |
| `OUTBOX_RETRY_JITTER_FACTOR` | `0.2` (20%) | Maximum random jitter percentage added to calculated backoff |

#### Progression Timeline (Default Configuration)

| Attempt # | Calculated Delay | Next Retry Window | Outcome If Failure Persists |
| :--- | :--- | :--- | :--- |
| **Attempt 1** | $5000 \times 2^0 = 5\,\text{s}$ | $+5$ seconds from failure | Remains `PENDING`, `nextAttemptAt` scheduled |
| **Attempt 2** | $5000 \times 2^1 = 10\,\text{s}$ | $+10$ seconds from failure | Remains `PENDING`, `nextAttemptAt` scheduled |
| **Attempt 3** | $5000 \times 2^2 = 20\,\text{s}$ | $+20$ seconds from failure | Remains `PENDING`, `nextAttemptAt` scheduled |
| **Attempt 4** | $5000 \times 2^3 = 40\,\text{s}$ | $+40$ seconds from failure | Remains `PENDING`, `nextAttemptAt` scheduled |
| **Attempt 5** | $\text{Exceeds Max}$ | Immediate transition | **Transitions permanently to `DEAD_LETTER`** |

### 3. Database Schema & State Lifecycle

The `OutboxEvent` entity maintains persistent lifecycle state:

```prisma
enum OutboxStatus {
  PENDING
  PUBLISHED
  DEAD_LETTER
}

model OutboxEvent {
  id             String       @id @default(cuid())
  eventType      String
  aggregateId    String
  payload        Json
  createdAt      DateTime     @default(now())
  processedAt    DateTime?
  attempts       Int          @default(0)
  lastError      String?
  status         OutboxStatus @default(PENDING)
  nextAttemptAt  DateTime?
  deadLetteredAt DateTime?

  @@index([status, nextAttemptAt, createdAt])
  @@index([status, deadLetteredAt])
  @@index([processedAt, createdAt])
  @@index([aggregateId])
}
```

```
                    ┌────────────────────────┐
                    │      Order Commit      │
                    │   (status = PENDING)   │
                    └───────────┬────────────┘
                                │
                                ▼
                    ┌────────────────────────┐
          ┌────────►│    Publish Attempt     │
          │         └───────────┬────────────┘
          │                     │
          │            Success? │
          │           ┌─────────┴─────────┐
          │       Yes │                   │ No
          │           ▼                   ▼
          │   ┌───────────────┐   ┌────────────────────────┐
          │   │   PUBLISHED   │   │ Increment `attempts`   │
          │   │ processedAt   │   │ Capture `lastError`    │
          │   └───────────────┘   └───────────┬────────────┘
          │                                   │
          │                       Attempts >= maxAttempts?
          │                      ┌────────────┴────────────┐
          │                   No │                         │ Yes
          │                      ▼                         ▼
          │         ┌────────────────────────┐   ┌───────────────────┐
          └─────────┤   Calculate Backoff    │   │    DEAD_LETTER    │
                    │ Set `nextAttemptAt`    │   │ `deadLetteredAt`  │
                    │ (Excluded until due)   │   │ Excluded from run │
                    └────────────────────────┘   └─────────┬─────────┘
                                                           │
                                                           │ Admin /replay
                                                           ▼
                                                 ┌───────────────────┐
                                                 │ Resets to PENDING │
                                                 │ attempts = 0      │
                                                 │ nextAttemptAt=now │
                                                 └───────────────────┘
```

#### State Invariants
- **No Event Loss**: Failed events are never deleted from the database.
- **Exclusion from Normal Loop**: `DEAD_LETTER` events and events whose `nextAttemptAt > now` are strictly excluded by the database query (`WHERE status = 'PENDING' AND (nextAttemptAt IS NULL OR nextAttemptAt <= now)`).
- **Restart Immunity**: Because retry counts and timestamps reside in PostgreSQL rows, worker restarts or container rescheduling preserve exact retry history.

---

## Distributed Advisory Locking Architecture

### 1. The Multi-Replica Distributed Challenge

In production cloud environments (Kubernetes, AWS ECS, Docker Compose replicas), background worker processes (`order.sweeper.runner.ts` and `outbox.runner.ts`) are deployed across multiple containers for high availability.

- **In-Memory Mutex Limitation**: Local boolean flags (`isSweepingState`, `running`) exist only within the memory heap of a single Node.js process. They cannot prevent container replica A and container replica B from triggering sweeps or event dispatches at the exact same second.
- **Consequences of Uncoordinated Execution**:
  - Duplicate database queries and range scans multiplying load on PostgreSQL.
  - Heightened row lock contention and avoidable transaction aborts (`P2034` serialization conflicts).
  - Outbox workers racing to process and publish the exact same event batches.

### 2. In-Memory Mutex vs. Distributed Lock

| Dimension | In-Memory Mutex (`isSweepingState`, `running`) | Distributed PostgreSQL Advisory Lock (`PostgresAdvisoryLock`) |
| :--- | :--- | :--- |
| **Scope** | Single Node.js process / single thread heap | Global across all container instances connected to PostgreSQL |
| **Multi-Instance Protection** | ❌ None (each replica runs independently) | ✅ Full mutual exclusion across all application replicas |
| **Overlapping Execution** | Prevents overlapping ticks within the same process | Prevents concurrent ticks across all cluster instances |
| **Storage / Mechanism** | Local boolean state variable in JavaScript runtime | PostgreSQL engine shared memory table (`pg_locks`) |
| **Role in Architecture** | Local primary guard to eliminate local event-loop stacking | Distributed coordination guard to eliminate multi-container contention |

### 3. PostgreSQL Advisory Lock Mechanics

OrderFlow Engine uses **Session-Level Advisory Locks** via PostgreSQL's built-in lock manager:

```sql
-- Non-blocking acquisition attempt:
SELECT pg_try_advisory_lock($1::bigint) AS acquired;

-- Explicit release:
SELECT pg_advisory_unlock($1::bigint) AS released;
```

#### Why Dedicated Connection Ownership is Mandatory
- **PostgreSQL Session Affinity**: In PostgreSQL, session-level advisory locks belong strictly to a single database session (connection).
- **Prisma Connection Pooling Hazard**: Prisma's query engine maintains a connection pool, acquiring a connection for a query and immediately releasing it back to the pool. Calling `pg_try_advisory_lock` via `prisma.$queryRaw` would acquire the lock on connection A, return connection A to the pool, run subsequent work on connection B (which does not own the lock!), and fail to release on connection C.
- **Solution — Dedicated `pg.Client`**: `PostgresAdvisoryLock` encapsulates a dedicated `pg.Client` instance that remains connected for the lifetime of the lock session. The exact TCP connection that acquires the lock holds it throughout the protected block and releases it in `finally`.
- **Automatic Failure Recovery**: If a worker container crashes, suffers an Out-of-Memory (OOM) kill, or loses network connectivity, PostgreSQL detects the severed TCP socket and **instantly releases all session-level advisory locks** held by that session, preventing deadlocks or orphaned locks.

### 4. Lock Identifiers & Complete Subsystem Isolation

Advisory lock keys are 64-bit integers partitioned into stable, dedicated namespaces:

| Lock Constant | Lock ID | Protected Component | Isolation Boundary |
| :--- | :--- | :--- | :--- |
| `ADVISORY_LOCK_IDS.ORDER_SWEEPER` | `100001` | `order.sweeper.runner.ts` | Isolated from outbox publishing |
| `ADVISORY_LOCK_IDS.OUTBOX_PUBLISHER` | `100002` | `outbox.runner.ts` | Isolated from reservation sweeper |

Because lock IDs are distinct numbers in PostgreSQL's advisory lock namespace, the reservation sweeper and outbox publisher run concurrently without ever blocking or waiting for each other.

### 5. Multi-Replica Execution & Contention Flow

```
[ Container Replica 1 ]                [ PostgreSQL Engine ]                [ Container Replica 2 ]
          │                                     │                                     │
   Interval Tick #1                             │                              Interval Tick #1
          │                                     │                                     │
          ├──── pg_try_advisory_lock(100001) ──►│                                     │
          │     (Acquired: true)                │                                     │
          │◄────────────────────────────────────┤                                     │
          │                                     │                                     │
          │  [Runs Batch Sweep / Outbox]        │◄─── pg_try_advisory_lock(100001) ───┤
          │                                     │     (Acquired: false - Lock Busy)   │
          │                                     ├────────────────────────────────────►│
          │                                     │                                     │
          │                                     │                               [Skips execution cycle;]
          │                                     │                               [Logs clear info message]
          │                                     │                                     │
          ├──── pg_advisory_unlock(100001) ─────►│                                     │
          │     (Released: true)                │                                     │
          │◄────────────────────────────────────┤                                     │
          │                                     │                                     │
   Sweep Complete                               │                              Idle until next tick
```

### 6. Defense-in-Depth: Why Database Transactions & CAS Remain Essential

A common distributed systems pitfall is assuming distributed locks eliminate the need for transactional safety. In OrderFlow Engine, distributed locks provide **operational efficiency**, while database transactions provide **absolute correctness**:

1. **Uncoordinated Triggers**: BullMQ worker jobs (`order.worker.ts`) and administrative endpoints (`POST /orders/admin/expire-stale`) execute outside the runner's lock.
2. **Network Partitions (Split-Brain)**: If network partitions temporarily affect connectivity, database ACID transactions and Compare-And-Swap (`UPDATE "Order" SET status = 'CANCELLED' WHERE id = :id AND status = 'PENDING'`) guarantee that an order is never cancelled twice and inventory is never double-restored.
3. **Outbox Guarantee**: Outbox event publishing uses idempotency tracking (`ProcessedEvent`) and atomic status transitions so duplicate delivery cannot corrupt downstream consumers.

### 7. Operational Limitations & Failure Handling

- **Database Offline**: If PostgreSQL is unreachable when `acquire()` is called, `PostgresAdvisoryLock` logs an error, fail-closes, and returns `acquired: false`. The worker skips the cycle and safely retries on the next interval without crashing.
- **Connection Loss Mid-Execution**: If the dedicated connection drops while work is in flight, PostgreSQL releases the lock on the server side. Client-side error listeners intercept the socket error, mark the state disconnected, and automatically re-establish a fresh client on the subsequent cycle.
- **Non-Preemptive Execution**: Lock acquisition is non-blocking (`pg_try_advisory_lock`). Replicas that do not obtain the lock do not queue or wait; they skip the current interval and wait for their next scheduled tick.

---

## Product Caching Architecture

### 1. Cache-Aside Pattern (Lazy Loading)

Product data is cached using the Cache-Aside pattern:
1. When a read request (`GET /products/:id` or `GET /products`) arrives, the service first queries Redis.
2. **Cache Hit**: Data is deserialized and returned directly from Redis, bypassing PostgreSQL.
3. **Cache Miss**: Data is queried from PostgreSQL, serialized, stored in Redis with a TTL, and returned to the client.
4. **Resilience Fallback**: If Redis is offline, times out, or errors, the error is logged as a warning, and the request seamlessly falls back to PostgreSQL without failing the user request.
5. **Negative Caching Guard**: Failed responses (4xx, 5xx) and nonexistent products (404) are never cached.

### 2. Cache Key Design

Keys are namespaced and generated deterministically:

- **Single Product**: `products:detail:<id>`
- **Paginated Listings**: `products:list:limit=<limit>:order=<order>:page=<page>:search=<search>:sortBy=<sortBy>`

#### Deterministic Normalization
List query parameters are normalized before key generation:
- Default parameters applied (`page=1`, `limit=10`, `sortBy=createdAt`, `order=desc`).
- Search strings trimmed and converted to lower case.
- Parameter keys sorted in canonical alphabetical order.

This guarantees that permutations such as `GET /products?page=1&limit=10` and `GET /products?limit=10&page=1` hit the exact same cache key, eliminating cache fragmentation.

### 3. TTL Configuration

- Default TTL: **60 seconds**.
- Configurable via `PRODUCT_CACHE_TTL_SECONDS` in environment variables.

### 4. Cache Invalidation Strategy

- **On Product Creation (`POST /products`)**:
  - All cached list variants (`products:list:*`) are invalidated using non-blocking Redis `SCAN` in batches followed by `UNLINK`.
  - Ensures immediate visibility of new inventory in search results and accurate pagination counts (`total`, `totalPages`).

- **On Product Update (`PATCH /products/:id` or `PUT /products/:id`)**:
  - The single-product detail cache (`products:detail:<id>`) is deleted via Redis `DEL`.
  - All cached list variants (`products:list:*`) are invalidated via non-blocking `SCAN` and `UNLINK`.
  - Ensures price/name modifications reflect immediately on subsequent detail views and catalog listings.

- **On Product Archival (`PATCH /products/:id/archive`)**:
  - The single-product detail cache (`products:detail:<id>`) is deleted.
  - All cached list variants (`products:list:*`) are invalidated.
  - Ensures archived products immediately disappear from public catalog listings and return 404 on subsequent direct detail requests.

- **On Product Unarchival / Restore (`PATCH /products/:id/unarchive`)**:
  - The single-product detail cache (`products:detail:<id>`) is deleted.
  - All cached list variants (`products:list:*`) are invalidated.
  - Ensures restored products immediately reappear in public catalog listings, search results, and accurate pagination totals.

- **On Product Deletion (`DELETE /products/:id`)**:
  - The single-product detail cache (`products:detail:<id>`) is deleted.
  - All cached list variants (`products:list:*`) are invalidated.
  - Ensures deleted items immediately disappear from product listings and return 404 on direct queries.

- **Mutation Safety & Consistency Policy**:
  - Cache invalidation is executed **strictly after** the primary PostgreSQL database transaction commits.
  - If a mutation fails validation (400), target entity does not exist (404), or violates referential integrity (409), cache invalidation is **never triggered**, preserving existing valid cache entries.
  - **Failure Degradation & Limitation**: Redis cache invalidation runs in a non-fatal try/catch block. If Redis is unreachable during invalidation, the database write still succeeds (availability priority), with a warning logged. In this rare edge case, stale cache entries will persist until their TTL expires (default 60s).

#### Invalidation Trade-Offs Considered

| Strategy | Advantages | Trade-Offs / Disadvantages |
| :--- | :--- | :--- |
| **Pattern SCAN + UNLINK** *(Implemented)* | Guarantees instant consistency across all filter variants and pagination counts; non-blocking memory reclamation via `UNLINK`. | Requires scanning the `products:list:*` keyspace. Suitable when active list variants are bounded by short TTL. |
| **Namespace Versioning (Epoch Counter)** | Instant $O(1)$ invalidation via single Redis `INCR` on a version key (`products:list:v2:...`). | Deprecated list cache entries remain in Redis memory until their TTL expires. |
| **TTL-Only (Eventual Consistency)** | Zero invalidation overhead. | High latency to visibility: new products are invisible in listings until TTL expires, causing inconsistencies between catalog and detail views. |

---

## Order Reservation Expiration Architecture

### 1. The Core Distributed Problem
When an order is created, physical inventory is atomically reserved (`available` decrements, `reserved` increments). If a customer abandons checkout or closes their browser, reserved inventory remains locked indefinitely without an expiration mechanism. This leads to **inventory starvation / leakage**, where items appear out-of-stock to other paying customers despite never being purchased.

### 2. Dual-Layer Defense-in-Depth Architecture

OrderFlow Engine implements a resilient **Dual-Layer Expiration System**:

```
[ POST /orders ] ───────────► Creates Order (PENDING) & Reserves Stock
       │
       ├────────────────────► Enqueues Delayed Job (BullMQ) [Delay: 15 min]
       │                                     │
       ▼                                     ▼ (After 15 min)
[ Periodic / Admin Sweeper ] ◄──────── [ order.worker.ts ]
  (POST /orders/admin/expire-stale)          │
       │                                     ▼
       └───────────────► Atomic Database Transaction:
                         1. Verify order.status === 'PENDING'
                         2. Transition status: 'PENDING' -> 'CANCELLED'
                         3. Release inventory: available += qty, reserved -= qty
                         4. Record OrderStatusHistory audit note
                         5. Emit OutboxEvent ('ORDER_EXPIRED')
```

#### Layer 1: Real-Time BullMQ Delayed Jobs
- Upon order creation (`POST /orders`), a delayed job is registered on the `order-events` queue with `delay: ORDER_EXPIRATION_SECONDS * 1000` and deterministic jobId `order-expiration-${orderId}`.
- When the expiration window elapses, `order.worker.ts` executes `processOrderJob`.
- **Worker Idempotency**: Tracked via `ProcessedEvent` table (`eventId: order-expiration-${orderId}`) to ensure duplicate delivery or network retries do not re-process jobs.
- **Graceful Degradation**: If Redis or BullMQ is temporarily offline during order creation, the error is caught and logged as a warning; order creation succeeds uninterrupted while Layer 2 guarantees eventual cleanup.

#### Layer 2: Dedicated Automated Reservation Sweeper (Reconciliation Safety Net)
- **Why the Sweeper Exists**:
  - In a distributed system, primary delayed job mechanisms (BullMQ / Redis) can encounter edge failures: Redis restarts with loss of unpersisted delayed sets, queue crashes, Redis eviction under memory pressure, or transient Redis downtime during checkout creation (where graceful degradation creates the order but skips delayed job scheduling).
  - Without a sweeper, orders whose delayed jobs were dropped would lock reserved inventory permanently.
  - The dedicated background sweeper acts as a self-healing reconciliation loop, guaranteeing eventual consistency and reclaiming orphaned inventory.
- **How It Complements BullMQ Delayed Jobs**:
  - BullMQ provides low-latency, real-time expiration ($O(1)$ push trigger exactly when the 15-minute window expires).
  - The Sweeper provides guaranteed safety and correctness via periodic indexed polling, catching any anomalies, missed jobs, or failed worker executions.
- **Standalone Background Runner**:
  - Executable entry point: `src/modules/orders/order.sweeper.runner.ts` (runnable via `npm run sweeper`).
  - Runs independently of the Express API server and BullMQ worker.
  - Automatically executes an initial sweep on boot, followed by non-overlapping interval execution.
  - Employs an `isSweeping` mutex guard: if a large sweep iteration takes longer than the configured interval, subsequent ticks are skipped rather than overlapping, preventing connection pool exhaustion and database thrashing.
- **Batch Processing & Fault Isolation**:
  - Queries stale orders using an index range scan on composite index `("status", "createdAt")`.
  - Processes each order inside its own discrete database transaction.
  - **Fault Isolation**: If a single order encounters an unexpected error (e.g. data corruption or inventory mismatch), it is recorded as `failed`, added to an in-memory exclude list for the remainder of the sweep, and processing continues uninterrupted for all remaining orders.
  - Drains up to `maxOrdersPerSweep` (default 500) per sweep cycle in configurable batches (default 50).
- **Graceful Shutdown**:
  - Intercepts `SIGINT` and `SIGTERM` signals.
  - Immediately disarms interval timers, waits for any in-flight database sweep transaction to cleanly finish, closes database connections (`prisma.$disconnect()`), and terminates with exit code 0.

### 3. Concurrency & Race Condition Mitigation

A critical interview design challenge is the **Payment vs Expiration Race Condition**:
*What happens if the customer clicks "Pay" at second 899 while the expiration worker or sweeper triggers at second 900?*
*What happens if the sweeper and BullMQ worker attempt to expire the same order at the exact same millisecond?*

- **Atomic State Guard (Compare-And-Swap)**:
  Status transitions use strict SQL conditions inside an interactive PostgreSQL transaction:
  ```sql
  UPDATE "Order" SET status = 'CANCELLED' WHERE id = :id AND status = 'PENDING';
  ```
- **PostgreSQL Row Write Locking**:
  - When two workers (e.g. Sweeper and BullMQ Worker) execute this update simultaneously, PostgreSQL serializes write access on the `Order` row.
  - The first worker updates the row (`count = 1`), releases inventory, records the audit history, emits the outbox event, and commits.
  - The second worker waits for the first to commit. Once unblocked, the row's status is now `CANCELLED`, so the condition `status = 'PENDING'` matches 0 rows (`count = 0`).
  - The second worker detects `count !== 1`, immediately aborts and rolls back its transaction, throwing `"Order is not eligible for expiration"`.
  - The worker / sweeper catches this expected error, classifies the order as `skipped`, and avoids double-releasing inventory or throwing unhandled errors.
- **Payment Safety**:
  - When a customer begins payment, `startPayment` performs an atomic CAS:
    ```sql
    UPDATE "Order" SET status = 'PAYMENT_PROCESSING' WHERE id = :id AND status = 'PENDING';
    ```
  - If payment started first, the order is no longer in `PENDING` state. Any subsequent expiration attempt fails the CAS condition and aborts with HTTP 409 (`ORDER_NOT_ELIGIBLE_FOR_EXPIRATION`), completely preventing cancellation of in-flight payments.
- **Inventory Safety (Exact-Once Restoration)**:
  - Inventory restoration executes conditional SQL:
    ```sql
    UPDATE "Inventory" SET reserved = reserved - :qty, available = available + :qty
    WHERE "productId" = :productId AND reserved >= :qty;
    ```
  - If any inventory update fails, the entire transaction throws and rolls back, ensuring that no partially released inventory or mismatched counts ever occur.
- **Transactional Outbox Dispatch**:
  - An `ORDER_EXPIRED` event is written within the exact same database transaction, ensuring downstream event consistency.

### 4. Failure Recovery & Operational Limitations

- **Transient Write Conflicts**: Wrapped in `withTransactionRetry` with exponential backoff to handle PostgreSQL serialization conflicts (error `P2034`).
- **Database Downtime**: If PostgreSQL is completely unreachable, the sweep iteration logs an error with correlation context and safely retries on the next scheduled interval without crashing the process.
- **Batch Upper Bound**: A hard ceiling of 500 orders per sweep cycle prevents backlog stampedes from blocking the database connection pool; backlogged orders are drained progressively across consecutive intervals.
- **Trade-Off — Sweeper Interval vs Database Load**: Polling interval defaults to 30 seconds (`ORDER_SWEEPER_INTERVAL_MS=30000`). Faster intervals (e.g. 5s) reduce reclamation latency but increase read traffic; slower intervals reduce DB overhead but increase the window during which abandoned inventory remains locked. Combined with real-time BullMQ delayed jobs, the 30-second sweeper provides the optimal balance of zero steady-state latency and robust self-healing reliability.

### 5. Architecture Trade-Offs Considered

| Expiration Strategy | Advantages | Trade-Offs / Disadvantages |
| :--- | :--- | :--- |
| **BullMQ Delayed Jobs + Sweeper Runner** *(Implemented)* | Real-time precision; low database load ($O(1)$ push scheduling); bulletproof reliability with standalone sweeper reconciliation fallback and CAS concurrency protection. | Requires Redis and running two background processes (worker + sweeper). |
| **Database Polling Sweeper Only** | Simple architecture; zero Redis queue dependency. | High database read amplification; high latency to inventory release (orders stay locked until the next sweep interval). |
| **Redis Key Expiration (Keyspace Notifications)** | In-memory pub/sub notifications on key TTL expiry. | Pub/Sub is fire-and-forget; if worker is offline at the moment of expiration, the event is permanently lost without recovery. |

---

## Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | HTTP server listening port | `3000` |
| `DATABASE_URL` | PostgreSQL connection URL | `postgresql://...` |
| `REDIS_URL` | Redis connection URL | `redis://127.0.0.1:6379` |
| `PRODUCT_CACHE_TTL_SECONDS` | Product cache expiration time (seconds) | `60` |
| `ORDER_EXPIRATION_SECONDS` | Order inventory reservation TTL before auto-cancellation (seconds) | `900` (15 min) |
| `ORDER_SWEEPER_INTERVAL_MS` | Periodic reservation sweeper execution interval (milliseconds) | `30000` (30 sec) |
| `ORDER_SWEEPER_BATCH_SIZE` | Batch size limit per sweeper query iteration | `50` |
| `LOG_LEVEL` | Pino log level (`info`, `warn`, `error`, `debug`) | `info` |

---

## Setup & Running

### 1. Prerequisites
- Node.js >= 20
- Docker & Docker Compose

### 2. Start Infrastructure
```bash
docker compose up -d
```

### 3. Run Database Migrations
```bash
npx prisma migrate dev
```

### 4. Start Development Server
```bash
npm run dev
```

### 5. Start Background Workers & Sweeper
```bash
# Terminal 1: Real-time BullMQ event worker (processes delayed expiration jobs & confirmation notifications)
npm run worker

# Terminal 2: Transactional outbox publisher runner
npm run outbox

# Terminal 3: Automated periodic reservation sweeper runner
npm run sweeper
```

### 6. Run Test Suite
```bash
npm test
```

---

## API Reference — Product Endpoints

### 1. Create Product
- **Method & Route**: `POST /products`
- **Request Body**:
  ```json
  {
    "name": "Mechanical Keyboard",
    "description": "RGB mechanical keyboard with brown switches",
    "price": 129.99
  }
  ```
- **Validation**:
  - `name`: required string, non-empty.
  - `description`: optional string.
  - `price`: positive number (> 0).
- **Response**: `201 Created` with product object.
- **Cache Invalidation**: Clears all `products:list:*` keys.

### 2. Get Products (Paginated)
- **Method & Route**: `GET /products`
- **Query Parameters**:
  - `page`: positive integer (default: 1).
  - `limit`: positive integer <= 100 (default: 10).
  - `sortBy`: `createdAt` | `name` | `price` (default: `createdAt`).
  - `order`: `asc` | `desc` (default: `desc`).
  - `search`: optional string filter.
- **Response**: `200 OK` with `{ data: [...], pagination: { page, limit, total, totalPages, hasNextPage, hasPreviousPage } }`.
- **Caching**: Served from Redis on cache hit (`products:list:...`).

### 3. Get Product by ID
- **Method & Route**: `GET /products/:id`
- **Response**: `200 OK` with `{ data: product }`.
- **Error**: `404 Not Found` if product does not exist (`PRODUCT_NOT_FOUND`).
- **Caching**: Served from Redis on cache hit (`products:detail:<id>`).

### 4. Partial Update Product
- **Method & Route**: `PATCH /products/:id`
- **Request Body**: (At least one field must be provided; omitted fields remain unchanged)
  ```json
  {
    "price": 119.99,
    "description": "Updated product description"
  }
  ```
- **Validation**:
  - `name`: optional non-empty string.
  - `description`: optional string or `null` (to clear description).
  - `price`: optional positive number.
  - Immutable fields (`id`, `createdAt`, `updatedAt`) and unknown properties are strictly forbidden and rejected.
- **Response**: `200 OK` with `{ data: product }`.
- **Errors**:
  - `400 Bad Request` with `VALIDATION_ERROR` for empty bodies, negative prices, empty names, or unknown/immutable fields.
  - `404 Not Found` with `PRODUCT_NOT_FOUND` if product does not exist.
- **Cache Invalidation**: Invalidates `products:detail:<id>` and `products:list:*`.

### 5. Replace Product (Full Replacement Semantics)
- **Method & Route**: `PUT /products/:id`
- **Request Body**:
  ```json
  {
    "name": "Mechanical Keyboard Pro",
    "price": 149.99,
    "description": "Full replacement specification"
  }
  ```
- **Semantics**: Requires `name` and `price`. If `description` is omitted, it is reset to `null`.
- **Response**: `200 OK` with `{ data: product }`.
- **Errors**:
  - `400 Bad Request` with `VALIDATION_ERROR` if required fields are missing.
  - `404 Not Found` with `PRODUCT_NOT_FOUND` if product does not exist.
- **Cache Invalidation**: Invalidates `products:detail:<id>` and `products:list:*`.

### 6. Archive Product (Soft Delete)
- **Method & Route**: `PATCH /products/:id/archive`
- **Response**: `200 OK` with:
  ```json
  {
    "message": "Product archived successfully",
    "data": {
      "id": "cmvtg4h9d0000u9x2zemxw5sm",
      "name": "Mechanical Keyboard Pro",
      "price": "149.99",
      "isArchived": true,
      "createdAt": "2026-10-29T11:14:24.441Z",
      "updatedAt": "2026-10-29T11:14:24.570Z"
    }
  }
  ```
- **Idempotency**: Repeated archive calls on an already archived product succeed idempotently with `200 OK`.
- **Errors**: `404 Not Found` with `PRODUCT_NOT_FOUND` if the product does not exist.
- **Catalog & Order Safety**:
  - Automatically excluded from default catalog listings (`GET /products`) and search/pagination calculations.
  - Returns `404 Not Found` on direct detail lookups (`GET /products/:id`) and update attempts.
  - Rejects new order creation (`POST /orders`) with `400 Bad Request` (`PRODUCT_ARCHIVED`). Mixed orders fail atomically with zero partial inventory reservations.
  - Preserves historical orders, audit history, and associated inventory records intact.
- **Cache Invalidation**: Invalidates `products:detail:<id>` and `products:list:*` upon successful database commit.

### 7. Unarchive / Restore Product
- **Method & Route**: `PATCH /products/:id/unarchive`
- **Response**: `200 OK` with:
  ```json
  {
    "message": "Product restored successfully",
    "data": {
      "id": "cmvtg4h9d0000u9x2zemxw5sm",
      "name": "Mechanical Keyboard Pro",
      "price": "149.99",
      "isArchived": false,
      "createdAt": "2026-10-29T11:14:24.441Z",
      "updatedAt": "2026-10-29T11:20:15.123Z"
    }
  }
  ```
- **Idempotency**: Repeated unarchive calls on an already active/unarchived product safely succeed idempotently with `200 OK`.
- **Errors**: `404 Not Found` with `PRODUCT_NOT_FOUND` if the product does not exist.
- **Catalog & Order Restoration**:
  - Restored product immediately reappears in normal `GET /products` catalog listings, search, sorting, and pagination totals.
  - Product detail lookups (`GET /products/:id`) and updates (`PATCH /products/:id`) behave normally.
  - New order creation (`POST /orders`) is re-enabled, subject to existing inventory availability and validation rules.
  - Preserves historical orders, audit history, and existing inventory numbers intact.
- **Cache Invalidation**: Invalidates `products:detail:<id>` and `products:list:*` upon successful database commit.

### 8. Delete Product (Hard Delete)
- **Method & Route**: `DELETE /products/:id`
- **Response**: `200 OK` with `{ "message": "Product deleted successfully" }`.
- **Referential Integrity & Foreign Key Restrictions**:
  - **Orders Protection**: If an order has been placed containing this product (`OrderItem` record exists), deletion is **blocked** by database foreign key constraints to preserve financial order history and audit integrity.
  - **Inventory Protection**: If an active inventory record exists for this product, deletion is **blocked**.
  - **Error Response**: `409 Conflict` with:
    ```json
    {
      "error": {
        "code": "PRODUCT_REFERENTIAL_INTEGRITY_VIOLATION",
        "message": "Product cannot be deleted because it is referenced by existing orders or inventory"
      }
    }
    ```
- **Error**: `404 Not Found` with `PRODUCT_NOT_FOUND` if product does not exist.
- **Cache Invalidation**: Invalidates `products:detail:<id>` and `products:list:*` upon successful deletion.

---

### Comparison: Product Lifecycle Actions

| Feature / Behavior | Archiving (`PATCH /products/:id/archive`) | Unarchiving (`PATCH /products/:id/unarchive`) | Physical Deletion (`DELETE /products/:id`) |
| :--- | :--- | :--- | :--- |
| **Database Effect** | Updates `isArchived = true` | Updates `isArchived = false` | Executes `DELETE FROM "Product"` |
| **Historical Orders** | Preserved completely; historical order items remain valid | Preserved completely; historical order items remain valid | Blocked with HTTP 409 if any orders reference the product |
| **Inventory Records** | Retained in database | Retained in database | Blocked with HTTP 409 if inventory record exists |
| **Catalog Visibility** | Excluded from listings and returns 404 on detail | Included in listings and returns 200 on detail | Permanently removed from database; returns 404 |
| **New Orders** | Blocked with HTTP 400 (`PRODUCT_ARCHIVED`) | Allowed (subject to available stock) | Blocked with HTTP 404 (`PRODUCT_NOT_FOUND`) |
| **Idempotency** | Yes; repeated calls safely return 200 | Yes; repeated calls safely return 200 | No; second call returns 404 |
| **Cache Invalidation** | Invalidates detail (`:id`) and list (`*`) caches | Invalidates detail (`:id`) and list (`*`) caches | Invalidates detail (`:id`) and list (`*`) caches |

---

## Limitations & Future Considerations

1. **Role-Based Access Control (RBAC)**: Currently, administrative actions like unarchiving, archiving, and deletion are open endpoints. Future iterations will introduce JWT/OAuth2 authentication and role-based guards (`admin`, `merchant`, `customer`).
2. **Cache Stampede Protection**: Under extreme concurrency spikes on expired popular keys, probabilistic early expiration (XFetch) or distributed mutex locking can prevent multiple simultaneous database queries.
3. **Distributed Invalidation**: In a multi-cluster deployment with local in-memory L1 caches, Redis Pub/Sub could be added for distributed cache invalidation broadcasts.
