import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/server/database.ts';
import {
  createReservation,
  cancelReservation,
  checkAvailability,
  listReservations,
  verifyDatabaseInvariants,
} from '../src/server/reservationService.ts';
import type { DatabaseSync } from 'node:sqlite';

describe('TableGuard Reservations — Core Lifecycle, Overlaps & Validation', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  it('creates a normal valid reservation and decreases available table count', async () => {
    const availBefore = checkAvailability(
      {
        restaurant_id: 1,
        start_time: '2026-10-10T18:00:00',
        duration_minutes: 90,
        guests: 2,
        timezone: 'America/New_York',
      },
      db
    );
    expect(availBefore.ok).toBe(true);
    expect(availBefore.data?.available_count).toBe(6);

    const res = await createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: 'Alice Vance',
        customer_email: 'alice@example.com',
        guests: 2,
        start_time: '2026-10-10T18:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'test-normal-1',
        notes: 'Anniversary dinner',
      },
      db
    );

    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    expect(res.data?.status).toBe('CONFIRMED');
    expect(res.data?.table_id).toBe(1);
    expect(res.data?.start_time_utc).toBe('2026-10-10T22:00:00.000Z');
    expect(res.data?.end_time_utc).toBe('2026-10-10T23:30:00.000Z');

    const availAfter = checkAvailability(
      {
        restaurant_id: 1,
        start_time: '2026-10-10T18:00:00',
        duration_minutes: 90,
        guests: 2,
        timezone: 'America/New_York',
      },
      db
    );
    expect(availAfter.data?.available_count).toBe(5);
    const table1 = availAfter.data?.tables.find((t) => t.id === 1);
    expect(table1?.is_available).toBe(false);
    expect(table1?.conflicting_reservation_id).toBe(res.data?.id);
  });

  it('prevents exact and partial overlapping reservations on the same table', async () => {
    // Base booking: 18:00 to 19:30 (America/New_York)
    const first = await createReservation(
      {
        restaurant_id: 1,
        table_id: 3, // 4-seat table
        customer_name: 'First Guest',
        customer_email: 'first@example.com',
        guests: 4,
        start_time: '2026-10-12T18:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'overlap-base',
      },
      db
    );
    expect(first.ok).toBe(true);

    // 1. Exact same window (18:00 to 19:30) -> MUST FAIL 409
    const exactOverlap = await createReservation(
      {
        restaurant_id: 1,
        table_id: 3,
        customer_name: 'Exact Intruder',
        customer_email: 'exact@example.com',
        guests: 4,
        start_time: '2026-10-12T18:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'overlap-exact',
      },
      db
    );
    expect(exactOverlap.ok).toBe(false);
    expect(exactOverlap.status).toBe(409);
    expect(exactOverlap.code).toBe('OVERLAPPING_RESERVATION');

    // 2. Partial overlap starting inside existing window (19:00 to 20:30) -> MUST FAIL 409
    const lateOverlap = await createReservation(
      {
        restaurant_id: 1,
        table_id: 3,
        customer_name: 'Late Intruder',
        customer_email: 'late@example.com',
        guests: 4,
        start_time: '2026-10-12T19:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'overlap-late',
      },
      db
    );
    expect(lateOverlap.ok).toBe(false);
    expect(lateOverlap.status).toBe(409);

    // 3. Partial overlap ending inside existing window (17:00 to 18:30) -> MUST FAIL 409
    const earlyOverlap = await createReservation(
      {
        restaurant_id: 1,
        table_id: 3,
        customer_name: 'Early Intruder',
        customer_email: 'early@example.com',
        guests: 4,
        start_time: '2026-10-12T17:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'overlap-early',
      },
      db
    );
    expect(earlyOverlap.ok).toBe(false);
    expect(earlyOverlap.status).toBe(409);

    // 4. Enclosing overlap (17:30 to 20:00) -> MUST FAIL 409
    const enclosingOverlap = await createReservation(
      {
        restaurant_id: 1,
        table_id: 3,
        customer_name: 'Enclosing Intruder',
        customer_email: 'enclosing@example.com',
        guests: 4,
        start_time: '2026-10-12T17:30:00',
        duration_minutes: 150,
        timezone: 'America/New_York',
        idempotency_key: 'overlap-enclosing',
      },
      db
    );
    expect(enclosingOverlap.ok).toBe(false);
    expect(enclosingOverlap.status).toBe(409);

    // 5. Adjacent non-overlapping slot starting at exact end time (19:30 to 21:00) -> MUST SUCCEED 201
    const adjacent = await createReservation(
      {
        restaurant_id: 1,
        table_id: 3,
        customer_name: 'Adjacent Guest',
        customer_email: 'adjacent@example.com',
        guests: 4,
        start_time: '2026-10-12T19:30:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'overlap-adjacent-ok',
      },
      db
    );
    expect(adjacent.ok).toBe(true);
    expect(adjacent.status).toBe(201);

    expect(verifyDatabaseInvariants(db).passed).toBe(true);
  });

  it('allows cancelling a reservation and immediately rebooking the released slot', async () => {
    const initial = await createReservation(
      {
        restaurant_id: 1,
        table_id: 2,
        customer_name: 'Cancel Test User',
        customer_email: 'cancel@example.com',
        guests: 2,
        start_time: '2026-10-14T19:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'cancel-flow-1',
      },
      db
    );
    expect(initial.ok).toBe(true);
    const resId = initial.data!.id;

    // Cancel the reservation
    const cancelRes = cancelReservation(resId, db);
    expect(cancelRes.ok).toBe(true);
    expect(cancelRes.data?.status).toBe('CANCELLED');

    // Now book the exact same table and time slot for a new guest
    const rebook = await createReservation(
      {
        restaurant_id: 1,
        table_id: 2,
        customer_name: 'New Guest After Cancel',
        customer_email: 'newguest@example.com',
        guests: 2,
        start_time: '2026-10-14T19:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'cancel-flow-2',
      },
      db
    );
    expect(rebook.ok).toBe(true);
    expect(rebook.status).toBe(201);
    expect(verifyDatabaseInvariants(db).passed).toBe(true);
  });

  it('rejects unavailable / over-capacity table and invalid inputs with 422', async () => {
    // Table 1 has capacity 2; requesting for 5 guests must fail
    const overCapacity = await createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: 'Large Party',
        customer_email: 'party@example.com',
        guests: 5,
        start_time: '2026-10-15T18:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'invalid-cap-1',
      },
      db
    );
    expect(overCapacity.ok).toBe(false);
    expect(overCapacity.status).toBe(422);
    expect(overCapacity.code).toBe('CAPACITY_EXCEEDED');

    // Invalid email and 0 guests
    const invalidInput = await createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: 'A',
        customer_email: 'not-an-email',
        guests: 0,
        start_time: '2026-10-15T18:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'invalid-schema-1',
      },
      db
    );
    expect(invalidInput.ok).toBe(false);
    expect(invalidInput.status).toBe(422);
    expect(invalidInput.code).toBe('VALIDATION_ERROR');

    // Invalid date/time string
    const invalidDate = await createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: 'Valid Name',
        customer_email: 'valid@example.com',
        guests: 2,
        start_time: '2026-02-30T25:99:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'invalid-date-1',
      },
      db
    );
    expect(invalidDate.ok).toBe(false);
    expect(invalidDate.status).toBe(422);
    expect(invalidDate.code).toBe('INVALID_TIME_WINDOW');

    const allConfirmed = listReservations({ status: 'CONFIRMED' }, db);
    expect(allConfirmed.length).toBe(0);
  });
});
