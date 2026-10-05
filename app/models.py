from dataclasses import dataclass
from typing import Optional


@dataclass
class RestaurantModel:
    id: int
    name: str
    timezone: str
    address: str
    open_hour: int
    close_hour: int
    default_duration_minutes: int


@dataclass
class TableModel:
    id: int
    restaurant_id: int
    name: str
    capacity: int
    zone: str


@dataclass
class ReservationModel:
    id: int
    restaurant_id: int
    table_id: int
    customer_name: str
    customer_email: str
    guests: int
    start_time_utc: str
    end_time_utc: str
    client_timezone: str
    status: str
    idempotency_key: str
    notes: str
    created_at_utc: str
    table_name: Optional[str] = None
    table_capacity: Optional[int] = None
    restaurant_name: Optional[str] = None
    restaurant_timezone: Optional[str] = None
