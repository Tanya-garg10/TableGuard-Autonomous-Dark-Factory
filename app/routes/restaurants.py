from typing import List, Dict, Any
from app.database import get_connection, DB_PATH


def list_restaurants_route(db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    conn = get_connection(db_path)
    try:
        restaurants = [dict(r) for r in conn.execute("SELECT * FROM restaurants ORDER BY id ASC").fetchall()]
        for r in restaurants:
            r["tables"] = [
                dict(t)
                for t in conn.execute(
                    "SELECT * FROM tables WHERE restaurant_id = ? ORDER BY capacity ASC, id ASC",
                    (r["id"],),
                ).fetchall()
            ]
        return restaurants
    finally:
        conn.close()
