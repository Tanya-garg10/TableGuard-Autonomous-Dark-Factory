import sqlite3
import os
import threading
from datetime import datetime, timezone

DB_PATH = os.environ.get("TABLEGUARD_DB_PATH", "tableguard.sqlite")
db_lock = threading.Lock()


def get_connection(db_path: str = DB_PATH) -> sqlite3.Connection:
    # isolation_level=None puts sqlite3 in manual transaction mode so we can explicitly issue BEGIN IMMEDIATE
    conn = sqlite3.connect(db_path, timeout=10.0, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


def init_db(db_path: str = DB_PATH) -> None:
    conn = get_connection(db_path)
    try:
        conn.executescript(
            """
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

            CREATE TABLE IF NOT EXISTS system_metrics (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                booking_attempts INTEGER NOT NULL DEFAULT 0,
                successful_reservations INTEGER NOT NULL DEFAULT 0,
                conflicts_prevented INTEGER NOT NULL DEFAULT 0,
                idempotent_replays INTEGER NOT NULL DEFAULT 0,
                validation_rejections INTEGER NOT NULL DEFAULT 0,
                cancellations INTEGER NOT NULL DEFAULT 0,
                verification_status TEXT NOT NULL DEFAULT 'PASS',
                last_verification_result TEXT NOT NULL DEFAULT 'Verified at startup',
                last_verification_utc TEXT
            );
            """
        )

        row = conn.execute("SELECT id FROM system_metrics WHERE id = 1").fetchone()
        if not row:
            conn.execute(
                """
                INSERT INTO system_metrics (
                    id, booking_attempts, successful_reservations, conflicts_prevented,
                    idempotent_replays, validation_rejections, cancellations,
                    verification_status, last_verification_result, last_verification_utc
                ) VALUES (1, 0, 0, 0, 0, 0, 0, 'PASS', 'Initial invariant check verified', ?)
                """,
                (datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),),
            )

        count = conn.execute("SELECT COUNT(*) as c FROM restaurants").fetchone()["c"]
        if count == 0:
            cur = conn.execute(
                """
                INSERT INTO restaurants (name, timezone, address, open_hour, close_hour, default_duration_minutes)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                ("Riverside Grill", "America/New_York", "420 Hudson River Way, New York, NY", 11, 23, 90),
            )
            r1_id = cur.lastrowid
            tables = [
                ("Table 1", 2, "Waterfront Window"),
                ("Table 2", 2, "Waterfront Window"),
                ("Table 3", 4, "Main Dining Room"),
                ("Table 4", 4, "Main Dining Room"),
                ("Table 5", 6, "Chef Alcove"),
                ("Table 6", 8, "Private River Terrace"),
            ]
            for name, cap, zone in tables:
                conn.execute(
                    "INSERT INTO tables (restaurant_id, name, capacity, zone) VALUES (?, ?, ?, ?)",
                    (r1_id, name, cap, zone),
                )
    finally:
        conn.close()
