/**
 * zod schemas for scenario YAML and _globals.yaml.
 *
 * Faults are normalized here from their terse YAML form — a single-key
 * mapping like `{ delay: "2000ms" }` — into the typed {@link Fault} union,
 * and unknown fault names are rejected at load time rather than ignored.
 */
import { z } from "zod";
import type { Fault } from "./types.js";

/** Parses a millisecond duration: `"2000ms"`, `"2s"`, or a bare number of ms. */
function parseMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const ms = /^(\d+)\s*ms$/.exec(value);
    if (ms) return Number(ms[1]);
    const s = /^(\d+)\s*s$/.exec(value);
    if (s) return Number(s[1]) * 1000;
    if (/^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/** Parses a seconds offset for signature timestamps: `"-25h"`, `"-90000s"`, or a bare number. */
function parseSeconds(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const h = /^(-?\d+)\s*h$/.exec(value);
    if (h) return Number(h[1]) * 3600;
    const s = /^(-?\d+)\s*s$/.exec(value);
    if (s) return Number(s[1]);
    if (/^-?\d+$/.test(value)) return Number(value);
  }
  return null;
}

function requirePositiveInt(value: unknown, ctx: z.RefinementCtx, fault: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) {
    ctx.addIssue({ code: "custom", message: `${fault} requires a positive integer, got ${JSON.stringify(value)}` });
    return z.NEVER as never;
  }
  return n;
}

function requireMs(value: unknown, ctx: z.RefinementCtx, fault: string): number {
  const ms = parseMs(value);
  if (ms === null) {
    ctx.addIssue({ code: "custom", message: `${fault} requires a duration like "2000ms", got ${JSON.stringify(value)}` });
    return z.NEVER as never;
  }
  return ms;
}

/**
 * Accepts a fault as a single-key mapping (`{ delay: "2000ms" }`) and
 * normalizes it to a Fault. All five faults carry a value, so there is no
 * bare-string form.
 */
const faultSchema: z.ZodType<Fault> = z
  .record(z.string(), z.unknown())
  .transform((raw, ctx): Fault => {
    const keys = Object.keys(raw);
    if (keys.length !== 1) {
      ctx.addIssue({ code: "custom", message: `each fault must have exactly one key, got ${JSON.stringify(raw)}` });
      return z.NEVER as never;
    }
    const name = keys[0]!;
    const value = raw[name];

    switch (name) {
      case "duplicate":
        return { kind: "duplicate", count: requirePositiveInt(value, ctx, "duplicate") };
      case "concurrent":
        return { kind: "concurrent", count: requirePositiveInt(value, ctx, "concurrent") };
      case "delay":
        return { kind: "delay", ms: requireMs(value, ctx, "delay") };
      case "timeout_retry":
        return { kind: "timeout_retry", ms: requireMs(value, ctx, "timeout_retry") };
      case "sign_with":
        return { kind: "sign_with", secret: String(value) };
      case "timestamp_offset": {
        const seconds = parseSeconds(value);
        if (seconds === null) {
          ctx.addIssue({ code: "custom", message: `timestamp_offset requires seconds like "-25h", got ${JSON.stringify(value)}` });
          return z.NEVER as never;
        }
        return { kind: "timestamp_offset", seconds };
      }
      default:
        ctx.addIssue({ code: "custom", message: `unknown fault "${name}"` });
        return z.NEVER as never;
    }
  });

const setupSchema = z
  .object({
    wallet_balance: z.number().int().optional(),
    email_delay_ms: z.number().int().nonnegative().optional(),
    email_fail: z.boolean().optional(),
  })
  .strict();

const deliverySchema = z
  .object({
    event: z.string(),
    fixture: z.string(),
    overrides: z.record(z.string(), z.unknown()).optional(),
    faults: z.array(faultSchema).default([]),
  })
  .strict();

export const scenarioSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    setup: setupSchema.default({}),
    deliveries: z.array(deliverySchema).min(1),
    assert: z.record(z.string(), z.union([z.number(), z.string()])),
  })
  .strict();

export const globalsSchema = z
  .object({
    global_invariants: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
  })
  .strict();

export type ParsedScenario = z.infer<typeof scenarioSchema>;
export type ParsedGlobals = z.infer<typeof globalsSchema>;
