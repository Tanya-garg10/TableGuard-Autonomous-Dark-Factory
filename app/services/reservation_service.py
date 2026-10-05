from datetime import datetime, timezone
from typing import Dict, Any, List
import sqlite3

from app.database import get_connection, db_lock, DB_PATH
from app.schemas import validate_reservation_payload, parse_and_normalize_window


def _inc_metric(conn: sqlite3.Connection, field: str, amount: int = 1) -> None:
    conn.execute(f"UPDATE system_metrics SET {field} = {field} + ? WHERE id = 1", (amount,))


def create_reservation_service(raw_payload: Dict[str, Any], db_path: str = DB_PATH) -> Dict[str, Any]:
    """
    Deterministic reservation service using:
    1. Application-level mutex + SQLite BEGIN IMMEDIATE transaction for serialized write safety.
    2. Idempotency key deduplication & parameter tampering protection.
    3. Explicit IANA timezone normalization to canonical UTC.
    4. Half-open interval [start_utc, end_utc) overlap prevention.
    """
    with db_lock:
        conn = get_connection(db_path)
        try:
            conn.execute("BEGIN IMMEDIATE")
            _inc_metric(conn, "booking_attempts", 1)

            try:
                data = validate_reservation_payload(raw_payload)
            except (ValueError, TypeError) as exc:
                _inc_metric(conn, "validation_rejections", 1)
                conn.execute("COMMIT")
                return {
                    "ok": False,
                    "status": 422,
                    "code": "VALIDATION_ERROR",
                    "error": str(exc),
                }

            rest = conn.execute(
                "SELECT * FROM restaurants WHERE id = ?", (data["restaurant_id"],)
            ).fetchone()
            if not rest:
                _inc_metric(conn, "validation_rejections", 1)
                conn.execute("COMMIT")
                return {
                    "ok": False,
                    "status": 404,
                    "code": "RESTAURANT_NOT_FOUND",
                    "error": "Restaurant not found",
                }

            table = conn.execute(
                "SELECT * FROM tables WHERE id = ? AND restaurant_id = ?",
                (data["table_id"], data["restaurant_id"]),
            ).fetchone()
            if not table:
                _inc_metric(conn, "validation_rejections", 1)
                conn.execute("COMMIT")
                return {
                    "ok": False,
                    "status": 404,
                    "code": "TABLE_NOT_FOUND",
                    "error": "Table not found for this restaurant",
                }

            try:
                start_utc_iso, end_utc_iso, _, _ = parse_and_normalize_window(
                    data["start_time"],
                    data["duration_minutes"],
                    data["timezone"],
                    rest["timezone"],
                    rest["open_hour"],
                    rest["close_hour"],
                )
            except ValueError as exc:
                _inc_metric(conn, "validation_rejections", 1)
                conn.execute("COMMIT")
                return {
                    "ok": False,
                    "status": 422,
                    "code": "INVALID_TIME_WINDOW",
                    "error": str(exc),
                }

            existing_key = conn.execute(
                "SELECT * FROM reservations WHERE idempotency_key = ?",
                (data["idempotency_key"],),
            ).fetchone()

            if existing_key:
                same_params = (
                    existing_key["restaurant_id"] == data["restaurant_id"]
                    and existing_key["table_id"] == data["table_id"]
                    and existing_key["start_time_utc"] == start_utc_iso
                    and existing_key["end_time_utc"] == end_utc_iso
                    and existing_key["guests"] == data["guests"]
                    and existing_key["customer_name"].strip().lower() == data["customer_name"].strip().lower()
                    and existing_key["customer_email"].lower() == data["customer_email"].lower()
                )
                if not same_params:
                    _inc_metric(conn, "conflicts_prevented", 1)
                    conn.execute("COMMIT")
                    return {
                        "ok": False,
                        "status": 409,
                        "code": "IDEMPOTENCY_PARAMETER_MISMATCH",
                        "error": "Idempotency key reused with mismatched reservation parameters",
                    }

                _inc_metric(conn, "idempotent_replays", 1)
                conn.execute("COMMIT")
                return {
                    "ok": True,
                    "status": 200,
                    "idempotent_replay": True,
                    "data": dict(existing_key),
                }

            if data["guests"] > table["capacity"]:
                _inc_metric(conn, "validation_rejections", 1)
                conn.execute("COMMIT")
                return {
                    "ok": False,
                    "status": 422,
                    "code": "CAPACITY_EXCEEDED",
                    "error": f"Party of {data['guests']} exceeds {table['name']} capacity ({table['capacity']})",
                }

            conflict = conn.execute(
                """
                SELECT id, start_time_utc, end_time_utc
                FROM reservations
                WHERE table_id = ?
                  AND status = 'CONFIRMED'
                  AND start_time_utc < ?
                  AND end_time_utc > ?
                LIMIT 1
                """,
                (data["table_id"], end_utc_iso, start_utc_iso),
            ).fetchone()

            if conflict:
                _inc_metric(conn, "conflicts_prevented", 1)
                conn.execute("COMMIT")
                return {
                    "ok": False,
                    "status": 409,
                    "code": "OVERLAPPING_RESERVATION",
                    "error": f"Table is already booked for overlapping window (Reservation #{conflict['id']})",
                }

            now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            cur = conn.execute(
                """
                INSERT INTO reservations (
                    restaurant_id, table_id, customer_name, customer_email,
                    guests, start_time_utc, end_time_utc, client_timezone,
                    status, idempotency_key, notes, created_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?)
                """,
                (
                    data["restaurant_id"],
                    data["table_id"],
                    data["customer_name"],
                    data["customer_email"],
                    data["guests"],
                    start_utc_iso,
                    end_utc_iso,
                    data["timezone"],
                    data["idempotency_key"],
                    data["notes"],
                    now_utc,
                ),
            )
            new_id = cur.lastrowid
            created = conn.execute(
                "SELECT * FROM reservations WHERE id = ?", (new_id,)
            ).fetchone()
            _inc_metric(conn, "successful_reservations", 1)
            conn.execute("COMMIT")

            return {
                "ok": True,
                "status": 201,
                "idempotent_replay": False,
                "data": dict(created),
            }
        except Exception as exc:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            return {
                "ok": False,
                "status": 409,
                "code": "TRANSACTION_CONFLICT",
                "error": str(exc),
            }
        finally:
            conn.close()


