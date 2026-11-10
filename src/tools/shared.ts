import { z } from "zod";

export const engineEnum = z.enum(["patchright", "chromium", "obscura"]);

export const targetShape = {
  ref: z
    .string()
    .optional()
    .describe("Element ref from the latest snapshot, e.g. e12. Preferred over selectors."),
  selector: z.string().optional().describe("CSS selector (use when no ref is available)."),
  text: z.string().optional().describe("Visible text to match (first match wins)."),
  role: z
    .string()
    .optional()
    .describe("ARIA role, e.g. button, link, textbox, checkbox, combobox."),
  name: z.string().optional().describe("Accessible name to combine with role."),
  exact: z.boolean().optional().describe("Require exact text/name match."),
  confirm: z
    .boolean()
    .optional()
    .describe("Confirm a high-impact action when the server policy is ask."),
  observe: z
    .boolean()
    .optional()
    .describe("Return a compact change observation after the action (default true)."),
};

export const targetDescription =
  "Target one of: ref (preferred), selector, text, or role+name.";

export function describeTarget(target: {
  ref?: string;
  selector?: string;
  text?: string;
  role?: string;
  name?: string;
}): string {
  if (target.ref) return `ref=${target.ref}`;
  if (target.selector) return `selector=${target.selector}`;
  if (target.role) return `${target.role}${target.name ? ` "${target.name}"` : ""}`;
  if (target.text) return `text "${target.text}"`;
  return "target";
}
