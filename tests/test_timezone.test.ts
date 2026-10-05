import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/server/database.ts';
import {
  createReservation,
  verifyDatabaseInvariants,
} from '../src/server/reservationService.ts';
import type { DatabaseSync } from 'node:sqlite';

describe('TableGuard Time-Zone Conversion & Edge Cases', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  it('normalizes cross-timezone requests to canonical UTC and detects overlapping bookings made from different timezones', async () => {
    // Restaurant 1 (Riverside Grill) is in America/New_York.
    // On 2026-07-10 (Summer EDT = UTC-4):
    // Guest A books from America/New_York at 18:00 EDT -> 22:00 UTC to 23:30 UTC
    const bookingNY = await createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: 'New York Diner',
        customer_email: 'ny@example.com',
        guests: 2,
        start_time: '2026-07-10T18:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'tz-ny-1',
      },
      db
    );
    expect(bookingNY.ok).toBe(true);
    expect(bookingNY.data?.start_time_utc).toBe('2026-07-10T22:00:00.000Z');
    expect(bookingNY.data?.end_time_utc).toBe('2026-07-10T23:30:00.000Z');

    // Guest B attempts to book the same table from Europe/London (BST = UTC+1)
    // 23:30 BST on 2026-07-10 == 22:30 UTC on 2026-07-10, which overlaps [22:00 UTC, 23:30 UTC)!
    const bookingLondon = await createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: 'London Traveler',
        customer_email: 'london@example.com',
        guests: 2,
        start_time: '2026-07-10T23:30:00',
        duration_minutes: 90,
        timezone: 'Europe/London',
        idempotency_key: 'tz-london-1',
      },
      db
    );
    expect(bookingLondon.ok).toBe(false);
    expect(bookingLondon.status).toBe(409);
    expect(bookingLondon.code).toBe('OVERLAPPING_RESERVATION');

    // Guest C attempts to book the same table from Asia/Tokyo (JST = UTC+9)
    // 2026-07-11T07:00:00 JST == 2026-07-10T22:00:00 UTC -> Exact collision across the international date line!
    const bookingTokyo = await createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: 'Tokyo Traveler',
        customer_email: 'tokyo@example.com',
        guests: 2,
        start_time: '2026-07-11T07:00:00',
        duration_minutes: 90,
        timezone: 'Asia/Tokyo',
        idempotency_key: 'tz-tokyo-1',
      },
      db
    );
    expect(bookingTokyo.ok).toBe(false);
    expect(bookingTokyo.status).toBe(409);
    expect(bookingTokyo.code).toBe('OVERLAPPING_RESERVATION');

    expect(verifyDatabaseInvariants(db).passed).toBe(true);
  });

  it('enforces restaurant operating hours in the restaurant own local timezone regardless of caller timezone', async () => {
    // Riverside Grill operates 11:00–23:00 America/New_York.
    // Requesting 09:00 America/New_York (before opening) must be rejected with 422
    const tooEarly = await createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: 'Early Bird',
        customer_email: 'early@example.com',
        guests: 2,
        start_time: '2026-10-10T09:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'tz-hours-early',
      },
      db
    );
    expect(tooEarly.ok).toBe(false);
    expect(tooEarly.status).toBe(422);
    expect(tooEarly.code).toBe('INVALID_TIME_WINDOW');

    // Requesting 22:00 America/New_York with a 90-minute duration ends at 23:30 (past 23:00 close) -> rejected with 422
    const pastClose = await createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: 'Late Diner',
        customer_email: 'late@example.com',
        guests: 2,
        start_time: '2026-10-10T22:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'tz-hours-late',
      },
      db
    );
    expect(pastClose.ok).toBe(false);
    expect(pastClose.status).toBe(422);
  });

  it('handles Daylight Saving Time (DST) transitions and rejects unrecognized IANA timezones', async () => {
    // Reject bogus timezone string
    const badTz = await createReservation(
      {
        restaurant_id: 1,
        table_id: 1,
        customer_name: 'Bad Timezone',
        customer_email: 'badtz@example.com',
        guests: 2,
        start_time: '2026-10-10T18:00:00',
        duration_minutes: 90,
        timezone: 'Mars/Olympus_Mons',
        idempotency_key: 'tz-invalid-zone',
      },
      db
    );
    expect(badTz.ok).toBe(false);
    expect(badTz.status).toBe(422);

    // Winter EST (UTC-5) vs Summer EDT (UTC-4) check:
    // On 2026-12-15 (EST = UTC-5), 18:00 America/New_York -> 23:00 UTC
    const winterBooking = await createReservation(
      {
        restaurant_id: 1,
        table_id: 2,
        customer_name: 'Winter Guest',
        customer_email: 'winter@example.com',
        guests: 2,
        start_time: '2026-12-15T18:00:00',
        duration_minutes: 90,
        timezone: 'America/New_York',
        idempotency_key: 'tz-winter-est',
      },
      db
    );
    expect(winterBooking.ok).toBe(true);
    expect(winterBooking.data?.start_time_utc).toBe('2026-12-15T23:00:00.000Z');
  });
});
