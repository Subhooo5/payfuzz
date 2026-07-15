/**
 * Happy-path unit tests for both victim apps.
 *
 * This is the pitch, made literal: a developer's own unit tests exercise the
 * NON-adversarial behaviour of a webhook handler — a payment credits, a
 * duplicate is ignored, a refund debits, a bad signature is rejected — and
 * BOTH the naive and the hardened service pass every one of them. The naive
 * service is not "buggy code that fails its tests"; it is correct under the
 * inputs a developer thinks to write, and loses money only under the
 * adversarial delivery payfuzz replays (see FINDINGS.md). That is why these
 * bugs reach production: the unit suite is green.
 *
 * Run offline: signatures are HMAC over the same PAYFUZZ_WHSEC the victims
 * verify with; no network, no Stripe account.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type { Express } from "express";
import { signPayload } from "../src/signer.ts";

// Set before any request is served; getWebhookSecret reads this lazily, and the
// signer below uses the same value, so signatures always verify.
process.env.PAYFUZZ_WHSEC = "whsec_" + "u".repeat(48);
const SECRET = process.env.PAYFUZZ_WHSEC;

import { EmailTransport } from "../victims/shared/email.ts";
import { Database } from "../victims/shared/sqlite.ts";
import { createApp as createHardenedApp } from "../victims/hardened/app.ts";
import { resetDatabase as resetHardenedDb } from "../victims/hardened/db.ts";
import { createApp as createNaiveApp } from "../victims/naive/app.ts";
import { resetDatabase as resetNaiveDb } from "../victims/naive/db.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nowSec = (): number => Math.floor(Date.now() / 1000);

interface VictimHandle {
  base: string;
  db: Database;
  close: () => Promise<void>;
}

/** Boots a victim app on an ephemeral port and returns its base URL + teardown. */
async function boot(
  db: Database,
  createApp: (db: Database, email: EmailTransport) => Express,
): Promise<VictimHandle> {
  const app = createApp(db, new EmailTransport());
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.cleanup();
    },
  };
}

async function reset(base: string): Promise<void> {
  const res = await fetch(`${base}/__payfuzz/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet_balance: 0 }),
  });
  assert.equal(res.status, 200);
}

async function state(base: string): Promise<Record<string, number | string | null>> {
  const res = await fetch(`${base}/__payfuzz/state`);
  return (await res.json()) as Record<string, number | string | null>;
}

/** Signs `event` under SECRET (or `wrongSecret`, to forge) and POSTs it. */
async function deliver(base: string, event: unknown, wrongSecret?: string): Promise<number> {
  const raw = Buffer.from(JSON.stringify(event), "utf8");
  const t = nowSec();
  const header = signPayload(raw, t, wrongSecret ?? SECRET);
  const res = await fetch(`${base}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: raw,
  });
  return res.status;
}

const payment = (id: string, amount: number, pi = "pi_unit") => ({
  id,
  type: "payment_intent.succeeded",
  created: nowSec(),
  data: { object: { id: pi, amount, currency: "inr", receipt_email: "c@example.com" } },
});
const refund = (id: string, amount: number, pi = "pi_unit") => ({
  id,
  type: "charge.refunded",
  created: nowSec(),
  data: { object: { id: "ch_unit", payment_intent: pi, amount, amount_refunded: amount, currency: "inr" } },
});
const subUpdated = (id: string, sub = "sub_unit") => ({
  id,
  type: "customer.subscription.updated",
  created: nowSec(),
  data: { object: { id: sub, status: "active", customer: "cus_unit" } },
});

/** The identical happy-path contract both victims must satisfy. */
function happyPathSuite(name: string, makeHandle: () => Promise<VictimHandle>): void {
  test(`${name}: a payment credits the wallet exactly once`, async () => {
    const h = await makeHandle();
    try {
      await reset(h.base);
      assert.equal(await deliver(h.base, payment("evt_pay_1", 100000)), 200);
      const s = await state(h.base);
      assert.equal(s.wallet_balance, 100000);
      assert.equal(s.events_processed, 1);
      assert.equal(s.emails_sent, 1);
    } finally {
      await h.close();
    }
  });

  test(`${name}: a sequential duplicate is ignored`, async () => {
    const h = await makeHandle();
    try {
      await reset(h.base);
      const evt = payment("evt_pay_dup", 100000);
      await deliver(h.base, evt);
      await deliver(h.base, evt); // same id, delivered again
      const s = await state(h.base);
      assert.equal(s.wallet_balance, 100000, "a duplicate must not credit twice");
      assert.equal(s.unique_event_ids, 1);
    } finally {
      await h.close();
    }
  });

  test(`${name}: a refund after its capture debits the wallet`, async () => {
    const h = await makeHandle();
    try {
      await reset(h.base);
      await deliver(h.base, payment("evt_pay_2", 100000, "pi_ref"));
      await deliver(h.base, refund("evt_ref_1", 100000, "pi_ref"));
      const s = await state(h.base);
      assert.equal(s.wallet_balance, 0, "capture then equal refund nets to zero");
    } finally {
      await h.close();
    }
  });

  test(`${name}: a subscription update is recorded`, async () => {
    const h = await makeHandle();
    try {
      await reset(h.base);
      assert.equal(await deliver(h.base, subUpdated("evt_sub_1")), 200);
      const s = await state(h.base);
      assert.equal(s.sub_status, "active");
    } finally {
      await h.close();
    }
  });

  test(`${name}: a forged signature is rejected`, async () => {
    const h = await makeHandle();
    try {
      await reset(h.base);
      const status = await deliver(h.base, payment("evt_forge", 100000), "whsec_" + "z".repeat(48));
      assert.equal(status, 400);
      const s = await state(h.base);
      assert.equal(s.wallet_balance, 0, "a rejected event must not move money");
    } finally {
      await h.close();
    }
  });
}

happyPathSuite("naive", async () => {
  const db = new Database(":memory:");
  await resetNaiveDb(db, 0);
  return boot(db, createNaiveApp);
});

happyPathSuite("hardened", async () => {
  const db = new Database(join(tmpdir(), `payfuzz-unit-hardened-${process.pid}-${Math.random().toString(36).slice(2)}`));
  await resetHardenedDb(db, 0);
  return boot(db, createHardenedApp);
});
