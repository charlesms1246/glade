import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "./http";

export interface Offer<P> {
  plan: P;
  hash: string;
  tag: string;
  passkey: Parameters<typeof startAuthentication>[0]["optionsJSON"];
}

/** Ask the passkey to sign the plan hash, then hand plan + assertion to the server. */
export async function approve<P, R>(offer: Offer<P>, confirmPath: string): Promise<R> {
  const assertion = await startAuthentication({ optionsJSON: offer.passkey });
  return api<R>(confirmPath, { plan: offer.plan, tag: offer.tag, assertion });
}
