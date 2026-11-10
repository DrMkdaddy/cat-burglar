import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { BrowserSession, ActionRecord } from "../session.js";
import {
  canonicalOrigin,
  compactHint,
  type MemoryStep,
  type SiteMemoryStore,
} from "../memory.js";
import { defineTool, json } from "./util.js";

function sanitizeSteps(actions: ActionRecord[]): MemoryStep[] {
  return actions
    .filter((action) =>
      ["navigate", "click", "fill", "type", "press", "select", "upload", "wait"].includes(
        action.tool,
      ),
    )
    .map((action) => {
      const args: Record<string, unknown> = { ...action.arguments };
      delete args.ref;
      delete args.confirm;
      delete args.observe;
      if ("value" in args) args.value = "{{value}}";
      if (action.tool === "type" && "text" in args) args.text = "{{text}}";
      return { tool: action.tool, arguments: args };
    });
}

export function registerStateTools(
  server: McpServer,
  session: BrowserSession,
  config: Config,
  memory: SiteMemoryStore,
): void {
  defineTool(
    server,
    "cookies",
    {
      title: "Cookies",
      description:
        "Get, set, or clear cookies for the current browser context. `get` can be limited to URLs.",
      inputSchema: {
        action: z.enum(["get", "set", "clear"]),
        urls: z.array(z.string()).optional().describe("For get: only cookies sent to these URLs."),
        cookies: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("For set: cookie objects (name, value, domain, path, expires, sameSite…)."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      if (args.action === "get") {
        const cookies = await session.cookies(args.urls);
        return json({ count: cookies.length, cookies });
      }
      if (args.action === "set") {
        if (!args.cookies?.length) throw new Error("set requires cookies");
        await session.setCookies(args.cookies);
        return json({ set: args.cookies.length });
      }
      await session.clearCookies();
      return json({ cleared: true });
    },
  );

  defineTool(
    server,
    "storage",
    {
      title: "Storage state",
      description:
        "Export or import cookies + localStorage as a Playwright storage-state file. " +
        "Use this to persist logins across browser restarts. Import applies cookies immediately and " +
        "writes localStorage through CDP.",
      inputSchema: {
        action: z.enum(["export", "import", "get"]),
        path: z
          .string()
          .optional()
          .describe("Export: save path under the artifact dir. Import: JSON file path."),
        state: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Import: inline storage state ({cookies, origins})."),
        include_state: z.boolean().optional().describe("Export: include state in the response."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      if (args.action === "export") {
        const result = await session.exportStorage(args.path);
        return json({
          path: result.path,
          cookies: result.state.cookies?.length ?? 0,
          origins: result.state.origins?.length ?? 0,
          ...(args.include_state ? { state: result.state } : {}),
        });
      }
      if (args.action === "get") {
        const state = await session.exportStorage();
        return json({
          cookies: state.state.cookies?.length ?? 0,
          origins: state.state.origins?.length ?? 0,
          state: args.include_state ? state.state : undefined,
        });
      }

      let state = args.state as
        | {
            cookies?: Array<Record<string, unknown>>;
            origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
          }
        | undefined;
      if (!state && args.path) {
        const root = resolve(config.artifactDir);
        const target = resolve(root, args.path);
        if (target !== root && !target.startsWith(root + sep)) {
          throw new Error(`storage import path must stay inside ${root}`);
        }
        state = JSON.parse(readFileSync(target, "utf8"));
      }
      if (!state) throw new Error("import requires state or path");
      const result = await session.importStorage(state);
      return json(result);
    },
  );

  defineTool(
    server,
    "stealth",
    {
      title: "Stealth check",
      description:
        "Fingerprint self-check on the current page: navigator.webdriver, UA-CH, plugins, chrome " +
        "runtime, native function masking, canvas/WebGL, timezone/locale, screen, and permissions. " +
        "Returns a verdict plus concrete warnings. Run after opening a protected site.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const report = await session.stealthReport();
      const warnings: string[] = [];
      if (report.webdriver) warnings.push("navigator.webdriver is true");
      if (!report.hasChrome) warnings.push("window.chrome is missing");
      if (!report.uaData) warnings.push("navigator.userAgentData is missing");
      if (!report.permissionsQueryNative) warnings.push("permissions.query is not native");
      if (report.plugins.length === 0) warnings.push("navigator.plugins is empty");
      if (config.timezone && report.timezone !== config.timezone) {
        warnings.push(`timezone ${report.timezone} != configured ${config.timezone}`);
      }
      if (config.locale && !report.languages.includes(config.locale)) {
        warnings.push(`locale ${config.locale} missing from navigator.languages`);
      }
      if (!report.webglVendor && !report.webglRenderer) {
        warnings.push("WebGL vendor/renderer unavailable");
      }
      return json({
        engine: session.engine,
        verdict: warnings.length === 0 ? "ok" : "check",
        warnings,
        report,
      });
    },
  );

  defineTool(
    server,
    "proxy",
    {
      title: "Proxy pool",
      description:
        "Inspect, test, rotate, add, or remove HTTP/HTTPS/SOCKS5 residential proxies. " +
        "Proxy URLs are redacted in output. Rotation relaunches the browser with the next proxy.",
      inputSchema: {
        action: z.enum(["list", "status", "test", "rotate", "add", "remove"]),
        id: z.string().optional(),
        url: z
          .string()
          .optional()
          .describe("Proxy URL for add: http://user:pass@host:port or socks5://host:port."),
        label: z.string().optional(),
        force: z.boolean().optional().describe("Force a fresh health check."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      if (args.action === "list" || args.action === "status") {
        return json(session.proxyStatus());
      }
      if (args.action === "test") {
        return json({ results: await session.proxyTest(args.id, args.force ?? false) });
      }
      if (args.action === "rotate") {
        return json(await session.rotateProxy());
      }
      if (args.action === "add") {
        if (!args.url) throw new Error("add requires url");
        const id = args.id ?? `proxy-${Date.now().toString(36)}`;
        session.addProxy({ id, url: args.url, ...(args.label ? { label: args.label } : {}) });
        return json(session.proxyStatus());
      }
      if (!args.id) throw new Error("remove requires id");
      return json({ removed: session.removeProxy(args.id), ...session.proxyStatus() });
    },
  );

  defineTool(
    server,
    "memory",
    {
      title: "Site memory",
      description:
        "Per-origin memory for selector hints, notes, and reusable workflows. Entries are " +
        "agent-authored only (never page text). `navigate` injects the top hints automatically. " +
        "Use `learn` after a successful run to save the recent action sequence as a workflow; " +
        "verify selectors before replaying them.",
      inputSchema: {
        action: z.enum(["list", "get", "put", "remove", "clear", "learn"]),
        origin: z
          .string()
          .optional()
          .describe("Canonical origin, e.g. https://example.com. Defaults to the current page."),
        id: z.string().optional().describe("Entry id for get/remove."),
        kind: z.enum(["hint", "workflow", "note"]).optional(),
        name: z.string().optional().describe("Workflow or hint name."),
        text: z.string().optional().describe("Hint/note text (bounded, control chars stripped)."),
        steps: z
          .array(
            z.object({
              tool: z.string(),
              arguments: z.record(z.string(), z.unknown()),
            }),
          )
          .optional()
          .describe("Workflow steps. Omit on learn to use the recent action log."),
        limit: z.number().int().positive().max(100).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const origin = canonicalOrigin(args.origin ?? "") || session.currentOrigin();
      if (args.action === "list") {
        return json({
          sites: memory.list(origin || undefined, args.limit ?? 20),
        });
      }
      if (!origin) throw new Error("no active origin; navigate to a page or pass origin");

      if (args.action === "get") {
        if (!args.id) throw new Error("get requires id");
        const entry = memory.get(origin, args.id);
        if (!entry) throw new Error(`no memory entry ${args.id} for ${origin}`);
        return json(compactHint(entry));
      }
      if (args.action === "put") {
        if (!args.kind) throw new Error("put requires kind");
        const entry = memory.put(origin, {
          kind: args.kind,
          name: args.name,
          text: args.text,
          steps: args.steps,
        });
        return json(compactHint(entry));
      }
      if (args.action === "learn") {
        if (!args.name) throw new Error("learn requires name");
        const steps =
          args.steps?.map((step: { tool: string; arguments: Record<string, unknown> }) => ({
            tool: step.tool,
            arguments: step.arguments,
          })) ?? sanitizeSteps(session.recentActions(origin, 20));
        if (!steps.length) {
          throw new Error("no recent actions for this origin; pass steps explicitly");
        }
        const entry = memory.learn(origin, args.name, steps, args.text);
        return json({
          ...compactHint(entry),
          note: "Workflow saved. Selectors and values are placeholders; verify before replay.",
        });
      }
      if (args.action === "remove") {
        if (!args.id) throw new Error("remove requires id");
        return json({ removed: memory.remove(origin, args.id) });
      }
      return json({ cleared: memory.clear(args.origin ? origin : undefined) });
    },
  );
}
