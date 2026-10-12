import { describe, expect, it } from "vitest";
import { requirePermission, SEND_SCOPE, STATUS_SCOPE } from "../../src/auth/policy.js";

describe("owner and scope authorization", () => {
  it("allows the configured owner only for an explicitly granted scope", () => {
    const principal = { subject: "owner", scopes: [SEND_SCOPE], clientId: "client" };
    expect(() => requirePermission(principal, "owner", SEND_SCOPE)).not.toThrow();
    expect(() => requirePermission(principal, "other", SEND_SCOPE)).toThrow(
      "FORBIDDEN_OWNER",
    );
    expect(() => requirePermission(principal, "owner", STATUS_SCOPE)).toThrow(
      "INSUFFICIENT_SCOPE",
    );
  });
});
