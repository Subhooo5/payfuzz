/**
 * The fault engine: expands built deliveries into an ordered delivery plan.
 *
 * Each delivery becomes one dispatch group. Multiplicity faults set how many
 * copies fire and whether they race (duplicate = sequential, concurrent =
 * Promise.all); timing faults set the group's delay and retry behaviour;
 * signing faults are folded into the signature here, over the exact bytes
 * that will be POSTed.
 */
import type { BuiltDelivery } from "./factory.js";
import { signDispatch } from "./signer.js";
import type { DeliveryPlan, Dispatch, DispatchGroup, Fault } from "./types.js";

/**
 * Safety timeout for deliveries without a `timeout_retry` fault. Real
 * providers retry on any timeout; payfuzz models that as an explicit fault so
 * scenarios stay deterministic, and this bound only exists so a hung victim
 * cannot hang the run — it aborts and records, but never resends.
 */
const SAFETY_TIMEOUT_MS = 10_000;

function find<K extends Fault["kind"]>(faults: Fault[], kind: K): Extract<Fault, { kind: K }> | undefined {
  return faults.find((f) => f.kind === kind) as Extract<Fault, { kind: K }> | undefined;
}

function buildGroup(delivery: BuiltDelivery, realSecret: string): DispatchGroup {
  const { event, faults } = delivery;

  const duplicate = find(faults, "duplicate");
  const concurrent = find(faults, "concurrent");
  if (duplicate && concurrent) {
    throw new Error(`delivery ${event.type} cannot be both duplicate and concurrent`);
  }

  // Apply the timestamp offset to `created` before serializing, so the signed
  // body and its signature timestamp stay coherent. Then freeze the bytes.
  const offset = find(faults, "timestamp_offset");
  if (offset) event.created += offset.seconds;
  const t: number = event.created;
  const rawBody = Buffer.from(JSON.stringify(event), "utf8");

  // INVARIANT (protects scenario 06 — replay): the Stripe-Signature `t` MUST
  // equal the `created` inside the exact bytes we sign and POST. Stripe's
  // tolerance window and the naive verify both recompute the HMAC over
  // `${t}.${body}`; if a future edit ever sourced `t` from anything but the
  // serialized `created` (e.g. baseNow), replay would break with no test
  // catching it. Assert against the serialized bytes so the guard survives
  // any such refactor.
  const bodyCreated = (JSON.parse(rawBody.toString("utf8")) as { created: number }).created;
  if (t !== bodyCreated) {
    throw new Error(`signer invariant violated: header t=${t} != body.created=${bodyCreated}`);
  }

  const signWith = find(faults, "sign_with");
  const timeoutRetry = find(faults, "timeout_retry");

  const dispatch: Dispatch = signDispatch(
    {
      eventId: event.id,
      eventType: event.type,
      t,
      rawBody,
      timeoutRetry: {
        enabled: timeoutRetry !== undefined,
        timeoutMs: timeoutRetry?.ms ?? SAFETY_TIMEOUT_MS,
      },
    },
    { signWith: signWith?.secret },
    realSecret,
  );

  const count = duplicate?.count ?? concurrent?.count ?? 1;
  const mode = concurrent ? "concurrent" : "sequential";
  const delayMs = find(faults, "delay")?.ms ?? 0;

  const suffix = count > 1 ? ` ×${count} (${mode})` : "";
  return {
    label: `${event.type}${suffix}`,
    mode,
    delayMs,
    // Each copy is an independent dispatch with its OWN body Buffer, so N
    // concurrent requests never stream from one shared buffer. Id, t, body
    // content and signature stay identical across copies — that is the whole
    // point of duplicate/concurrent; only the Buffer instance differs.
    dispatches: Array.from({ length: count }, () => ({ ...dispatch, rawBody: Buffer.from(dispatch.rawBody) })),
  };
}

/** Expands built deliveries into a signed delivery plan. */
export function buildPlan(deliveries: BuiltDelivery[], realSecret: string): DeliveryPlan {
  return deliveries.map((d) => buildGroup(d, realSecret));
}
