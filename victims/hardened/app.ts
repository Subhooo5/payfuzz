/**
 * The hardened wallet top-up service.
 *
 * Same domain, framework, and schema shape as the naive service; the only
 * differences are handler logic and DB constraints. Every write the database
 * adjudicates: dedup is a PRIMARY KEY, ordering is a conditional UPDATE on the
 * event's own timestamp, and the credit is committed atomically with the
 * dedup so a retry can never double-credit. It talks to SQLite through a fresh
 * connection per request (a pool in production), so concurrent deliveries
 * contend on the write lock — the database serializes them, not app code.
 */
import express, { type Express } from "express";
import { getWebhookSecret } from "../../src/config.js";
import { EmailTransport } from "../shared/email.js";
import type { Connection, Database } from "../shared/sqlite.js";
import type { PayfuzzState, ResetRequest } from "../shared/state-contract.js";
import { resetDatabase } from "./db.js";
import { constructWebhookEvent, type WebhookEvent } from "./verify.js";

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Processes one event inside an open transaction. Returns true when a receipt
 * email should be sent. Returns false for duplicates and for events with no
 * receipt, so the caller only emails on a real, first-time credit.
 */
async function process(tx: Connection, event: WebhookEvent): Promise<boolean> {
  // Mark-first: the PK is the dedup, and it commits atomically with the credit.
  const marked = await tx.run(
    "INSERT INTO events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    event.id,
    event.type,
    nowSeconds(),
  );
  if (marked.changes === 0) return false; // already processed

  switch (event.type) {
    case "payment_intent.succeeded": {
      const payment = event.data.object;
      await tx.run("UPDATE wallet SET balance = balance + ? WHERE id = 1", payment.amount);
      await tx.run(
        "INSERT INTO ledger (event_id, kind, amount, created_at) VALUES (?, 'credit', ?, ?)",
        event.id,
        payment.amount,
        nowSeconds(),
      );
      await tx.run("INSERT OR IGNORE INTO payments (payment_intent, amount) VALUES (?, ?)", payment.id, payment.amount);

      // Apply any refunds that arrived before this capture was seen.
      const pending = await tx.all<{ id: number; amount: number }>(
        "SELECT id, amount FROM pending_refunds WHERE payment_intent = ?",
        payment.id,
      );
      for (const refund of pending) {
        await tx.run("UPDATE wallet SET balance = balance - ? WHERE id = 1", refund.amount);
        await tx.run(
          "INSERT INTO ledger (event_id, kind, amount, created_at) VALUES (?, 'debit', ?, ?)",
          event.id,
          -refund.amount,
          nowSeconds(),
        );
        await tx.run("DELETE FROM pending_refunds WHERE id = ?", refund.id);
      }
      return true;
    }

    case "charge.refunded": {
      const charge = event.data.object;
      const captured = await tx.get<{ amount: number }>(
        "SELECT amount FROM payments WHERE payment_intent = ?",
        charge.payment_intent,
      );
      if (captured) {
        await tx.run("UPDATE wallet SET balance = balance - ? WHERE id = 1", charge.amount_refunded);
        await tx.run(
          "INSERT INTO ledger (event_id, kind, amount, created_at) VALUES (?, 'debit', ?, ?)",
          event.id,
          -charge.amount_refunded,
          nowSeconds(),
        );
      } else {
        // Prerequisite capture unseen — hold the refund, never debit into the negative.
        await tx.run(
          "INSERT INTO pending_refunds (payment_intent, amount) VALUES (?, ?)",
          charge.payment_intent,
          charge.amount_refunded,
        );
      }
      return false;
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      // Order by the event's own `created`: a write only lands if it is newer.
      await tx.run(
        `INSERT INTO subs (id, status, customer, last_event_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, customer = excluded.customer, last_event_at = excluded.last_event_at
         WHERE excluded.last_event_at > subs.last_event_at`,
        sub.id,
        sub.status,
        sub.customer,
        event.created,
      );
      return false;
    }

    default:
      return false;
  }
}

export function createApp(db: Database, email: EmailTransport): Express {
  const app = express();

  app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    let event: WebhookEvent;
    try {
      event = constructWebhookEvent(req.body, req.header("stripe-signature"), getWebhookSecret());
    } catch {
      return res.status(400).send("invalid signature");
    }

    const credited = await db.withConnection((conn) => conn.transaction((tx) => process(tx, event)));

    res.sendStatus(200); // ack after the transaction has committed

    if (credited) {
      // Side effect off the critical path: its failure cannot roll back the credit.
      void email
        .send(event.data.object.receipt_email ?? "customer@example.com", "Your wallet top-up receipt")
        .catch(() => {
          /* an outbox would record this and retry; the money is already correct */
        });
    }
  });

  app.get("/__payfuzz/state", async (_req, res) => {
    const state = await db.withConnection(async (conn): Promise<PayfuzzState> => {
      const wallet = await conn.get<{ balance: number }>("SELECT balance FROM wallet WHERE id = 1");
      const ledger = await conn.get<{ entries: number; total: number }>(
        "SELECT COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS total FROM ledger",
      );
      const events = await conn.get<{ processed: number; unique_ids: number }>(
        "SELECT COUNT(*) AS processed, COUNT(DISTINCT id) AS unique_ids FROM events",
      );
      const sub = await conn.get<{ id: string; status: string }>("SELECT id, status FROM subs LIMIT 1");

      return {
        wallet_balance: wallet?.balance ?? 0,
        ledger_entries: ledger?.entries ?? 0,
        ledger_sum: ledger?.total ?? 0,
        emails_sent: email.sentCount,
        events_processed: events?.processed ?? 0,
        unique_event_ids: events?.unique_ids ?? 0,
        sub_status: sub?.status ?? null,
        sub_id: sub?.id ?? null,
      };
    });
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
