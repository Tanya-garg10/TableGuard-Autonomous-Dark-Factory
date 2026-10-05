from typing import Dict, Any, List
from app.database import get_connection, DB_PATH
from app.services.reservation_service import (
    create_reservation_service,
    cancel_reservation_service,
    verify_invariants_service,
)


def list_reservations_route(db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    conn = get_connection(db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM reservations ORDER BY start_time_utc DESC, id DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
