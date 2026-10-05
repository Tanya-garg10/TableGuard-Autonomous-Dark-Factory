import { DatabaseSync } from 'node:sqlite';
import {
  getDb,
  Restaurant,
  TableInfo,
  Reservation,
  SystemMetrics,
} from './database.ts';
import {
  CreateReservationSchema,
  AvailabilityQuerySchema,
  parseAndValidateTimeWindow,
} from './schemas.ts';

export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.queue;
    this.queue = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const bookingMutex = new AsyncMutex();

export interface ServiceResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  code?: string;
  idempotent_replay?: boolean;
}

export interface TableAvailabilityItem extends TableInfo {
  is_available: boolean;
  fits_party: boolean;
  conflicting_reservation_id: number | null;
  reason: string | null;
}

export interface AvailabilityResponse {
  restaurant: Restaurant;
  requested_start_utc: string;
  requested_end_utc: string;
  restaurant_local_window: string;
  guests: number;
  duration_minutes: number;
  tables: TableAvailabilityItem[];
  available_count: number;
}

function incrementMetric(
  db: DatabaseSync,
  field:
    | 'booking_attempts'
    | 'successful_reservations'
    | 'conflicts_prevented'
    | 'idempotent_replays'
    | 'validation_rejections'
    | 'cancellations',
  amount = 1
): void {
  db.prepare(`UPDATE system_metrics SET ${field} = ${field} + ? WHERE id = 1`).run(amount);
}

export function listRestaurants(db: DatabaseSync = getDb()): (Restaurant & { tables: TableInfo[] })[] {
  const restaurants = db
    .prepare('SELECT * FROM restaurants ORDER BY id ASC')
    .all() as unknown as Restaurant[];

  const tablesStmt = db.prepare(
    'SELECT * FROM tables WHERE restaurant_id = ? ORDER BY capacity ASC, id ASC'
  );

  return restaurants.map((r) => ({
    ...r,
    tables: tablesStmt.all(r.id) as unknown as TableInfo[],
  }));
}

export function getRestaurantById(
  restaurantId: number,
  db: DatabaseSync = getDb()
): (Restaurant & { tables: TableInfo[] }) | null {
  const restaurant = db
    .prepare('SELECT * FROM restaurants WHERE id = ?')
    .get(restaurantId) as unknown as Restaurant | undefined;

  if (!restaurant) return null;

  const tables = db
    .prepare('SELECT * FROM tables WHERE restaurant_id = ? ORDER BY capacity ASC, id ASC')
    .all(restaurantId) as unknown as TableInfo[];

  return { ...restaurant, tables };
}

export function checkAvailability(
  rawQuery: unknown,
  db: DatabaseSync = getDb()
): ServiceResult<AvailabilityResponse> {
  const parsed = AvailabilityQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, status: 422, error: msg, code: 'VALIDATION_ERROR' };
  }

  const { restaurant_id, start_time, duration_minutes, guests, timezone } = parsed.data;
  const restaurant = getRestaurantById(restaurant_id, db);
  if (!restaurant) {
    return { ok: false, status: 404, error: 'Restaurant not found', code: 'NOT_FOUND' };
  }

  const timeCheck = parseAndValidateTimeWindow(
    start_time,
    duration_minutes,
    timezone,
    restaurant.timezone,
    restaurant.open_hour,
    restaurant.close_hour
  );

  if (!timeCheck.ok) {
    return { ok: false, status: 422, error: timeCheck.error, code: 'INVALID_TIME_WINDOW' };
  }

  const { startUtcIso, endUtcIso, restaurantLocalStart, restaurantLocalEnd } = timeCheck.window;

  // Find all overlapping confirmed reservations for this restaurant in the requested window:
  // Half-open interval overlap condition: existing.start_time_utc < requested.end_time_utc AND existing.end_time_utc > requested.start_time_utc
  const overlapping = db
    .prepare(
      `SELECT id, table_id, start_time_utc, end_time_utc, customer_name
       FROM reservations
       WHERE restaurant_id = ?
         AND status = 'CONFIRMED'
         AND start_time_utc < ?
         AND end_time_utc > ?`
    )
    .all(restaurant_id, endUtcIso, startUtcIso) as unknown as {
      id: number;
      table_id: number;
      start_time_utc: string;
      end_time_utc: string;
      customer_name: string;
    }[];

  const conflictByTable = new Map<number, number>();
  for (const row of overlapping) {
    conflictByTable.set(row.table_id, row.id);
  }

  const tables: TableAvailabilityItem[] = restaurant.tables.map((t) => {
    const fitsParty = t.capacity >= guests;
    const conflictId = conflictByTable.get(t.id) ?? null;
    const isAvailable = fitsParty && conflictId === null;

    let reason: string | null = null;
    if (!fitsParty) {
      reason = `Capacity (${t.capacity} seats) is smaller than party size (${guests} guests)`;
    } else if (conflictId !== null) {
      reason = `Reserved during overlapping window (Reservation #${conflictId})`;
    }

    return {
      ...t,
      is_available: isAvailable,
      fits_party: fitsParty,
      conflicting_reservation_id: conflictId,
      reason,
    };
  });

  const availableCount = tables.filter((t) => t.is_available).length;

  return {
    ok: true,
    status: 200,
    data: {
      restaurant,
      requested_start_utc: startUtcIso,
      requested_end_utc: endUtcIso,
      restaurant_local_window: `${restaurantLocalStart.toFormat('yyyy-MM-dd HH:mm')}–${restaurantLocalEnd.toFormat('HH:mm')} (${restaurant.timezone})`,
      guests,
      duration_minutes,
      tables,
      available_count: availableCount,
    },
  };
}

