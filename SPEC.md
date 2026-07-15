payfuzz — full spec

1. What you show when there's no UI
The instinct that a project needs a UI to be demoable is wrong for infra tooling. Nobody asks Jest for a dashboard. What you need is evidence, and evidence has better formats than a webpage:
ArtifactWhat it provesEffortTerminal report (the primary UI)The tool works, and the naive app loses moneyFree — it's the outputFINDINGS.md8 bugs, each with root cause, money impact, and the one-line fix30 min, highest ROISingle-file HTML reportYou can present results to non-CLI humans30 minGreen CI badgeYou turned payment correctness into a merge gate15 minnpx payfuzz (published to npm)It's a real tool, not a toy repo10 min, free60s terminal GIF in READMERecruiter sees it in 5 seconds without cloning15 min
The single most persuasive thing you can put in front of an interviewer is a two-column diff:
$ payfuzz run --target http://localhost:4242   # naive handler
  8 scenarios · 1 passed · 7 failed · ₹5,000 phantom money created

$ payfuzz run --target http://localhost:4343   # hardened handler
  8 scenarios · 8 passed · 0 failed · ₹0 phantom money created
Both apps pass 100% of their own unit tests. That sentence is your entire pitch. The interviewer's next question is "how does it find the concurrent one?" — and now you're having a systems conversation, which is exactly where you want to be.
Do not build a web dashboard for this. It would actively weaken the project by signalling you didn't know what the deliverable was.

2. Requirements & cost
Everything is free. Nothing needs a card.
ThingCostNotesNode.js 20+FreeTypeScriptFreeStripe accountFreeTest mode works without activating the account or entering a cardStripe CLIFreeOpen source; used once to capture real event fixturesstripe Node SDKFree (MIT)Used by the victim apps to verify signaturesSQLite (better-sqlite3 / node:sqlite)FreeNo Docker, no Postgres serveryaml, zod, commander, undiciFreeGitHub + GitHub ActionsFreePublic repo = unlimited CI minutesnpm publishFreevhs or asciinema for the GIFFree
Why SQLite and not MongoDB: the entire fix for half these bugs is a UNIQUE constraint plus transactional atomicity. Mongo would let you fake it and the project would lose its spine. SQLite gives you real constraints with zero setup.
Do you strictly need Stripe? No — payfuzz replays checked-in fixture payloads and signs them itself, so it runs offline in CI. You use Stripe once, at the start, to capture real event bodies (stripe trigger payment_intent.succeeded). That matters: your fixtures are authentic, and your victim apps verify your signatures using Stripe's own SDK. Your tool produces signatures the real Stripe library accepts.

3. The three components
payfuzz/
├─ src/                 # the CLI tool
├─ victims/
│  ├─ naive/            # merchant wallet app, written the way everyone writes it
│  └─ hardened/         # same app, correct
├─ scenarios/           # 8 YAML files
├─ fixtures/            # real Stripe event bodies, captured once
└─ .github/workflows/ci.yml
The domain: a wallet top-up service. User pays → wallet credited. Refund → debited. This makes bugs literal: phantom money.
The payfuzz contract — any app can be tested by exposing 3 endpoints. This is what makes it a tool and not a demo:
EndpointPurposePOST /webhookThe endpoint under testGET /__payfuzz/stateReturns money state: { wallet_balance, ledger_entries, emails_sent, events_processed, sub_status }POST /__payfuzz/resetWipes state between scenarios

4. Input → processing → output
Input: a scenario file
yaml# scenarios/03_refund_before_capture.yaml
name: refund_before_capture
description: Provider delivers charge.refunded before payment_intent.succeeded.
setup:
  wallet_balance: 0

deliveries:
  - event: charge.refunded
    fixture: charge.refunded.json
    overrides: { data.object.amount_refunded: 100000 }   # ₹1000 in paise
  - event: payment_intent.succeeded
    fixture: payment_intent.succeeded.json
    overrides: { data.object.amount: 100000 }
    faults: [ delay: 2000ms ]

