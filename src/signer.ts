/**
 * Stripe webhook signing.
 *
 * The signature covers `${t}.${rawBody}`, so the bytes signed here must be
 * byte-for-byte the bytes POSTed to the victim — callers serialize the event
 * once and pass the same Buffer to both {@link signPayload} and the deliverer.
 * The v1 digest is always 64 hex characters, so a wrong-secret signature is a
 * same-length forgery, which is the honest way to test a length-guarded
 * timingSafeEqual comparison.
 */
import { createHmac } from "node:crypto";
import type { Dispatch } from "./types.js";

/**
 * Computes a `t=…,v1=…` Stripe-Signature header for the given body and
 * timestamp under `secret`. Signing with a secret other than the verifier's
 * produces a valid-format but rejected signature.
 */
export function signPayload(rawBody: Buffer, t: number, secret: string): string {
  const signedPayload = `${t}.${rawBody.toString("utf8")}`;
  const v1 = createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${t},v1=${v1}`;
}

/** How a dispatch's signature should be produced. */
export interface SigningDirective {
  /** "none" omits the header; any other value is a wrong secret to forge with. */
  signWith?: string;
}

/**
 * Builds the Stripe-Signature header for a dispatch, honouring signing faults:
 * omit it entirely, forge it with a wrong secret, or sign honestly.
 */
export function buildSignatureHeader(
  rawBody: Buffer,
  t: number,
  directive: SigningDirective,
  realSecret: string,
): string | null {
  if (directive.signWith === "none") return null;
  const secret = directive.signWith ?? realSecret;
  return signPayload(rawBody, t, secret);
}

/** Attaches a computed signature header to a dispatch (used by the fault engine). */
export function signDispatch(
  dispatch: Omit<Dispatch, "signatureHeader">,
  directive: SigningDirective,
  realSecret: string,
): Dispatch {
  return {
    ...dispatch,
    signatureHeader: buildSignatureHeader(dispatch.rawBody, dispatch.t, directive, realSecret),
  };
}
