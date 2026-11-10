import type { RiskPolicy } from "./config.js";

export type RiskLevel = "low" | "high";

export interface RiskAssessment {
  risk: RiskLevel;
  reasons: string[];
}

const HIGH_RISK =
  /\b(delete|remove|pay|purchase|place order|checkout|transfer|withdraw|send money|deactivate|close account|unsubscribe|cancel subscription|confirm payment|authorize)\b/i;

export function assessTargetRisk(
  target: { ref?: string; selector?: string; text?: string; role?: string; name?: string; key?: string },
  extra = "",
): RiskAssessment {
  const haystack = [target.text, target.name, target.selector, target.key, extra]
    .filter(Boolean)
    .join(" ");
  const reasons: string[] = [];
  if (HIGH_RISK.test(haystack)) reasons.push(`high-impact verb in target: ${haystack.slice(0, 120)}`);
  return { risk: reasons.length ? "high" : "low", reasons };
}

export interface RiskGate {
  allowed: boolean;
  warning?: string;
  error?: string;
  risk: RiskAssessment;
}

export function gateRisk(
  assessment: RiskAssessment,
  policy: RiskPolicy,
  confirmed: boolean,
): RiskGate {
  if (assessment.risk === "low" || policy === "off") {
    return { allowed: true, risk: assessment };
  }
  const reason = assessment.reasons.join("; ");
  const warning =
    `WARNING: this looks like a high-impact action (${reason}). ` +
    "Confirm with the user before proceeding.";
  if (policy === "ask" && !confirmed) {
    return {
      allowed: false,
      risk: assessment,
      warning,
      error:
        `${warning} The server policy is "ask": repeat the call with confirm:true after the user approves.`,
    };
  }
  return { allowed: true, risk: assessment, warning };
}
