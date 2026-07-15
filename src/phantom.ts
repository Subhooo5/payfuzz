/**
 * Phantom money: the currency a handler invented or destroyed.
 *
 * For each failed scenario that asserted `wallet_balance`, the delta is
 * |actual − expected| paise; the total is the sum across all such scenarios.
 * It is a presentation layer over data the oracle already produced — the
 * assertion's want/got — not a re-derivation of state.
 */
import type { ScenarioResult } from "./types.js";

export type PhantomDirection = "minted" | "destroyed" | "negative";

export interface WalletDelta {
  /** |got − want| in paise. */
  delta: number;
  want: number;
  got: number;
  direction: PhantomDirection;
}

/**
 * The wallet delta for one scenario, or null when it passed or never asserted
 * `wallet_balance`. Scans every assertion — a scenario's headline may be a
 * different field (e.g. replay_attack fails on http_status yet still mints
 * money), so the wallet assertion must be found among all of them.
 */
export function walletDelta(result: ScenarioResult): WalletDelta | null {
  if (result.passed) return null;

  const wallet = result.assertions.find(
    (a) => a.field === "wallet_balance" && !a.pass && a.wantValue !== undefined && a.gotValue !== undefined,
  );
  if (!wallet) return null;

  const want = wallet.wantValue!;
  const got = wallet.gotValue!;
  const direction: PhantomDirection = got < 0 ? "negative" : got > want ? "minted" : "destroyed";
  return { delta: Math.abs(got - want), want, got, direction };
}

/** Sum of wallet deltas across all failed scenarios, in paise. */
export function phantomTotal(results: ScenarioResult[]): number {
  return results.reduce((sum, result) => sum + (walletDelta(result)?.delta ?? 0), 0);
}

/** Formats integer paise as Indian rupees, e.g. 500000 → "₹5,000". */
export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