assert:
  wallet_balance: 0        # net zero: paid then refunded
  ledger_sum: 0
Plus a global invariants block applied after every scenario:
yaml# scenarios/_globals.yaml
global_invariants:
  wallet_balance: ">= 0"                       # money can never be negative
  events_processed: "== unique_event_ids"      # no event processed twice
  emails_sent: "<= 1 per unique event"
Processing: what payfuzz does, step by step
1. LOAD        parse YAML → zod-validate → scenario object
2. RESET       POST /__payfuzz/reset  → victim wipes DB, seeds setup state
3. BUILD       fixture JSON + overrides → concrete Stripe event
                 · assign a fresh evt_xxx id (stable across duplicates)
                 · set `created` timestamp per scenario ordering
4. PLAN        fault engine expands `deliveries` into a DELIVERY PLAN:
                 [ {t:0ms, evt_A, sig:valid}, {t:0ms, evt_A, sig:valid},  ← duplicate
                   {t:2000ms, evt_B, sig:valid} ]
5. SIGN        for each delivery, compute the Stripe-Signature header:
                 signed_payload = `${t}.${rawBody}`
                 v1 = HMAC-SHA256(signed_payload, whsec_test)
                 header = `t=${t},v1=${v1}`
6. DELIVER     POST raw body to /webhook per the plan's timings
                 · record status, latency, response body
                 · on timeout (default 5s): abort + resend — exactly what a
                   real provider does
7. SETTLE      wait for quiesce (poll /__payfuzz/state until stable, cap 3s)
8. ORACLE      GET /__payfuzz/state → diff against `assert` + `global_invariants`
9. REPORT      accumulate result; move to next scenario
The fault engine — 5 primitives
FaultWhat it doesReal-world analogueduplicate: nSame evt_id, sent n times sequentiallyAt-least-once deliveryconcurrent: nSame evt_id, fired via Promise.allProvider retry racing the originaldelay: XmsHolds a deliveryNetwork jitter (also subsumes causal reordering: delay the later-arriving event)timeout_retry: XmsAborts if no response in X, then resendsThe nastiest one — handler finished the work but answered late, so the provider retries a completed operationsign_with: <secret | none> | timestamp_offset: XForged / stale signatureReplay attack
Output: three forms
A. Console (primary)
payfuzz v0.1.0  ·  target http://localhost:4242  ·  8 scenarios

  ✗ duplicate_delivery         wallet_balance   want 1000   got 3000   ⚠ +2000 minted
  ✗ concurrent_duplicate       wallet_balance   want 1000   got 2000   ⚠ +1000 minted
  ✗ refund_before_capture      wallet_balance   want    0   got -1000  ⚠ NEGATIVE BALANCE
  ✗ stale_update_overwrite     sub_status       want canceled  got active
  ✗ slow_ack_timeout           emails_sent      want    1   got 2
  ✗ replay_attack              http_status      want  400   got 200    ⚠ 25h-old event accepted
  ✓ forged_signature           http_status      want  400   got 400
  ✗ partial_failure_rollback   wallet_balance   want 1000   got 2000   ⚠ +1000 minted

  1 passed · 7 failed · ₹5,000 phantom money created
  → payfuzz-report.html
B. payfuzz-report.html — one self-contained file, inlined CSS, no framework. Per scenario: the delivery timeline (t=0 evt_A → 200, t=0 evt_A dup → 200, t=2000 evt_B → 500), expected vs actual state table, and the raw HTTP trace. Generated from a template string.
C. --ci — exits 1 on any failure. This is what makes the GitHub Actions badge meaningful.

