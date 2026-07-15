/**
 * Webhook signature verification, hand-rolled from the Stripe docs.
 *
 * Checks that the v1 signature in the Stripe-Signature header is a valid
 * HMAC-SHA256 of `${t}.${rawBody}` under our signing secret.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: {
    object: Record<string, any>;
  };
}

/**
 * Verifies the Stripe-Signature header and returns the parsed event.
 * Throws when the header is missing, malformed, or the signature is wrong.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): StripeEvent {
  if (!signatureHeader) {
    throw new Error("missing Stripe-Signature header");
  }

  let timestamp: string | undefined;
  let signature: string | undefined;
  for (const part of signatureHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1" && signature === undefined) signature = value;
  }
  if (!timestamp || !signature) {
    throw new Error("malformed Stripe-Signature header");
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    throw new Error("signature mismatch");
  }

  return JSON.parse(rawBody.toString("utf8")) as StripeEvent;
}
