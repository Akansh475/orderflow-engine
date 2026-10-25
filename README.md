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

## Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | HTTP server listening port | `3000` |
| `DATABASE_URL` | PostgreSQL connection URL | `postgresql://...` |
| `REDIS_URL` | Redis connection URL | `redis://127.0.0.1:6379` |
| `PRODUCT_CACHE_TTL_SECONDS` | Product cache expiration time (seconds) | `60` |
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