def cancel_reservation_service(reservation_id: int, db_path: str = DB_PATH) -> Dict[str, Any]:
    with db_lock:
        conn = get_connection(db_path)
        try:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT * FROM reservations WHERE id = ?", (reservation_id,)
            ).fetchone()
            if not existing:
                conn.execute("ROLLBACK")
                return {"ok": False, "status": 404, "code": "NOT_FOUND", "error": "Reservation not found"}

            if existing["status"] == "CANCELLED":
                conn.execute("COMMIT")
                return {"ok": True, "status": 200, "idempotent_replay": True, "data": dict(existing)}

            conn.execute(
                "UPDATE reservations SET status = 'CANCELLED' WHERE id = ?", (reservation_id,)
            )
            _inc_metric(conn, "cancellations", 1)
            updated = conn.execute(
                "SELECT * FROM reservations WHERE id = ?", (reservation_id,)
            ).fetchone()
            conn.execute("COMMIT")
            return {"ok": True, "status": 200, "idempotent_replay": False, "data": dict(updated)}
        finally:
            conn.close()


def verify_invariants_service(db_path: str = DB_PATH) -> Dict[str, Any]:
    conn = get_connection(db_path)
    try:
        overlaps = conn.execute(
            """
            SELECT a.id as res_a, b.id as res_b, a.table_id
            FROM reservations a
            JOIN reservations b
              ON a.table_id = b.table_id
             AND a.id < b.id
             AND a.status = 'CONFIRMED'
             AND b.status = 'CONFIRMED'
             AND a.start_time_utc < b.end_time_utc
             AND a.end_time_utc > b.start_time_utc
            """
        ).fetchall()
        return {
            "passed": len(overlaps) == 0,
            "overlapping_pairs_count": len(overlaps),
        }
    finally:
        conn.close()
