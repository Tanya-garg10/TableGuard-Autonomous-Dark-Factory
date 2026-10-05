# FACTORY.md — Autonomous Multi-Agent Dark Factory Architecture

## Overview
**TableGuard** is engineered and verified through a three-agent autonomous Dark Factory pipeline (**Architect → Builder → Verifier → Builder → Verifier**) operating inside a shared **BAND Room (`TableGuard Dark Factory`)**.

All three agent mandates (`mandates/architect.md`, `mandates/builder.md`, `mandates/verifier.md`) are strictly **domain-agnostic**—they define formal engineering roles, invariant design, evidence-driven implementation, and adversarial verification without hardcoding domain-specific terms.

---

## 1. Registered BAND Agents & Mandates

| Agent Role | BAND Handle | BAND Agent ID | Mandate File | Core Responsibility |
| :--- | :--- | :--- | :--- | :--- |
| **Architect** | `tanyagarg5315/architect` | `a9d32c2b-ce91-4226-814b-5873a66acf2b` | `mandates/architect.md` | Analyzes the stage specification, formalizes the non-overlapping allocation invariant (`[start_utc, end_utc)`), specifies SQLite `BEGIN IMMEDIATE` transactional locking + idempotency rules, and produces the implementation handoff. |
| **Builder** | `tanyagarg5315/builder` | `9975d55c-736c-441a-8b34-972b4415155e` | `mandates/builder.md` | Implements the service, database schema, transactional locking, explicit IANA timezone normalization, and automated test suite. Reproduces and repairs any defect discovered by the Verifier. |
| **Verifier** | `tanyagarg5315/verifier` | `a34c9866-18ba-46d0-9b23-9b41b7d15be4` | `mandates/verifier.md` | Independently attacks the implementation across 5 adversarial vectors (concurrency bursts, interval boundaries, idempotent retries & parameter tampering, cross-timezone collisions, and cancellation recovery). |

---

## 2. Autonomous Execution Workflow (`Architect → Builder → Verifier → Builder → Verifier`)

### Stage 1: Architect Analysis & Handoff
- Formalizes the core reliability invariant: *A resource must never be successfully allocated twice for overlapping time windows, including under concurrent requests and safe retries.*
- Defines the half-open interval condition (`existing.start_time_utc < requested.end_time_utc AND existing.end_time_utc > requested.start_time_utc`) and requires `BEGIN IMMEDIATE` transaction isolation in SQLite WAL mode.

### Stage 2: Builder Initial Implementation
- Implements the REST API (`/api/restaurants`, `/api/availability`, `/api/reservations`, `/api/reservations/:id/cancel`, `/api/status`), SQLite schema, and UI dashboard.
- Executes initial unit and integration tests.

### Stage 3: Verifier Adversarial Attack & Defect Discovery
- Attacks the service with:
  1. **25 simultaneous overlapping requests** targeting the same resource and window.
  2. **Cross-timezone collision attacks** (e.g., `23:30 Europe/London` vs `18:00 America/New_York` on the same UTC date).
  3. **Idempotency key parameter tampering** (reusing an existing `Idempotency-Key` with a different resource or time window).
- Flags any defect where idempotency key reuse with mutated payload parameters or cross-day closing hour calculation (`endDecimalHour` crossing midnight) could misbehave, routing a **DEFECT REPORT** back to Builder.

### Stage 4: Builder Reproduction & Repair
- Adds explicit parameter verification on idempotency replays (`409 IDEMPOTENCY_PARAMETER_MISMATCH` when payload parameters differ from the original record) and cross-midnight decimal hour calculation in `parseAndValidateTimeWindow`.
- Runs the complete Vitest + Python unittest suites and hands back reproducible test output.

### Stage 5: Verifier Independent Re-Test & Final Acceptance
- Re-runs all 17 automated tests and the 6-stage live concurrency stress suite (`POST /api/reliability/verify`).
- Confirms `0` double-booking invariant violations across all concurrent and cross-timezone stress tests and issues **FINAL VERIFICATION ACCEPTANCE**.
