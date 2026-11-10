import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sanitizeAuditArgs, type AuditLog } from "../audit.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

export function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

export function json(value: unknown, isError = false): ToolResult {
  return text(JSON.stringify(value, null, 2), isError);
}

export function imageResult(buffer: Buffer, caption?: string): ToolResult {
  const content: ContentBlock[] = [];
  if (caption) content.push({ type: "text", text: caption });
  content.push({ type: "image", data: buffer.toString("base64"), mimeType: "image/png" });
  return { content };
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function truncate(value: string, max: number, label = "output"): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n… [${label} truncated at ${max} chars]`;
}

export function limitedJson(value: unknown, max = 16_000): ToolResult {
  return text(truncate(JSON.stringify(value, null, 2), max, "JSON"));
}

/** 
 * Thin wrapper around McpServer.registerTool that keeps the tool registration
 * code readable while letting the SDK infer schemas from zod raw shapes.
 */

const SLIM_TOOLS = new Set([
  "open",
  "close",
  "navigate",
  "status",
  "snapshot",
  "markdown",
  "extract",
  "evaluate",
  "screenshot",
  "click",
  "fill",
  "press",
  "select",
  "wait",
]);

let toolset: "full" | "slim" = "full";
let auditLog: AuditLog | null = null;
let auditOrigin: (() => string | undefined) | null = null;

export function configureAudit(log: AuditLog, origin: () => string | undefined): void {
  auditLog = log;
  auditOrigin = origin;
}

export function configureToolset(mode: "full" | "slim"): void {
  toolset = mode;
}

export function isToolEnabled(name: string): boolean {
  return toolset === "full" || SLIM_TOOLS.has(name);
}

export function defineTool(
  server: McpServer,
  name: string,
  meta: {
    title: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  },
  handler: (args: any) => Promise<ToolResult> | ToolResult,
): void {
  if (!isToolEnabled(name)) return;
  const safeHandler = async (args: any): Promise<ToolResult> => {
    const started = Date.now();
    const cleanArgs = sanitizeAuditArgs(name, (args ?? {}) as Record<string, unknown>);
    try {
      const result = await handler(args ?? {});
      auditLog?.append({
        at: new Date().toISOString(),
        tool: name,
        args: cleanArgs,
        origin: auditOrigin?.(),
        ok: !result.isError,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      auditLog?.append({
        at: new Date().toISOString(),
        tool: name,
        args: cleanArgs,
        origin: auditOrigin?.(),
        ok: false,
        error: errorText(error).slice(0, 500),
        durationMs: Date.now() - started,
      });
      if (process.env.BROWSER_MCP_DEBUG) {
        process.stderr.write(`[browser-mcp] ${name} failed: ${(error as Error)?.stack}\n`);
      }
      return text(`${name} failed: ${errorText(error)}`, true);
    }
  };
  (server.registerTool as any)(name, meta, safeHandler);
}
