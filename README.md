# TableGuard — Autonomous Dark Factory for Reliable Reservations

TableGuard is a clean-room restaurant reservation engine engineered around a single non-negotiable reliability invariant:

> **Core Invariant:** *A table must never be successfully booked twice for overlapping reservations, including under concurrent requests, cross-timezone bookings, and safe network retries.*

---

## 1. Reservation Concurrency & Invariant Protection Strategy

### A. Half-Open Time Interval Algebra (`[start_time_utc, end_time_utc)`)
Every reservation window is normalized to canonical ISO-8601 UTC (`YYYY-MM-DDTHH:mm:ss.000Z`) and modeled as a half-open interval `[start_utc, end_utc)`:
- Two intervals `[startA, endA)` and `[startB, endB)` overlap if and only if:
  ```sql
  existing.start_time_utc < requested.end_time_utc
  AND existing.end_time_utc > requested.start_time_utc
  ```
- **Exact Boundary Adjacency:** A reservation from `18:00–19:30` (`[22:00Z, 23:30Z)`) and an immediately following reservation from `19:30–21:00` (`[23:30Z, 01:00Z)`) satisfy `22:00Z < 01:00Z` and `23:30Z > 23:30Z` (False), allowing zero-waste back-to-back table turnover while strictly blocking even a 1-second overlap.

### B. SQLite WAL + `BEGIN IMMEDIATE` Transactional Locking
SQLite defaults to deferred transactions (`BEGIN`), where a transaction starts in read mode and upgrades to a write lock only upon `INSERT`/`UPDATE`. Under high concurrency, two deferred transactions can both read `0 conflicts` simultaneously before attempting to insert.

TableGuard eliminates this race condition using a **two-layer deterministic lock**:
1. **In-Process Serialization Mutex (`AsyncMutex` / `threading.Lock`):** Serializes concurrent asynchronous requests within the same process before entering the database transaction.
2. **Database-Level `BEGIN IMMEDIATE TRANSACTION` + WAL Mode:** Acquires a reserved write lock in SQLite **before** executing the idempotency and interval-overlap `SELECT` queries. No other connection can acquire a write lock or commit changes until the active transaction finishes its check-and-insert sequence and issues `COMMIT` or `ROLLBACK`.

### C. Idempotency & Safe Network Retries
Clients supply an `Idempotency-Key` header (or `idempotency_key` field in the JSON payload), enforced by a `UNIQUE` index on `reservations(idempotency_key)`:
- **Safe Retry (`200 OK`):** If a request is retried with the same `idempotency_key` and identical booking parameters (`restaurant_id`, `table_id`, `start_time_utc`, `end_time_utc`, `guests`, `customer_email`), TableGuard returns the existing reservation (`idempotent_replay: true`) without creating a duplicate row.
- **Parameter Tampering Rejection (`409 Conflict`):** If a client reuses an existing `idempotency_key` with altered reservation parameters (e.g., different table or time), TableGuard rejects the request with `409 IDEMPOTENCY_PARAMETER_MISMATCH`.

### D. Explicit IANA Time-Zone Normalization
- Every restaurant defines an authoritative IANA time zone (e.g., `America/New_York` for **Riverside Grill**, `Asia/Tokyo` for **Kyoto Izakaya Tensei**, `Europe/London` for **Thames Conservatory**).
- Every availability and reservation request requires an explicit caller IANA `timezone`.
- Input timestamps are parsed in the caller's timezone, converted to the restaurant's local IANA timezone to verify operating hours (`11:00–23:00`), and persisted in canonical UTC. Server local timezone is never used.

---

## 2. Seeded Demo Data

### Primary Venue: **Riverside Grill** (`America/New_York`, 11:00–23:00)
| Table | Capacity | Dining Zone |
| :--- | :--- | :--- |
| **Table 1** | 2 seats | Waterfront Window |
| **Table 2** | 2 seats | Waterfront Window |
| **Table 3** | 4 seats | Main Dining Room |
| **Table 4** | 4 seats | Main Dining Room |
| **Table 5** | 6 seats | Chef Alcove |
| **Table 6** | 8 seats | Private River Terrace |

Additional multi-timezone venues (**Kyoto Izakaya Tensei** in `Asia/Tokyo` and **Thames Conservatory** in `Europe/London`) are also seeded for cross-timezone verification.

---

## 3. Running & Testing Locally

### Start the Full-Stack Application
```bash
npm install
npm run dev
```
The server listens on `http://0.0.0.0:3000`.

### Run the Automated Test Suites
1. **TypeScript / Vitest Suite** (Reservations, Concurrency, Idempotency, Timezone Edge Cases):
   ```bash
   npm test
   ```
2. **Python Unittest Suite** (`tests/test_reservations.py`, `tests/test_concurrency.py`, `tests/test_timezone.py`):
   ```bash
   python3 -m unittest discover -s tests -p "test_*.py" -v
   ```

### Run via Docker
```bash
docker build -t tableguard:latest .
docker run -p 3000:3000 tableguard:latest
```

---

## 4. Demo Walkthrough

1. **Reservation Desk:** Select **Riverside Grill**, pick a date, time slot, party size, and caller time zone. View real-time table availability and click **Confirm Reservation**.
2. **Idempotency Replay Test:** Check *"Keep same key after booking"* above the Confirm button and click **Confirm Reservation** twice. Observe `201 Created` on the first request and `200 OK (Idempotent Safe Retry Verified)` on the second.
3. **Simulate Simultaneous Booking Race:** Select an available table and click **Launch 12 Concurrent Requests**. Observe that exactly **1** request succeeds (`201`) and **11** requests are blocked (`409 Conflict`), with `0` overlapping reservations in SQLite.
4. **Reliability Center:** Click **Run Verification Suite** in the top bar to run the automated 6-stage live concurrency, overlap, adjacency, idempotency, timezone, and cancellation verification suite.
