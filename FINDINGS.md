# FINDINGS

payfuzz replays eight adversarial delivery scenarios against two wallet
top-up services that share a domain, a framework, and a schema shape. The
**naive** service is written the way a competent developer writes their first
webhook integration; the **hardened** service is the same app, correct. Both
pass 100% of their own unit tests.

Under adversarial delivery they diverge sharply:

| Target   | Result (representative run) | Exit | Phantom money |
|----------|-----------------------------|:----:|---------------|
| naive    | 2 passed · 6 failed         | `1`  | **₹5,000 created / destroyed** |
| hardened | 8 passed · 0 failed         | `0`  | ₹0 |

*Phantom money* = the sum, over failing scenarios, of `|actual wallet − expected
wallet|`. It is the total currency the handler invented or destroyed during the
run. All amounts are integer **paise** internally (₹1,000 = 100,000 paise); the
rupee sign appears at display only.

Measured over 6 full naive runs and 3 full hardened runs (each victim alone and
quiet, the sequencing CI uses):

- **naive** exits `1` on **every** run (6/6). Five runs read ₹5,000; one run the
  intermittent concurrency scenario deduplicated, reading ₹4,000 — still a
  failing gate. See the intermittency headline below.
- **hardened** exits `0` on every run (3/3): 8 passed, ₹0.

---

## The eight scenarios

Each scenario ties back to one sentence: *a webhook handler must not create or
destroy money under adversarial delivery — not that it returns 200, that the
ledger balances.* If a scenario can't be tied to that, it isn't here.

### 1 — `duplicate_delivery` — naive PASSES ✓ · ₹0

The same event id is delivered twice, **sequentially** (payfuzz waits for the
first `200` before sending the second). The naive `SELECT … then … INSERT`
dedup handles this correctly: by the time the second delivery runs its
`SELECT`, the first has already committed its `INSERT`, so the second is
deduped.

This is a deliberate green row. Idempotency-via-seen-check is not wrong for
sequential retries — the bug needs *concurrency* (scenario 2) to surface.
Reporting this as a pass, rather than forcing it red, is the honest result: two
green rows read as more credible than eight red ones.

**Fix:** none required.

---

### 2 — `concurrent_duplicate` — naive FAILS ✗ · +₹1,000 minted *(intermittent — see headline)*

A provider retry races the original: two deliveries of one event id fire
concurrently (`Promise.all`). Both handlers run their `SELECT` and both see
"not seen" **before either** reaches its `INSERT`, because the `await` on the
read yields the event loop. Both credit.

- **Root cause:** a check-then-act race. The gap between the read (①) and the
  write (②) is an interleaving window; single-threaded ≠ atomic.
- **Money:** wallet want `100000`, got `200000` → **+₹1,000 minted**.

```diff
  // NAIVE — dedup is application logic with a gap
- const seen = await conn.get("SELECT 1 FROM events WHERE id = ?", event.id); // ① read — await yields
- if (seen) return res.status(200).send("already processed");
- // …credit the wallet…
- await conn.run("INSERT INTO events (id, type, received_at) VALUES (?,?,?)", …); // ② write, later
  // schema:  CREATE TABLE events (id TEXT NOT NULL);        -- no constraint

  // HARDENED — dedup is a database constraint, atomic with the credit
+ CREATE TABLE events (id TEXT PRIMARY KEY);                 -- the constraint IS the dedup
+ await conn.transaction(async (tx) => {
+   const marked = await tx.run(
+     "INSERT INTO events (id,type,received_at) VALUES (?,?,?) ON CONFLICT DO NOTHING", …);
+   if (marked.changes === 0) return;                        // lost the insert race → do no work
+   await tx.run("UPDATE wallet SET balance = balance + ? WHERE id = 1", amount);
+ });
```

**One-line fix:** make the database adjudicate identity — `INSERT … ON CONFLICT
DO NOTHING` on a `PRIMARY KEY`, inside the same transaction as the credit, so
there is no gap to interleave into.

---

### 3 — `refund_before_capture` — naive FAILS ✗ · ₹1,000 destroyed (NEGATIVE balance)

