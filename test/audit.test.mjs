import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeAuditArgs } from "../dist/audit.js";

test("audit arguments redact secrets and typed values", () => {
  const args = sanitizeAuditArgs("fill", {
    ref: "e1",
    value: "hunter2",
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(args.ref, "e1");
  assert.equal(args.value, "[redacted]");
  assert.deepEqual(args.headers, "[redacted]");
});

test("audit arguments redact proxy URLs and cookies", () => {
  const proxy = sanitizeAuditArgs("proxy", {
    action: "add",
    url: "http://user:pass@proxy.example:8080",
  });
  assert.equal(proxy.url, "[redacted]");
  const state = sanitizeAuditArgs("storage", {
    action: "import",
    state: { cookies: [{ value: "secret" }] },
  });
  assert.equal(state.state, "[redacted]");
});

test("audit arguments keep useful non-secret targets", () => {
  const args = sanitizeAuditArgs("click", { ref: "e12", button: "left" });
  assert.deepEqual(args, { ref: "e12", button: "left" });
});
