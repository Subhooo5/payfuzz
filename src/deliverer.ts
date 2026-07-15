/**
 * Delivers a plan to a target's /webhook and records what happened.
 *
 * Groups run in order; within a group, sequential dispatches are awaited one
 * at a time (so a naive seen-check can dedup them) while concurrent dispatches
 * race via Promise.all. A dispatch with timeout_retry aborts after its window
 * and resends exactly once — note that aborting the client request does not
 * stop the victim's handler, which is precisely why the retried work runs
 * twice.
 */
import { request } from "undici";
import type { Dispatch, DispatchGroup, DeliveryPlan, PayfuzzState, ScenarioSetup, Trace } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function dispatchOnce(target: string, dispatch: Dispatch, groupLabel: string, attempt: number): Promise<Trace> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dispatch.timeoutRetry.timeoutMs);
  const start = performance.now();

  const base = { groupLabel, eventId: dispatch.eventId, eventType: dispatch.eventType, attempt, t: dispatch.t, sentAt: Date.now() };
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (dispatch.signatureHeader) headers["stripe-signature"] = dispatch.signatureHeader;

    const res = await request(`${target}/webhook`, {
      method: "POST",
      headers,
      body: dispatch.rawBody,
      signal: controller.signal,
    });
    const responseBody = await res.body.text();
    return { ...base, status: res.statusCode, latencyMs: Math.round(performance.now() - start), responseBody };
  } catch (err) {
    const status = controller.signal.aborted ? "timeout" : "error";
    const responseBody = controller.signal.aborted ? "" : String((err as Error).message ?? err);
    return { ...base, status, latencyMs: Math.round(performance.now() - start), responseBody };
  } finally {
    clearTimeout(timer);
  }
}

/** One dispatch and, if it timed out with retry enabled, a single resend. */
async function dispatchWithRetry(target: string, dispatch: Dispatch, groupLabel: string): Promise<Trace[]> {
  const first = await dispatchOnce(target, dispatch, groupLabel, 1);
  if (first.status === "timeout" && dispatch.timeoutRetry.enabled) {
    return [first, await dispatchOnce(target, dispatch, groupLabel, 2)];
  }
  return [first];
}

async function deliverGroup(target: string, group: DispatchGroup): Promise<Trace[]> {
  if (group.delayMs > 0) await sleep(group.delayMs);

  if (group.mode === "concurrent") {
    const batches = await Promise.all(group.dispatches.map((d) => dispatchWithRetry(target, d, group.label)));
    return batches.flat();
  }

  const traces: Trace[] = [];
  for (const dispatch of group.dispatches) {
    traces.push(...(await dispatchWithRetry(target, dispatch, group.label)));
  }
  return traces;
}

/** Delivers every group in order and returns the flat list of attempt traces. */
export async function deliver(target: string, plan: DeliveryPlan): Promise<Trace[]> {
  const traces: Trace[] = [];
  for (const group of plan) {
    traces.push(...(await deliverGroup(target, group)));
  }
  return traces;
}

// ─── payfuzz control-plane helpers ──────────────────────────────────────────

/** POST /__payfuzz/reset with the scenario's seed state. */
export async function resetVictim(target: string, setup: ScenarioSetup): Promise<void> {
  const res = await request(`${target}/__payfuzz/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(setup),
  });
  await res.body.text();
  if (res.statusCode >= 300) {
    throw new Error(`reset failed with status ${res.statusCode}`);
  }
}

/** GET /__payfuzz/state. */
export async function fetchState(target: string): Promise<PayfuzzState> {
  const res = await request(`${target}/__payfuzz/state`, { method: "GET" });
  if (res.statusCode >= 300) {
    await res.body.text(); // drain so the socket is released before throwing
    throw new Error(`GET /__payfuzz/state failed with status ${res.statusCode}`);
  }
  return (await res.body.json()) as PayfuzzState;
}