A refund arrives for a payment whose `succeeded` webhook was never seen (dropped
or still in the provider's retry queue). The naive handler debits a balance it
never credited.

- **Root cause:** trusting arrival order. A refund is applied without checking
  that its capture was ever processed.
- **Money:** wallet want `0`, got `-100000` → **₹1,000 destroyed**, and the
  global invariant `wallet_balance >= 0` is violated.

```diff
  // NAIVE — unconditional debit
- await conn.run("UPDATE wallet SET balance = balance - ? WHERE id = 1", refunded);

  // HARDENED — a refund checks its prerequisite; if unseen, it is held
+ const captured = await tx.get("SELECT amount FROM payments WHERE payment_intent = ?", pi);
+ if (captured) {
+   await tx.run("UPDATE wallet SET balance = balance - ? WHERE id = 1", refunded);
+ } else {
+   await tx.run("INSERT INTO pending_refunds (payment_intent, amount) VALUES (?, ?)", pi, refunded);
+ }                 // when the capture finally arrives, the pending refund is applied then
```

**One-line fix:** reconstruct state from a payment state machine — never debit an
uncaptured charge; buffer the refund until its capture is seen.

---

### 4 — `stale_update_overwrite` — naive FAILS ✗ · free subscription forever

`subscription.deleted` (newer) is delivered first; a redelivered, stale
`subscription.updated(active)` (60s older by its own `created`) lands last. The
naive handler's last-write-wins resurrects a cancelled subscription.

- **Root cause:** last-write-wins over *arrival* order, which is not *causal*
  order once retries exist.
- **Money:** no direct wallet delta, but the customer keeps a paid subscription
  for free — a recurring loss. `sub_status` want `canceled`, got `active`.

```diff
  // NAIVE — arrival order wins
- await conn.run("INSERT OR REPLACE INTO subs (id, status, customer) VALUES (?,?,?)", id, status, customer);

  // HARDENED — the event's own timestamp is the version; a write only lands if newer
+ await tx.run(
+   `INSERT INTO subs (id, status, customer, last_event_at) VALUES (?,?,?,?)
+    ON CONFLICT(id) DO UPDATE SET status = excluded.status, last_event_at = excluded.last_event_at
+    WHERE excluded.last_event_at > subs.last_event_at`,     // refuse to go backwards
+   id, status, customer, event.created);
```

**One-line fix:** order by the event's `created`, not by arrival — a conditional
`UPDATE … WHERE last_event_at < ?` makes late arrivals no-ops.

*This is the same primitive as scenario 2 — a conditional write the database
enforces — applied to a version key (`created`) instead of an identity key
(`event_id`).*

---

### 5 — `slow_ack_timeout` — naive FAILS ✗ · +₹1,000 minted

The handler credits the wallet, then blocks 6s on an email send **before**
marking the event processed. payfuzz times out at 5s (`timeout_retry`) and the
provider resends; the work runs twice.

- **Root cause:** slow side-effect (I/O) on the critical path, ahead of the
  dedup mark. A client abort doesn't stop the handler — it just makes the
  provider retry a running operation.
- **Money:** wallet want `100000`, got `200000` → **+₹1,000 minted**; a second
  receipt email is also sent.

```diff
  // NAIVE — email blocks the ack, and the mark comes after it
- await conn.run("UPDATE wallet SET balance = balance + ? WHERE id = 1", amount);
- await email.send(receipt, "Your wallet top-up receipt");   // blocks ~6s > 5s timeout
- await conn.run("INSERT INTO events (id,…) VALUES (…)", …);  // never reached before the retry

  // HARDENED — persist, ack, then send email off the critical path
+ await db.withConnection((c) => c.transaction((tx) => process(tx, event))); // ms
+ res.sendStatus(200);                                        // ack immediately
+ void email.send(receipt, "…").catch(() => { /* an outbox retries; money is already correct */ });
```

**One-line fix:** ack after the (fast) transaction commits; move the email off
the critical path. "Ack immediately" means *get the slow work off the path*, not
*respond before you've persisted*.

---

### 6 — `replay_attack` — naive FAILS ✗ · +₹1,000 minted

A correctly-signed but **25-hour-old** event is replayed. The naive signature
check is hand-rolled from the docs and verifies the HMAC but never checks the
timestamp against a tolerance window, so it accepts the stale request.

- **Root cause:** a hand-rolled verifier that omits the freshness check. A valid
  signature on an old captured request is still a replay.
- **Money:** `http_status` want `400`, got `200`; wallet `0 → 100000` →
  **+₹1,000 minted**.

```diff
  // NAIVE — HMAC verified, timestamp never checked
- const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
- if (!timingSafeEqual(expectedBuf, providedBuf)) throw new Error("signature mismatch");
- return JSON.parse(rawBody);                                 // no tolerance window — 25h-old accepted

  // HARDENED — Stripe's own verifier enforces the 300s default tolerance
+ return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret); // rejects stale timestamps
```

**One-line fix:** use `stripe.webhooks.constructEvent()` — its 300s tolerance
rejects the replay. (`constructEvent` is pure HMAC: no network, which is what
lets payfuzz and both victims run fully offline.)

---

### 7 — `forged_signature` — both PASS ✓ · ₹0

A payload signed with the **wrong secret** — a same-length, valid-format v1
forgery (not a truncated string, which a length-guarded `timingSafeEqual` would
reject trivially). Every handler must reject it, and both do (`400`).

This is the honesty control. A tool where everything fails looks rigged; one row
that *should* pass and does makes the seven red rows credible. The naive app
genuinely checks the HMAC — its bugs are about delivery semantics, not a missing
signature check.

**Fix:** none required — both are already correct here.

---

### 8 — `partial_failure_rollback` — naive FAILS ✗ · +₹1,000 minted

The wallet credit commits; then the email throws (`email_fail`) **before** the
event is marked processed; the provider retries and the credit runs again.

- **Root cause:** no atomic unit of work. The credit is durable but the mark is
  not, and a side effect between them can abort the request after the money
  moved but before dedup was recorded.
- **Money:** wallet want `100000`, got `200000` → **+₹1,000 minted**.

```diff
  // NAIVE — credit commits, email throws, event never marked → retry double-credits
- await conn.run("UPDATE wallet SET balance = balance + ? WHERE id = 1", amount); // committed
- await email.send(receipt, "…");        // THROWS → request aborts here
- await conn.run("INSERT INTO events …"); // never runs; the retry sees "not seen"

  // HARDENED — mark + credit are one transaction; email is a post-commit side effect
+ await db.withConnection((c) => c.transaction(async (tx) => {
+   const marked = await tx.run("INSERT INTO events … ON CONFLICT DO NOTHING", …);
+   if (marked.changes === 0) return false;   // retry is a no-op
+   await tx.run("UPDATE wallet SET balance = balance + ? WHERE id = 1", amount);
+   return true;
+ }));
+ res.sendStatus(200);
+ if (credited) void email.send(…).catch(() => {}); // failure cannot roll back the credit
```

**One-line fix:** make `{mark processed + credit}` a single transaction; deliver
side effects via an outbox after commit. (The scenario-2 fix already kills this
one — the atomic mark+credit means a retry does no work.)

---

## Headline — the concurrency race is intermittent, and that is the point

Scenario 2 is a genuine concurrency race, and its intermittency is a finding,
not a defect in the tool:

| Condition                                   | Race fires |
|---------------------------------------------|-----------:|
| Scenario 2 alone, repeated (isolation)      | **30 / 30** |
| Scenario 2 sequenced after another scenario | **27 / 30** (~90%) |
| Full 8-scenario suite, per run              | **~5 / 6 runs** |
| Naive merge gate (`payfuzz --ci` → exit 1)  | **6 / 6 runs** |

Run in isolation the race is deterministic (30/30). Under the varied timing of a
full run it fires most of the time but not every time; when it doesn't, the two
concurrent deliveries happen to serialize and the handler *correctly* dedups.

**A check-then-act race that fired identically every time would be caught in
staging.** These cost real money precisely because they fire most of the time
and pass the rest, slipping through CI into production. payfuzz pins the naive
victim to a single in-process connection — the singleton every Node tutorial
reaches for — to make the race frequent enough to demonstrate; the bug is
present regardless of connection topology, and the fix (a `PRIMARY KEY` plus an
atomic conditional write) is correct regardless, because the *database*
adjudicates it, not application code.

Crucially, **the merge gate holds every run**: the other five failing scenarios
are deterministic, so `payfuzz --ci` against the naive victim exits `1` on every
run whether or not scenario 2 fires.

---

## Limitations

Reported as-is, not hidden.

- **Final-state oracle only.** payfuzz asserts on FINAL state, so it only
  catches bugs that leave a mark on final state. A handler that dips negative
  and recovers within a scenario passes. Catching that would require per-write
  assertions or an intermediate state probe. Known limitation, deliberately
  out of scope. (This is why `03_refund_before_capture` is a single refund
  delivery — a two-delivery net-zero version would go −₹1000 then +₹1000 and
  the transient negative would be invisible.)

- **The concurrency race is intermittent under the full suite** (~5/6 runs;
  30/30 in isolation, 27/30 sequenced). This is characterized in full above and
  is a property of the bug class, not a flaw in the tool. It never weakens the
  gate, which is carried by five deterministic scenarios and exits `1` every
  run.

- **Design note — why the hardened ack comes after an await.** The hardened
  handler persists, THEN acks, THEN fires side effects asynchronously. Acking
  before the write commits would mean acknowledging an event that could still be
  lost. "Ack immediately" (scenario 5's fix) means get the SLOW work (email/IO)
  off the critical path — not respond before you've persisted. The transaction
  is milliseconds; the email is seconds.

- **Reset knobs are transport-only.** The reset endpoint's `email_delay_ms` and
  `email_fail` configure the fake email transport only; neither victim's handler
  reads them, both expose identical knobs, and the hardened victim passes 8/8
  under the same knob settings the naive one fails under. The bug is in the
  handler, not the harness.

---

Both victims pass 100% of their own unit tests.
