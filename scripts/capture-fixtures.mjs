#!/usr/bin/env node
/**
 * One-time fixture capture utility.
 *
 * Captures authentic Stripe event bodies into fixtures/ so payfuzz can
 * replay and re-sign them offline. Usage:
 *
 *   node scripts/capture-fixtures.mjs                    # this listener
 *   stripe listen --forward-to localhost:9999/capture    # separate terminal
 *   stripe trigger payment_intent.succeeded              # once per event type
 *   stripe trigger charge.refunded
 *   stripe trigger customer.subscription.updated
 *   stripe trigger customer.subscription.deleted
 *
 * `stripe trigger` fires a cascade of related events (e.g. payment_intent.created
 * before payment_intent.succeeded); only the types listed in CAPTURE_TYPES are
 * saved. Bodies are written verbatim apart from pretty-printing — the data is
 * never edited. The process exits 0 once every expected type has been captured.
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CAPTURE_TYPES = new Set([
  "payment_intent.succeeded",
  "charge.refunded",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

const PORT = 9999;
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

mkdirSync(FIXTURES_DIR, { recursive: true });

const captured = new Set();

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    // Always ack immediately — the Stripe CLI retries non-2xx responses.
    res.writeHead(200).end();

    let event;
    try {
      event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      console.warn("skipped: non-JSON request body");
      return;
    }

    if (!CAPTURE_TYPES.has(event.type)) {
      console.log(`skipped: ${event.type ?? "<no type>"}`);
      return;
    }
    if (captured.has(event.type)) {
      console.log(`already captured: ${event.type}`);
      return;
    }

    const file = join(FIXTURES_DIR, `${event.type}.json`);
    writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`);
    captured.add(event.type);
    console.log(`captured: ${event.type} → fixtures/${event.type}.json (${captured.size}/${CAPTURE_TYPES.size})`);

    if (captured.size === CAPTURE_TYPES.size) {
      console.log("all fixtures captured — shutting down.");
      server.close(() => process.exit(0));
    }
  });
});

server.listen(PORT, () => {
  console.log(`fixture capture listening on http://localhost:${PORT}/capture`);
  console.log(`waiting for: ${[...CAPTURE_TYPES].join(", ")}`);
});
