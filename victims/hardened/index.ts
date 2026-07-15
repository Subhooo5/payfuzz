import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARDENED_VICTIM_PORT } from "../../src/config.js";
import { EmailTransport } from "../shared/email.js";
import { Database } from "../shared/sqlite.js";
import { createApp } from "./app.js";
import { resetDatabase } from "./db.js";

async function main(): Promise<void> {
  const db = new Database(join(tmpdir(), "payfuzz-hardened"));
  await resetDatabase(db, 0);

  const email = new EmailTransport();
  const app = createApp(db, email);
  const server = app.listen(HARDENED_VICTIM_PORT, () => {
    console.log(`victim-hardened listening on http://localhost:${HARDENED_VICTIM_PORT}`);
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
  console.error("victim-hardened failed to start:", err);
  process.exit(1);
});
