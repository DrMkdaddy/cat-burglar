import test from "node:test";
import assert from "node:assert/strict";
import { assessTargetRisk, gateRisk } from "../dist/risk.js";

test("high-impact verbs are flagged", () => {
  for (const name of ["Delete account", "Pay now", "Transfer funds", "Place order", "Unsubscribe"]) {
    assert.equal(assessTargetRisk({ name }).risk, "high", name);
  }
});

test("ordinary form actions are low risk", () => {
  for (const name of ["Sign in", "Save", "Create account", "Search", "Load more"]) {
    assert.equal(assessTargetRisk({ name }).risk, "low", name);
  }
});

test("warn policy allows but attaches a warning", () => {
  const assessment = assessTargetRisk({ name: "Delete account" });
  const gate = gateRisk(assessment, "warn", false);
  assert.equal(gate.allowed, true);
  assert.match(gate.warning ?? "", /high-impact/);
});

test("ask policy blocks without confirm and allows with confirm", () => {
  const assessment = assessTargetRisk({ name: "Pay now" });
  const blocked = gateRisk(assessment, "ask", false);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.error ?? "", /confirm:true/);
  const allowed = gateRisk(assessment, "ask", true);
  assert.equal(allowed.allowed, true);
});

test("off policy ignores high-impact targets", () => {
  const gate = gateRisk(assessTargetRisk({ name: "Delete account" }), "off", false);
  assert.equal(gate.allowed, true);
  assert.equal(gate.warning, undefined);
});
