import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ShieldCheck,
  Calendar,
  Clock,
  Users,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  XCircle,
  ArrowRight,
  Globe,
  Database,
  Play,
  RotateCcw,
  Terminal,
  Copy,
  Check,
  Search,
  ChevronRight,
} from 'lucide-react';

interface TableInfo {
  id: number;
  restaurant_id: number;
  name: string;
  capacity: number;
  zone: string;
}

interface Restaurant {
  id: number;
  name: string;
  timezone: string;
  address: string;
  open_hour: number;
  close_hour: number;
  default_duration_minutes: number;
  tables: TableInfo[];
}

interface TableAvailabilityItem extends TableInfo {
  is_available: boolean;
  fits_party: boolean;
  conflicting_reservation_id: number | null;
  reason: string | null;
}

interface AvailabilityResponse {
  restaurant: Restaurant;
  requested_start_utc: string;
  requested_end_utc: string;
  restaurant_local_window: string;
  guests: number;
  duration_minutes: number;
  tables: TableAvailabilityItem[];
  available_count: number;
}

interface Reservation {
  id: number;
  restaurant_id: number;
  table_id: number;
  table_name?: string;
  table_capacity?: number;
  restaurant_name?: string;
  restaurant_timezone?: string;
  customer_name: string;
  customer_email: string;
  guests: number;
  start_time_utc: string;
  end_time_utc: string;
  client_timezone: string;
  status: 'CONFIRMED' | 'CANCELLED';
  idempotency_key: string;
  notes: string;
  created_at_utc: string;
}

interface SystemStatus {
  system_status: 'OPERATIONAL' | 'DEGRADED';
  total_tables: number;
  active_reservations: number;
  cancelled_reservations: number;
  invariant_check: {
    passed: boolean;
    overlappingPairsCount: number;
    details: string;
  };
  metrics: {
    booking_attempts: number;
    successful_reservations: number;
    conflicts_prevented: number;
    idempotent_replays: number;
    validation_rejections: number;
    cancellations: number;
    verification_status: 'PASS' | 'FAIL' | 'PENDING';
    last_verification_result: string;
    last_verification_utc: string | null;
  };
}

interface VerificationSuiteReport {
  overall_status: 'PASS' | 'FAIL';
  executed_at_utc: string;
  total_checks: number;
  passed_checks: number;
  concurrency_summary: {
    concurrent_requests: number;
    succeeded: number;
    conflicts_prevented: number;
    idempotent_replays_verified: number;
    invariant_preserved: boolean;
  };
  checks: Array<{
    name: string;
    category: string;
    passed: boolean;
    duration_ms: number;
    assertion_detail: string;
  }>;
}

interface ConcurrencyBurstReport {
  batch_id: string;
  workers: number;
  elapsed_ms: number;
  succeeded_count: number;
  conflicts_prevented_count: number;
  other_errors_count: number;
  winning_reservation: Reservation | null;
  invariant_check: {
    passed: boolean;
    overlappingPairsCount: number;
    details: string;
  };
  outcomes: Array<{
    worker_index: number;
    status: number;
    ok: boolean;
    code: string;
    reservation_id: number | null;
    error: string | null;
  }>;
}

