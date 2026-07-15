/**
 * Shared runtime configuration for payfuzz and both victim apps.
 *
 * The webhook signing secret is read from the PAYFUZZ_WHSEC environment
 * variable and is never hardcoded. payfuzz signs each delivery and the
 * victims verify it with the same value, so any consistent secret works —
 * the real `whsec_` from `stripe listen` locally, a dummy in CI.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env when present (local development). Real environment variables
// take precedence, so CI setting PAYFUZZ_WHSEC directly always wins.
const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/** Port the one-time fixture capture listener binds (scripts/capture-fixtures.mjs). */
export const CAPTURE_PORT = 9999;

/** Port the intentionally buggy victim listens on. */
export const NAIVE_VICTIM_PORT = 4242;

/** Port the corrected victim listens on. */
export const HARDENED_VICTIM_PORT = 4343;

/**
 * Returns the webhook signing secret, failing loudly when unset.
 *
 * Deliberately a function rather than an eagerly-read constant: importing
 * this module never throws, only actually signing or verifying without a
 * configured secret does.
 */
export function getWebhookSecret(): string {
  const secret = process.env.PAYFUZZ_WHSEC;
  if (!secret) {
    throw new Error(
      "PAYFUZZ_WHSEC is not set. Copy .env.example to .env and paste the " +
        "secret printed by `stripe listen --print-secret`, or export " +
        "PAYFUZZ_WHSEC directly (any consistent value works, e.g. in CI).",
    );
  }
  return secret;
}
