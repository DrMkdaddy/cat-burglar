import test from "node:test";
import assert from "node:assert/strict";
import { diffControls, textDelta } from "../dist/diff.js";

const control = (ref, role, name, extra = {}) => ({
  ref,
  role,
  name,
  tag: "input",
  states: [],
  ...extra,
});

test("diff detects added, removed, changed, and unchanged controls by ref", () => {
  const previous = [
    control("e1", "textbox", "Email", { value: "" }),
    control("e2", "button", "Save"),
    control("e3", "link", "Old"),
  ];
  const next = [
    control("e1", "textbox", "Email", { value: "a@b.co" }),
    control("e2", "button", "Save"),
    control("e4", "button", "Continue"),
  ];
  const diff = diffControls(previous, next);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].ref, "e4");
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].ref, "e3");
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].ref, "e1");
  assert.match(diff.changed[0].changes.join(" "), /value/);
  assert.equal(diff.unchanged, 1);
});

test("diff compares control state changes", () => {
  const previous = [control("e1", "checkbox", "Remember", { states: [] })];
  const next = [control("e1", "checkbox", "Remember", { states: ["checked"] })];
  const diff = diffControls(previous, next);
  assert.equal(diff.changed.length, 1);
  assert.match(diff.changed[0].changes.join(" "), /states/);
});

test("textDelta returns null for identical text and a bounded change otherwise", () => {
  assert.equal(textDelta("hello world", "hello world"), null);
  const delta = textDelta("The status is idle.", "The status is recovered.", 200);
  assert.ok(delta);
  assert.match(delta.after, /recovered/);
  assert.ok(delta.after.length <= 200);
});

test("textDelta handles a large shared prefix without returning the whole page", () => {
  const prefix = "A".repeat(20_000);
  const delta = textDelta(`${prefix} old`, `${prefix} new`, 120);
  assert.ok(delta);
  assert.ok(delta.after.length <= 120);
  assert.match(delta.after, /new/);
});
