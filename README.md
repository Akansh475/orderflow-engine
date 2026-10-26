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

- **Product Management**: CRUD operations, deterministic validation, pagination, filtering, sorting, and full-text search.
- **Order Processing**: Creation, idempotency protection, atomic inventory reservation with transaction retry handling, payment processing, cancellation, and fulfillment.
- **Transactional Outbox & Worker**: Guaranteed event dispatch with idempotent background worker processing.
- **Resilience & Observability**: API rate limiting, structured JSON logging with correlation IDs, health check endpoints (`/health`, `/health/db`).
- **Product Caching (Cache-Aside)**: High-speed read caching for product detail and paginated listings using Redis with automated invalidation and database fallback.
- **Order Reservation Expiration & Auto-Release**: Dual-layer reservation lifecycle management combining BullMQ delayed jobs and batch reconciliation sweepers to reclaim inventory from abandoned checkouts, emit `ORDER_EXPIRED` outbox events, and prevent stock starvation.

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

When a new product is created (`POST /products`):
- All cached list variants (`products:list:*`) are invalidated using non-blocking Redis `SCAN` in batches followed by `UNLINK`.
- Ensures immediate visibility of new inventory in search results and accurate pagination counts (`total`, `totalPages`).

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

#### Layer 2: Batch Reconciliation Sweeper (Defense-in-Depth)
- If the Redis queue is restarted, flushed, or network partitions occur, delayed jobs could potentially be dropped.
- The administrative reconciliation sweep (`POST /orders/admin/expire-stale` or background cron) queries for any orders where `status = 'PENDING'` and `createdAt < cutoff`.
- **Batch Draining**: Sweeps and cancels stale orders in safe batches (default 50 per iteration, up to 500) within atomic transactions, ensuring zero inventory leakage under any failure scenario.

### 3. Concurrency & Race Condition Mitigation

A critical interview design challenge is the **Payment vs Expiration Race Condition**:
*What happens if the customer clicks "Pay" at second 899 while the expiration worker triggers at second 900?*

- **Atomic State Guard**: Status transitions use strict SQL conditions:
  ```sql
  UPDATE "Order" SET status = 'CANCELLED' WHERE id = :id AND status = 'PENDING';
  ```
- **Conditional Count Check**: If the update returns `count !== 1`, the order is already in `PAYMENT_PROCESSING`, `CONFIRMED`, or `CANCELLED`.
- **Payment Safety**: If payment has started (`PAYMENT_PROCESSING`), expiration aborts with HTTP 409 (`ORDER_NOT_ELIGIBLE_FOR_EXPIRATION`) and the worker logs a graceful no-op (`expired: false`).
- **Inventory Safety**: Inventory is only released when the order successfully transitions from `PENDING` to `CANCELLED`, completely preventing double-release or overselling.
- **Transactional Outbox Dispatch**: An `ORDER_EXPIRED` event is written within the exact same database transaction, ensuring downstream event consistency.

### 4. Architecture Trade-Offs Considered

| Expiration Strategy | Advantages | Trade-Offs / Disadvantages |
| :--- | :--- | :--- |
| **BullMQ Delayed Jobs + Sweeper** *(Implemented)* | Real-time precision; low database load ($O(1)$ push scheduling); bulletproof reliability with sweeper reconciliation fallback. | Requires Redis and active background worker. |
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

### 5. Start Background Workers
```bash
npm run worker
npm run outbox
```

### 6. Run Test Suite
```bash
npm test
```

---

## Limitations & Future Considerations

1. **Product Mutation Scope**: Currently, product modification (`PUT/PATCH`) and deletion endpoints are not yet implemented. When added, they must invalidate both `products:detail:<id>` and `products:list:*`.
2. **Cache Stampede Protection**: Under extreme concurrency spikes on expired popular keys, probabilistic early expiration (XFetch) or distributed mutex locking can prevent multiple simultaneous database queries.
3. **Distributed Invalidation**: In a multi-cluster deployment with local in-memory L1 caches, Redis Pub/Sub could be added for distributed cache invalidation broadcasts.
