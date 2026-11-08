import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interpretClaudeAuthStatus } from "../src/auth.ts";

describe("interpretClaudeAuthStatus", () => {
  it("logged out -> not logged in", () => {
    assert.deepEqual(interpretClaudeAuthStatus({ loggedIn: false }), {
      loggedIn: false,
      detail: "auth-status-logged-out",
      authMethod: "none",
    });
  });
  it("api key only -> not logged in", () => {
    const r = interpretClaudeAuthStatus({ loggedIn: true, authMethod: "api-key" });
    assert.equal(r.loggedIn, false);
    assert.equal(r.detail, "api-key-only");
  });
  it("bedrock provider -> not logged in", () => {
    const r = interpretClaudeAuthStatus({ loggedIn: true, authMethod: "oauth", apiProvider: "bedrock" });
    assert.equal(r.loggedIn, false);
    assert.equal(r.detail, "third-party-provider");
  });
  it("oauth subscription -> logged in", () => {
    const r = interpretClaudeAuthStatus({ loggedIn: true, authMethod: "oauth" });
    assert.equal(r.loggedIn, true);
  });
  it("invalid payload -> not logged in", () => {
    assert.equal(interpretClaudeAuthStatus(null).loggedIn, false);
  });
});
