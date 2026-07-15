/**
 * Webhook signature verification for the hardened service.
 *
 * Uses Stripe's own library instead of a hand-rolled HMAC check, so it gets
 * the 300s timestamp tolerance window for free — a replayed 25-hour-old request
 * is rejected, not just a wrong signature. `constructEvent` is pure HMAC: the
 * dummy key `sk_test_dummy` never touches the network, which is what lets this
 * (and all of payfuzz) run offline in CI.
 */
import Stripe from "stripe";

const stripe = new Stripe("sk_test_dummy");

export interface WebhookEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, any> };
}

/**
 * Verifies the signature and freshness of a webhook and returns the event.
 * Throws when the signature is invalid or the timestamp is outside tolerance.
 */
export function constructWebhookEvent(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): WebhookEvent {
  return stripe.webhooks.constructEvent(rawBody, signatureHeader ?? "", secret) as unknown as WebhookEvent;
}
