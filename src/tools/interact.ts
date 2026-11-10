import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { BrowserSession } from "../session.js";
import { assessTargetRisk, gateRisk } from "../risk.js";
import { formatObservation } from "./format.js";
import { defineTool, imageResult, json, text } from "./util.js";
import { detectCaptcha } from "../page-scripts.js";
import { describeTarget, targetDescription, targetShape } from "./shared.js";

function toTarget(args: {
  ref?: string;
  selector?: string;
  text?: string;
  role?: string;
  name?: string;
  exact?: boolean;
}): {
  ref?: string;
  selector?: string;
  text?: string;
  role?: string;
  name?: string;
  exact?: boolean;
} {
  return {
    ref: args.ref,
    selector: args.selector,
    text: args.text,
    role: args.role,
    name: args.name,
    exact: args.exact,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function registerInteractionTools(
  server: McpServer,
  session: BrowserSession,
  config: Config,
): void {
  const riskGate = (args: {
    ref?: string;
    selector?: string;
    text?: string;
    role?: string;
    name?: string;
    key?: string;
    confirm?: boolean;
  }): { error?: string; warning?: string } => {
    const assessment = assessTargetRisk(args);
    const gate = gateRisk(assessment, config.riskyActionPolicy, args.confirm === true);
    return { ...(gate.allowed ? {} : { error: gate.error }), ...(gate.warning ? { warning: gate.warning } : {}) };
  };

  const finish = async (
    tool: string,
    args: Record<string, unknown>,
    summary: string,
    warning?: string,
    observeByDefault = true,
  ): Promise<ReturnType<typeof text>> => {
    session.recordAction(tool, args);
    const shouldObserve = args.observe === false ? false : args.observe === true || observeByDefault;
    if (!shouldObserve) {
      return text([warning, summary].filter(Boolean).join("\n\n"));
    }
    let body: string;
    try {
      const observation = await session.observe();
      body = formatObservation(observation, session.limits.observationChars);
    } catch (error) {
      body = `Observation unavailable: ${(error as Error).message}`;
    }
    return text([warning, summary, body].filter(Boolean).join("\n\n"));
  };

  defineTool(
    server,
    "click",
    {
      title: "Click",
      description:
        `Click an element. ${targetDescription} Humanized mouse movement is used by default. ` +
        "Returns a compact change observation so you rarely need a second snapshot.",
      inputSchema: {
        ...targetShape,
        button: z.enum(["left", "right", "middle"]).optional(),
        click_count: z.number().int().min(1).max(3).optional(),
        humanize: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const risk = riskGate(args);
      if (risk.error) return text(risk.error, true);
      await session.click(toTarget(args), {
        button: args.button,
        clickCount: args.click_count,
        humanize: args.humanize,
      });
      return finish("click", args, `Clicked ${describeTarget(args)}.`, risk.warning);
    },
  );

  defineTool(
    server,
    "fill",
    {
      title: "Fill input",
      description:
        `Set an input/textarea/contenteditable value in one call (fires input + change). ${targetDescription}`,
      inputSchema: {
        ...targetShape,
        value: z.string().describe("Value to set."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const risk = riskGate(args);
      if (risk.error) return text(risk.error, true);
      await session.fill(toTarget(args), args.value);
      return finish(
        "fill",
        args,
        `Filled ${describeTarget(args)} (${args.value.length} chars).`,
        risk.warning,
        false,
      );
    },
  );

  defineTool(
    server,
    "type",
    {
      title: "Type text",
      description:
        `Type into a field with humanized per-character delays. ${targetDescription} ` +
        "Use fill for long values or speed; use type for keystroke-driven UIs.",
      inputSchema: {
        ...targetShape,
        text: z.string().describe("Text to type."),
        delay_ms: z.number().int().min(0).max(2_000).optional().describe("Fixed delay per char."),
        clear: z.boolean().optional().describe("Clear the field first."),
        submit: z.boolean().optional().describe("Press Enter after typing."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const risk = riskGate(args);
      if (risk.error) return text(risk.error, true);
      await session.type(toTarget(args), args.text, {
        delay: args.delay_ms,
        clear: args.clear,
        submit: args.submit,
      });
      return finish(
        "type",
        args,
        `Typed into ${describeTarget(args)} (${args.text.length} chars).`,
        risk.warning,
        false,
      );
    },
  );

  defineTool(
    server,
    "press",
    {
      title: "Press key",
      description:
        "Press a keyboard key (Enter, Escape, Tab, ArrowDown, Control+A…). Optionally focus a target first.",
      inputSchema: {
        key: z.string().describe("Playwright key name, e.g. Enter or Control+A."),
        ref: targetShape.ref,
        selector: targetShape.selector,
        confirm: targetShape.confirm,
        observe: targetShape.observe,
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const risk = riskGate(args);
      if (risk.error) return text(risk.error, true);
      if (args.ref || args.selector) {
        await session.click({ ref: args.ref, selector: args.selector }, { humanize: false });
      }
      await session.press(args.key);
      return finish("press", args, `Pressed ${args.key}.`, risk.warning);
    },
  );

  defineTool(
    server,
    "select",
    {
      title: "Select option",
      description: `Choose one or more <option> values in a select element. ${targetDescription}`,
      inputSchema: {
        ...targetShape,
        values: z.array(z.string()).min(1).describe("Option values or labels."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const risk = riskGate(args);
      if (risk.error) return text(risk.error, true);
      const selected = await session.select(toTarget(args), args.values);
      return finish(
        "select",
        args,
        `Selected ${JSON.stringify(selected)} on ${describeTarget(args)}.`,
        risk.warning,
      );
    },
  );

  defineTool(
    server,
    "hover",
    {
      title: "Hover",
      description: `Move the mouse over an element (menus, tooltips). ${targetDescription}`,
      inputSchema: { ...targetShape },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      await session.hover(toTarget(args));
      return json({ hovered: describeTarget(args) });
    },
  );

  defineTool(
    server,
    "scroll",
    {
      title: "Scroll",
      description:
        "Scroll the page by direction/amount, to the top/bottom, or bring an element into view. " +
        "Humanized wheel events by default.",
      inputSchema: {
        direction: z.enum(["up", "down", "left", "right", "top", "bottom"]).optional(),
        amount: z.number().int().positive().optional().describe("Pixels (default 600)."),
        ref: targetShape.ref,
        selector: targetShape.selector,
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const result = await session.scroll({
        direction: args.direction,
        amount: args.amount,
        ref: args.ref,
        selector: args.selector,
      });
      return json(result);
    },
  );

  defineTool(
    server,
    "upload",
    {
      title: "Upload files",
      description:
        "Attach local files to a file input. Paths are resolved from the current directory; ~ is expanded.",
      inputSchema: {
        ...targetShape,
        paths: z.array(z.string()).min(1).describe("Local file paths."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const risk = riskGate(args);
      if (risk.error) return text(risk.error, true);
      const paths = args.paths.map(expandHome);
      for (const path of paths) {
        if (!existsSync(path)) throw new Error(`file not found: ${path}`);
      }
      const count = await session.upload(toTarget(args), paths);
      return finish("upload", args, `Uploaded ${count} file(s) to ${describeTarget(args)}.`, risk.warning);
    },
  );

  defineTool(
    server,
    "captcha",
    {
      title: "CAPTCHA check",
      description:
        "Detect reCAPTCHA, hCaptcha, Turnstile, DataDome, PerimeterX, Arkose, or text challenges. " +
        "Returns a screenshot and a manual handoff flag. It does not solve CAPTCHAs.",
      inputSchema: {
        action: z.enum(["detect", "handoff", "status", "wait", "screenshot", "close_handoff"]).optional(),
        timeout_ms: z.number().int().positive().max(300_000).optional(),
        open_window: z.boolean().optional().describe("Open the local handoff URL in the default browser."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const page = await session.page();
      const action = args.action ?? "detect";
      let report = await page.evaluate(detectCaptcha);
      if (action === "status") {
        return json({ report, handoff: session.handoffStatus() });
      }
      if (action === "close_handoff") {
        await session.stopHandoff();
        return json({ closed: true, report });
      }
      if (action === "handoff") {
        if (!report.detected) return json({ report, handoff: null });
        const handoff = await session.startHandoff({
          openWindow: args.open_window ?? true,
          timeoutMs: args.timeout_ms,
        });
        return json({
          report,
          handoff,
          requires_human: true,
          instructions:
            handoff.mode === "local"
              ? "A local solve window was opened. Solve the challenge, click Done, then call captcha with action=wait."
              : "Open the provider live view, solve the challenge, then call captcha with action=wait.",
        });
      }
      if (action === "wait") {
        const started = Date.now();
        const timeout = args.timeout_ms ?? 60_000;
        while (report.detected && Date.now() - started < timeout) {
          await sleep(1_000);
          report = await page.evaluate(detectCaptcha);
        }
      }
      if (action === "wait" && !report.detected) {
        await session.stopHandoff();
      }
      if (action === "screenshot" || report.detected) {
        const shot = await session.screenshot({});
        return imageResult(
          shot.buffer,
          `${JSON.stringify(report, null, 2)}
${
            report.detected
              ? "Manual handoff required. Switch to headless:false or complete the challenge in the browser."
              : "No challenge detected."
          }`,
        );
      }
      return text(JSON.stringify(report, null, 2));
    },
  );

  defineTool(
    server,
    "wait",
    {
      title: "Wait",
      description:
        "Wait for a selector or text to become visible, or wait a fixed number of milliseconds. " +
        "Prefer this over sleep loops after triggering async UI.",
      inputSchema: {
        selector: z.string().optional(),
        text: z.string().optional(),
        timeout_ms: z.number().int().positive().max(120_000).optional(),
        state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      if (!args.selector && !args.text && !args.timeout_ms) {
        throw new Error("provide selector, text, or timeout_ms");
      }
      await session.waitFor({
        selector: args.selector,
        text: args.text,
        timeout: args.timeout_ms,
        state: args.state,
      });
      return json({ waited: true, selector: args.selector, text: args.text });
    },
  );
}
