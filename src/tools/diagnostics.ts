import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserSession } from "../session.js";
import { defineTool, json, limitedJson } from "./util.js";

export function registerDiagnosticTools(server: McpServer, session: BrowserSession): void {
  defineTool(
    server,
    "network",
    {
      title: "Network log",
      description:
        "Inspect requests made by pages in this browser session: status, type, size, duration, " +
        "and failures. URLs are redacted according to BROWSER_MCP_REDACT_PARAMS.",
      inputSchema: {
        action: z.enum(["list", "summary", "clear"]).optional(),
        filter: z.string().optional().describe("Substring match on URL."),
        type: z.string().optional().describe("Resource type, e.g. document, script, xhr, fetch, image."),
        failed_only: z.boolean().optional(),
        status_min: z.number().int().min(100).max(599).optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const action = args.action ?? "list";
      if (action === "clear") {
        session.clearNetwork();
        return json({ cleared: true });
      }
      if (action === "summary") return json(session.networkSummary());
      return json({
        entries: session.networkEntries({
          filter: args.filter,
          type: args.type,
          failedOnly: args.failed_only,
          statusMin: args.status_min,
          limit: args.limit,
        }),
      });
    },
  );

  defineTool(
    server,
    "console",
    {
      title: "Console log",
      description:
        "Read console messages and page errors captured since launch. Note: Patchright stealth mode " +
        "disables the console API by design; use engine=chromium when console output matters.",
      inputSchema: {
        action: z.enum(["list", "clear"]).optional(),
        level: z.enum(["debug", "log", "info", "warning", "error", "pageerror"]).optional(),
        filter: z.string().optional(),
        limit: z.number().int().positive().max(300).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      if (args.action === "clear") {
        session.clearConsole();
        return json({ cleared: true });
      }
      const messages = session.consoleMessages({
        level: args.level,
        filter: args.filter,
        limit: args.limit,
      });
      return limitedJson({ count: messages.length, messages }, 20_000);
    },
  );

  defineTool(
    server,
    "perf",
    {
      title: "Performance",
      description:
        "Performance tools: web vitals (LCP/CLS/FCP/TTFB/long tasks), CDP runtime metrics, slowest " +
        "resources, a combined overview, or a Chrome trace. trace_start → do work → trace_stop " +
        "returns a summary and writes the full trace JSON to the artifact directory. " +
        "Use engine=chromium for full devtools fidelity.",
      inputSchema: {
        action: z.enum([
          "overview",
          "vitals",
          "metrics",
          "resources",
          "trace_start",
          "trace_stop",
        ]),
        limit: z.number().int().positive().max(200).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      switch (args.action) {
        case "vitals":
          return json(await session.vitals());
        case "metrics":
          return json(await session.perfMetrics());
        case "resources":
          return json({
            resources: await session.resourceTimings(args.limit ?? 25),
            network: session.networkSummary(),
          });
        case "trace_start":
          await session.startTrace();
          return json({ tracing: true, hint: "Perform the interaction, then call perf trace_stop." });
        case "trace_stop":
          return json(await session.stopTrace());
        case "overview":
          return json({
            engine: session.engine,
            vitals: await session.vitals(),
            metrics: await session.perfMetrics().catch((error) => ({
              error: (error as Error).message,
            })),
            resources: await session.resourceTimings(args.limit ?? 15),
            network: session.networkSummary(),
            downloads: session.listDownloads().slice(-5),
          });
        default:
          throw new Error(`unknown perf action ${args.action}`);
      }
    },
  );
}
