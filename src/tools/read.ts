import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { BrowserSession } from "../session.js";
import { readableToMarkdown } from "../markdown.js";
import { describeArtifact } from "../artifacts.js";
import { defineTool, imageResult, json, limitedJson, text, truncate } from "./util.js";
import { formatSnapshotResult, UNTRUSTED_NOTICE } from "./format.js";

export function registerReadTools(
  server: McpServer,
  session: BrowserSession,
  config: Config,
): void {
  defineTool(
    server,
    "snapshot",
    {
      title: "Snapshot page",
      description:
        "Compact view of the current page: URL, title, actionable elements with refs (e1, e2…), " +
        "control states, and visible text. Refs stay stable while the element remains in the DOM; a " +
        "new snapshot does not renumber them. Use diff=true (or since=sN) to see only changes since " +
        "the last observation. Prefer refs over CSS selectors.",
      inputSchema: {
        max_chars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Character budget (profile default). Controls get priority over body text."),
        max_controls: z.number().int().positive().optional().describe("Max controls (profile default)."),
        include_text: z.boolean().optional().describe("Include visible body text (default true)."),
        diff: z
          .boolean()
          .optional()
          .describe("Return only changes since the previous snapshot. Profile default applies."),
        since: z
          .string()
          .optional()
          .describe("Diff against a specific snapshot id (e.g. s4) instead of the latest."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const maxChars = args.max_chars ?? session.limits.snapshotChars;
      const result = await session.snapshot(
        maxChars,
        args.max_controls ?? session.limits.maxControls,
        args.since,
      );
      const diffMode =
        args.diff ?? (args.since !== undefined ? true : session.limits.diffDefault);
      return text(
        formatSnapshotResult(result, maxChars, args.include_text ?? true, Boolean(diffMode)),
      );
    },
  );

  defineTool(
    server,
    "markdown",
    {
      title: "Read as Markdown",
      description:
        "Extract the main readable content of the current page as Markdown (article/main detection, " +
        "boilerplate removal, absolute links). Best for articles, docs, and research. " +
        "Use snapshot instead when you need to interact.",
      inputSchema: {
        max_chars: z.number().int().positive().optional().describe("Default 8000."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const maxChars = args.max_chars ?? session.limits.markdownChars;
      const readable = await session.markdown();
      const result = readableToMarkdown(readable, maxChars);
      return text(
        `${UNTRUSTED_NOTICE}\n\n${result.markdown}\n\n---\nchars: ${result.chars}${
          result.truncated ? " (truncated)" : ""
        }`,
      );
    },
  );

  defineTool(
    server,
    "extract",
    {
      title: "Extract structured data",
      description:
        "Deterministic extraction from the current page. Modes: links, tables, jsonld, meta, " +
        "selector (CSS map), text. No LLM involved; pair with snapshot/markdown when you need " +
        "to locate a selector first.",
      inputSchema: {
        mode: z.enum(["links", "tables", "jsonld", "meta", "selector", "text"]),
        selector: z
          .record(
            z.string(),
            z.union([
              z.string(),
              z.object({
                selector: z.string(),
                attr: z.string().optional(),
                all: z.boolean().optional(),
              }),
            ]),
          )
          .optional()
          .describe('For mode=selector: { field: "css" | { selector, attr?, all? } }'),
        limit: z.number().int().positive().optional().describe("Max items (default 100)."),
        max_chars: z.number().int().positive().optional().describe("JSON output cap (default 16000)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const value = await session.extract(args.mode, {
        selector: args.selector,
        limit: args.limit,
      });
      let rendered: string;
      try {
        rendered = JSON.stringify(value, null, 2);
      } catch {
        rendered = String(value);
      }
      return text(
        `${UNTRUSTED_NOTICE}\n\n${truncate(rendered, args.max_chars ?? 16_000, "JSON")}`,
      );
    },
  );

  defineTool(
    server,
    "evaluate",
    {
      title: "Evaluate JavaScript",
      description:
        "Evaluate a JavaScript expression in the page and return its value as JSON. Promises are awaited. " +
        "Use for data extraction or page state, not for navigation (prefer navigate).",
      inputSchema: {
        expression: z.string().describe("JavaScript expression, e.g. document.title"),
        max_chars: z.number().int().positive().optional().describe("Output cap (default 8000)."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const value = await session.evaluate(args.expression);
      let rendered: string;
      try {
        rendered = JSON.stringify(value, null, 2) ?? String(value);
      } catch {
        rendered = String(value);
      }
      return text(
        `${UNTRUSTED_NOTICE}\n\n${truncate(rendered, args.max_chars ?? 8_000, "result")}`,
      );
    },
  );

  defineTool(
    server,
    "screenshot",
    {
      title: "Screenshot",
      description:
        "Capture the viewport, full page, or a single element as PNG. The image is returned inline; " +
        "an optional path saves a copy under the artifact directory.",
      inputSchema: {
        full_page: z.boolean().optional(),
        selector: z.string().optional().describe("Capture only this element."),
        path: z.string().optional().describe("Save path relative to the artifact directory."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await session.screenshot({
        fullPage: args.full_page,
        selector: args.selector,
        path: args.path,
      });
      const page = await session.page();
      const caption = [
        `Screenshot of ${page.url()}`,
        `title: ${await page.title().catch(() => "")}`,
        `size: ${(result.buffer.length / 1024).toFixed(1)} KiB`,
        result.path ? `saved: ${result.path}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return imageResult(result.buffer, caption);
    },
  );

  defineTool(
    server,
    "pdf",
    {
      title: "Export PDF",
      description: "Render the current page to PDF and save it under the artifact directory.",
      inputSchema: {
        path: z.string().optional(),
        landscape: z.boolean().optional(),
        print_background: z.boolean().optional(),
        format: z.enum(["A4", "Letter", "Legal", "A3", "A5"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await session.pdf({
        path: args.path,
        landscape: args.landscape,
        printBackground: args.print_background,
        format: args.format,
      });
      return json({
        path: result.path,
        bytes: result.buffer.length,
        saved: describeArtifact(result.path, result.buffer.length),
      });
    },
  );
}
