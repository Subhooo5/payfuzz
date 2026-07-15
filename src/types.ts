/**
 * Shared internal types for the payfuzz pipeline.
 *
 * The stages are: LOAD (loader) → BUILD (factory) → PLAN (faults) →
 * SIGN (signer) → DELIVER (deliverer) → SETTLE + ORACLE (runner/oracle).
 */

// ─── Faults (normalized from scenario YAML by schema.ts) ────────────────────

/** One adversarial delivery primitive, already parsed from its YAML form. */
export type Fault =
  | { kind: "duplicate"; count: number } // n sequential copies of one event
  | { kind: "concurrent"; count: number } // n copies fired via Promise.all
  | { kind: "delay"; ms: number } // hold this delivery before dispatching
  | { kind: "timeout_retry"; ms: number } // abort after ms, resend once
  | { kind: "sign_with"; secret: string } // "none" omits header; else a wrong secret
  | { kind: "timestamp_offset"; seconds: number }; // shift signature t (and created)

// ─── Scenario (output of the loader) ────────────────────────────────────────

/** Seed state for POST /__payfuzz/reset. Mirrors the victims' ResetRequest. */
export interface ScenarioSetup {
  wallet_balance?: number;
  email_delay_ms?: number;
  email_fail?: boolean;
}

/** One entry in a scenario's `deliveries` list. */
export interface DeliverySpec {
  event: string;
  fixture: string;
  overrides?: Record<string, unknown>;
  faults: Fault[];
}

/** A single assertion value as written in YAML (interpreted by the oracle). */
export type AssertValue = number | string;

/** A fully-loaded, validated scenario. */
export interface Scenario {
  name: string;
  description: string;
  setup: ScenarioSetup;
  deliveries: DeliverySpec[];
  assert: Record<string, AssertValue>;
}

/** The `_globals.yaml` invariants applied after every scenario. */
export interface Globals {
  global_invariants: Record<string, AssertValue>;
}

// ─── Delivery plan (output of the fault engine) ─────────────────────────────

/** A single POST to /webhook — the exact bytes and signature to send. */
export interface Dispatch {
  eventId: string;
  eventType: string;
  /** Signature timestamp, equal to the event's `created`. */
  t: number;
  /** The exact body bytes: signed once, POSTed unchanged. */
  rawBody: Buffer;
  /** Stripe-Signature header, or null to omit it entirely. */
  signatureHeader: string | null;
  /** When enabled, abort after timeoutMs and resend once. */
  timeoutRetry: { enabled: boolean; timeoutMs: number };
}

/** A set of dispatches fired together (one delivery, possibly multiplied). */
export interface DispatchGroup {
  label: string;
  mode: "sequential" | "concurrent";
  /** Milliseconds to wait before dispatching this group. */
  delayMs: number;
  dispatches: Dispatch[];
}

export type DeliveryPlan = DispatchGroup[];

// ─── Delivery traces (output of the deliverer) ──────────────────────────────

/** The outcome of one POST attempt. */
export interface Trace {
  groupLabel: string;
  eventId: string;
  eventType: string;
  /** 1 for the original, 2 for a timeout resend. */
  attempt: number;
  t: number;
  /** Wall-clock time the request was sent; the report renders offsets relative to the earliest. */
  sentAt: number;
  /** HTTP status, or "timeout"/"error" when no status was received. */
  status: number | "timeout" | "error";
  latencyMs: number;
  responseBody: string;
}

// ─── Oracle output ──────────────────────────────────────────────────────────

/** The money state payfuzz expects back from GET /__payfuzz/state. */
export interface PayfuzzState {
  wallet_balance: number;
  ledger_entries: number;
  ledger_sum: number;
  emails_sent: number;
  events_processed: number;
  unique_event_ids: number;
  sub_status: string | null;
  sub_id: string | null;
}

/** The evaluated result of one assertion, ready for the console/report. */
export interface AssertionResult {
  source: "assert" | "global";
  field: string;
  wantDisplay: string;
  gotDisplay: string;
  pass: boolean;
  /** Numeric want/got when both sides are numbers (used by the Phase 5 phantom accumulator). */
  wantValue?: number;
  gotValue?: number;
}

/** Everything one scenario produced. */
export interface ScenarioResult {
  name: string;
  description: string;
  passed: boolean;
  assertions: AssertionResult[];
  traces: Trace[];
  finalState: PayfuzzState;
}

/** Options threaded through the runner. */
export interface RunOptions {
  target: string;
  secret: string;
  fixturesDir: string;
}
