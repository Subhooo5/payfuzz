/**
 * The oracle: diffs the victim's final money state against a scenario's
 * `assert` block and the global invariants.
 *
 * The assertion grammar is deliberately tiny — four forms, no expression
 * parser:
 *   - a bare number or string        → equality
 *   - "OP literal" (== >= <= > < !=)  → compare the field to a constant
 *   - "== <state_key>"               → compare two live state fields
 *   - "<= 1 per unique event"        → emails_sent <= unique_event_ids
 */
import type { AssertionResult, AssertValue, Globals, PayfuzzState, Trace } from "./types.js";

type Comparator = "==" | "!=" | ">=" | "<=" | ">" | "<";

const STATE_KEYS = new Set<keyof PayfuzzState>([
  "wallet_balance",
  "ledger_entries",
  "ledger_sum",
  "emails_sent",
  "events_processed",
  "unique_event_ids",
  "sub_status",
  "sub_id",
]);

interface Predicate {
  op: Comparator;
  /** A constant, or the name of another state field to read at evaluation time. */
  rhs: { literal: number | string } | { stateRef: keyof PayfuzzState };
  display: string;
}

function parsePredicate(spec: AssertValue): Predicate {
  if (typeof spec === "number") {
    return { op: "==", rhs: { literal: spec }, display: String(spec) };
  }

  if (spec === "<= 1 per unique event") {
    return { op: "<=", rhs: { stateRef: "unique_event_ids" }, display: spec };
  }

  const match = /^(==|!=|>=|<=|>|<)\s+(.+)$/.exec(spec);
  if (match) {
    const op = match[1] as Comparator;
    const rhsToken = match[2]!.trim();
    if (STATE_KEYS.has(rhsToken as keyof PayfuzzState)) {
      return { op, rhs: { stateRef: rhsToken as keyof PayfuzzState }, display: spec };
    }
    if (/^-?\d+$/.test(rhsToken)) {
      return { op, rhs: { literal: Number(rhsToken) }, display: spec };
    }
    return { op, rhs: { literal: rhsToken }, display: spec };
  }

  // Bare string → equality (e.g. sub_status: canceled).
  return { op: "==", rhs: { literal: spec }, display: spec };
}

/** The last attempt's status, which is what http_status assertions read. */
function httpStatusOf(traces: Trace[]): number | string {
  const last = traces[traces.length - 1];
  return last ? last.status : "no-delivery";
}

function resolveField(field: string, state: PayfuzzState, traces: Trace[]): number | string | null {
  if (field === "http_status") return httpStatusOf(traces);
  if (STATE_KEYS.has(field as keyof PayfuzzState)) {
    return state[field as keyof PayfuzzState];
  }
  return null; // unknown field → surfaces as a failed assertion
}

function compare(op: Comparator, got: number | string | null, want: number | string): boolean {
  if (got === null) return false;
  switch (op) {
    case "==":
      return got === want;
    case "!=":
      return got !== want;
    default:
      break;
  }
  if (typeof got !== "number" || typeof want !== "number") return false;
  switch (op) {
    case ">=":
      return got >= want;
    case "<=":
      return got <= want;
    case ">":
      return got > want;
    case "<":
      return got < want;
  }
}

function evaluateOne(
  source: "assert" | "global",
  field: string,
  spec: AssertValue,
  state: PayfuzzState,
  traces: Trace[],
): AssertionResult {
  const predicate = parsePredicate(spec);
  const got = resolveField(field, state, traces);
  const want = "literal" in predicate.rhs ? predicate.rhs.literal : state[predicate.rhs.stateRef];

  const pass = compare(predicate.op, got, want as number | string);
  const result: AssertionResult = {
    source,
    field,
    wantDisplay: predicate.display,
    gotDisplay: got === null ? "(unknown field)" : String(got),
    pass,
  };
  if (typeof want === "number") result.wantValue = want;
  if (typeof got === "number") result.gotValue = got;
  return result;
}

/** Evaluates every scenario assertion followed by every global invariant. */
export function evaluate(
  state: PayfuzzState,
  traces: Trace[],
  assertions: Record<string, AssertValue>,
  globals: Globals,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  for (const [field, spec] of Object.entries(assertions)) {
    results.push(evaluateOne("assert", field, spec, state, traces));
  }
  for (const [field, spec] of Object.entries(globals.global_invariants)) {
    results.push(evaluateOne("global", field, spec, state, traces));
  }
  return results;
}
