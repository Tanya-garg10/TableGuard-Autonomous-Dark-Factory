import unittest
import tempfile
import os
from app.database import init_db
from app.services.reservation_service import (
    create_reservation_service,
    verify_invariants_service,
)


class TestTimezone(unittest.TestCase):
    def setUp(self):
        self.fd, self.db_path = tempfile.mkstemp(suffix=".sqlite")
        os.close(self.fd)
        init_db(self.db_path)

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_cross_timezone_overlap_detection(self):
        # 18:00 America/New_York on 2026-07-10 (EDT, UTC-4) -> 22:00 UTC
        r1 = create_reservation_service(
            {
                "restaurant_id": 1,
                "table_id": 1,
                "customer_name": "NY Diner",
                "customer_email": "ny@example.com",
                "guests": 2,
                "start_time": "2026-07-10T18:00:00",
                "duration_minutes": 90,
                "timezone": "America/New_York",
                "idempotency_key": "py-tz-1",
            },
            self.db_path,
        )
        self.assertTrue(r1["ok"])
        self.assertEqual(r1["data"]["start_time_utc"], "2026-07-10T22:00:00.000Z")

        # 23:30 Europe/London on 2026-07-10 (BST, UTC+1) -> 22:30 UTC (Overlaps!)
        r2 = create_reservation_service(
            {
                "restaurant_id": 1,
                "table_id": 1,
                "customer_name": "London Diner",
                "customer_email": "london@example.com",
                "guests": 2,
                "start_time": "2026-07-10T23:30:00",
                "duration_minutes": 90,
                "timezone": "Europe/London",
                "idempotency_key": "py-tz-2",
            },
            self.db_path,
        )
        self.assertFalse(r2["ok"])
        self.assertEqual(r2["status"], 409)
        self.assertTrue(verify_invariants_service(self.db_path)["passed"])

    def test_invalid_timezone_and_outside_operating_hours(self):
        bad_tz = create_reservation_service(
            {
                "restaurant_id": 1,
                "table_id": 1,
                "customer_name": "Invalid TZ",
                "customer_email": "tz@example.com",
                "guests": 2,
                "start_time": "2026-07-10T18:00:00",
                "duration_minutes": 90,
                "timezone": "Invalid/Timezone",
                "idempotency_key": "py-tz-bad",
            },
            self.db_path,
        )
        self.assertFalse(bad_tz["ok"])
        self.assertEqual(bad_tz["status"], 422)


if __name__ == "__main__":
    unittest.main()
