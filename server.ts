import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  listRestaurants,
  getRestaurantById,
  checkAvailability,
  createReservation,
  cancelReservation,
  listReservations,
  getSystemStatus,
  runLiveVerificationSuite,
} from './src/server/reservationService.ts';

export function createApp() {
  const app = express();
  app.use(express.json());

  // 1. Health & Reliability Status
  app.get('/api/status', (_req, res) => {
    try {
      const status = getSystemStatus();
      res.status(200).json(status);
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal server error',
      });
    }
  });

  // 2. List all restaurants and their tables
  app.get('/api/restaurants', (_req, res) => {
    try {
      const restaurants = listRestaurants();
      res.status(200).json({ restaurants });
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to fetch restaurants',
      });
    }
  });

  // 3. Get single restaurant details & tables
  app.get('/api/restaurants/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(422).json({ error: 'Invalid restaurant ID' });
      return;
    }
    const restaurant = getRestaurantById(id);
    if (!restaurant) {
      res.status(404).json({ error: 'Restaurant not found' });
      return;
    }
    res.status(200).json({ restaurant });
  });

  // 4. Check availability for a given restaurant, date/time, duration, guests, and timezone
  app.get('/api/availability', (req, res) => {
    const result = checkAvailability(req.query);
    if (!result.ok) {
      res.status(result.status).json({
        error: result.error,
        code: result.code,
      });
      return;
    }
    res.status(200).json(result.data);
  });

  // 5. List reservations (with optional filters)
  app.get('/api/reservations', (req, res) => {
    const restaurantId = req.query.restaurant_id ? Number(req.query.restaurant_id) : undefined;
    const tableId = req.query.table_id ? Number(req.query.table_id) : undefined;
    const status = (req.query.status as 'CONFIRMED' | 'CANCELLED' | 'ALL' | undefined) || 'ALL';

    const reservations = listReservations({
      restaurant_id: restaurantId,
      table_id: tableId,
      status,
    });
    res.status(200).json({ reservations });
  });

  // 6. Create reservation (Protected against overlaps, concurrency, and duplicate retries)
  app.post('/api/reservations', async (req, res) => {
    const headerIdempotencyKey = req.header('Idempotency-Key') || req.header('X-Idempotency-Key');
    const payload = {
      ...req.body,
      idempotency_key: req.body?.idempotency_key || headerIdempotencyKey,
    };

    const result = await createReservation(payload);
    if (!result.ok) {
      res.status(result.status).json({
        error: result.error,
        code: result.code,
      });
      return;
    }

    res.status(result.status).json({
      reservation: result.data,
      idempotent_replay: Boolean(result.idempotent_replay),
    });
  });

  // 7. Cancel reservation
  app.post('/api/reservations/:id/cancel', (req, res) => {
    const id = Number(req.params.id);
    const result = cancelReservation(id);
    if (!result.ok) {
      res.status(result.status).json({
        error: result.error,
        code: result.code,
      });
      return;
    }
    res.status(200).json({
      reservation: result.data,
      idempotent_replay: Boolean(result.idempotent_replay),
    });
  });

  // Also support DELETE /api/reservations/:id for REST completeness
  app.delete('/api/reservations/:id', (req, res) => {
    const id = Number(req.params.id);
    const result = cancelReservation(id);
    if (!result.ok) {
      res.status(result.status).json({
        error: result.error,
        code: result.code,
      });
      return;
    }
    res.status(200).json({
      reservation: result.data,
      idempotent_replay: Boolean(result.idempotent_replay),
    });
  });

  // 8. Interactive Concurrency Burst Test for a Specific Table & Window (Visible in UI)
  app.post('/api/reliability/concurrency-burst', async (req, res) => {
    try {
      const workers = Math.min(Math.max(Number(req.body?.workers || 12), 2), 40);
      const restaurantId = Number(req.body?.restaurant_id || 1);
      const tableId = Number(req.body?.table_id || 1);
      const startTime = String(req.body?.start_time || '2026-10-06T19:00:00');
      const durationMinutes = Number(req.body?.duration_minutes || 90);
      const timezone = String(req.body?.timezone || 'America/New_York');
      const guests = Number(req.body?.guests || 2);
      const batchId = `burst-${Date.now()}`;

      const startTimer = performance.now();

      // Fire N simultaneous booking requests for the exact same table and overlapping time window
      const attempts = Array.from({ length: workers }, (_, i) =>
        createReservation({
          restaurant_id: restaurantId,
          table_id: tableId,
          customer_name: `Concurrent Request #${i + 1}`,
          customer_email: `request${i + 1}@concurrency.test`,
          guests,
          start_time: startTime,
          duration_minutes: durationMinutes,
          timezone,
          idempotency_key: `${batchId}-worker-${i + 1}`,
          notes: `Simultaneous burst test (${workers} threads)`,
        })
      );

      const outcomes = await Promise.all(attempts);
      const elapsedMs = Math.round(performance.now() - startTimer);

      const succeeded = outcomes.filter((o) => o.ok && o.status === 201);
      const conflicts = outcomes.filter((o) => !o.ok && o.status === 409);
      const otherErrors = outcomes.filter((o) => !o.ok && o.status !== 409);

      const statusAfter = getSystemStatus();

      res.status(200).json({
        batch_id: batchId,
        workers,
        elapsed_ms: elapsedMs,
        succeeded_count: succeeded.length,
        conflicts_prevented_count: conflicts.length,
        other_errors_count: otherErrors.length,
        winning_reservation: succeeded[0]?.data || null,
        invariant_check: statusAfter.invariant_check,
        outcomes: outcomes.map((o, idx) => ({
          worker_index: idx + 1,
          status: o.status,
          ok: o.ok,
          code: o.code || (o.ok ? 'CREATED' : 'ERROR'),
          reservation_id: o.data?.id || null,
          error: o.error || null,
        })),
      });
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Concurrency burst test failed',
      });
    }
  });

  // 9. Run Full Automated Verification Suite (Reliability Center)
  app.post('/api/reliability/verify', async (req, res) => {
    try {
      const workers = Number(req.body?.workers || 15);
      const report = await runLiveVerificationSuite({
        concurrentWorkers: workers,
        cleanupAfter: true,
      });
      res.status(200).json(report);
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Verification suite execution failed',
      });
    }
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const PORT = 3000;

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TableGuard Server listening on http://0.0.0.0:${PORT}`);
  });
}

// Only start listening if executed directly (not imported by Vitest)
if (process.env.VITEST !== 'true') {
  startServer();
}
