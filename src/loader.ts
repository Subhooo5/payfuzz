/**
 * Reads scenario and _globals YAML files, validates them, and enforces the
 * load-time invariants that keep results deterministic.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { globalsSchema, scenarioSchema } from "./schema.js";
import type { Globals, Scenario } from "./types.js";

/** True if the delivery multiplies into more than one dispatch. */
function multipliesDeliveries(scenario: Scenario): boolean {
  if (scenario.deliveries.length > 1) return true;
  return scenario.deliveries.some((d) =>
    d.faults.some((f) => f.kind === "duplicate" || f.kind === "concurrent"),
  );
}

/** Loads and validates one scenario file. */
export function loadScenario(path: string): Scenario {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to read scenario ${basename(path)}: ${(err as Error).message}`);
  }

  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid scenario ${basename(path)}:\n${formatIssues(parsed.error)}`);
  }
  const scenario = parsed.data as Scenario;

  // http_status is only meaningful when a single request is delivered; on a
  // multi-delivery scenario "the status" is ambiguous, so refuse it loudly.
  if ("http_status" in scenario.assert && multipliesDeliveries(scenario)) {
    throw new Error(
      `invalid scenario ${basename(path)}: http_status cannot be asserted on a ` +
        `multi-delivery scenario — its value would be nondeterministic`,
    );
  }

  return scenario;
}

/** Loads and validates the _globals.yaml invariants. */
export function loadGlobals(path: string): Globals {
  const parsed = globalsSchema.safeParse(parseYaml(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`invalid ${basename(path)}:\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `  · ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}