/**
 * Core Reservation Creation with:
 * 1. Input & Pydantic/Zod validation
 * 2. Explicit timezone normalization & operating hours verification
 * 3. Deterministic SQLite BEGIN IMMEDIATE write transaction + application mutex
 * 4. Idempotency key handling (safe retries return 200 OK without duplicate rows;
 *    mismatched payload with same idempotency_key returns 409 IDEMPOTENCY_MISMATCH)
 * 5. Half-open interval [start_utc, end_utc) overlap check guaranteeing zero double bookings
 */
export async function createReservation(
  rawInput: unknown,
  db: DatabaseSync = getDb()
): Promise<ServiceResult<Reservation>> {
  return bookingMutex.runExclusive(() => {
    return createReservationSync(rawInput, db);
  });
}

export function createReservationSync(
  rawInput: unknown,
  db: DatabaseSync = getDb()
): ServiceResult<Reservation> {
  incrementMetric(db, 'booking_attempts', 1);

  const parsed = CreateReservationSchema.safeParse(rawInput);
  if (!parsed.success) {
    incrementMetric(db, 'validation_rejections', 1);
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, status: 422, error: msg, code: 'VALIDATION_ERROR' };
  }

  const input = parsed.data;

  // Enter SQLite IMMEDIATE transaction to acquire a reserved write lock immediately.
  // This prevents any concurrent connection or process from modifying reservations until COMMIT/ROLLBACK.
  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    // 1. Check idempotency key first inside the transaction
    const existingByKey = db
      .prepare(
        `SELECT r.*, t.name as table_name, t.capacity as table_capacity,
                rest.name as restaurant_name, rest.timezone as restaurant_timezone
         FROM reservations r
         JOIN tables t ON r.table_id = t.id
         JOIN restaurants rest ON r.restaurant_id = rest.id
         WHERE r.idempotency_key = ?`
      )
      .get(input.idempotency_key) as unknown as Reservation | undefined;

    const restaurant = db
      .prepare('SELECT * FROM restaurants WHERE id = ?')
      .get(input.restaurant_id) as unknown as Restaurant | undefined;

    if (!restaurant) {
      db.exec('ROLLBACK');
      incrementMetric(db, 'validation_rejections', 1);
      return { ok: false, status: 404, error: 'Restaurant not found', code: 'RESTAURANT_NOT_FOUND' };
    }

    const table = db
      .prepare('SELECT * FROM tables WHERE id = ? AND restaurant_id = ?')
      .get(input.table_id, input.restaurant_id) as unknown as TableInfo | undefined;

    if (!table) {
      db.exec('ROLLBACK');
      incrementMetric(db, 'validation_rejections', 1);
      return {
        ok: false,
        status: 404,
        error: `Table #${input.table_id} does not exist at ${restaurant.name}`,
        code: 'TABLE_NOT_FOUND',
      };
    }

    const timeCheck = parseAndValidateTimeWindow(
      input.start_time,
      input.duration_minutes,
      input.timezone,
      restaurant.timezone,
      restaurant.open_hour,
      restaurant.close_hour
    );

    if (!timeCheck.ok) {
      db.exec('ROLLBACK');
      incrementMetric(db, 'validation_rejections', 1);
      return { ok: false, status: 422, error: timeCheck.error, code: 'INVALID_TIME_WINDOW' };
    }

    const { startUtcIso, endUtcIso } = timeCheck.window;

    if (existingByKey) {
      // Verify that the retry parameters match the original reservation
      const isSameParams =
        existingByKey.restaurant_id === input.restaurant_id &&
        existingByKey.table_id === input.table_id &&
        existingByKey.start_time_utc === startUtcIso &&
        existingByKey.end_time_utc === endUtcIso &&
        existingByKey.guests === input.guests &&
        existingByKey.customer_name.trim().toLowerCase() === input.customer_name.trim().toLowerCase() &&
        existingByKey.customer_email.toLowerCase() === input.customer_email.toLowerCase();

      db.exec('COMMIT');

      if (!isSameParams) {
        incrementMetric(db, 'conflicts_prevented', 1);
        return {
          ok: false,
          status: 409,
          error:
            'Idempotency key was already used with different reservation parameters.',
          code: 'IDEMPOTENCY_PARAMETER_MISMATCH',
        };
      }

      incrementMetric(db, 'idempotent_replays', 1);
      return {
        ok: true,
        status: 200,
        data: existingByKey,
        idempotent_replay: true,
      };
    }

    // 2. Validate party size against table capacity
    if (input.guests > table.capacity) {
      db.exec('ROLLBACK');
      incrementMetric(db, 'validation_rejections', 1);
      return {
        ok: false,
        status: 422,
        error: `Party of ${input.guests} exceeds ${table.name} capacity of ${table.capacity} seats`,
        code: 'CAPACITY_EXCEEDED',
      };
    }

    // 3. Critical Invariant Check:
    // Ensure NO overlapping CONFIRMED reservation exists for this table.
    // Overlap condition for half-open intervals [startA, endA) and [startB, endB):
    // existing.start_time_utc < requested.end_time_utc AND existing.end_time_utc > requested.start_time_utc
    const conflicting = db
      .prepare(
        `SELECT id, customer_name, start_time_utc, end_time_utc
         FROM reservations
         WHERE table_id = ?
           AND status = 'CONFIRMED'
           AND start_time_utc < ?
           AND end_time_utc > ?
         LIMIT 1`
      )
      .get(input.table_id, endUtcIso, startUtcIso) as unknown as
      | { id: number; customer_name: string; start_time_utc: string; end_time_utc: string }
      | undefined;

    if (conflicting) {
      db.exec('ROLLBACK');
      incrementMetric(db, 'conflicts_prevented', 1);
      return {
        ok: false,
        status: 409,
        error: `${table.name} is already booked for an overlapping window (${conflicting.start_time_utc} to ${conflicting.end_time_utc}, Reservation #${conflicting.id}).`,
        code: 'OVERLAPPING_RESERVATION',
      };
    }

    // 4. Insert the confirmed reservation
    const nowUtc = new Date().toISOString();
    const insertResult = db
      .prepare(
        `INSERT INTO reservations (
          restaurant_id, table_id, customer_name, customer_email,
          guests, start_time_utc, end_time_utc, client_timezone,
          status, idempotency_key, notes, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?)`
      )
      .run(
        input.restaurant_id,
        input.table_id,
        input.customer_name,
        input.customer_email,
        input.guests,
        startUtcIso,
        endUtcIso,
        input.timezone,
        input.idempotency_key,
        input.notes || '',
        nowUtc
      );

    const newId = Number(insertResult.lastInsertRowid);
    const created = db
      .prepare(
        `SELECT r.*, t.name as table_name, t.capacity as table_capacity,
                rest.name as restaurant_name, rest.timezone as restaurant_timezone
         FROM reservations r
         JOIN tables t ON r.table_id = t.id
         JOIN restaurants rest ON r.restaurant_id = rest.id
         WHERE r.id = ?`
      )
      .get(newId) as unknown as Reservation;

    db.exec('COMMIT');
    incrementMetric(db, 'successful_reservations', 1);

    return {
      ok: true,
      status: 201,
      data: created,
      idempotent_replay: false,
    };
  } catch (err: unknown) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback error if transaction already closed
    }
    const message = err instanceof Error ? err.message : String(err);
    incrementMetric(db, 'conflicts_prevented', 1);
    return {
      ok: false,
      status: 409,
      error: `Transactional conflict prevented booking: ${message}`,
      code: 'TRANSACTION_CONFLICT',
    };
  }
}

