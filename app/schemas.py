import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Tuple, Dict, Any

try:
    from pydantic import BaseModel, Field, field_validator
    HAS_PYDANTIC = True
except ImportError:
    HAS_PYDANTIC = False
    BaseModel = object  # type: ignore

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def validate_timezone(tz_name: str) -> ZoneInfo:
    if not tz_name or not isinstance(tz_name, str):
        raise ValueError("Timezone is required")
    try:
        return ZoneInfo(tz_name.strip())
    except (ZoneInfoNotFoundError, KeyError, ValueError) as exc:
        raise ValueError(f"Invalid or unsupported IANA timezone: {tz_name}") from exc


def parse_and_normalize_window(
    start_time_str: str,
    duration_minutes: int,
    client_tz_name: str,
    restaurant_tz_name: str,
    open_hour: int,
    close_hour: int,
) -> Tuple[str, str, datetime, datetime]:
    """
    Explicitly parses start_time in client_tz_name, converts to canonical UTC ISO-8601
    (YYYY-MM-DDTHH:MM:SS.000Z), and validates operating hours in restaurant_tz_name.
    Never uses the server's local timezone.
    """
    client_tz = validate_timezone(client_tz_name)
    restaurant_tz = validate_timezone(restaurant_tz_name)

    if not isinstance(duration_minutes, int) or duration_minutes < 30 or duration_minutes > 240:
        raise ValueError("duration_minutes must be an integer between 30 and 240")

    cleaned = start_time_str.strip()
    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"

    try:
        dt = datetime.fromisoformat(cleaned)
    except ValueError as exc:
        raise ValueError(f"Invalid ISO date/time format: {start_time_str}") from exc

    if dt.year < 2020 or dt.year > 2100:
        raise ValueError("Reservation year must be between 2020 and 2100")

    if dt.tzinfo is None:
        dt_aware = dt.replace(tzinfo=client_tz)
    else:
        dt_aware = dt.astimezone(client_tz)

    end_aware = dt_aware + timedelta(minutes=duration_minutes)

    start_utc = dt_aware.astimezone(timezone.utc)
    end_utc = end_aware.astimezone(timezone.utc)

    rest_local_start = start_utc.astimezone(restaurant_tz)
    rest_local_end = end_utc.astimezone(restaurant_tz)

    start_dec = rest_local_start.hour + rest_local_start.minute / 60.0
    end_dec = (
        (24.0 if rest_local_end.date() != rest_local_start.date() else 0.0)
        + rest_local_end.hour
        + rest_local_end.minute / 60.0
    )

    if start_dec < open_hour or end_dec > close_hour:
        raise ValueError(
            f"Requested window ({rest_local_start.strftime('%Y-%m-%d %H:%M')}–{rest_local_end.strftime('%H:%M')} "
            f"{restaurant_tz_name}) is outside operating hours ({open_hour:02d}:00–{close_hour:02d}:00)."
        )

    start_utc_iso = start_utc.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    end_utc_iso = end_utc.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return start_utc_iso, end_utc_iso, rest_local_start, rest_local_end


def validate_reservation_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    required_fields = [
        "restaurant_id",
        "table_id",
        "customer_name",
        "customer_email",
        "guests",
        "start_time",
        "timezone",
        "idempotency_key",
    ]
    for f in required_fields:
        if f not in payload or payload[f] is None:
            raise ValueError(f"Missing required field: {f}")

    restaurant_id = int(payload["restaurant_id"])
    table_id = int(payload["table_id"])
    guests = int(payload["guests"])
    duration_minutes = int(payload.get("duration_minutes", 90))
    customer_name = str(payload["customer_name"]).strip()
    customer_email = str(payload["customer_email"]).strip()
    start_time = str(payload["start_time"]).strip()
    tz_name = str(payload["timezone"]).strip()
    idempotency_key = str(payload["idempotency_key"]).strip()
    notes = str(payload.get("notes", "")).strip()

    if restaurant_id <= 0 or table_id <= 0:
        raise ValueError("restaurant_id and table_id must be positive integers")
    if len(customer_name) < 2 or len(customer_name) > 100:
        raise ValueError("customer_name must be between 2 and 100 characters")
    if not EMAIL_RE.match(customer_email):
        raise ValueError("Invalid customer_email format")
    if guests < 1 or guests > 20:
        raise ValueError("guests must be between 1 and 20")
    if len(idempotency_key) < 4 or len(idempotency_key) > 128:
        raise ValueError("idempotency_key must be between 4 and 128 characters")

    validate_timezone(tz_name)

    return {
        "restaurant_id": restaurant_id,
        "table_id": table_id,
        "customer_name": customer_name,
        "customer_email": customer_email,
        "guests": guests,
        "start_time": start_time,
        "duration_minutes": duration_minutes,
        "timezone": tz_name,
        "idempotency_key": idempotency_key,
        "notes": notes,
    }