5. The eight scenarios (this is the actual project)
Each one must have a money consequence. That's the rule.
#ScenarioNaive bugRoot-cause fix in hardened1duplicate_deliveryCredits wallet 3×UNIQUE(event_id) on a webhook_events inbox table2concurrent_duplicateCheck-then-act race: both deliveries pass the "seen?" check before either writesINSERT ... ON CONFLICT DO NOTHING inside the same transaction as the credit — the constraint violation is the dedup3refund_before_captureDebits a balance never credited → negative walletDon't trust arrival order. Reconstruct state from a payment state machine; buffer events whose prerequisite is missing4stale_update_overwritesubscription.updated(active, t=1) arrives after subscription.deleted(t=2) → last-write-wins resurrects a cancelled sub → free access foreverCompare event created against last_event_at; drop stale5slow_ack_timeoutHandler credits, then blocks 6s on an email send; payfuzz times out at 5s and retries; work runs twiceAck 200 immediately, persist to inbox, process async from a worker6replay_attackNaive hand-rolls the HMAC check from a blog post and skips the tolerance window → a captured 25-hour-old request is acceptedstripe.webhooks.constructEvent() with its 300s default tolerance7forged_signaturePasses — the naive app does check the HMAC(nothing — proves the tool isn't rigged)8partial_failure_rollbackWallet credited (committed), email throws, event never marked processed → retry double-creditsSingle transaction: {mark processed + credit} atomic; side effects via outbox
Scenario 7 passing is deliberate. A tool where everything fails looks rigged. One green row makes the seven red ones credible.
The one subtlety you must understand before you build #2
Node is single-threaded, so a naive person would say a concurrency race is impossible. It isn't. The race is real because the naive handler does:
tsconst seen = await db.get('SELECT 1 FROM events WHERE id=?', evt.id);  // ← await yields
if (seen) return res.send(200);
await db.run('INSERT INTO events ...');
await db.run('UPDATE wallet SET balance = balance + ?', amt);
That first await yields the event loop. Delivery B enters and completes its SELECT before delivery A reaches its INSERT. Both see "not seen." Both credit.
Learn this cold. It is exactly the question a Stripe interviewer will ask, and "the await on the read yields the event loop, so the two deliveries interleave between the check and the write — which is why the fix has to be a database constraint, not application logic" is a very strong answer.

6. Build order (≈4.5 hrs)
PhaseTimeWhat0. Setup20mRepo, TS config, Stripe account, stripe listen --forward-to localhost:9999/capture + stripe trigger payment_intent.succeeded (and charge.refunded, customer.subscription.updated/deleted) → save 4 raw bodies to fixtures/1. victim-naive45mExpress + SQLite. Wallet, ledger, webhook_events (no unique constraint), hand-rolled HMAC check with no tolerance, all 7 bugs baked in. Plus /state and /reset.2. payfuzz core60mLoader (yaml+zod) → event factory → fault engine → signer → deliverer (undici) → oracle. Console output only.3. Scenarios30mThe 8 YAML files + _globals.yaml. Iterate until naive fails 7.4. victim-hardened45mSame app, correct. UNIQUE(event_id), ON CONFLICT DO NOTHING in-transaction, constructEvent, ack-then-process inbox, stale-event guard. Target: 8/8 green.5. Reporter40mHTML report + the ₹X phantom money created line + --ci exit code.6. Ship30mGitHub Actions (runs both victims; asserts naive fails, hardened passes), README with GIF, FINDINGS.md, npm publish.
Ship phase 0–4 tonight if time gets tight. Phases 5–6 are the polish that makes it legible to a recruiter — do not skip them, but they can slip to tomorrow.

7. Scope traps — do not do these

No web dashboard.
No support for a second PSP. Stripe only.
No plugin architecture / no payfuzz.config.ts extensibility layer. Hardcode the 5 faults.
No Postgres, no Docker, no Redis.
No LLM anywhere in this project.
Don't write unit tests for payfuzz itself beyond a couple for the signer. The CI run is the test.


8. The line you defend in the interview

"payfuzz asserts that a webhook handler cannot create or destroy money under adversarial delivery. Not that it returns 200 — that the ledger balances."