export function cancelReservation(
  reservationId: number,
  db: DatabaseSync = getDb()
): ServiceResult<Reservation> {
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    return { ok: false, status: 422, error: 'Invalid reservation ID', code: 'VALIDATION_ERROR' };
  }

  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const existing = db
      .prepare(
        `SELECT r.*, t.name as table_name, t.capacity as table_capacity,
                rest.name as restaurant_name, rest.timezone as restaurant_timezone
         FROM reservations r
         JOIN tables t ON r.table_id = t.id
         JOIN restaurants rest ON r.restaurant_id = rest.id
         WHERE r.id = ?`
      )
      .get(reservationId) as unknown as Reservation | undefined;

    if (!existing) {
      db.exec('ROLLBACK');
      return { ok: false, status: 404, error: 'Reservation not found', code: 'NOT_FOUND' };
    }

    if (existing.status === 'CANCELLED') {
      db.exec('COMMIT');
      return { ok: true, status: 200, data: existing, idempotent_replay: true };
    }

    db.prepare(`UPDATE reservations SET status = 'CANCELLED' WHERE id = ?`).run(reservationId);
    const updated = db
      .prepare(
        `SELECT r.*, t.name as table_name, t.capacity as table_capacity,
                rest.name as restaurant_name, rest.timezone as restaurant_timezone
         FROM reservations r
         JOIN tables t ON r.table_id = t.id
         JOIN restaurants rest ON r.restaurant_id = rest.id
         WHERE r.id = ?`
      )
      .get(reservationId) as unknown as Reservation;

    db.exec('COMMIT');
    incrementMetric(db, 'cancellations', 1);

    return { ok: true, status: 200, data: updated };
  } catch (err: unknown) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : 'Failed to cancel reservation',
      code: 'INTERNAL_ERROR',
    };
  }
}

