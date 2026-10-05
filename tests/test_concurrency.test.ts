import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/server/database.ts';
import {
  createReservation,
  listReservations,
  verifyDatabaseInvariants,
} from '../src/server/reservationService.ts';
import type { DatabaseSync } from 'node:sqlite';

describe('TableGuard Concurrency & Idempotency Protection', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  it('guarantees exactly ONE valid booking succeeds when 25 simultaneous requests target the same table and overlapping window', async () => {
    const CONCURRENT_ATTEMPTS = 25;

    const tasks = Array.from({ length: CONCURRENT_ATTEMPTS }, (_, i) =>
      createReservation(
        {
          restaurant_id: 1,
          table_id: 1,
          customer_name: `Concurrent Guest ${i + 1}`,
          customer_email: `guest${i + 1}@example.com`,
          guests: 2,
          start_time: '2026-11-20T19:00:00',
          duration_minutes: 90,
          timezone: 'America/New_York',
          idempotency_key: `concurrent-distinct-key-${i + 1}`,
        },
        db
      )
    );

    const results = await Promise.all(tasks);

    const successes = results.filter((r) => r.ok && r.status === 201);
    const conflicts = results.filter(
      (r) => !r.ok && r.status === 409 && r.code === 'OVERLAPPING_RESERVATION'
    );

    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(CONCURRENT_ATTEMPTS - 1);

    // Verify database consistency: only 1 row exists and invariant check passes
    const confirmedRows = listReservations({ restaurant_id: 1, table_id: 1, status: 'CONFIRMED' }, db);
    expect(confirmedRows.length).toBe(1);
    expect(confirmedRows[0].id).toBe(successes[0].data?.id);

    const invariant = verifyDatabaseInvariants(db);
    expect(invariant.passed).toBe(true);
    expect(invariant.overlappingPairsCount).toBe(0);
  });

  it('handles staggered overlapping concurrent requests (18:30, 19:00, 19:30) deterministically without any double booking', async () => {
    // 15 requests split across 18:30 (90m), 19:00 (90m), and 19:30 (90m)
    // Note: 18:30–20:00 and 19:30–21:00 overlap at [19:30, 20:00), and 19:00–20:30 overlaps with both!
    const slots = ['18:30:00', '19:00:00', '19:30:00'];
    const tasks = Array.from({ length: 15 }, (_, i) => {
      const slot = slots[i % slots.length];
      return createReservation(
        {
          restaurant_id: 1,
          table_id: 4,
          customer_name: `Staggered Guest ${i + 1}`,
          customer_email: `staggered${i + 1}@example.com`,
          guests: 4,
          start_time: `2026-11-21T${slot}`,
          duration_minutes: 90,
          timezone: 'America/New_York',
          idempotency_key: `staggered-key-${i + 1}`,
        },
        db
      );
    });

    await Promise.all(tasks);

    const invariant = verifyDatabaseInvariants(db);
    expect(invariant.passed).toBe(true);
    expect(invariant.overlappingPairsCount).toBe(0);

    const confirmed = listReservations({ restaurant_id: 1, table_id: 4, status: 'CONFIRMED' }, db);
    // Since all 3 slots mutually overlap with each other, only 1 can succeed
    expect(confirmed.length).toBe(1);
  });

  it('handles repeated/retried requests safely via idempotency_key without creating duplicate records', async () => {
    const payload = {
      restaurant_id: 1,
      table_id: 5,
      customer_name: 'Retry Safe Customer',
      customer_email: 'retry@example.com',
      guests: 6,
      start_time: '2026-11-22T18:00:00',
      duration_minutes: 90,
      timezone: 'America/New_York',
      idempotency_key: 'idem-retry-key-999',
    };

    // Send 10 simultaneous retries with the exact same idempotency_key and payload
    const results = await Promise.all(
      Array.from({ length: 10 }, () => createReservation(payload, db))
    );

    const created = results.filter((r) => r.ok && r.status === 201 && !r.idempotent_replay);
    const replayed = results.filter((r) => r.ok && r.status === 200 && r.idempotent_replay);

    expect(created.length).toBe(1);
    expect(replayed.length).toBe(9);

    // Every single response must return the exact same reservation ID
    const firstId = created[0].data?.id;
    for (const r of results) {
      expect(r.data?.id).toBe(firstId);
    }

    // Only 1 row in database
    const rows = listReservations({ restaurant_id: 1, table_id: 5 }, db);
    expect(rows.length).toBe(1);

    // Reusing the same idempotency_key with different parameters (e.g. different table or customer_name) must fail with 409
    const tampered = await createReservation(
      {
        ...payload,
        table_id: 6,
      },
      db
    );
    expect(tampered.ok).toBe(false);
    expect(tampered.status).toBe(409);
    expect(tampered.code).toBe('IDEMPOTENCY_PARAMETER_MISMATCH');

    const tamperedCustomerName = await createReservation(
      {
        ...payload,
        customer_name: 'Different Hijacker Name',
      },
      db
    );
    expect(tamperedCustomerName.ok).toBe(false);
    expect(tamperedCustomerName.status).toBe(409);
    expect(tamperedCustomerName.code).toBe('IDEMPOTENCY_PARAMETER_MISMATCH');
  });
});
