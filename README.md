# payfuzz

**Asserts that a webhook handler cannot create or destroy money under
adversarial delivery — not that it returns 200, but that the ledger balances.**

[![ci](https://github.com/Subhooo5/payfuzz/actions/workflows/ci.yml/badge.svg)](https://github.com/Subhooo5/payfuzz/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/payfuzz.svg)](https://www.npmjs.com/package/payfuzz)
[![license](https://img.shields.io/npm/l/payfuzz)](LICENSE)

## The problem, and how payfuzz solves it

**A linter for money-losing bugs.**

**(Note: payfuzz is a testing tool, not a hosted service — it has no API of its own. It replays real Stripe events (captured once via `stripe listen` / `stripe trigger`) as YAML scenarios against any handler that implements the contract below.)**

Every payment provider — Stripe, Razorpay, PayU — delivers webhooks *at least
once*, never exactly once, and not always in order. A subscription can be
deleted before its "created" event arrives. A refund can land before the payment
it refers to. Most handlers are written for the happy path, so in production
they double-credit wallets, fulfil an order twice, or apply a refund to a
payment they haven't seen yet.

The classic one is the check-then-process race: two copies of the same event
arrive at once, both pass the "have I already handled this?" check before either
records it, and both go through. The money is gone. Almost nobody tests for this
— because there's been no tool to do it.

Stripe already solved *half* of this problem. Their [Test Clocks](https://docs.stripe.com/api/test_clocks)
let you fast-forward time, so you can test a year of billing in seconds instead
of waiting. But that only covers the *timing* half. Nobody built the equivalent
for the *delivery* half — duplicates, reordering, replays, stale writes,
slow-ack retries.

That gap is payfuzz. Point it at any webhook handler and it replays real events
under those exact failure conditions, then checks one thing: **did the money
stay correct?** It ships with two reference apps — a naive one that loses ₹5,000
of phantom money across eight scenarios, and a hardened one that loses nothing —
and both pass 100% of their own unit tests. That's the point: unit tests don't
catch these bugs. payfuzz does.

payfuzz replays checked-in Stripe events under duplication, concurrency,
reordering, timeouts, and replay attacks — signing each one itself so it runs
fully offline — and checks that your wallet balance and ledger are still
correct afterward. It ships with two identical wallet services, one written the
usual way and one written correctly, to show the difference.

```console
$ payfuzz run --target http://localhost:4242    # naive handler

  ✗ concurrent_duplicate      wallet_balance   want 100000   got 200000   ⚠ +₹1,000 minted
  ✗ refund_before_capture     wallet_balance   want 0        got -100000  ⚠ NEGATIVE BALANCE
  ✗ stale_update_overwrite    sub_status       want canceled got active
  ✗ slow_ack_timeout          wallet_balance   want 100000   got 200000   ⚠ +₹1,000 minted
  ✗ replay_attack             http_status      want 400      got 200      ⚠ +₹1,000 minted
  ✗ partial_failure_rollback  wallet_balance   want 100000   got 200000   ⚠ +₹1,000 minted

  2 passed · 6 failed · ₹5,000 phantom money created        # exit 1

$ payfuzz run --target http://localhost:4343    # hardened handler

  8 passed · 0 failed · ₹0 phantom money created            # exit 0
```

Phantom money = |actual wallet balance − expected wallet balance|, summed across all failed scenarios.

## Architecture
<img width="1398" height="3278" alt="payfuzz-architecture" src="https://github.com/user-attachments/assets/8a487299-4597-4894-8ed1-61ae62a7c719" />


## Demo

![payfuzz demo: naive run creates ₹5,000, hardened run creates ₹0](docs/demo.gif)

## What it does

payfuzz models the four things a real payment provider does that break naive
handlers: **at-least-once delivery** (the same event arrives more than once),
**unordered events** (a refund before its capture, a stale update after a
cancel), **adversarial replay** (a correctly-signed but 25-hour-old request),
and **slow acks** (the handler answers after the provider has already retried).
After each scenario it reads your money state and asserts the invariants that
matter: the wallet never goes negative, no event is processed twice, at most one
receipt per event, and the balance is exactly what it should be.

## Quickstart

```bash
npx payfuzz run --target http://localhost:4242
```

Point `--target` at any app that implements the contract below. payfuzz brings
its own eight scenarios and signed fixtures. Add `--ci` to exit `1` on any
failure — that is the merge gate.

```bash
npx payfuzz run --target <url> --ci        # exit 1 if any scenario creates or destroys money
```

## The contract

payfuzz can test **any** app — not just the bundled victims — as long as it
exposes three endpoints. This is what makes it a tool and not a demo.

| Endpoint | Purpose |
|----------|---------|
| `POST /webhook` | the endpoint under test |
| `GET /__payfuzz/state` | returns your money state as JSON |
| `POST /__payfuzz/reset` | wipes state and seeds the scenario's opening balance |

```ts
// ~10 lines to make your app testable:
app.post("/webhook", express.raw({ type: "application/json" }), yourHandler);

app.get("/__payfuzz/state", async (_req, res) => res.json({
  wallet_balance,        // paise, integer
  ledger_sum,
  events_processed,
  unique_event_ids,
  emails_sent,
  sub_status,
}));

app.post("/__payfuzz/reset", express.json(), async (req, res) => {
  await resetDb(req.body.wallet_balance ?? 0);   // fresh DB, seeded balance
  res.json({ ok: true });
});
```

payfuzz can't assert your ledger balances if it can't read your ledger. The
`state` endpoint is the whole interface — everything else is delivery.

## Writing a scenario

A scenario is a YAML file: some deliveries (each a fixture plus overrides and
faults) and the assertions that must hold afterward.

```yaml
name: concurrent_duplicate
description: A provider retry races the original — two concurrent deliveries of one event.
setup:
  wallet_balance: 0                 # POST /__payfuzz/reset seeds this (paise)
deliveries:
  - event: payment_intent.succeeded
    fixture: payment_intent.succeeded.json
    overrides:
      data.object.amount: 100000    # ₹1,000 in paise
      data.object.currency: inr
    faults: [ concurrent: 2 ]       # fire the same event id twice, simultaneously
assert:
  wallet_balance: 100000            # credited exactly once, not twice
  events_processed: 1
```

A global `_globals.yaml` adds invariants checked after **every** scenario:
`wallet_balance >= 0`, `events_processed == unique_event_ids`, and at most one
email per unique event.

## The five faults

| Fault | What it does | Real-world analogue |
|-------|--------------|---------------------|
| `duplicate: n` | same event id, `n` times **sequentially** | at-least-once delivery |
| `concurrent: n` | same event id, `n` times via `Promise.all` | a provider retry racing the original |
| `delay: Xms` | holds a delivery | network jitter; also causal reordering |
| `timeout_retry: Xms` | aborts if no response in `X`, then resends once | handler finished the work but answered late |
| `sign_with` / `timestamp_offset` | wrong-secret forgery / stale-or-future timestamp | forged signature / replay attack |

## The eight scenarios

Measured against the bundled victims. Each has a money consequence — that is the
rule; a scenario that can't move the phantom-money number doesn't belong here.

| # | Scenario | Naive | Money impact | Root-cause fix |
|---|----------|:-----:|--------------|----------------|
| 1 | `duplicate_delivery` | ✓ pass | ₹0 | (sequential dedup is fine — the bug needs concurrency) |
| 2 | `concurrent_duplicate` | ✗ fail\* | +₹1,000 minted | `PRIMARY KEY` + `ON CONFLICT DO NOTHING`, atomic with the credit |
| 3 | `refund_before_capture` | ✗ fail | ₹1,000 destroyed | don't debit an uncaptured charge; buffer it |
| 4 | `stale_update_overwrite` | ✗ fail | free subscription | conditional write on the event's own `created` timestamp |
| 5 | `slow_ack_timeout` | ✗ fail | +₹1,000 minted | ack after a fast transaction; email off the critical path |
| 6 | `replay_attack` | ✗ fail | +₹1,000 minted | `stripe.webhooks.constructEvent()` + its 300s tolerance |
| 7 | `forged_signature` | ✓ pass | ₹0 | (both reject it — the honesty control) |
| 8 | `partial_failure_rollback` | ✗ fail | +₹1,000 minted | `{mark + credit}` atomic; side effects via an outbox |

\* intermittent — see the note above and [FINDINGS.md](FINDINGS.md).

**Naive: 2 passed · 6 failed · ₹5,000 · exit 1. Hardened: 8 passed · 0 failed ·
₹0 · exit 0.**

## Use it as a merge gate

`--ci` turns payment correctness into a green/red check. Boot your app, run
payfuzz against it, and the job fails if any scenario creates or destroys money:

```yaml
- run: |
    npx tsx your-app.ts &                 # boot the app under test
    npx wait-on http://localhost:4242/__payfuzz/state
    npx payfuzz run --target http://localhost:4242 --ci
```

This repo's own [CI](.github/workflows/ci.yml) does exactly that against both
victims and asserts the tool catches the broken one: naive → `exit 1`, hardened
→ `exit 0`. The badge is green only when both hold, fully offline (payfuzz signs
its own deliveries; no Stripe account needed).

## Limitations

payfuzz asserts on **final** state, so it catches bugs that leave a mark on
final state — a handler that dips negative and recovers within a scenario
passes. The concurrency race is intermittent under the full suite (deterministic
in isolation). Both are characterized in full in [FINDINGS.md](FINDINGS.md).

## License

MIT © 2026 Subhodeep
