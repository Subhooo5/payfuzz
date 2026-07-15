import { NAIVE_VICTIM_PORT } from "../../src/config.js";
import { EmailTransport } from "../shared/email.js";
import { Database } from "../shared/sqlite.js";
import { createApp } from "./app.js";
import { resetDatabase } from "./db.js";

async function main(): Promise<void> {
  // A single in-process shared connection — the singleton every Node tutorial
  // ships. Combined with check-then-act, it races deterministically.
  const db = new Database(":memory:");
  await resetDatabase(db, 0);

  const email = new EmailTransport();
  const app = createApp(db, email);
  const server = app.listen(NAIVE_VICTIM_PORT, () => {
    console.log(`victim-naive listening on http://localhost:${NAIVE_VICTIM_PORT}`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await db.cleanup();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("victim-naive failed to start:", err);
  process.exit(1);
});
