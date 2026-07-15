#!/usr/bin/env node
/**
 * Evidence for the naive check-then-act race, and why the connection model
 * matters. The naive handler dedups with `SELECT … then … INSERT`; the `await`
 * on the SELECT yields the event loop, so two concurrent deliveries of the same
 * event can both pass the "seen?" check before either writes, and both credit.
 *
 * The bug is present under BOTH connection models — only how often it manifests
 * changes:
 *
 *   shared connection       one connection serializes both SELECTs before either
 *                           INSERT, so the race fires every time. This is the
 *                           singleton every Node tutorial reaches for, and what
 *                           the naive victim uses.
 *   connection-per-request  each delivery reads and writes on its own connection;
 *                           whether both SELECTs land before the first INSERT is
 *                           then a genuine race, so it fires only sometimes.
 *
 * That gap — deterministic vs intermittent — is exactly why such races pass
 * staging and lose money in production. The fix (a UNIQUE/PRIMARY KEY plus an
 * atomic conditional write in a transaction) is correct under both models,
 * because the database, not the connection topology, adjudicates it.
 *
 * Run: node scripts/race-proof.mjs
 */
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sqlite3 from "sqlite3";

const open = (path) =>
  new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, (err) => {
      if (err) return reject(err);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;", (e) => (e ? reject(e) : resolve(db)));
    });
  });
const run = (db, sql, ...a) => new Promise((res, rej) => db.run(sql, a, function (e) { e ? rej(e) : res(this); }));
const get = (db, sql, ...a) => new Promise((res, rej) => db.get(sql, a, (e, r) => (e ? rej(e) : res(r))));
const close = (db) => new Promise((res) => db.close(() => res()));

// The naive handler shape: check (a read) … then credit … then mark (the write).
async function handleDelivery(conn, id, amountPaise) {
  const seen = await get(conn, "SELECT 1 FROM events WHERE id = ?", id); // ← await yields here
  if (seen) return;
  await run(conn, "UPDATE wallet SET balance = balance + ?", amountPaise);
  await run(conn, "INSERT INTO events (id) VALUES (?)", id); // naive marks after the effect
}

async function trial(perRequest) {
  const path = join(tmpdir(), `payfuzz-race-proof-${process.pid}-${Math.random()}.db`);
  const setup = await open(path);
  await run(setup, "CREATE TABLE events (id TEXT)"); // no UNIQUE — the naive schema
  await run(setup, "CREATE TABLE wallet (balance INTEGER NOT NULL)");
  await run(setup, "INSERT INTO wallet (balance) VALUES (0)");
  await close(setup);

  // Shared: one connection handed to both deliveries. Per-request: one each.
  const shared = perRequest ? null : await open(path);
  const acquire = perRequest ? () => open(path) : async () => shared;
  const release = perRequest ? (c) => close(c) : async () => {};

  const [a, b] = [await acquire(), await acquire()];
  await Promise.all([handleDelivery(a, "evt_race", 1000), handleDelivery(b, "evt_race", 1000)]);
  await Promise.all([release(a), release(b)]);

  const reader = perRequest ? await open(path) : shared;
  const { balance } = await get(reader, "SELECT balance FROM wallet");
  await close(reader);
  for (const f of [path, `${path}-wal`, `${path}-shm`]) try { unlinkSync(f); } catch {}
  return balance === 2000; // 2000 paise = both credited = race fired
}

async function measure(perRequest, trials) {
  let fired = 0;
  for (let i = 0; i < trials; i++) if (await trial(perRequest)) fired++;
  return fired;
}

const TRIALS = 20;
const sharedFires = await measure(false, TRIALS);
const perRequestFires = await measure(true, TRIALS);
console.log(`shared connection:        race fired ${sharedFires}/${TRIALS}`);
console.log(`connection-per-request:   race fired ${perRequestFires}/${TRIALS}`);
console.log("\nThe check-then-act bug is present under both models; only its frequency changes.");
// Fail only if the bug never manifests at all under either model.
process.exit(sharedFires + perRequestFires > 0 ? 0 : 1);
