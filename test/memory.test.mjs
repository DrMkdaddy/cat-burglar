import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteMemoryStore, canonicalOrigin, compactHint } from "../dist/memory.js";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "browser-mcp-memory-"));
  return { dir, memory: new SiteMemoryStore(join(dir, "memory.json")) };
}

test("canonicalOrigin normalizes and rejects invalid URLs", () => {
  assert.equal(canonicalOrigin("HTTPS://Example.com/path?q=1"), "https://example.com");
  assert.equal(canonicalOrigin("http://127.0.0.1:3000/a"), "http://127.0.0.1:3000");
  assert.equal(canonicalOrigin("not a url"), "");
});

test("hints and workflows round-trip with provenance", () => {
  const { dir, memory } = store();
  try {
    const hint = memory.put("https://example.com", {
      kind: "hint",
      name: "email field",
      text: "Email input uses #email",
    });
    assert.equal(hint.source, "agent");
    assert.equal(hint.kind, "hint");

    const workflow = memory.learn("https://example.com", "sign in", [
      { tool: "fill", arguments: { selector: "#user", value: "{{value}}" } },
      { tool: "click", arguments: { role: "button", name: "Sign in" } },
    ]);
    assert.equal(workflow.kind, "workflow");
    assert.equal(workflow.steps?.length, 2);

    assert.equal(memory.hints("https://example.com", 5).length, 1);
    assert.equal(memory.workflows("https://example.com", 5).length, 1);
    assert.equal(memory.get("https://example.com", hint.id)?.name, "email field");

    const compact = compactHint(hint);
    assert.equal(compact.name, "email field");
    assert.equal(compact.source, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("touch updates usage and confidence; failure lowers it", () => {
  const { dir, memory } = store();
  try {
    const hint = memory.put("https://example.com", { kind: "hint", text: "hint" });
    const before = hint.confidence;
    memory.touch("https://example.com", hint.id, true);
    const afterSuccess = memory.get("https://example.com", hint.id);
    assert.equal(afterSuccess?.uses, 1);
    assert.ok((afterSuccess?.confidence ?? 0) > before);
    const successConfidence = afterSuccess?.confidence ?? 0;
    memory.touch("https://example.com", hint.id, false);
    assert.ok((memory.get("https://example.com", hint.id)?.confidence ?? 1) < successConfidence);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove and clear are scoped to an origin", () => {
  const { dir, memory } = store();
  try {
    const hint = memory.put("https://a.example", { kind: "hint", text: "a" });
    memory.put("https://b.example", { kind: "hint", text: "b" });
    assert.equal(memory.remove("https://a.example", hint.id), true);
    assert.equal(memory.list("https://a.example").length, 0);
    assert.equal(memory.clear("https://b.example"), 1);
    assert.equal(memory.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow memory requires steps", () => {
  const { dir, memory } = store();
  try {
    assert.throws(() => memory.put("https://example.com", { kind: "workflow", name: "empty" }), /steps/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
