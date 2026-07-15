/**
 * The one unit test SPEC §7 allows: proof that payfuzz produces signatures
 * Stripe's own library accepts, and that a wrong-secret forgery is rejected.
 *
 * constructEvent is pure HMAC — no network, no API key beyond a dummy — so
 * this (and all of payfuzz) runs fully offline, which is what lets CI run
 * without a Stripe account.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { signPayload } from "../src/signer.ts";

const stripe = new Stripe("sk_test_dummy");
const REAL_SECRET = "whsec_" + "a".repeat(48);
const WRONG_SECRET = "whsec_" + "b".repeat(48); // same length: an honest forgery

function body(): Buffer {
  return Buffer.from(JSON.stringify({ id: "evt_signer_test", type: "payment_intent.succeeded", created: 0 }), "utf8");
}

test("Stripe constructEvent accepts a payfuzz-signed payload", () => {
  const raw = body();
  const t = Math.floor(Date.now() / 1000);
  const header = signPayload(raw, t, REAL_SECRET);

  const event = stripe.webhooks.constructEvent(raw, header, REAL_SECRET);
  assert.equal(event.id, "evt_signer_test");
});

test("Stripe constructEvent rejects a same-length wrong-secret forgery", () => {
  const raw = body();
  const t = Math.floor(Date.now() / 1000);
  const forged = signPayload(raw, t, WRONG_SECRET);

  const [, v1] = forged.split(",v1=");
  assert.equal(v1!.length, 64, "a forged v1 must be a full-length sha256 digest, not a short string");

  assert.throws(() => stripe.webhooks.constructEvent(raw, forged, REAL_SECRET), /signature/i);
});