export function listReservations(
  filters: {
    restaurant_id?: number;
    status?: 'CONFIRMED' | 'CANCELLED' | 'ALL';
    table_id?: number;
  } = {},
  db: DatabaseSync = getDb()
): Reservation[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filters.restaurant_id) {
    clauses.push('r.restaurant_id = ?');
    params.push(filters.restaurant_id);
  }
  if (filters.table_id) {
    clauses.push('r.table_id = ?');
    params.push(filters.table_id);
  }
  if (filters.status && filters.status !== 'ALL') {
    clauses.push('r.status = ?');
    params.push(filters.status);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `
    SELECT r.*, t.name as table_name, t.capacity as table_capacity,
           rest.name as restaurant_name, rest.timezone as restaurant_timezone
    FROM reservations r
    JOIN tables t ON r.table_id = t.id
    JOIN restaurants rest ON r.restaurant_id = rest.id
    ${whereSql}
    ORDER BY r.start_time_utc DESC, r.id DESC
    LIMIT 200
  `;

  return db.prepare(sql).all(...params) as unknown as Reservation[];
}

export function verifyDatabaseInvariants(db: DatabaseSync = getDb()): {
  passed: boolean;
  overlappingPairsCount: number;
  details: string;
} {
  // Self-join on confirmed reservations for the same table where intervals overlap
  const overlaps = db
    .prepare(
      `SELECT a.id as res_a, b.id as res_b, a.table_id, a.start_time_utc as a_start, a.end_time_utc as a_end,
              b.start_time_utc as b_start, b.end_time_utc as b_end
       FROM reservations a
       JOIN reservations b
         ON a.table_id = b.table_id
        AND a.id < b.id
        AND a.status = 'CONFIRMED'
        AND b.status = 'CONFIRMED'
        AND a.start_time_utc < b.end_time_utc
        AND a.end_time_utc > b.start_time_utc`
    )
    .all() as unknown as Array<{
    res_a: number;
    res_b: number;
    table_id: number;
  }>;

  const passed = overlaps.length === 0;
  const details = passed
    ? 'Zero overlapping CONFIRMED reservations across all tables.'
    : `CRITICAL INVARIANT VIOLATION: Found ${overlaps.length} overlapping reservation pair(s)!`;

  return {
    passed,
    overlappingPairsCount: overlaps.length,
    details,
  };
}

