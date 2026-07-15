/**
 * File-backed SQLite shared verbatim by both victims. It offers two connection
 * patterns, both plumbing available to both victims — only their usage differs:
 *
 *   - shared()          a memoized module-level connection: the singleton every
 *                       Node tutorial reaches for. The naive victim uses this,
 *                       so its check-then-act dedup races deterministically —
 *                       one connection serializes both SELECTs before either
 *                       INSERT, so concurrent deliveries both see "not seen".
 *   - withConnection() + transaction()  a fresh connection per request wrapping
 *                       BEGIN IMMEDIATE … COMMIT. The hardened victim uses this;
 *                       two connections contending on the write lock is exactly
 *                       what two pods behind a load balancer do, and the lock —
 *                       not application code — serializes the writers.
 *
 * The same race is present under both models; only how often it manifests
 * changes (see scripts/race-proof.mjs). Each reset() starts a new generation on
 * a fresh file, so a straggler from the previous scenario writes to an orphaned
 * file (or its now-closed shared connection) and never reaches the next one.
 */
import { unlink } from "node:fs/promises";
import sqlite3 from "sqlite3";

export interface RunResult {
  /** Rows modified — 0 signals a no-op (e.g. ON CONFLICT DO NOTHING lost the race). */
  changes: number;
}

/** A live connection to one generation's database file. */
export class Connection {
  constructor(private readonly db: sqlite3.Database) {}

  run(sql: string, ...params: unknown[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
  }

  get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T | undefined)));
    });
  }

  all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
    });
  }

  exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Runs fn inside `BEGIN IMMEDIATE … COMMIT`, rolling back on any throw so a
   * partial unit of work never commits. BEGIN IMMEDIATE takes the write lock
   * up front, so a second connection's transaction blocks (busy_timeout) until
   * this one commits — the database, not application code, serializes writers.
   */
  async transaction<T>(fn: (tx: Connection) => Promise<T>): Promise<T> {
    await this.run("BEGIN IMMEDIATE");
    try {
      const result = await fn(this);
      await this.run("COMMIT");
      return result;
    } catch (err) {
      await this.run("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function openConnection(path: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, (err) => {
      if (err) return reject(err);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;", (pragmaErr) =>
        pragmaErr ? reject(pragmaErr) : resolve(new Connection(db)),
      );
    });
  });
}

function unlinkGeneration(path: string): Promise<unknown> {
  return Promise.all([path, `${path}-wal`, `${path}-shm`].map((f) => unlink(f).catch(() => {})));
}

/**
 * Two storage modes, chosen by the constructor path:
 *  - ":memory:"  — one persistent in-process connection; reset wipes it in
 *                  place. The naive victim uses this so its check-then-act race
 *                  is timing-deterministic (in-memory statements are fast and
 *                  tight, so concurrent SELECTs reliably precede the writes).
 *  - a file base — a fresh generation file per reset, one connection per
 *                  request. The hardened victim uses this so concurrent
 *                  BEGIN IMMEDIATE transactions contend on a real write lock.
 */
export class Database {
  private generation = 0;
  private currentPath: string;
  /** The immediately-previous generation, kept one cycle in case a straggler still holds it. */
  private previousPath: string | undefined;
  /** Memoized as a promise so concurrent first callers share one connection. */
  private sharedConn: Promise<Connection> | undefined;
  private readonly inMemory: boolean;

  constructor(private readonly basePath: string) {
    this.inMemory = basePath === ":memory:";
    this.currentPath = this.inMemory ? ":memory:" : `${basePath}.gen${this.generation}.db`;
  }

  /** Opens a fresh connection to the current generation, runs fn, closes it. */
  async withConnection<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    const conn = await openConnection(this.currentPath);
    try {
      return await fn(conn);
    } finally {
      await conn.close().catch(() => {});
    }
  }

  /**
   * The one long-lived connection, opened on first use — the module-level
   * singleton every Node tutorial reaches for. On the file backend, callers
   * grab it fresh each request so a straggler holds the pre-reset connection
   * and its late write errors harmlessly rather than crossing scenarios.
   */
  shared(): Promise<Connection> {
    if (!this.sharedConn) this.sharedConn = openConnection(this.currentPath);
    return this.sharedConn;
  }

  /**
   * Wipes and reseeds. In memory, `populate` runs against the persistent
   * connection in place (it drops and recreates the tables). On the file
   * backend, a fresh generation file is created and the shared connection is
   * re-pointed to it; the generation two back is retired now that SETTLE has
   * quiesced that scenario.
   */
  async reset(populate: (conn: Connection) => Promise<void>): Promise<void> {
    if (this.inMemory) {
      await populate(await this.shared());
      return;
    }

    const retired = this.previousPath;
    this.previousPath = this.currentPath;
    this.generation += 1;
    this.currentPath = `${this.basePath}.gen${this.generation}.db`;

    await this.withConnection(populate);

    if (this.sharedConn) {
      const old = await this.sharedConn.catch(() => undefined);
      this.sharedConn = openConnection(this.currentPath); // eagerly reopened against the new generation
      await old?.close().catch(() => {});
    }

    if (retired) await unlinkGeneration(retired);
  }

  /** Closes the shared connection and deletes remaining generation files (call on shutdown). */
  async cleanup(): Promise<void> {
    const shared = await this.sharedConn?.catch(() => undefined);
    await shared?.close().catch(() => {});
    if (!this.inMemory) {
      await Promise.all([this.previousPath, this.currentPath].filter(Boolean).map((p) => unlinkGeneration(p!)));
    }
  }
}