If a scenario can't be tied back to that sentence, cut it.

Verify this and I'll write the two-stage Claude Code prompt — file manifest first, you confirm, then generation.What is the "phantom money" mentioned here? what is it? how is it related to the project? is it absolutely necessary and needed for the project? what are its functions? elaborate in briefThinking about defining phantom money and analyzing its project necessity and functionsThinking about defining phantom money and analyzing its project necessity and functionsWhat it is
"Phantom money" is a term I coined for the spec — it isn't industry jargon. It's a single number your tool computes:

phantom money = |actual wallet balance − expected wallet balance|, summed across all failed scenarios.

That's it. It's the total amount of currency the handler invented or destroyed during the run.
Concretely, from the naive run:
ScenarioExpectedActualDeltaduplicate_delivery₹1000₹3000+₹2000 mintedconcurrent_duplicate₹1000₹2000+₹1000 mintedrefund_before_capture₹0−₹1000₹1000 destroyedpartial_failure_rollback₹1000₹2000+₹1000 minted₹5000
Why it exists in the project
It's a presentation layer over data you already have. The oracle already computes expected-vs-actual per scenario to decide pass/fail. Phantom money just sums the deltas.
Its whole function is translation. 7 scenarios failed is a test result — an interviewer's eyes slide over it. ₹5,000 of money created from nothing is a finding. It reframes the tool from "a test runner" to "a correctness auditor," and it's the number that goes in your resume bullet and your README headline.
It also gives the project a spine: it forces every scenario to have a monetary consequence. If a scenario you're tempted to add doesn't move this number, it doesn't belong in the suite. That constraint is what keeps you from drifting into generic HTTP fuzzing.
Is it necessary?
Functionally: no. The tool works identically without it. Pass/fail is decided by the invariant assertions, not by this counter. Cutting it costs you maybe 15 lines of code and zero capability.
For the purpose you're building this: yes, keep it. You're building a portfolio artifact whose job is to survive a 20-second recruiter scan and then open a 20-minute systems conversation. The single-number summary is what does the first job. It's the cheapest high-leverage thing in the entire spec — an accumulator and a print statement.
One honest caveat: don't oversell it. It's a derived stat, not a novel algorithm. If an interviewer asks how it works, say "it's the sum of the balance deltas across failing scenarios" and move immediately to how the deltas arise — the check-then-act race, the stale overwrite. The number is the hook; the concurrency bug is the substance.explain how the deltas arise — the check-then-act race, the stale overwrite?Thinking about race conditions causing data inconsistencies in concurrent systemsThinking about race conditions causing data inconsistencies in concurrent systemsBoth are ordering bugs, but at different layers. One is a race inside your process; the other is a race outside it, in the network.

1. Check-then-act race (concurrent_duplicate)
Where it comes from: the provider retried an event while the original delivery was still in flight. Your server now has two HTTP handlers running for the same evt_id.
The naive handler:
tsapp.post('/webhook', async (req, res) => {
  const evt = verify(req);

  const seen = await db.get('SELECT 1 FROM events WHERE id = ?', evt.id);   // ① READ
  if (seen) return res.sendStatus(200);

  await db.run('INSERT INTO events (id) VALUES (?)', evt.id);               // ② WRITE
  await db.run('UPDATE wallet SET balance = balance + ?', evt.amount);      // ③ EFFECT
  res.sendStatus(200);
});
The bug is the gap between ① and ②. Every await is a yield point — the event loop is free to run the other handler there.
t   Delivery A                        Delivery B                    wallet
──────────────────────────────────────────────────────────────────────────
0   SELECT id=evt_1  ───┐                                           1000
1                       │ (awaiting IO)  SELECT id=evt_1  ───┐      1000
2   ← not found  ───────┘                                    │      1000
3   INSERT evt_1                        ← not found  ────────┘      1000
4   UPDATE +1000                        INSERT evt_1 (dup!)         2000
5                                       UPDATE +1000                3000
Both handlers read "not seen" before either wrote. Both proceed. Delta: +₹1000 minted.
Two things people get wrong here:

