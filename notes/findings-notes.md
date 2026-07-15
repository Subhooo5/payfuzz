# payfuzz — running findings notes

Working notes that become FINDINGS.md in Phase 6. Nothing here is polished yet.

## Headline finding — the connection model changes the bug's frequency, not its existence

The naive check-then-act race fires deterministically on a shared connection and
only ~30% of the time with per-request connections. The bug is present in both;
only how often it manifests changes. This is precisely why such races survive
staging and lose money in production. payfuzz pins the connection model so the
scenario is deterministic enough to gate a merge — but the handler is broken
under both, and the fix (unique constraint + atomic conditional write in a
transaction) is correct under both.

Measured by `scripts/race-proof.mjs`: shared connection ~20/20 fires,
connection-per-request ~6/20. The naive victim uses a module-level shared
connection — the singleton every Node tutorial reaches for — so its race is
deterministic; the hardened victim uses a connection per request (a pool in
production), which is what two pods behind a load balancer do.

**The fix is connection-model-independent.** The hardened victim was verified
8/8 with per-request connections. It would be equally correct on a shared
connection, because dedup is a PRIMARY KEY and the credit is an atomic
conditional write inside a transaction — both adjudicated by the DATABASE, not
by connection topology. That is the answer to "did you just pick a connection
model that made your fix look good?": no — the naive is broken under both models
and the hardened is correct under both.

## Design note — why the hardened ack comes after an await

The hardened handler persists, THEN acks, THEN fires side effects
asynchronously. Acking before the write commits would mean acknowledging an
event that could still be lost. The "ack immediately" fix for slow-ack
timeouts means "get the SLOW work (email/IO) off the critical path" — not
"respond before you've persisted". The transaction is milliseconds; the
email is seconds.

## OPEN ISSUE — naive scenario 02 flakes under load (needs a decision)

With the naive on a **file-backed** shared connection, `02_concurrent_duplicate`
is deterministic in isolation (20/20 fires) but deduped once in a 3-run full
suite while the hardened victim was also running — a load-correlated ~1/3 flake.
File I/O latency on the shared connection widens the arrival-skew window between
the two concurrent SELECTs.

Phases 1–3 used a **`:memory:` single shared connection** and 02 was
byte-identical deterministic. The file-backing (added in Phase 4 for the
hardened victim's transactions) is what introduced the flake — but the naive
never needs a file: it uses one shared connection and no transactions.

Recommended fix (awaiting decision, since it is a victim storage change):
naive → `:memory:` single shared connection; hardened stays file-backed +
pool + transactions. This is coherent with Path A (naive = the simplest thing,
hardened = production-grade infra) and restores the deterministic race. Not yet
applied.

## Known limitations (report as-is; do not hide)

- **Final-state oracle only.** payfuzz asserts on FINAL state, so it only
  catches bugs that leave a mark on final state. A handler that dips negative
  and recovers within a scenario passes. Catching that would require per-write
  assertions or an intermediate state probe. Known limitation, deliberately
  out of scope. (This is why `03_refund_before_capture` is a single refund
  delivery — a two-delivery net-zero version would go −₹1000 then +₹1000 and
  the transient negative would be invisible.)

## Measured results — naive victim (Phase 3, 3 identical runs)

| # | scenario | result | want | got | wallet Δ (paise) |
|---|----------|--------|------|-----|------------------|
| 01 | duplicate_delivery | PASS | wallet 100000 | 100000 | 0 |
| 02 | concurrent_duplicate | FAIL | wallet 100000 | 200000 | +100000 minted |
| 03 | refund_before_capture | FAIL | wallet 0 | −100000 | 100000 destroyed |
| 04 | stale_update_overwrite | FAIL | sub_status canceled | active | 0 (sub, not wallet) |
| 05 | slow_ack_timeout | FAIL | wallet 100000 / emails 1 | 200000 / 2 | +100000 minted |
| 06 | replay_attack | FAIL | http 400 / wallet 0 | 200 / 100000 | +100000 minted |
| 07 | forged_signature | PASS | http 400 | 400 | 0 |
| 08 | partial_failure_rollback | FAIL | wallet 100000 | 200000 | +100000 minted |

**6 failed · 2 passed · ₹5,000 phantom money** (500000 paise across 02/03/05/06/08).

Notes on the honest divergences from the SPEC's illustrative table:
- **01 passes** — sequential duplicates are legitimately deduped by the naive seen-check; the bug needs *concurrency* (02) to fire. Two green rows, not one.
- **06 mints ₹1000** — accepting a replayed 25h-old request literally creates money. The SPEC framed 06 as only an http_status issue; measured, it is also phantom money. Stronger finding.
- **03** contributes ₹1000 *destroyed* only because it is the single-refund design; see the final-state limitation above.