const SUPPORTED_TIMEZONES = [
  { value: 'America/New_York', label: 'America/New_York (EDT/EST)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (PDT/PST)' },
  { value: 'Europe/London', label: 'Europe/London (BST/GMT)' },
  { value: 'Europe/Paris', label: 'Europe/Paris (CEST/CET)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST)' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
  { value: 'UTC', label: 'UTC (Canonical)' },
];

const TIME_SLOTS = [
  '12:00',
  '12:30',
  '13:00',
  '13:30',
  '17:30',
  '18:00',
  '18:30',
  '19:00',
  '19:30',
  '20:00',
  '20:30',
  '21:00',
];

function generateIdempotencyKey(): string {
  const rand = Math.random().toString(36).substring(2, 10);
  return `tg-req-${Date.now()}-${rand}`;
}

function formatUtcTimestampInZone(utcIso: string, timezone: string): string {
  try {
    const dt = new Date(utcIso);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(dt);
  } catch {
    return utcIso;
  }
}

export default function App() {
  const [activeSection, setActiveSection] = useState<'booking' | 'reservations' | 'reliability' | 'factory'>('booking');
  const [copiedBlock, setCopiedBlock] = useState<string | null>(null);

  // Core data states
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);

  // Selection states (Main Flow: Select Restaurant -> Date -> Time -> Guests -> View Available Tables -> Reserve -> Confirmation)
  const [selectedRestaurantId, setSelectedRestaurantId] = useState<number>(1);
  const [selectedDate, setSelectedDate] = useState<string>('2026-10-06');
  const [selectedTime, setSelectedTime] = useState<string>('19:00');
  const [selectedDuration, setSelectedDuration] = useState<number>(90);
  const [selectedGuests, setSelectedGuests] = useState<number>(2);
  const [selectedTimezone, setSelectedTimezone] = useState<string>('America/New_York');
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);

  // Booking form states
  const [customerName, setCustomerName] = useState<string>('Elena Rostova');
  const [customerEmail, setCustomerEmail] = useState<string>('elena.rostova@example.com');
  const [notes, setNotes] = useState<string>('Quiet table preferred');
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => generateIdempotencyKey());
  const [lockIdempotencyKeyForRetryDemo, setLockIdempotencyKeyForRetryDemo] = useState<boolean>(false);

  // Feedback & confirmation states
  const [isLoadingAvailability, setIsLoadingAvailability] = useState<boolean>(false);
  const [isSubmittingBooking, setIsSubmittingBooking] = useState<boolean>(false);
  const [bookingFeedback, setBookingFeedback] = useState<{
    type: 'success' | 'replay' | 'error';
    title: string;
    message: string;
    reservation?: Reservation;
    code?: string;
  } | null>(null);

  // Reservation History filter states
  const [historyStatusFilter, setHistoryStatusFilter] = useState<'ALL' | 'CONFIRMED' | 'CANCELLED'>('ALL');
  const [historySearchQuery, setHistorySearchQuery] = useState<string>('');

  // Reliability Center states
  const [isRunningVerification, setIsRunningVerification] = useState<boolean>(false);
  const [verificationReport, setVerificationReport] = useState<VerificationSuiteReport | null>(null);
  const [burstWorkers, setBurstWorkers] = useState<number>(12);
  const [isRunningBurst, setIsRunningBurst] = useState<boolean>(false);
  const [burstReport, setBurstReport] = useState<ConcurrencyBurstReport | null>(null);
  const [copiedKey, setCopiedKey] = useState<boolean>(false);

  const selectedRestaurant = useMemo(
    () => restaurants.find((r) => r.id === selectedRestaurantId) || null,
    [restaurants, selectedRestaurantId]
  );

  const fetchSystemAndRestaurants = useCallback(async () => {
    try {
      const [statusRes, restRes, resListRes] = await Promise.all([
        fetch('/api/status'),
        fetch('/api/restaurants'),
        fetch(`/api/reservations?restaurant_id=${selectedRestaurantId}`),
      ]);

      if (statusRes.ok) {
        const sData = await statusRes.json();
        setSystemStatus(sData);
      }
      if (restRes.ok) {
        const rData = await restRes.json();
        setRestaurants(rData.restaurants || []);
      }
      if (resListRes.ok) {
        const lData = await resListRes.json();
        setReservations(lData.reservations || []);
      }
    } catch (err) {
      console.error('Error fetching initial state:', err);
    }
  }, [selectedRestaurantId]);

  const fetchAvailability = useCallback(async () => {
    if (!selectedRestaurantId || !selectedDate || !selectedTime) return;
    setIsLoadingAvailability(true);
    try {
      const startTimeIso = `${selectedDate}T${selectedTime}:00`;
      const params = new URLSearchParams({
        restaurant_id: String(selectedRestaurantId),
        start_time: startTimeIso,
        duration_minutes: String(selectedDuration),
        guests: String(selectedGuests),
        timezone: selectedTimezone,
      });

      const res = await fetch(`/api/availability?${params.toString()}`);
      const data = await res.json();

      if (res.ok) {
        setAvailability(data);
        // Auto-select first available table if current selection is unavailable or null
        const availTables = (data.tables || []) as TableAvailabilityItem[];
        const currentStillAvailable = availTables.some(
          (t) => t.id === selectedTableId && t.is_available
        );
        if (!currentStillAvailable) {
          const firstAvail = availTables.find((t) => t.is_available);
          setSelectedTableId(firstAvail ? firstAvail.id : availTables[0]?.id ?? null);
        }
      } else {
        setAvailability(null);
        setBookingFeedback({
          type: 'error',
          title: 'Time Window Validation Error',
          message: data.error || 'Unable to check availability for the selected window.',
          code: data.code,
        });
      }
    } catch (err) {
      console.error('Availability check error:', err);
    } finally {
      setIsLoadingAvailability(false);
    }
  }, [
    selectedRestaurantId,
    selectedDate,
    selectedTime,
    selectedDuration,
    selectedGuests,
    selectedTimezone,
    selectedTableId,
  ]);

  useEffect(() => {
    fetchSystemAndRestaurants();
  }, [fetchSystemAndRestaurants]);

  useEffect(() => {
    fetchAvailability();
  }, [fetchAvailability]);

  // When changing restaurant, align client timezone to restaurant timezone by default for convenience
  const handleSelectRestaurant = (id: number) => {
    setSelectedRestaurantId(id);
    setSelectedTableId(null);
    setBookingFeedback(null);
    const found = restaurants.find((r) => r.id === id);
    if (found) {
      setSelectedTimezone(found.timezone);
    }
  };

  const handleCreateReservation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTableId) {
      setBookingFeedback({
        type: 'error',
        title: 'No Table Selected',
        message: 'Please select a table from the floor grid before submitting.',
      });
      return;
    }

    setIsSubmittingBooking(true);
    setBookingFeedback(null);

    try {
      const startTimeIso = `${selectedDate}T${selectedTime}:00`;
      const res = await fetch('/api/reservations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          restaurant_id: selectedRestaurantId,
          table_id: selectedTableId,
          customer_name: customerName,
          customer_email: customerEmail,
          guests: selectedGuests,
          start_time: startTimeIso,
          duration_minutes: selectedDuration,
          timezone: selectedTimezone,
          idempotency_key: idempotencyKey,
          notes,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        const isReplay = Boolean(data.idempotent_replay);
        setBookingFeedback({
          type: isReplay ? 'replay' : 'success',
          title: isReplay
            ? 'Idempotent Safe Retry Verified (200 OK)'
            : 'Reservation Confirmed (201 Created)',
          message: isReplay
            ? `Duplicate request detected with key "${idempotencyKey}". Returned existing Reservation #${data.reservation.id} without creating a duplicate database record.`
            : `Reserved ${data.reservation.table_name} at ${data.reservation.restaurant_name} for ${data.reservation.guests} guests.`,
          reservation: data.reservation,
        });

        if (!lockIdempotencyKeyForRetryDemo) {
          setIdempotencyKey(generateIdempotencyKey());
        }
      } else {
        setBookingFeedback({
          type: 'error',
          title:
            res.status === 409
              ? 'Booking Conflict Prevented (409 Conflict)'
              : 'Validation Error (422 Unprocessable)',
          message: data.error || 'Reservation request was rejected.',
          code: data.code,
        });
      }

      await Promise.all([fetchSystemAndRestaurants(), fetchAvailability()]);
    } catch (err: unknown) {
      setBookingFeedback({
        type: 'error',
        title: 'Network Error',
        message: err instanceof Error ? err.message : 'Failed to communicate with server',
      });
    } finally {
      setIsSubmittingBooking(false);
    }
  };

  const handleCancelReservation = async (id: number) => {
    try {
      const res = await fetch(`/api/reservations/${id}/cancel`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        setBookingFeedback({
          type: 'success',
          title: `Reservation #${id} Cancelled`,
          message: `${data.reservation.table_name} is now released and immediately available for new bookings.`,
        });
        await Promise.all([fetchSystemAndRestaurants(), fetchAvailability()]);
      }
    } catch (err) {
      console.error('Cancel error:', err);
    }
  };

  const handleRunVerificationSuite = async () => {
    setIsRunningVerification(true);
    try {
      const res = await fetch('/api/reliability/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workers: 15 }),
      });
      if (res.ok) {
        const report = await res.json();
        setVerificationReport(report);
        await fetchSystemAndRestaurants();
      }
    } catch (err) {
      console.error('Verification error:', err);
    } finally {
      setIsRunningVerification(false);
    }
  };

  const handleRunConcurrencyBurst = async () => {
    if (!selectedTableId) return;
    setIsRunningBurst(true);
    setBurstReport(null);
    try {
      const startTimeIso = `${selectedDate}T${selectedTime}:00`;
      const res = await fetch('/api/reliability/concurrency-burst', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workers: burstWorkers,
          restaurant_id: selectedRestaurantId,
          table_id: selectedTableId,
          start_time: startTimeIso,
          duration_minutes: selectedDuration,
          timezone: selectedTimezone,
          guests: selectedGuests,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setBurstReport(data);
        await Promise.all([fetchSystemAndRestaurants(), fetchAvailability()]);
      }
    } catch (err) {
      console.error('Concurrency burst error:', err);
    } finally {
      setIsRunningBurst(false);
    }
  };

  const filteredReservations = useMemo(() => {
    return reservations.filter((r) => {
      if (historyStatusFilter !== 'ALL' && r.status !== historyStatusFilter) {
        return false;
      }
      if (historySearchQuery.trim() !== '') {
        const q = historySearchQuery.toLowerCase();
        const matchName = r.customer_name.toLowerCase().includes(q);
        const matchEmail = r.customer_email.toLowerCase().includes(q);
        const matchTable = (r.table_name || '').toLowerCase().includes(q);
        const matchKey = r.idempotency_key.toLowerCase().includes(q);
        const matchId = String(r.id).includes(q);
        return matchName || matchEmail || matchTable || matchKey || matchId;
      }
      return true;
    });
  }, [reservations, historyStatusFilter, historySearchQuery]);

  const selectedTableObj = useMemo(() => {
    return availability?.tables.find((t) => t.id === selectedTableId) || null;
  }, [availability, selectedTableId]);

  const copyIdempotencyKey = () => {
    navigator.clipboard.writeText(idempotencyKey);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 1500);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Strict 3-Zone Top Navigation Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200 px-6 py-3.5 flex items-center justify-between">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('booking');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap"
        >
          TableGuard
        </a>

        {/* Zone 2: Clean text navigation links */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600">
          <button
            type="button"
            onClick={() => setActiveSection('booking')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap py-1 border-b-2 ${
              activeSection === 'booking'
                ? 'border-slate-900 text-slate-900 font-semibold'
                : 'border-transparent'
            }`}
          >
            Reservation Desk
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('reservations')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap py-1 border-b-2 ${
              activeSection === 'reservations'
                ? 'border-slate-900 text-slate-900 font-semibold'
                : 'border-transparent'
            }`}
          >
            Reservation Ledger ({reservations.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('reliability')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap py-1 border-b-2 ${
              activeSection === 'reliability'
                ? 'border-slate-900 text-slate-900 font-semibold'
                : 'border-transparent'
            }`}
          >
            Reliability Center
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('factory')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap py-1 border-b-2 ${
              activeSection === 'factory'
                ? 'border-slate-900 text-slate-900 font-semibold'
                : 'border-transparent'
            }`}
          >
            BAND Dark Factory
          </button>
        </nav>

        {/* Zone 3: 1-2 Primary Actions */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRunVerificationSuite}
            disabled={isRunningVerification}
            className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors whitespace-nowrap flex items-center gap-2 cursor-pointer disabled:opacity-60"
          >
            <Play className="w-3.5 h-3.5" />
            {isRunningVerification ? 'Running Suite...' : 'Run Verification Suite'}
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 max-w-[1400px] w-full mx-auto px-6 py-8 space-y-8">
        {/* Top System & Reliability Telemetry Bar */}
        <section className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-4 border-b border-slate-100">
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                Autonomous Dark Factory for Reliable Reservations
              </h1>
              <p className="text-sm text-slate-600 mt-0.5">
                Strict half-open interval locking · SQLite WAL immediate transactions · Idempotent retry safety · Explicit IANA timezone normalization
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs text-slate-600 font-mono tabular-nums">
              <span className="flex items-center gap-1.5 font-semibold text-emerald-700">
                <ShieldCheck className="w-4 h-4" />
                System: {systemStatus?.system_status || 'OPERATIONAL'}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Verification: {systemStatus?.metrics.verification_status || 'PASS'}
              </span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={fetchSystemAndRestaurants}
                className="text-slate-700 hover:text-slate-900 underline underline-offset-4 cursor-pointer flex items-center gap-1"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Sync
              </button>
            </div>
          </div>

          {/* Live Metrics Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-6 pt-4">
            <div>
              <div className="text-xs text-slate-500">Available Tables (Window)</div>
              <div className="text-2xl font-bold text-slate-900 font-mono tabular-nums mt-1">
                {availability ? `${availability.available_count} / ${availability.tables.length}` : '—'}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                For {selectedGuests} {selectedGuests === 1 ? 'guest' : 'guests'}
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-500">Active Reservations</div>
              <div className="text-2xl font-bold text-slate-900 font-mono tabular-nums mt-1">
                {systemStatus?.active_reservations ?? 0}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Confirmed in database
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-500">Booking Attempts</div>
              <div className="text-2xl font-bold text-slate-900 font-mono tabular-nums mt-1">
                {systemStatus?.metrics.booking_attempts ?? 0}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Total API requests
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-500">Conflicts Prevented</div>
              <div className="text-2xl font-bold text-amber-700 font-mono tabular-nums mt-1">
                {systemStatus?.metrics.conflicts_prevented ?? 0}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Overlaps & races blocked
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-500">Idempotent Replays</div>
              <div className="text-2xl font-bold text-slate-900 font-mono tabular-nums mt-1">
                {systemStatus?.metrics.idempotent_replays ?? 0}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Safe network retries
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-500">Double-Booking Violations</div>
              <div className="text-2xl font-bold text-emerald-700 font-mono tabular-nums mt-1">
                {systemStatus?.invariant_check.overlappingPairsCount ?? 0}
              </div>
              <div className="text-xs text-emerald-700 font-medium mt-0.5">
                Invariant strictly holds
              </div>
            </div>
          </div>
        </section>

        {/* Mobile Section Switcher */}
        <div className="flex md:hidden items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setActiveSection('booking')}
            className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              activeSection === 'booking' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Reservation Desk
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('reservations')}
            className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              activeSection === 'reservations' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Ledger ({reservations.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('reliability')}
            className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              activeSection === 'reliability' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Reliability Center
          </button>
        </div>

        {/* SECTION 1: RESERVATION DESK (Main SaaS Flow) */}
        {activeSection === 'booking' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left Column (7 cols): Step 1 Restaurant & Window Selection -> Step 2 Table Availability Grid */}
            <div className="lg:col-span-7 space-y-6">
              {/* Step 1: Select Restaurant, Date, Time, Guests, Timezone */}
              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
                <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                  <div>
                    <h2 className="text-base font-bold text-slate-900">
                      01. Select Venue & Time Window
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Choose a restaurant, date, time slot, party size, and caller time zone
                    </p>
                  </div>
                  {selectedRestaurant && (
                    <div className="text-xs text-slate-500 font-mono">
                      Venue TZ: {selectedRestaurant.timezone}
                    </div>
                  )}
                </div>

                {/* Restaurant Selector Tabs */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    Select Restaurant
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {restaurants.map((rest) => {
                      const isSelected = rest.id === selectedRestaurantId;
                      return (
                        <button
                          key={rest.id}
                          type="button"
                          onClick={() => handleSelectRestaurant(rest.id)}
                          className={`text-left p-3.5 rounded-lg border transition-colors cursor-pointer ${
                            isSelected
                              ? 'border-slate-900 bg-slate-900 text-white'
                              : 'border-slate-200 bg-slate-50/60 hover:border-slate-300 text-slate-900'
                          }`}
                        >
                          <div className="font-semibold text-sm truncate">{rest.name}</div>
                          <div
                            className={`text-xs mt-1 font-mono ${
                              isSelected ? 'text-slate-300' : 'text-slate-500'
                            }`}
                          >
                            {rest.timezone} · {rest.tables.length} tables
                          </div>
                          <div
                            className={`text-xs mt-0.5 ${
                              isSelected ? 'text-slate-300' : 'text-slate-500'
                            }`}
                          >
                            Hours: {String(rest.open_hour).padStart(2, '0')}:00–
                            {String(rest.close_hour).padStart(2, '0')}:00
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Date, Guests, Duration, Caller Timezone Controls */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <label
                      htmlFor="booking-date"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Date
                    </label>
                    <input
                      id="booking-date"
                      type="date"
                      value={selectedDate}
                      onChange={(e) => setSelectedDate(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg font-mono focus:outline-none focus:border-slate-900"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="booking-guests"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Party Size (Guests)
                    </label>
                    <select
                      id="booking-guests"
                      value={selectedGuests}
                      onChange={(e) => setSelectedGuests(Number(e.target.value))}
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg font-mono focus:outline-none focus:border-slate-900"
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 8, 10].map((num) => (
                        <option key={num} value={num}>
                          {num} {num === 1 ? 'Guest' : 'Guests'}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="booking-duration"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Duration
                    </label>
                    <select
                      id="booking-duration"
                      value={selectedDuration}
                      onChange={(e) => setSelectedDuration(Number(e.target.value))}
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg font-mono focus:outline-none focus:border-slate-900"
                    >
                      <option value={60}>60 min</option>
                      <option value={90}>90 min (Standard)</option>
                      <option value={120}>120 min</option>
                      <option value={150}>150 min</option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="booking-tz"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Caller Time Zone
                    </label>
                    <select
                      id="booking-tz"
                      value={selectedTimezone}
                      onChange={(e) => setSelectedTimezone(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg font-mono focus:outline-none focus:border-slate-900"
                    >
                      {SUPPORTED_TIMEZONES.map((tz) => (
                        <option key={tz.value} value={tz.value}>
                          {tz.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Time Slot Quick Selector + Custom Time Input */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-semibold text-slate-700">
                      Select Time ({selectedTimezone})
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">Custom time:</span>
                      <input
                        type="time"
                        value={selectedTime}
                        onChange={(e) => setSelectedTime(e.target.value)}
                        className="px-2 py-1 text-xs bg-slate-50 border border-slate-300 rounded font-mono"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                    {TIME_SLOTS.map((slot) => {
                      const active = selectedTime === slot;
                      return (
                        <button
                          key={slot}
                          type="button"
                          onClick={() => setSelectedTime(slot)}
                          className={`py-2 px-3 text-xs font-mono font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${
                            active
                              ? 'bg-emerald-700 text-white border-emerald-700'
                              : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400'
                          }`}
                        >
                          {slot}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Timezone Conversion Preview Bar */}
                {availability && (
                  <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 font-mono">
                    <div>
                      Canonical UTC:{' '}
                      <span className="font-semibold text-slate-900">
                        {availability.requested_start_utc.slice(0, 16).replace('T', ' ')}Z →{' '}
                        {availability.requested_end_utc.slice(11, 16)}Z
                      </span>
                    </div>
                    <div>
                      Venue Local:{' '}
                      <span className="font-semibold text-slate-900">
                        {availability.restaurant_local_window}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Step 2: Live Table Floor Availability Grid */}
              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                  <div>
                    <h2 className="text-base font-bold text-slate-900">
                      02. Select Available Table
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Real-time SQLite interval overlap check for {selectedRestaurant?.name || 'Venue'}
                    </p>
                  </div>
                  <div className="text-xs font-mono text-slate-600">
                    {isLoadingAvailability ? (
                      <span>Checking SQLite...</span>
                    ) : availability ? (
                      <span>
                        {availability.available_count} of {availability.tables.length} tables available
                      </span>
                    ) : (
                      <span>Window outside operating hours</span>
                    )}
                  </div>
                </div>

                {!availability ? (
                  <div className="p-6 bg-amber-50/70 border border-amber-200 rounded-lg text-sm text-amber-900 space-y-2">
                    <div className="font-semibold flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" />
                      Requested Time Window Unavailable
                    </div>
                    <p className="text-xs text-amber-800">
                      {bookingFeedback?.message ||
                        'The selected time and timezone converts to a window outside the restaurant operating hours. Try selecting a time between 12:00 and 21:00 in the venue timezone.'}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5">
                    {availability.tables.map((table) => {
                      const isSelected = table.id === selectedTableId;
                      return (
                        <button
                          key={table.id}
                          type="button"
                          onClick={() => setSelectedTableId(table.id)}
                          className={`text-left p-4 rounded-lg border transition-all cursor-pointer flex flex-col justify-between ${
                            isSelected
                              ? 'border-slate-900 ring-2 ring-slate-900/10 bg-slate-50'
                              : table.is_available
                              ? 'border-slate-200 bg-white hover:border-slate-400'
                              : 'border-slate-200 bg-slate-100/70 opacity-80 hover:border-slate-300'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-bold text-sm text-slate-900">
                                {table.name}
                              </span>
                              <span className="text-xs font-mono font-semibold text-slate-700">
                                {table.capacity} seats
                              </span>
                            </div>
                            <div className="text-xs text-slate-500 mt-1">{table.zone}</div>
                          </div>

                          <div className="mt-4 pt-2.5 border-t border-slate-200/70 flex items-center justify-between text-xs">
                            {table.is_available ? (
                              <span className="font-semibold text-emerald-700 flex items-center gap-1">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                Available
                              </span>
                            ) : !table.fits_party ? (
                              <span className="font-medium text-slate-500 flex items-center gap-1">
                                <Users className="w-3.5 h-3.5" />
                                Too small ({table.capacity} max)
                              </span>
                            ) : (
                              <span className="font-semibold text-rose-700 flex items-center gap-1">
                                <XCircle className="w-3.5 h-3.5" />
                                Reserved (#{table.conflicting_reservation_id})
                              </span>
                            )}
                            {isSelected && (
                              <span className="font-mono text-[11px] font-semibold text-slate-900 underline">
                                Selected
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Right Column (5 cols): Step 3 Reserve & Confirmation + Live Concurrency Test Trigger */}
            <div className="lg:col-span-5 space-y-6">
              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
                <div className="border-b border-slate-100 pb-4">
                  <h2 className="text-base font-bold text-slate-900">
                    03. Complete Reservation
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Protected by SQLite immediate write lock and idempotency key verification
                  </p>
                </div>

                {/* Selected Slot Summary Banner */}
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Venue & Table:</span>
                    <span className="font-semibold text-slate-900">
                      {selectedRestaurant?.name} · {selectedTableObj?.name || 'None'} (
                      {selectedTableObj?.capacity || 0} seats)
                    </span>
                  </div>
                  <div className="flex items-center justify-between font-mono">
                    <span className="text-slate-500 font-sans">Window:</span>
                    <span className="text-slate-900">
                      {selectedDate} {selectedTime} ({selectedDuration}m · {selectedTimezone})
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Table Status:</span>
                    <span
                      className={`font-semibold ${
                        selectedTableObj?.is_available ? 'text-emerald-700' : 'text-rose-700'
                      }`}
                    >
                      {selectedTableObj?.is_available
                        ? 'Available for Booking'
                        : selectedTableObj?.reason || 'Unavailable'}
                    </span>
                  </div>
                </div>

                <form onSubmit={handleCreateReservation} className="space-y-4">
                  <div>
                    <label
                      htmlFor="guest-name"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Guest Full Name
                    </label>
                    <input
                      id="guest-name"
                      type="text"
                      required
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      placeholder="e.g., Elena Rostova"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-slate-900"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="guest-email"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Guest Email Address
                    </label>
                    <input
                      id="guest-email"
                      type="email"
                      required
                      value={customerEmail}
                      onChange={(e) => setCustomerEmail(e.target.value)}
                      placeholder="elena@example.com"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-slate-900"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="guest-notes"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Special Requests (Optional)
                    </label>
                    <input
                      id="guest-notes"
                      type="text"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Dietary restrictions, seating preference"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-slate-900"
                    />
                  </div>

                  {/* Idempotency Key Control */}
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="idempotency-key"
                        className="text-xs font-semibold text-slate-700"
                      >
                        Idempotency-Key Header
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={copyIdempotencyKey}
                          className="text-xs text-slate-600 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
                        >
                          {copiedKey ? (
                            <Check className="w-3 h-3 text-emerald-700" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                          {copiedKey ? 'Copied' : 'Copy'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setIdempotencyKey(generateIdempotencyKey())}
                          className="text-xs text-slate-700 hover:text-slate-900 font-medium flex items-center gap-1 cursor-pointer"
                        >
                          <RotateCcw className="w-3 h-3" />
                          New Key
                        </button>
                      </div>
                    </div>
                    <input
                      id="idempotency-key"
                      type="text"
                      value={idempotencyKey}
                      onChange={(e) => setIdempotencyKey(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded focus:outline-none focus:border-slate-900"
                    />
                    <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none pt-0.5">
                      <input
                        type="checkbox"
                        checked={lockIdempotencyKeyForRetryDemo}
                        onChange={(e) => setLockIdempotencyKeyForRetryDemo(e.target.checked)}
                        className="rounded border-slate-300"
                      />
                      <span>
                        Keep same key after booking (test safe network retry / idempotency replay)
                      </span>
                    </label>
                  </div>

                  <button
                    type="submit"
                    disabled={isSubmittingBooking || !selectedTableId}
                    className="w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isSubmittingBooking ? (
                      'Executing Transaction...'
                    ) : (
                      <>
                        <span>Confirm Reservation</span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </form>

                {/* Clear Success / Idempotent Replay / Error State */}
                {bookingFeedback && (
                  <div
                    className={`p-4 rounded-lg border text-xs space-y-2 ${
                      bookingFeedback.type === 'success'
                        ? 'bg-emerald-50/80 border-emerald-200 text-emerald-950'
                        : bookingFeedback.type === 'replay'
                        ? 'bg-sky-50/80 border-sky-200 text-sky-950'
                        : 'bg-rose-50/80 border-rose-200 text-rose-950'
                    }`}
                  >
                    <div className="font-bold text-sm flex items-center gap-2">
                      {bookingFeedback.type === 'error' ? (
                        <AlertCircle className="w-4 h-4 text-rose-700 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                      )}
                      <span>{bookingFeedback.title}</span>
                    </div>
                    <p className="leading-relaxed">{bookingFeedback.message}</p>
                    {bookingFeedback.reservation && (
                      <div className="pt-2 border-t border-black/10 font-mono text-[11px] space-y-1">
                        <div>
                          Reservation ID: #{bookingFeedback.reservation.id} · Status:{' '}
                          {bookingFeedback.reservation.status}
                        </div>
                        <div>
                          UTC Window: {bookingFeedback.reservation.start_time_utc} →{' '}
                          {bookingFeedback.reservation.end_time_utc}
                        </div>
                        <div>
                          Idempotency Key: {bookingFeedback.reservation.idempotency_key}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Quick Concurrency Stress Card for Selected Table */}
              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      Simulate Simultaneous Booking Race
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Fire {burstWorkers} parallel requests for {selectedTableObj?.name || 'Table'} at{' '}
                      {selectedTime}
                    </p>
                  </div>
                  <select
                    aria-label="Concurrent requests count"
                    value={burstWorkers}
                    onChange={(e) => setBurstWorkers(Number(e.target.value))}
                    className="px-2.5 py-1 text-xs font-mono border border-slate-300 rounded bg-white"
                  >
                    <option value={5}>5 parallel</option>
                    <option value={12}>12 parallel</option>
                    <option value={25}>25 parallel</option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={handleRunConcurrencyBurst}
                  disabled={isRunningBurst || !selectedTableId}
                  className="w-full py-2 px-4 bg-white border border-slate-300 hover:border-slate-900 text-slate-900 text-xs font-semibold rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-2"
                >
                  <Terminal className="w-3.5 h-3.5" />
                  {isRunningBurst
                    ? `Dispatching ${burstWorkers} Simultaneous Requests...`
                    : `Launch ${burstWorkers} Concurrent Requests on ${selectedTableObj?.name || 'Selected Table'}`}
                </button>

                {burstReport && (
                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-2 font-mono">
                    <div className="flex items-center justify-between font-sans font-semibold text-slate-900">
                      <span>Concurrency Race Outcome ({burstReport.elapsed_ms}ms)</span>
                      <span className="text-emerald-700">
                        Invariant: {burstReport.invariant_check.passed ? 'VERIFIED' : 'VIOLATED'}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 pt-1">
                      <div className="p-2 bg-white border border-slate-200 rounded">
                        <div className="text-[10px] text-slate-500 font-sans">Succeeded (201)</div>
                        <div className="text-sm font-bold text-emerald-700">
                          {burstReport.succeeded_count}
                        </div>
                      </div>
                      <div className="p-2 bg-white border border-slate-200 rounded">
                        <div className="text-[10px] text-slate-500 font-sans">Blocked (409)</div>
                        <div className="text-sm font-bold text-amber-700">
                          {burstReport.conflicts_prevented_count}
                        </div>
                      </div>
                      <div className="p-2 bg-white border border-slate-200 rounded">
                        <div className="text-[10px] text-slate-500 font-sans">Overlaps in DB</div>
                        <div className="text-sm font-bold text-slate-900">
                          {burstReport.invariant_check.overlappingPairsCount}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* SECTION 2: RESERVATION LEDGER & CANCELLATION MANAGEMENT */}
        {activeSection === 'reservations' && (
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Reservation History & Cancellation Ledger
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  All reservations stored in canonical UTC and displayed with venue & caller timezones
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {/* Search input */}
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={historySearchQuery}
                    onChange={(e) => setHistorySearchQuery(e.target.value)}
                    placeholder="Search guest, table, key..."
                    className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>

                {/* Segmented Filter Control */}
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  {(['ALL', 'CONFIRMED', 'CANCELLED'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setHistoryStatusFilter(st)}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                        historyStatusFilter === st
                          ? 'bg-white text-slate-900 shadow-xs font-semibold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {st === 'ALL' ? 'All Records' : st === 'CONFIRMED' ? 'Confirmed' : 'Cancelled'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filteredReservations.length === 0 ? (
              <div className="py-12 text-center space-y-3">
                <div className="text-sm font-semibold text-slate-700">
                  No reservations match the current filter
                </div>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  Create a new reservation from the Reservation Desk or run a concurrency burst test to populate the ledger.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveSection('booking')}
                  className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  Go to Reservation Desk
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500">
                      <th className="py-3 px-3">ID</th>
                      <th className="py-3 px-3">Guest</th>
                      <th className="py-3 px-3">Venue & Table</th>
                      <th className="py-3 px-3 text-right">Party</th>
                      <th className="py-3 px-3">Canonical UTC Window</th>
                      <th className="py-3 px-3">Venue Local Time</th>
                      <th className="py-3 px-3">Idempotency Key</th>
                      <th className="py-3 px-3">Status</th>
                      <th className="py-3 px-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredReservations.map((res) => (
                      <tr key={res.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-3 px-3 font-mono font-semibold text-slate-900">
                          #{res.id}
                        </td>
                        <td className="py-3 px-3">
                          <div className="font-semibold text-slate-900">{res.customer_name}</div>
                          <div className="text-slate-500">{res.customer_email}</div>
                        </td>
                        <td className="py-3 px-3">
                          <div className="font-medium text-slate-900">{res.restaurant_name}</div>
                          <div className="text-slate-500">
                            {res.table_name} ({res.table_capacity} seats)
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums">
                          {res.guests}
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-700 tabular-nums">
                          <div>{res.start_time_utc.replace('T', ' ').slice(0, 16)}Z</div>
                          <div className="text-slate-400">
                            → {res.end_time_utc.replace('T', ' ').slice(0, 16)}Z
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-700 tabular-nums">
                          <div>
                            {formatUtcTimestampInZone(
                              res.start_time_utc,
                              res.restaurant_timezone || 'America/New_York'
                            )}
                          </div>
                          <div className="text-slate-400">
                            Caller TZ: {res.client_timezone}
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-500 max-w-[160px] truncate" title={res.idempotency_key}>
                          {res.idempotency_key}
                        </td>
                        <td className="py-3 px-3 font-semibold">
                          {res.status === 'CONFIRMED' ? (
                            <span className="text-emerald-700">CONFIRMED</span>
                          ) : (
                            <span className="text-slate-400 line-through">CANCELLED</span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right">
                          {res.status === 'CONFIRMED' ? (
                            <button
                              type="button"
                              onClick={() => handleCancelReservation(res.id)}
                              className="px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 border border-rose-200 rounded transition-colors cursor-pointer whitespace-nowrap"
                            >
                              Cancel
                            </button>
                          ) : (
                            <span className="text-slate-400 font-mono">Released</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* SECTION 3: RELIABILITY CENTER (Automated Verification & Concurrency Stress Suite) */}
        {activeSection === 'reliability' && (
          <div className="space-y-6">
            <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-100 pb-4">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Reliability Center — Invariant & Concurrency Verification
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Execute real multi-request concurrency, idempotency, boundary overlap, and cross-timezone checks against the SQLite database
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleRunVerificationSuite}
                  disabled={isRunningVerification}
                  className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap flex items-center gap-2 self-start"
                >
                  <Play className="w-3.5 h-3.5" />
                  {isRunningVerification
                    ? 'Executing Verification Suite...'
                    : 'Run Full Verification Suite Now'}
                </button>
              </div>

              {/* Last Verification Status Summary */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="text-xs text-slate-500">Verification Status</div>
                  <div className="text-lg font-bold font-mono text-emerald-700 mt-1 flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5" />
                    {systemStatus?.metrics.verification_status || 'PASS'}
                  </div>
                  <div className="text-xs text-slate-600 mt-1">
                    {systemStatus?.metrics.last_verification_result}
                  </div>
                </div>

                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="text-xs text-slate-500">Database Overlap Audit</div>
                  <div className="text-lg font-bold font-mono text-slate-900 mt-1">
                    {systemStatus?.invariant_check.overlappingPairsCount ?? 0} Overlapping Pairs
                  </div>
                  <div className="text-xs text-slate-600 mt-1">
                    {systemStatus?.invariant_check.details}
                  </div>
                </div>

                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="text-xs text-slate-500">Concurrency Lock Architecture</div>
                  <div className="text-sm font-bold font-mono text-slate-900 mt-1">
                    SQLite WAL + BEGIN IMMEDIATE
                  </div>
                  <div className="text-xs text-slate-600 mt-1">
                    Half-open interval [start_utc, end_utc) check inside serialized write transaction
                  </div>
                </div>
              </div>

              {/* Detailed Verification Suite Report */}
              {verificationReport && (
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between text-xs text-slate-600 font-mono">
                    <span>
                      Suite Result: {verificationReport.passed_checks}/
                      {verificationReport.total_checks} Checks Passed
                    </span>
                    <span>Executed at: {verificationReport.executed_at_utc}</span>
                  </div>

                  <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden">
                    {verificationReport.checks.map((chk, idx) => (
                      <div
                        key={idx}
                        className="p-4 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                      >
                        <div className="space-y-1">
                          <div className="font-semibold text-slate-900 flex items-center gap-2">
                            {chk.passed ? (
                              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                            ) : (
                              <XCircle className="w-4 h-4 text-rose-700 shrink-0" />
                            )}
                            <span>{chk.name}</span>
                          </div>
                          <p className="text-slate-600 pl-6">{chk.assertion_detail}</p>
                        </div>
                        <div className="pl-6 sm:pl-0 flex items-center gap-3 font-mono text-slate-500 shrink-0">
                          <span>{chk.category}</span>
                          <span>·</span>
                          <span>{chk.duration_ms}ms</span>
                          <span>·</span>
                          <span
                            className={`font-bold ${
                              chk.passed ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                          >
                            {chk.passed ? 'PASS' : 'FAIL'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {/* SECTION 4: BAND DARK FACTORY (Multi-Agent Mandates & Stage 1 Task Prompt) */}
        {activeSection === 'factory' && (
          <div className="space-y-6">
            <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
              <div className="border-b border-slate-100 pb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    BAND Dark Factory — Autonomous 3-Agent Room Setup
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Room Name: <span className="font-mono font-semibold text-slate-800">TableGuard Dark Factory</span> · Agents: <span className="font-mono font-semibold text-slate-800">Architect · Builder · Verifier</span>
                  </p>
                </div>
                <div className="text-xs font-mono text-emerald-700 font-semibold">
                  Zero Domain Leakage in Mandates
                </div>
              </div>

              {/* Step-by-step BAND Room Checklist */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
                  <div className="text-xs font-bold text-slate-900">01. Registered BAND Agents</div>
                  <div className="text-xs text-slate-600 font-mono space-y-1">
                    <div>1. tanyagarg5315/architect</div>
                    <div>2. tanyagarg5315/builder</div>
                    <div>3. tanyagarg5315/verifier</div>
                  </div>
                </div>
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
                  <div className="text-xs font-bold text-slate-900">02. Create BAND Room</div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    In BAND → Rooms → Create Room, name it <code className="font-mono bg-white px-1 py-0.5 border border-slate-200 rounded">TableGuard Dark Factory</code> and add all 3 handles above.
                  </p>
                </div>
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
                  <div className="text-xs font-bold text-slate-900">03. Launch Stage 1 Task</div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Paste the Human Stage Task below into the Room task prompt and launch. Let <strong>Architect → Builder → Verifier</strong> run autonomously.
                  </p>
                </div>
              </div>

              {/* Copyable Human Stage Task */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900">
                    Room Human Stage Task (Paste in BAND Room Task Field)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const taskText = `Build and verify Stage 1 of the assigned software service.\n\nThe central reliability invariant is:\n\nA resource must never be successfully allocated twice for overlapping reservations, including under concurrent requests and safe retries.\n\nThe service must support:\n\n* availability checking\n* creating reservations\n* cancellation\n* overlapping reservation prevention\n* concurrent requests\n* retry/idempotency behavior\n* relevant time-zone handling\n* invalid input handling\n\nWorkflow:\n\nARCHITECT:\nAnalyze the complete task, identify requirements, risks, edge cases and acceptance criteria. Create a clear implementation handoff.\n\nBUILDER:\nImplement the service according to the handoff. Run relevant tests and provide reproducible evidence.\n\nVERIFIER:\nIndependently attack the implementation. Focus especially on concurrency, duplicate requests, overlapping allocations, invalid input and time-zone edge cases.\n\nIf the Verifier finds a defect:\n\n1. Builder must reproduce it.\n2. Builder must fix it.\n3. Verifier must independently re-test the fix.\n\nDo not ask the human for clarification.\nDo not wait for human approval.\nDo not claim success without evidence.\n\nThe task is complete only when the Verifier has sufficient evidence to accept the implementation.`;
                      navigator.clipboard.writeText(taskText);
                      setCopiedBlock('stage-task');
                      setTimeout(() => setCopiedBlock(null), 1500);
                    }}
                    className="px-3 py-1 text-xs font-semibold text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded transition-colors cursor-pointer flex items-center gap-1.5"
                  >
                    {copiedBlock === 'stage-task' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-700" />
                        <span>Copied Task</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Stage Task</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="p-4 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed whitespace-pre-wrap">
{`Build and verify Stage 1 of the assigned software service.

The central reliability invariant is:

A resource must never be successfully allocated twice for overlapping reservations, including under concurrent requests and safe retries.

The service must support:

* availability checking
* creating reservations
* cancellation
* overlapping reservation prevention
* concurrent requests
* retry/idempotency behavior
* relevant time-zone handling
* invalid input handling

Workflow:

ARCHITECT:
Analyze the complete task, identify requirements, risks, edge cases and acceptance criteria. Create a clear implementation handoff.

BUILDER:
Implement the service according to the handoff. Run relevant tests and provide reproducible evidence.

VERIFIER:
Independently attack the implementation. Focus especially on concurrency, duplicate requests, overlapping allocations, invalid input and time-zone edge cases.

If the Verifier finds a defect:

1. Builder must reproduce it.
2. Builder must fix it.
3. Verifier must independently re-test the fix.

Do not ask the human for clarification.
Do not wait for human approval.
Do not claim success without evidence.

The task is complete only when the Verifier has sufficient evidence to accept the implementation.`}
                </pre>
              </div>

              {/* 3 Domain-Agnostic Mandates */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pt-2">
                {/* Architect Mandate */}
                <div className="border border-slate-200 rounded-lg p-4 space-y-2 bg-slate-50/50 flex flex-col justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-900">1. architect.md (Generic)</span>
                      <button
                        type="button"
                        onClick={() => {
                          const text = `You are the Architect in an autonomous multi-agent software engineering factory. Analyze incoming system specifications, formalize core invariants, identify concurrency and edge-case failure modes, and produce a deterministic implementation handoff for the Builder and testable acceptance criteria for the Verifier. Never ask the human for clarification.`;
                          navigator.clipboard.writeText(text);
                          setCopiedBlock('architect');
                          setTimeout(() => setCopiedBlock(null), 1500);
                        }}
                        className="text-xs font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
                      >
                        {copiedBlock === 'architect' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Saved in <code className="font-mono">/mandates/architect.md</code>. Strictly generic factory instructions with zero mention of TableGuard, restaurants, or tables.
                    </p>
                  </div>
                </div>

                {/* Builder Mandate */}
                <div className="border border-slate-200 rounded-lg p-4 space-y-2 bg-slate-50/50 flex flex-col justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-900">2. builder.md (Generic)</span>
                      <button
                        type="button"
                        onClick={() => {
                          const text = `You are the Builder in an autonomous multi-agent software engineering factory. Implement, test, and repair the target software service strictly according to the Architect's handoff and the Verifier's defect reports. Run automated tests and provide reproducible evidence before handing off to Verifier.`;
                          navigator.clipboard.writeText(text);
                          setCopiedBlock('builder');
                          setTimeout(() => setCopiedBlock(null), 1500);
                        }}
                        className="text-xs font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
                      >
                        {copiedBlock === 'builder' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Saved in <code className="font-mono">/mandates/builder.md</code>. Enforces evidence-backed delivery and autonomous defect reproduction & repair loops.
                    </p>
                  </div>
                </div>

                {/* Verifier Mandate */}
                <div className="border border-slate-200 rounded-lg p-4 space-y-2 bg-slate-50/50 flex flex-col justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-900">3. verifier.md (Generic)</span>
                      <button
                        type="button"
                        onClick={() => {
                          const text = `You are the Verifier in an autonomous multi-agent software engineering factory. Independently attack, stress-test, and audit the Builder's implementation against the system invariants (concurrency races, boundary math, idempotent retries, temporal/timezone edge cases, and invalid inputs) before granting final acceptance.`;
                          navigator.clipboard.writeText(text);
                          setCopiedBlock('verifier');
                          setTimeout(() => setCopiedBlock(null), 1500);
                        }}
                        className="text-xs font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
                      >
                        {copiedBlock === 'verifier' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Saved in <code className="font-mono">/mandates/verifier.md</code>. Enforces adversarial stress testing and independent re-verification after fixes.
                    </p>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}
      </main>

      {/* Clean Quiet Footer */}
      <footer className="mt-auto border-t border-slate-200 bg-white px-6 py-4">
        <div className="max-w-[1400px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <div>
            TableGuard — Autonomous Dark Factory for Reliable Reservations
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setActiveSection('booking')}
              className="hover:text-slate-900 cursor-pointer"
            >
              Reservation Desk
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('reservations')}
              className="hover:text-slate-900 cursor-pointer"
            >
              Reservation Ledger
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('reliability')}
              className="hover:text-slate-900 cursor-pointer"
            >
              Reliability Center
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
