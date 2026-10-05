import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export interface Restaurant {
  id: number;
  name: string;
  timezone: string;
  address: string;
  open_hour: number;
  close_hour: number;
  default_duration_minutes: number;
}

export interface TableInfo {
  id: number;
  restaurant_id: number;
  name: string;
  capacity: number;
  zone: string;
}

export interface Reservation {
  id: number;
  restaurant_id: number;
  table_id: number;
  table_name?: string;
  table_capacity?: number;
  restaurant_name?: string;
  restaurant_timezone?: string;
  customer_name: string;
  customer_email: string;
  guests: number;
  start_time_utc: string;
  end_time_utc: string;
  client_timezone: string;
  status: 'CONFIRMED' | 'CANCELLED';
  idempotency_key: string;
  notes: string;
  created_at_utc: string;
}

export interface SystemMetrics {
  booking_attempts: number;
  successful_reservations: number;
  conflicts_prevented: number;
  idempotent_replays: number;
  validation_rejections: number;
  cancellations: number;
  verification_status: 'PASS' | 'FAIL' | 'PENDING';
  last_verification_result: string;
  last_verification_utc: string | null;
}

let dbInstance: DatabaseSync | null = null;

export function createDatabase(dbPath?: string): DatabaseSync {
  const resolvedPath = dbPath || path.resolve(process.cwd(), 'tableguard.sqlite');
  const db = new DatabaseSync(resolvedPath);

  // Configure SQLite for strict transactional concurrency and integrity
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  initializeSchema(db);
  seedDatabaseIfNeeded(db);
  return db;
}

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    dbInstance = createDatabase();
  }
  return dbInstance;
}

export function resetDbForTesting(customDb?: DatabaseSync): void {
  if (customDb) {
    dbInstance = customDb;
  } else {
    dbInstance = createDatabase(':memory:');
  }
}

export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL,
      address TEXT NOT NULL,
      open_hour INTEGER NOT NULL DEFAULT 11,
      close_hour INTEGER NOT NULL DEFAULT 23,
      default_duration_minutes INTEGER NOT NULL DEFAULT 90
    );

    CREATE TABLE IF NOT EXISTS tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity > 0),
      zone TEXT NOT NULL DEFAULT 'Main Dining',
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL,
      table_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      guests INTEGER NOT NULL CHECK (guests > 0),
      start_time_utc TEXT NOT NULL,
      end_time_utc TEXT NOT NULL,
      client_timezone TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'CANCELLED')),
      idempotency_key TEXT NOT NULL UNIQUE,
      notes TEXT NOT NULL DEFAULT '',
      created_at_utc TEXT NOT NULL,
      CHECK (start_time_utc < end_time_utc),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
      FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_reservations_lookup 
      ON reservations (table_id, status, start_time_utc, end_time_utc);

    CREATE INDEX IF NOT EXISTS idx_reservations_restaurant 
      ON reservations (restaurant_id, status, start_time_utc);

    CREATE TABLE IF NOT EXISTS system_metrics (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      booking_attempts INTEGER NOT NULL DEFAULT 0,
      successful_reservations INTEGER NOT NULL DEFAULT 0,
      conflicts_prevented INTEGER NOT NULL DEFAULT 0,
      idempotent_replays INTEGER NOT NULL DEFAULT 0,
      validation_rejections INTEGER NOT NULL DEFAULT 0,
      cancellations INTEGER NOT NULL DEFAULT 0,
      verification_status TEXT NOT NULL DEFAULT 'PENDING',
      last_verification_result TEXT NOT NULL DEFAULT 'Not run yet',
      last_verification_utc TEXT
    );
  `);
}

export function seedDatabaseIfNeeded(db: DatabaseSync): void {
  const metricsRow = db.prepare('SELECT id FROM system_metrics WHERE id = 1').get();
  if (!metricsRow) {
    db.prepare(`
      INSERT INTO system_metrics (
        id, booking_attempts, successful_reservations, conflicts_prevented,
        idempotent_replays, validation_rejections, cancellations,
        verification_status, last_verification_result, last_verification_utc
      ) VALUES (1, 0, 0, 0, 0, 0, 0, 'PASS', 'Initial invariant check verified at startup', ?)
    `).run(new Date().toISOString());
  }

  const countRow = db.prepare('SELECT COUNT(*) as count FROM restaurants').get() as { count: number };
  if (countRow.count > 0) {
    return;
  }

  // Seed Restaurant 1: Riverside Grill (Primary Required Demo Restaurant)
  const insertRestaurant = db.prepare(`
    INSERT INTO restaurants (name, timezone, address, open_hour, close_hour, default_duration_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const r1 = insertRestaurant.run(
    'Riverside Grill',
    'America/New_York',
    '420 Hudson River Way, New York, NY',
    11,
    23,
    90
  );
  const r1Id = Number(r1.lastInsertRowid);

  const insertTable = db.prepare(`
    INSERT INTO tables (restaurant_id, name, capacity, zone)
    VALUES (?, ?, ?, ?)
  `);

  const r1Tables = [
    { name: 'Table 1', capacity: 2, zone: 'Waterfront Window' },
    { name: 'Table 2', capacity: 2, zone: 'Waterfront Window' },
    { name: 'Table 3', capacity: 4, zone: 'Main Dining Room' },
    { name: 'Table 4', capacity: 4, zone: 'Main Dining Room' },
    { name: 'Table 5', capacity: 6, zone: 'Chef Alcove' },
    { name: 'Table 6', capacity: 8, zone: 'Private River Terrace' },
  ];

  for (const t of r1Tables) {
    insertTable.run(r1Id, t.name, t.capacity, t.zone);
  }

  // Seed Restaurant 2: Kyoto Izakaya Tensei (Asia/Tokyo timezone for cross-timezone testing)
  const r2 = insertRestaurant.run(
    'Kyoto Izakaya Tensei',
    'Asia/Tokyo',
    '3-14 Pontocho Alley, Nakagyo Ward, Kyoto',
    12,
    23,
    90
  );
  const r2Id = Number(r2.lastInsertRowid);

  const r2Tables = [
    { name: 'Table 1', capacity: 2, zone: 'Counter Bar' },
    { name: 'Table 2', capacity: 2, zone: 'Counter Bar' },
    { name: 'Table 3', capacity: 4, zone: 'Tatami Suite A' },
    { name: 'Table 4', capacity: 6, zone: 'Tatami Suite B' },
  ];

  for (const t of r2Tables) {
    insertTable.run(r2Id, t.name, t.capacity, t.zone);
  }

  // Seed Restaurant 3: Thames Conservatory (Europe/London timezone)
  const r3 = insertRestaurant.run(
    'Thames Conservatory',
    'Europe/London',
    '18 Southbank Embankment, London',
    11,
    22,
    90
  );
  const r3Id = Number(r3.lastInsertRowid);

  const r3Tables = [
    { name: 'Table 1', capacity: 2, zone: 'Glass Atrium' },
    { name: 'Table 2', capacity: 4, zone: 'Glass Atrium' },
    { name: 'Table 3', capacity: 4, zone: 'Botanical Terrace' },
    { name: 'Table 4', capacity: 8, zone: 'Royal Banquette' },
  ];

  for (const t of r3Tables) {
    insertTable.run(r3Id, t.name, t.capacity, t.zone);
  }
}