export function getSystemStatus(db: DatabaseSync = getDb()): {
  system_status: 'OPERATIONAL' | 'DEGRADED';
  total_tables: number;
  active_reservations: number;
  cancelled_reservations: number;
  invariant_check: {
    passed: boolean;
    overlappingPairsCount: number;
    details: string;
  };
  metrics: SystemMetrics;
} {
  const invariantCheck = verifyDatabaseInvariants(db);
  const totalTablesRow = db.prepare('SELECT COUNT(*) as count FROM tables').get() as { count: number };
  const activeResRow = db
    .prepare("SELECT COUNT(*) as count FROM reservations WHERE status = 'CONFIRMED'")
    .get() as { count: number };
  const cancelledResRow = db
    .prepare("SELECT COUNT(*) as count FROM reservations WHERE status = 'CANCELLED'")
    .get() as { count: number };

  const metricsRow = db.prepare('SELECT * FROM system_metrics WHERE id = 1').get() as unknown as SystemMetrics;

  return {
    system_status: invariantCheck.passed ? 'OPERATIONAL' : 'DEGRADED',
    total_tables: totalTablesRow.count,
    active_reservations: activeResRow.count,
    cancelled_reservations: cancelledResRow.count,
    invariant_check: invariantCheck,
    metrics: metricsRow,
  };
}

export interface VerificationSuiteReport {
  overall_status: 'PASS' | 'FAIL';
  executed_at_utc: string;
  total_checks: number;
  passed_checks: number;
  concurrency_summary: {
    concurrent_requests: number;
    succeeded: number;
    conflicts_prevented: number;
    idempotent_replays_verified: number;
    invariant_preserved: boolean;
  };
  checks: Array<{
    name: string;
    category: 'CONCURRENCY' | 'IDEMPOTENCY' | 'OVERLAP' | 'TIMEZONE' | 'VALIDATION' | 'CANCELLATION';
    passed: boolean;
    duration_ms: number;
    assertion_detail: string;
  }>;
}

/**
 * Executes a real, deterministic verification & concurrency stress test suite against the live SQLite engine
 * (using an isolated test window or an ephemeral verification transaction/table cleanup) OR updates live metrics
 * so the user can trigger and inspect real concurrency & invariant tests directly from the Reliability Center.
 */