"Node is single-threaded, so this can't happen." Single-threaded ≠ atomic. It only means no two lines run simultaneously — it says nothing about interleaving across awaits. Concurrency without parallelism still races.
"I'll add a mutex / in-memory Set of seen IDs." Works on one process. Dies the moment you run two pods behind a load balancer, which is the deployment every payments team actually has.

Root-cause fix — make the database the arbiter, not your code:
sqlCREATE TABLE events (id TEXT PRIMARY KEY);   -- the constraint IS the dedup
tsawait db.transaction(() => {
  const r = db.run('INSERT INTO events (id) VALUES (?) ON CONFLICT DO NOTHING', evt.id);
  if (r.changes === 0) return;                          // someone else won; we're a duplicate
  db.run('UPDATE wallet SET balance = balance + ?', evt.amount);
});
The check and the act are now one atomic operation. There is no gap to interleave into. Whoever loses the insert race does no work. This is also why it must be INSERT ... ON CONFLICT and not SELECT then INSERT — you're collapsing two statements into one so the constraint can adjudicate.
Note this fix also kills partial_failure_rollback (scenario 8): because the mark-as-processed and the credit are in the same transaction, a later failure rolls back both, so the retry is clean rather than double-crediting.

2. Stale overwrite (stale_update_overwrite)
Where it comes from: events arrive out of causal order. The provider emitted updated at 10:00 and deleted at 10:05, but the updated delivery hit a timeout and got retried, so it lands after the deleted.
The naive handler:
tscase 'customer.subscription.updated':
  await db.run('UPDATE subs SET status = ? WHERE id = ?', evt.data.object.status, subId);
  break;
case 'customer.subscription.deleted':
  await db.run('UPDATE subs SET status = "canceled" WHERE id = ?', subId);
  break;
Notice: idempotency does not save you. Both events have distinct evt_ids, so the dedup table happily lets both through. Each handler is individually correct. The bug is purely in the sequence.
emitted    10:00  sub.updated  (status=active)   evt_1
           10:05  sub.deleted                    evt_2

delivered  10:05  evt_2  →  status = canceled    ✅
           10:06  evt_1  →  status = active      ❌  resurrected
Delta: the user keeps a paid subscription forever, for free. In the wallet framing, it's a recurring credit that should have stopped.
The generalisation: last-write-wins over arrival order is wrong whenever arrival order isn't causal order — and with at-least-once delivery plus retries, it never reliably is.
Root-cause fix — order by the event's own logical timestamp, not by when it showed up:
sqlALTER TABLE subs ADD COLUMN last_event_at INTEGER NOT NULL DEFAULT 0;
tsconst r = db.run(
  `UPDATE subs SET status = ?, last_event_at = ?
   WHERE id = ? AND last_event_at < ?`,     // ← guard: refuse to go backwards
  status, evt.created, subId, evt.created
);
if (r.changes === 0) { /* stale event, drop it */ }
Stripe stamps every event with created. That's your version vector. A write only lands if it's newer than what's already there. Late arrivals become no-ops instead of regressions. (The stronger variant, when the provider gives you one, is a per-object sequence number or an ETag; created is the pragmatic version.)

The unifying idea
These are the same bug wearing different clothes:
check-then-actstale overwriteWhat's unorderedtwo deliveries of one eventtwo different eventsNaive assumption"no one else is between my read and my write""the last message I received is the latest truth"Fixatomic compare-and-set on identity (event_id)atomic compare-and-set on version (created)
Both fixes are the same primitive — a conditional write enforced by the database — applied to a different key. Once you see that, the whole hardened handler collapses into one rule:

Never let application code decide whether a write is safe. Encode the safety condition in the write itself and let the database reject it.

That's the sentence to have loaded when the interviewer asks how you fixed the naive app.