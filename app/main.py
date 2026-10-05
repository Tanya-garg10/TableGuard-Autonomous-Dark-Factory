from typing import Dict, Any
from app.database import init_db, DB_PATH
from app.routes.restaurants import list_restaurants_route
from app.routes.reservations import list_reservations_route
from app.services.reservation_service import (
    create_reservation_service,
    cancel_reservation_service,
    verify_invariants_service,
)

init_db(DB_PATH)

try:
    from fastapi import FastAPI, HTTPException, Header, Request
    from fastapi.responses import HTMLResponse, JSONResponse
    from fastapi.templating import Jinja2Templates

    app = FastAPI(
        title="TableGuard — Autonomous Dark Factory for Reliable Reservations",
        version="1.0.0",
    )

    @app.get("/api/restaurants")
    def get_restaurants():
        return {"restaurants": list_restaurants_route()}

    @app.get("/api/reservations")
    def get_reservations():
        return {"reservations": list_reservations_route()}

    @app.post("/api/reservations")
    def post_reservation(payload: Dict[str, Any], idempotency_key: str | None = Header(default=None)):
        if idempotency_key and "idempotency_key" not in payload:
            payload["idempotency_key"] = idempotency_key
        res = create_reservation_service(payload)
        if not res["ok"]:
            return JSONResponse(status_code=res["status"], content=res)
        return JSONResponse(
            status_code=res["status"],
            content={"reservation": res["data"], "idempotent_replay": res["idempotent_replay"]},
        )

    @app.post("/api/reservations/{reservation_id}/cancel")
    def post_cancel_reservation(reservation_id: int):
        res = cancel_reservation_service(reservation_id)
        if not res["ok"]:
            return JSONResponse(status_code=res["status"], content=res)
        return JSONResponse(
            status_code=200,
            content={"reservation": res["data"], "idempotent_replay": res["idempotent_replay"]},
        )

    @app.get("/api/status")
    def get_status():
        return verify_invariants_service()

except ImportError:
    app = None
