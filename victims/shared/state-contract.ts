/**
 * The payfuzz observability contract, shared verbatim by both victims.
 *
 * Any app is testable by payfuzz if it exposes:
 *   POST /webhook          — the endpoint under test
 *   GET  /__payfuzz/state  — returns {@link PayfuzzState}
 *   POST /__payfuzz/reset  — wipes state, seeds from {@link ResetRequest}
 */

/** Money state reported by GET /__payfuzz/state. All amounts are integer paise. */
export interface PayfuzzState {
  /** Current wallet balance in paise. */
  wallet_balance: number;
  /** Number of ledger rows written. */
  ledger_entries: number;
  /** Signed sum of all ledger amounts in paise (credits positive, debits negative). */
  ledger_sum: number;
  /** Emails the simulated transport actually delivered. */
  emails_sent: number;
  /** Rows in the processed-events table (double-inserts count twice). */
  events_processed: number;
  /** Distinct event ids in the processed-events table. */
  unique_event_ids: number;
  /** Status of the tracked subscription, or null if none seen yet. */
  sub_status: string | null;
  /** Id of the tracked subscription, or null if none seen yet. */
  sub_id: string | null;
}

/**
 * Seed state accepted by POST /__payfuzz/reset.
 *
 * The email knobs configure the FAKE SMTP TRANSPORT only — dependency
 * injection of a slow or failing provider, exactly like a mock in a unit
 * test. Webhook handler code never reads them. Both victims expose the
 * identical knobs; the hardened app must pass under the same settings.
 */
export interface ResetRequest {
  /** Opening wallet balance in paise. Default 0. */
  wallet_balance?: number;
  /** Latency of the simulated email transport in ms. Default 0. */
  email_delay_ms?: number;
  /** When true the simulated email transport hard-fails every send. Default false. */
  email_fail?: boolean;
}
