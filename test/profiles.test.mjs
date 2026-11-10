import test from "node:test";
import assert from "node:assert/strict";
import { PROFILES, resolveProfile } from "../dist/profiles.js";

test("profiles scale observation budgets with model capability", () => {
  assert.ok(PROFILES.local.snapshotChars < PROFILES.flash.snapshotChars);
  assert.ok(PROFILES.flash.snapshotChars < PROFILES.frontier.snapshotChars);
  assert.ok(PROFILES.local.observationChars < PROFILES.flash.observationChars);
  assert.ok(PROFILES.flash.observationChars < PROFILES.frontier.observationChars);
  assert.equal(PROFILES.local.diffDefault, true);
  assert.equal(PROFILES.frontier.diffDefault, false);
});

test("auto resolves to the flash-safe profile until probing exists", () => {
  assert.deepEqual(resolveProfile("auto"), PROFILES.flash);
  assert.deepEqual(resolveProfile("frontier"), PROFILES.frontier);
});
