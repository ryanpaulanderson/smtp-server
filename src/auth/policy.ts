/** OAuth authorization policy independent of token transport and key fetching. */
import { MailError } from "../mail/contracts";

/** Tool permissions granted by the selected identity provider. */
export const SEND_SCOPE = "email:send:self";
export const STATUS_SCOPE = "email:status:self";

/** Authenticated claims are still subject to the owner and scope boundary. */
export interface Principal {
  subject: string;
  scopes: readonly string[];
  clientId: string;
}

/** Require the configured immutable owner and an exact tool permission. */
export function requirePermission(
  principal: Principal,
  owner: string,
  scope: string,
): void {
  if (principal.subject !== owner) throw new MailError("FORBIDDEN_OWNER");
  if (!principal.scopes.includes(scope)) throw new MailError("INSUFFICIENT_SCOPE");
}
