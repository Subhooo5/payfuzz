/**
 * Storage for the naive wallet service.
 *
 * The way a competent developer writes their first webhook integration,
 * before being burned by at-least-once delivery. Note the `events` table has
 * NO unique constraint on id — dedup is left to a SELECT-then-INSERT in the
 * handler. Defects are catalogued in FINDINGS.md.
 */
import type { Connection, Database } from "../shared/sqlite.js";

const SCHEMA = `
  DROP TABLE IF EXISTS wallet;
  DROP TABLE IF EXISTS ledger;
  DROP TABLE IF EXISTS events;
  DROP TABLE IF EXISTS subs;

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

  -- audit log of processed events — deliberately without UNIQUE(id)
  CREATE TABLE events (
    id          TEXT    NOT NULL,
    type        TEXT    NOT NULL,
    received_at INTEGER NOT NULL
  );

  CREATE TABLE subs (
    id       TEXT PRIMARY KEY,
    status   TEXT NOT NULL,
    customer TEXT
  );
`;

/** Starts a fresh generation, creates the schema, and seeds the opening balance (paise). */
export async function resetDatabase(db: Database, walletBalance: number): Promise<void> {
  await db.reset(async (conn: Connection) => {
    await conn.exec(SCHEMA);
    await conn.run("INSERT INTO wallet (id, balance) VALUES (1, ?)", walletBalance);
  });
}
