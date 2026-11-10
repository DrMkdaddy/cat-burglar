import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { safeArtifactPath, slugify } from "../dist/artifacts.js";

const root = resolve("/tmp/browser-mcp-artifacts");

test("artifact paths stay inside the artifact directory", () => {
  assert.equal(safeArtifactPath(root, "shot", "page", ".png"), join(root, "shot.png"));
  assert.throws(() => safeArtifactPath(root, "../escape.png", "page", ".png"), /must stay inside/);
  assert.throws(() => safeArtifactPath(root, "/etc/passwd", "page", ".png"), /must stay inside/);
});

test("slugify produces stable filenames", () => {
  assert.equal(slugify("https://example.com/A Post!"), "example-com-a-post");
  assert.equal(slugify("!!!"), "artifact");
});
