/**
 * Turns fixture JSON + scenario overrides into concrete Stripe events.
 *
 * Identity is assigned here, before the fault engine runs: each entry in a
 * scenario's `deliveries` list gets one deterministic evt_id and a `created`
 * timestamp derived from its list position. Duplicates and concurrent copies
 * reuse the already-built event, so they share that id and timestamp — a
 * provider redelivering one event, not two different events.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliverySpec, Fault, Scenario } from "./types.js";

/** A concrete event plus the faults that will shape its delivery. */
export interface BuiltDelivery {
  event: Record<string, any>;
  faults: Fault[];
  index: number;
}

const fixtureCache = new Map<string, Record<string, any>>();

function readFixture(fixturesDir: string, name: string): Record<string, any> {
  const path = join(fixturesDir, name);
  let base = fixtureCache.get(path);
  if (!base) {
    base = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    fixtureCache.set(path, base);
  }
  // Clone so per-delivery mutation never touches the cached fixture.
  return structuredClone(base);
}

/** Stripe-shaped, stable-per-(scenario, index) event id. */
function deterministicEventId(scenarioName: string, index: number): string {
  const token = createHash("sha256").update(`${scenarioName}:${index}`).digest("hex").slice(0, 24);
  return `evt_${token}`;
}

/** Sets a dot-path (e.g. "data.object.amount") on a nested object. */
function setDotPath(target: Record<string, any>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cursor = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]!] = value;
}

/**
 * Builds every delivery's concrete event. Defaults (type, id, created) are
 * applied first so any matching override — including `data.object.id` and
 * `created` — takes precedence.
 */
export function buildDeliveries(scenario: Scenario, fixturesDir: string): BuiltDelivery[] {
  const baseNow = Math.floor(Date.now() / 1000);

  return scenario.deliveries.map((spec: DeliverySpec, index): BuiltDelivery => {
    const event = readFixture(fixturesDir, spec.fixture);

    event.type = spec.event;
    event.id = deterministicEventId(scenario.name, index);
    event.created = baseNow + index; // list order = logical/causal order

    for (const [path, value] of Object.entries(spec.overrides ?? {})) {
      setDotPath(event, path, value);
    }

    return { event, faults: spec.faults, index };
  });
}
