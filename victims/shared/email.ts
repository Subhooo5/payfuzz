/**
 * Simulated email transport, shared verbatim by both victims.
 *
 * The delay/fail knobs are seeded through POST /__payfuzz/reset and model a
 * real SMTP provider being slow or down — dependency injection of a fake
 * transport, exactly like a mock in a unit test. Webhook handler code never
 * reads the knobs; it just calls send() and experiences whatever latency or
 * failure the transport produces. Both victims run this identical transport,
 * so a handler only survives the knobs by keeping email off the webhook's
 * critical path — not by having a better email client.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface EmailTransportOptions {
  delayMs?: number;
  fail?: boolean;
}

export class EmailTransport {
  private delayMs = 0;
  private shouldFail = false;
  private delivered = 0;
  /**
   * Bumped on every configure(). In-flight sends from before a reset resolve
   * as no-ops so one scenario's stragglers cannot pollute the next scenario's
   * counter — fixture teardown semantics, not app behaviour.
   */
  private epoch = 0;

  /** Reconfigures the transport and zeroes the delivered counter. */
  configure({ delayMs = 0, fail = false }: EmailTransportOptions = {}): void {
    this.delayMs = delayMs;
    this.shouldFail = fail;
    this.delivered = 0;
    this.epoch += 1;
  }

  /** Emails actually delivered since the last configure(). */
  get sentCount(): number {
    return this.delivered;
  }

  /** Sends one email: waits out the transport latency, then delivers or fails. */
  async send(to: string, subject: string): Promise<void> {
    const epochAtSend = this.epoch;
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (epochAtSend !== this.epoch) return; // transport was reset mid-send; drop silently
    if (this.shouldFail) {
      throw new Error(`email transport failed sending "${subject}" to ${to} (simulated SMTP outage)`);
    }
    this.delivered += 1;
  }
}
