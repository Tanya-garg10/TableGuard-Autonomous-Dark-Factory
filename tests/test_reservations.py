import unittest
import tempfile
import os
from app.database import init_db
from app.services.reservation_service import (
    create_reservation_service,
    cancel_reservation_service,
    verify_invariants_service,
)


class TestReservations(unittest.TestCase):
    def setUp(self):
        self.fd, self.db_path = tempfile.mkstemp(suffix=".sqlite")
        os.close(self.fd)
        init_db(self.db_path)

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_normal_reservation_and_cancellation(self):
        res = create_reservation_service(
            {
                "restaurant_id": 1,
                "table_id": 1,
                "customer_name": "Elena Rostova",
                "customer_email": "elena@example.com",
                "guests": 2,
                "start_time": "2026-10-15T18:00:00",
                "duration_minutes": 90,
                "timezone": "America/New_York",
                "idempotency_key": "py-normal-1",
            },
            self.db_path,
        )
        self.assertTrue(res["ok"])
        self.assertEqual(res["status"], 201)
        res_id = res["data"]["id"]

        cancel = cancel_reservation_service(res_id, self.db_path)
        self.assertTrue(cancel["ok"])
        self.assertEqual(cancel["data"]["status"], "CANCELLED")

        # Rebooking after cancellation succeeds
        rebook = create_reservation_service(
            {
                "restaurant_id": 1,
                "table_id": 1,
                "customer_name": "Second Guest",
                "customer_email": "second@example.com",
                "guests": 2,
                "start_time": "2026-10-15T18:00:00",
                "duration_minutes": 90,
                "timezone": "America/New_York",
                "idempotency_key": "py-normal-2",
            },
            self.db_path,
        )
        self.assertTrue(rebook["ok"])
        self.assertEqual(rebook["status"], 201)

    def test_overlapping_reservation_blocked(self):
        first = create_reservation_service(
            {
                "restaurant_id": 1,
                "table_id": 3,
                "customer_name": "First Guest",
                "customer_email": "first@example.com",
                "guests": 4,
                "start_time": "2026-10-16T18:00:00",
                "duration_minutes": 90,
                "timezone": "America/New_York",
                "idempotency_key": "py-overlap-1",
            },
            self.db_path,
        )
        self.assertTrue(first["ok"])

        # Overlapping 18:30 to 20:00 must fail with 409
        second = create_reservation_service(
            {
                "restaurant_id": 1,
                "table_id": 3,
                "customer_name": "Overlap Guest",
                "customer_email": "overlap@example.com",
                "guests": 4,
                "start_time": "2026-10-16T18:30:00",
                "duration_minutes": 90,
                "timezone": "America/New_York",
                "idempotency_key": "py-overlap-2",
            },
            self.db_path,
        )
        self.assertFalse(second["ok"])
        self.assertEqual(second["status"], 409)
        self.assertEqual(second["code"], "OVERLAPPING_RESERVATION")
        self.assertTrue(verify_invariants_service(self.db_path)["passed"])

    def test_unavailable_table_capacity_and_invalid_input(self):
        # Exceeds Table 1 capacity (2 seats)
        over_cap = create_reservation_service(
            {
                "restaurant_id": 1,
                "table_id": 1,
                "customer_name": "Big Group",
                "customer_email": "group@example.com",
                "guests": 6,
                "start_time": "2026-10-16T18:00:00",
                "duration_minutes": 90,
                "timezone": "America/New_York",
                "idempotency_key": "py-cap-1",
            },
            self.db_path,
        )
        self.assertFalse(over_cap["ok"])
        self.assertEqual(over_cap["status"], 422)

        # Invalid date/time
        bad_date = create_reservation_service(
            {
                "restaurant_id": 1,
                "table_id": 1,
                "customer_name": "Bad Date",
                "customer_email": "baddate@example.com",
                "guests": 2,
                "start_time": "not-a-valid-date",
                "duration_minutes": 90,
                "timezone": "America/New_York",
                "idempotency_key": "py-bad-date",
            },
            self.db_path,
        )
        self.assertFalse(bad_date["ok"])
        self.assertEqual(bad_date["status"], 422)


if __name__ == "__main__":
    unittest.main()
