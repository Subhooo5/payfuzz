/**
 * The naive wallet top-up service.
 *
 * User pays → wallet credited. Refund → wallet debited. Subscription events
 * keep our copy in sync. Written the way a competent developer writes their
 * first webhook handler; see FINDINGS.md for what that costs under adversarial
 * delivery. It talks to SQLite through one module-level shared connection —
 * the singleton every Node tutorial shows — so the SELECT-then-INSERT dedup
 * gap is a real race between the read and the write.
 */
import express, { type Express } from "express";
import { getWebhookSecret } from "../../src/config.js";
import { EmailTransport } from "../shared/email.js";
import type { Database } from "../shared/sqlite.js";
import type { PayfuzzState, ResetRequest } from "../shared/state-contract.js";
import { resetDatabase } from "./db.js";
import { verifyWebhookSignature } from "./verify.js";

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function createApp(db: Database, email: EmailTransport): Express {
  const app = express();

  app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    let event;
    try {
      event = verifyWebhookSignature(req.body, req.header("stripe-signature"), getWebhookSecret());
    } catch {
      return res.status(400).send("invalid signature");
    }

    // The module-level shared connection: every request uses the same one.
    const conn = await db.shared();

    // Skip events we've already processed.
    const seen = await conn.get("SELECT 1 FROM events WHERE id = ?", event.id);
    if (seen) {
      return res.status(200).send("already processed");
    }

    switch (event.type) {
      case "payment_intent.succeeded": {
        const payment = event.data.object;
        const amount = payment.amount;
        await conn.run("UPDATE wallet SET balance = balance + ? WHERE id = 1", amount);
        await conn.run(
          "INSERT INTO ledger (event_id, kind, amount, created_at) VALUES (?, 'credit', ?, ?)",
          event.id,
          amount,
          nowSeconds(),
        );
        await email.send(payment.receipt_email ?? "customer@example.com", "Your wallet top-up receipt");
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object;
        const refunded = charge.amount_refunded;
        await conn.run("UPDATE wallet SET balance = balance - ? WHERE id = 1", refunded);
        await conn.run(
          "INSERT INTO ledger (event_id, kind, amount, created_at) VALUES (?, 'debit', ?, ?)",
          event.id,
          -refunded,
          nowSeconds(),
        );
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await conn.run(
          "INSERT OR REPLACE INTO subs (id, status, customer) VALUES (?, ?, ?)",
          sub.id,
          sub.status,
          sub.customer,
        );
        break;
      }

      default:
        break; // event types we don't handle
    }

    // Record the event so we don't process it twice.
    await conn.run(
      "INSERT INTO events (id, type, received_at) VALUES (?, ?, ?)",
      event.id,
      event.type,
      nowSeconds(),
    );
    res.sendStatus(200);
  });

  app.get("/__payfuzz/state", async (_req, res) => {
    const conn = await db.shared();
    const wallet = await conn.get<{ balance: number }>("SELECT balance FROM wallet WHERE id = 1");
    const ledger = await conn.get<{ entries: number; total: number }>(
      "SELECT COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS total FROM ledger",
    );
    const events = await conn.get<{ processed: number; unique_ids: number }>(
      "SELECT COUNT(*) AS processed, COUNT(DISTINCT id) AS unique_ids FROM events",
    );
    const sub = await conn.get<{ id: string; status: string }>("SELECT id, status FROM subs LIMIT 1");

    const state: PayfuzzState = {
      wallet_balance: wallet?.balance ?? 0,
      ledger_entries: ledger?.entries ?? 0,
      ledger_sum: ledger?.total ?? 0,
      emails_sent: email.sentCount,
      events_processed: events?.processed ?? 0,
      unique_event_ids: events?.unique_ids ?? 0,
      sub_status: sub?.status ?? null,
      sub_id: sub?.id ?? null,
    };
    res.json(state);
  });

  app.post("/__payfuzz/reset", express.json(), async (req, res) => {
    const body: ResetRequest = req.body ?? {};
    await resetDatabase(db, body.wallet_balance ?? 0);
    email.configure({ delayMs: body.email_delay_ms ?? 0, fail: body.email_fail ?? false });
    res.json({ ok: true });
  });

  return app;
}
