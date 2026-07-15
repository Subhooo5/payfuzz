/**
 * Storage for the hardened wallet service.
 *
 * Same shape as the naive schema, with the constraints that make the fixes
 * possible: `events.id` is a PRIMARY KEY (the dedup is the constraint, not a
 * SELECT-then-INSERT), `subs` carries `last_event_at` (so a stale update lands
 * 0 rows), and `payments`/`pending_refunds` reconstruct payment state so a
 * refund is never applied before its capture is seen.
 */
import type { Connection, Database } from "../shared/sqlite.js";

const SCHEMA = `
  CREATE TABLE wallet (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    balance INTEGER NOT NULL
  );

  CREATE TABLE ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    amount     INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- the inbox: id PRIMARY KEY is the dedup constraint
  CREATE TABLE events (
    id          TEXT    PRIMARY KEY,
    type        TEXT    NOT NULL,
    received_at INTEGER NOT NULL
  );

  -- captured payments, so a refund can check its prerequisite
  CREATE TABLE payments (
    payment_intent TEXT    PRIMARY KEY,
    amount         INTEGER NOT NULL
  );

  -- refunds that arrived before their capture, held until it appears
  CREATE TABLE pending_refunds (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_intent TEXT    NOT NULL,
    amount         INTEGER NOT NULL
  );

  CREATE TABLE subs (
    id            TEXT    PRIMARY KEY,
    status        TEXT    NOT NULL,
    customer      TEXT,
    last_event_at INTEGER NOT NULL
  );
`;

/** Starts a fresh generation, creates the schema, and seeds the opening balance (paise). */
export async function resetDatabase(db: Database, walletBalance: number): Promise<void> {
  await db.reset(async (conn: Connection) => {
    await conn.exec(SCHEMA);
    await conn.run("INSERT INTO wallet (id, balance) VALUES (1, ?)", walletBalance);
  });
}
