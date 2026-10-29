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