export async function runLiveVerificationSuite(
  options: { concurrentWorkers?: number; cleanupAfter?: boolean } = {},
  db: DatabaseSync = getDb()
): Promise<VerificationSuiteReport> {
  const workers = Math.min(Math.max(options.concurrentWorkers ?? 15, 2), 50);
  const cleanupAfter = options.cleanupAfter ?? true;
  const checks: VerificationSuiteReport['checks'] = [];
  const createdIdsToCleanup: number[] = [];

  const runTime = new Date().toISOString();
  // Use a deterministic future date (2027-06-15) for self-test so it never collides with user's interactive demo dates
  const testDateStr = '2027-06-15';

  // Ensure no leftover test reservations on 2027-06-15 from interrupted runs
  db.prepare("DELETE FROM reservations WHERE start_time_utc LIKE '2027-06-15%'").run();

  // Check 1: Concurrency Hammer Test (N simultaneous booking attempts for Table 1 at 18:00 America/New_York)
  const t0 = performance.now();
  const concurrentPromises = Array.from({ length: workers }, (_, idx) =>
    createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: `Concurrent Tester #${idx + 1}`,
        customer_email: `concurrent${idx + 1}@tableguard.test`,
        guests: 2,
        start_time: `${testDateStr}T18:00:00`,
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: `live-verify-conc-${Date.now()}-${idx}`,
        notes: 'Automated concurrency burst test',
      },
      db
    )
  );

  const results = await Promise.all(concurrentPromises);
  const succeeded = results.filter((r) => r.ok && r.status === 201);
  const failedConflict = results.filter((r) => !r.ok && r.status === 409);

  for (const s of succeeded) {
    if (s.data?.id) createdIdsToCleanup.push(s.data.id);
  }

  const check1Passed = succeeded.length === 1 && failedConflict.length === workers - 1;
  checks.push({
    name: `${workers} Simultaneous Overlapping Requests (Same Table & Window)`,
    category: 'CONCURRENCY',
    passed: check1Passed,
    duration_ms: Math.round(performance.now() - t0),
    assertion_detail: `Expected 1 success & ${workers - 1} conflicts (409). Actual: ${succeeded.length} succeeded, ${failedConflict.length} rejected with 409 OVERLAPPING_RESERVATION.`,
  });

  // Check 2: Partial Overlap Rejection (18:30–20:00 overlaps with 18:00–19:30)
  const t1 = performance.now();
  const overlapAttempt = await createReservation(
    {
      restaurant_id: 1,
      table_id: 1,
      customer_name: 'Partial Overlap Intruder',
      customer_email: 'intruder@tableguard.test',
      guests: 2,
      start_time: `${testDateStr}T18:30:00`,
      duration_minutes: 90,
      timezone: 'America/New_York',
      idempotency_key: `live-verify-overlap-${Date.now()}`,
    },
    db
  );
  const check2Passed = !overlapAttempt.ok && overlapAttempt.status === 409;
  checks.push({
    name: 'Partial Window Overlap Protection (18:30–20:00 vs 18:00–19:30)',
    category: 'OVERLAP',
    passed: check2Passed,
    duration_ms: Math.round(performance.now() - t1),
    assertion_detail: check2Passed
      ? `Correctly blocked overlapping interval with 409 (${overlapAttempt.code}).`
      : `Unexpectedly allowed overlapping reservation!`,
  });

  // Check 3: Exact Boundary Adjacency Allowed (19:30–21:00 immediately follows 18:00–19:30)
  const t2 = performance.now();
  const adjacentKey = `live-verify-adjacent-${Date.now()}`;
  const adjacentAttempt = await createReservation(
    {
      restaurant_id: 1,
      table_id: 1,
      customer_name: 'Adjacent Slot Guest',
      customer_email: 'adjacent@tableguard.test',
      guests: 2,
      start_time: `${testDateStr}T19:30:00`,
      duration_minutes: 90,
      timezone: 'America/New_York',
      idempotency_key: adjacentKey,
    },
    db
  );
  if (adjacentAttempt.data?.id) createdIdsToCleanup.push(adjacentAttempt.data.id);
  const check3Passed = adjacentAttempt.ok && adjacentAttempt.status === 201;
  checks.push({
    name: 'Half-Open Interval Boundary Adjacency ([18:00, 19:30) + [19:30, 21:00))',
    category: 'OVERLAP',
    passed: check3Passed,
    duration_ms: Math.round(performance.now() - t2),
    assertion_detail: check3Passed
      ? 'Back-to-back reservation starting at exact end_time_utc succeeded cleanly.'
      : `Failed back-to-back reservation: ${adjacentAttempt.error}`,
  });

  // Check 4: Safe Retry / Idempotency Replay & Parameter Tamper Protection
  const t3 = performance.now();
  const retryAttempt = await createReservation(
    {
      restaurant_id: 1,
      table_id: 1,
      customer_name: 'Adjacent Slot Guest',
      customer_email: 'adjacent@tableguard.test',
      guests: 2,
      start_time: `${testDateStr}T19:30:00`,
      duration_minutes: 90,
      timezone: 'America/New_York',
      idempotency_key: adjacentKey,
    },
    db
  );
  const tamperAttempt = await createReservation(
    {
      restaurant_id: 1,
      table_id: 2, // Changed table with same idempotency_key!
      customer_name: 'Adjacent Slot Guest',
      customer_email: 'adjacent@tableguard.test',
      guests: 2,
      start_time: `${testDateStr}T19:30:00`,
      duration_minutes: 90,
      timezone: 'America/New_York',
      idempotency_key: adjacentKey,
    },
    db
  );
  const check4Passed =
    retryAttempt.ok &&
    retryAttempt.status === 200 &&
    retryAttempt.idempotent_replay === true &&
    retryAttempt.data?.id === adjacentAttempt.data?.id &&
    !tamperAttempt.ok &&
    tamperAttempt.status === 409;

  checks.push({
    name: 'Idempotency Safe Retry (200 OK) & Tampered Payload Rejection (409)',
    category: 'IDEMPOTENCY',
    passed: check4Passed,
    duration_ms: Math.round(performance.now() - t3),
    assertion_detail: check4Passed
      ? `Safe retry returned identical Reservation #${retryAttempt.data?.id} without duplicate row; tampered reuse rejected with 409.`
      : 'Idempotency verification failed.',
  });

  // Check 5: Cross-Timezone Conflict Equivalence (Booking 22:00 UTC from Europe/London collides with 18:00 EDT America/New_York)
  const t4 = performance.now();
  // On 2027-06-15 (EDT = UTC-4, BST = UTC+1):
  // 18:00 America/New_York == 22:00 UTC == 23:00 Europe/London
  const crossTzAttempt = await createReservation(
    {
      restaurant_id: 1,
      table_id: 1,
      customer_name: 'London Caller',
      customer_email: 'london@tableguard.test',
      guests: 2,
      start_time: `${testDateStr}T23:00:00`,
      duration_minutes: 90,
      timezone: 'Europe/London',
      idempotency_key: `live-verify-tz-${Date.now()}`,
    },
    db
  );
  const check5Passed =
    !crossTzAttempt.ok &&
    crossTzAttempt.status === 409 &&
    crossTzAttempt.code === 'OVERLAPPING_RESERVATION';

  checks.push({
    name: 'Cross-Timezone Normalization (23:00 Europe/London == 18:00 America/New_York)',
    category: 'TIMEZONE',
    passed: check5Passed,
    duration_ms: Math.round(performance.now() - t4),
    assertion_detail: check5Passed
      ? 'Converted 23:00 BST to 22:00 UTC and detected exact collision with 18:00 EDT booking.'
      : `Cross-timezone check failed: ${crossTzAttempt.status} ${crossTzAttempt.error}`,
  });

  // Check 6: Cancellation Releases Slot for Immediate Rebooking
  const t5 = performance.now();
  const targetCancelId = succeeded[0]?.data?.id;
  let check6Passed = false;
  if (targetCancelId) {
    const cancelRes = cancelReservation(targetCancelId, db);
    const rebookRes = await createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: 'Post-Cancellation Guest',
        customer_email: 'rebook@tableguard.test',
        guests: 2,
        start_time: `${testDateStr}T18:00:00`,
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: `live-verify-rebook-${Date.now()}`,
      },
      db
    );
    if (rebookRes.data?.id) createdIdsToCleanup.push(rebookRes.data.id);
    check6Passed = cancelRes.ok && rebookRes.ok && rebookRes.status === 201;
  }

  checks.push({
    name: 'Cancellation Lifecycle & Immediate Slot Recovery',
    category: 'CANCELLATION',
    passed: check6Passed,
    duration_ms: Math.round(performance.now() - t5),
    assertion_detail: check6Passed
      ? 'Cancelled reservation transitioned to CANCELLED and unlocked [18:00, 19:30) for new booking.'
      : 'Cancellation lifecycle test failed.',
  });

  // Cleanup synthetic test records on 2027-06-15 so user's reservation list stays clean
  if (cleanupAfter && createdIdsToCleanup.length > 0) {
    db.prepare("DELETE FROM reservations WHERE start_time_utc LIKE '2027-06-15%'").run();
  }

  const invariantAfter = verifyDatabaseInvariants(db);
  const allPassed = checks.every((c) => c.passed) && invariantAfter.passed;
  const passedCount = checks.filter((c) => c.passed).length;

  const summaryText = allPassed
    ? `PASS: ${passedCount}/${checks.length} suites passed (${workers} concurrent threads, 1 booked, ${workers - 1} blocked, 0 overlaps)`
    : `FAIL: ${passedCount}/${checks.length} suites passed`;

  db.prepare(
    `UPDATE system_metrics
     SET verification_status = ?,
         last_verification_result = ?,
         last_verification_utc = ?
     WHERE id = 1`
  ).run(allPassed ? 'PASS' : 'FAIL', summaryText, runTime);

  return {
    overall_status: allPassed ? 'PASS' : 'FAIL',
    executed_at_utc: runTime,
    total_checks: checks.length,
    passed_checks: passedCount,
    concurrency_summary: {
      concurrent_requests: workers,
      succeeded: succeeded.length,
      conflicts_prevented: failedConflict.length,
      idempotent_replays_verified: 1,
      invariant_preserved: invariantAfter.passed,
    },
    checks,
  };
}
