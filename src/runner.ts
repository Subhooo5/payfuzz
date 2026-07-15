/**
 * Orchestrates one scenario end to end:
 * RESET → BUILD → PLAN(+SIGN) → DELIVER → SETTLE → ORACLE.
 */
import { deliver, fetchState, resetVictim } from "./deliverer.js";
import { buildDeliveries } from "./factory.js";
import { buildPlan } from "./faults.js";
import { evaluate } from "./oracle.js";
import type { Globals, PayfuzzState, RunOptions, Scenario, ScenarioResult, Trace } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SETTLE_POLL_MS = 150;
const SETTLE_STABLE_READS = 3;

/**
 * Fast-path cap: with no timeout, every handler finished before DELIVER
 * returned, so the state is already final and we only confirm it holds steady.
 */
const SETTLE_CAP_MS = 3_000;

/**
 * Timeout-path cap. A client abort does not stop the victim's handler, so a
 * timed-out delivery leaves work in flight: e.g. a 6s email that outlives the
 * 5s timeout, then a resend that sleeps another 6s, landing the final effect
 * ~11s after delivery started. Crucially there is a multi-second lull between
 * the first effect and the last during which the state looks stable but is
 * not final — so on this path we must NOT exit on a stable read. We poll to a
 * cap that comfortably clears worst-case trailing work and return the final
 * read. 15s leaves generous margin over the ~11s worst case.
 */
const SETTLE_TIMEOUT_CAP_MS = 15_000;

/**
 * Margin added to a scenario's declared email delay so an async email worker
 * (the hardened victim acks first, then sends) is sure to have landed.
 */
const SETTLE_ASYNC_EMAIL_MARGIN_MS = 3_000;

/**
 * Waits for the victim to quiesce, then returns its final state.
 *
 * Three budgets, in priority order:
 *  - a delivery timed out → poll to 15s, no early exit (client abort left work
 *    running; a stable read here can be a lull between effects, not completion);
 *  - else the scenario injected an email delay → an async handler (ack first,
 *    send later) may still be sending, so poll past that delay, no early exit;
 *  - else → exit as soon as the state holds steady across a few reads.
 *
 * The email delay comes from the scenario's own setup, not from the victim, so
 * this never asks the app under test to report its progress.
 */
async function settle(target: string, traces: Trace[], emailDelayMs: number): Promise<PayfuzzState> {
  const hadTimeout = traces.some((t) => t.status === "timeout");
  const asyncEmail = !hadTimeout && emailDelayMs > 0;

  let capMs = SETTLE_CAP_MS;
  if (hadTimeout) capMs = SETTLE_TIMEOUT_CAP_MS;
  else if (asyncEmail) capMs = emailDelayMs + SETTLE_ASYNC_EMAIL_MARGIN_MS;
  const allowEarlyExit = !hadTimeout && !asyncEmail;

  const deadline = Date.now() + capMs;
  let last = await fetchState(target);
  let previous = JSON.stringify(last);
  let stableReads = 1;

  while (Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS);
    last = await fetchState(target);
    const current = JSON.stringify(last);

    if (allowEarlyExit) {
      stableReads = current === previous ? stableReads + 1 : 1;
      if (stableReads >= SETTLE_STABLE_READS) break;
    }
    previous = current;
  }

  return last;
}

/** Runs a single scenario and returns its result. */
export async function runScenario(scenario: Scenario, globals: Globals, options: RunOptions): Promise<ScenarioResult> {
  const { target, secret, fixturesDir } = options;

  await resetVictim(target, scenario.setup);

  const deliveries = buildDeliveries(scenario, fixturesDir);
  const plan = buildPlan(deliveries, secret);

  const traces = await deliver(target, plan);
  const finalState = await settle(target, traces, scenario.setup.email_delay_ms ?? 0);
  const assertions = evaluate(finalState, traces, scenario.assert, globals);

  return {
    name: scenario.name,
    description: scenario.description,
    passed: assertions.every((a) => a.pass),
    assertions,
    traces,
    finalState,
  };
}
