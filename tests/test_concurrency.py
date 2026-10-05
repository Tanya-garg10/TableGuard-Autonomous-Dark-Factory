import unittest
import tempfile
import os
from concurrent.futures import ThreadPoolExecutor
from app.database import init_db
from app.services.reservation_service import (
    create_reservation_service,
    verify_invariants_service,
)


class TestConcurrency(unittest.TestCase):
    def setUp(self):
        self.fd, self.db_path = tempfile.mkstemp(suffix=".sqlite")
        os.close(self.fd)
        init_db(self.db_path)

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_concurrent_overlapping_bookings_allow_only_one_winner(self):
        workers = 20

        def attempt_booking(idx: int):
            return create_reservation_service(
                {
                    "restaurant_id": 1,
                    "table_id": 1,
                    "customer_name": f"Thread Guest {idx}",
                    "customer_email": f"thread{idx}@example.com",
                    "guests": 2,
                    "start_time": "2026-11-10T19:00:00",
                    "duration_minutes": 90,
                    "timezone": "America/New_York",
                    "idempotency_key": f"py-conc-key-{idx}",
                },
                self.db_path,
            )

        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(attempt_booking, range(workers)))

        succeeded = [r for r in results if r["ok"] and r["status"] == 201]
        conflicts = [r for r in results if not r["ok"] and r["status"] == 409]

        self.assertEqual(len(succeeded), 1)
        self.assertEqual(len(conflicts), workers - 1)
        self.assertTrue(verify_invariants_service(self.db_path)["passed"])

    def test_idempotent_retries_under_concurrency(self):
        payload = {
            "restaurant_id": 1,
            "table_id": 2,
            "customer_name": "Idempotent User",
            "customer_email": "idem@example.com",
            "guests": 2,
            "start_time": "2026-11-11T19:00:00",
            "duration_minutes": 90,
            "timezone": "America/New_York",
            "idempotency_key": "shared-retry-key-100",
        }

        with ThreadPoolExecutor(max_workers=10) as pool:
            results = list(pool.map(lambda _: create_reservation_service(payload, self.db_path), range(10)))

        created = [r for r in results if r["ok"] and r["status"] == 201]
        replayed = [r for r in results if r["ok"] and r["status"] == 200 and r.get("idempotent_replay")]

        self.assertEqual(len(created), 1)
        self.assertEqual(len(replayed), 9)
        self.assertTrue(verify_invariants_service(self.db_path)["passed"])


if __name__ == "__main__":
    unittest.main()
