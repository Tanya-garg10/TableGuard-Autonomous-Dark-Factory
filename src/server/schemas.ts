import { z } from 'zod';
import { DateTime } from 'luxon';

export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  return DateTime.local().setZone(tz).isValid;
}

export const CreateReservationSchema = z.object({
  restaurant_id: z.number().int().positive('restaurant_id must be a positive integer'),
  table_id: z.number().int().positive('table_id must be a positive integer'),
  customer_name: z
    .string()
    .trim()
    .min(2, 'Customer name must be at least 2 characters')
    .max(100, 'Customer name must not exceed 100 characters'),
  customer_email: z
    .string()
    .trim()
    .email('Invalid email address format')
    .max(150, 'Email must not exceed 150 characters'),
  guests: z
    .number()
    .int('Guests must be a whole number')
    .min(1, 'At least 1 guest is required')
    .max(20, 'Maximum party size is 20'),
  // Either explicit ISO start_time with offset/timezone OR date + time + timezone
  start_time: z.string().trim().min(1, 'Start time is required'),
  duration_minutes: z
    .number()
    .int()
    .min(30, 'Minimum reservation duration is 30 minutes')
    .max(240, 'Maximum reservation duration is 240 minutes')
    .optional()
    .default(90),
  timezone: z
    .string()
    .trim()
    .refine(isValidTimezone, { message: 'Invalid or unsupported IANA time zone' }),
  idempotency_key: z
    .string()
    .trim()
    .min(4, 'idempotency_key must be at least 4 characters')
    .max(128, 'idempotency_key must not exceed 128 characters'),
  notes: z.string().trim().max(500).optional().default(''),
});

export type CreateReservationInput = z.infer<typeof CreateReservationSchema>;

export const AvailabilityQuerySchema = z.object({
  restaurant_id: z.coerce.number().int().positive('restaurant_id is required'),
  start_time: z.string().trim().min(1, 'start_time is required'),
  duration_minutes: z.coerce.number().int().min(30).max(240).optional().default(90),
  guests: z.coerce.number().int().min(1).max(20).optional().default(2),
  timezone: z
    .string()
    .trim()
    .refine(isValidTimezone, { message: 'Invalid or unsupported IANA time zone' }),
});

export type AvailabilityQueryInput = z.infer<typeof AvailabilityQuerySchema>;

export interface ParsedTimeWindow {
  startUtcIso: string;
  endUtcIso: string;
  restaurantLocalStart: DateTime;
  restaurantLocalEnd: DateTime;
  clientLocalStart: DateTime;
}

/**
 * Explicitly parses a reservation start time in the provided client IANA timezone
 * (or embedded ISO offset) and converts it deterministically to canonical UTC
 * and the restaurant's own IANA timezone without ever relying on the server's local timezone.
 */
export function parseAndValidateTimeWindow(
  startTimeStr: string,
  durationMinutes: number,
  clientTimezone: string,
  restaurantTimezone: string,
  openHour: number,
  closeHour: number
): { ok: true; window: ParsedTimeWindow } | { ok: false; error: string } {
  if (!isValidTimezone(clientTimezone)) {
    return { ok: false, error: `Invalid client timezone: ${clientTimezone}` };
  }
  if (!isValidTimezone(restaurantTimezone)) {
    return { ok: false, error: `Invalid restaurant timezone: ${restaurantTimezone}` };
  }

  // Enforce strict ISO-8601 date-time structure (YYYY-MM-DDTHH:mm...)
  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?([+-]\d{2}:?\d{2}|Z)?$/i;
  if (!isoPattern.test(startTimeStr.trim())) {
    return {
      ok: false,
      error: `Invalid ISO-8601 date/time format "${startTimeStr}". Expected YYYY-MM-DDTHH:mm:ss`,
    };
  }

  // Parse ISO string. If the string contains an explicit offset or 'Z', Luxon respects it
  // when setZone: true is passed, or we convert into clientTimezone explicitly.
  const hasExplicitZone = /([+-]\d{2}:?\d{2}|Z)$/i.test(startTimeStr.trim());
  const dt = hasExplicitZone
    ? DateTime.fromISO(startTimeStr.trim(), { setZone: true }).setZone(clientTimezone)
    : DateTime.fromISO(startTimeStr.trim(), { zone: clientTimezone });

  if (!dt.isValid) {
    return {
      ok: false,
      error: `Invalid date/time format "${startTimeStr}": ${dt.invalidExplanation || 'unparseable ISO timestamp'}`,
    };
  }

  // Reject NaN or out-of-range years
  if (dt.year < 2020 || dt.year > 2100) {
    return { ok: false, error: 'Reservation year must be between 2020 and 2100' };
  }

  const endDt = dt.plus({ minutes: durationMinutes });

  // Convert both start and end to UTC in canonical ISO-8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)
  const startUtc = dt.toUTC();
  const endUtc = endDt.toUTC();

  const startUtcIso = startUtc.toISO();
  const endUtcIso = endUtc.toISO();

  if (!startUtcIso || !endUtcIso) {
    return { ok: false, error: 'Failed to normalize timestamps to UTC' };
  }

  // Convert to the restaurant's explicit IANA timezone to validate operating hours
  const restaurantLocalStart = startUtc.setZone(restaurantTimezone);
  const restaurantLocalEnd = endUtc.setZone(restaurantTimezone);

  const startDecimalHour =
    restaurantLocalStart.hour + restaurantLocalStart.minute / 60;
  const endDecimalHour =
    restaurantLocalEnd.day !== restaurantLocalStart.day
      ? 24 + restaurantLocalEnd.hour + restaurantLocalEnd.minute / 60
      : restaurantLocalEnd.hour + restaurantLocalEnd.minute / 60;

  if (startDecimalHour < openHour || endDecimalHour > closeHour) {
    const formattedLocal = restaurantLocalStart.toFormat('yyyy-MM-dd HH:mm');
    const formattedEndLocal = restaurantLocalEnd.toFormat('HH:mm');
    return {
      ok: false,
      error: `Requested window (${formattedLocal}–${formattedEndLocal} ${restaurantTimezone}) is outside restaurant operating hours (${String(openHour).padStart(2, '0')}:00–${String(closeHour).padStart(2, '0')}:00 ${restaurantTimezone}).`,
    };
  }

  return {
    ok: true,
    window: {
      startUtcIso,
      endUtcIso,
      restaurantLocalStart,
      restaurantLocalEnd,
      clientLocalStart: dt,
    },
  };
}
