import { existsSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { redactedConfig } from "../config.js";
import type { BrowserSession } from "../session.js";
import { canonicalOrigin, compactHint, type SiteMemoryStore } from "../memory.js";
import { defineTool, json } from "./util.js";
import { engineEnum } from "./shared.js";

const profileEnum = z.enum(["local", "flash", "frontier", "auto"]);

function siteMemoryView(
  memory: SiteMemoryStore,
  origin: string,
  limit: number,
): Record<string, unknown> {
  if (!origin) return {};
  const hints = memory.hints(origin, limit).map(compactHint);
  const workflows = memory.workflows(origin, 2).map(compactHint);
  if (!hints.length && !workflows.length) return {};
  return {
    siteMemory: {
      origin,
      note: "Site memory is agent-authored, not page text. Verify selectors before reuse.",
      ...(hints.length ? { hints } : {}),
      ...(workflows.length ? { workflows } : {}),
    },
  };
}

export function registerLifecycleTools(
  server: McpServer,
  session: BrowserSession,
  config: Config,
  memory: SiteMemoryStore,
): void {
  defineTool(
    server,
    "open",
    {
      title: "Open browser",
      description:
        "Launch the agent browser. Default engine is patchright (stealth Chromium). " +
        "Use engine=chromium for full-fidelity devtools/perf/local testing, or engine=obscura for " +
        "a lightweight Rust engine (lower memory, strongest tracker blocking). Reusing an open " +
        "browser keeps cookies and tabs; pass restart=true to relaunch with new options.",
      inputSchema: {
        url: z.string().optional().describe("Optional URL to open after launch."),
        engine: engineEnum.optional(),
        profile: profileEnum.optional().describe("Observation/verbosity profile (model-adaptive)."),
        headless: z.boolean().optional(),
        allow_private: z
          .boolean()
          .optional()
          .describe("Allow localhost/LAN/private IPs. Defaults to the server config."),
        proxy: z.string().optional().describe("HTTP or SOCKS5 proxy URL."),
        stealth: z.boolean().optional().describe("Obscura only: enable stealth mode (default true)."),
        viewport: z
          .object({ width: z.number().int().positive(), height: z.number().int().positive() })
          .optional(),
        user_agent: z.string().optional(),
        locale: z.string().optional(),
        timezone: z.string().optional(),
        humanize: z.boolean().optional().describe("Humanized mouse/typing (default true)."),
        block_trackers: z.boolean().optional(),
        restart: z.boolean().optional().describe("Close an open browser first."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      if (session.running && !args.restart) {
        if (args.url) {
          const navigation = await session.navigate(args.url);
          return json({ ...navigation, engine: session.engine, note: "browser already open" });
        }
        return json({ ...session.status(), note: "browser already open" });
      }

      await session.launch({
        engine: args.engine,
        profile: args.profile,
        headless: args.headless,
        allowPrivate: args.allow_private,
        proxy: args.proxy,
        stealth: args.stealth,
        viewport: args.viewport,
        userAgent: args.user_agent,
        locale: args.locale,
        timezone: args.timezone,
        humanize: args.humanize,
        blockTrackers: args.block_trackers,
      });

      let navigation: Record<string, unknown> | undefined;
      let memoryView: Record<string, unknown> = {};
      if (args.url) {
        navigation = await session.navigate(args.url);
        memoryView = siteMemoryView(
          memory,
          canonicalOrigin(args.url),
          session.limits.hintLimit,
        );
      }
      return json({
        ...session.status(),
        ...(navigation ? { page: navigation } : {}),
        ...memoryView,
        hint: "Call snapshot to get element refs, or navigate directly to a URL.",
      });
    },
  );

  defineTool(
    server,
    "close",
    {
      title: "Close browser",
      description: "Close the browser, all tabs, and any Obscura child process.",
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    async () => {
      await session.close();
      return json({ closed: true });
    },
  );

  defineTool(
    server,
    "navigate",
    {
      title: "Navigate",
      description:
        "Navigate the active tab to a URL. Opens the browser automatically if needed. " +
        "Private-network URLs are blocked unless allow_private is enabled.",
      inputSchema: {
        url: z.string().describe("Absolute http(s) URL."),
        wait_until: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Navigation wait condition (default load)."),
        engine: engineEnum.optional().describe("Engine to use when launching a new browser."),
        profile: profileEnum.optional().describe("Profile to use when launching a new browser."),
        allow_private: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      if (!session.running) {
        await session.launch({
          engine: args.engine,
          profile: args.profile,
          allowPrivate: args.allow_private,
        });
      } else if (args.engine && args.engine !== session.engine) {
        throw new Error(
          `browser is already running on ${session.engine}; call open with restart=true to switch to ${args.engine}`,
        );
      }
      const result = await session.navigate(args.url, args.wait_until);
      return json({
        ...result,
        engine: session.engine,
        profile: session.profile,
        ...siteMemoryView(memory, canonicalOrigin(args.url), session.limits.hintLimit),
        hint: "Call snapshot for refs, markdown for readable text, or extract for structured data.",
      });
    },
  );

  for (const [name, action] of [
    ["back", "Go back in history"],
    ["forward", "Go forward in history"],
    ["reload", "Reload the active tab"],
  ] as const) {
    defineTool(
      server,
      name,
      {
        title: name,
        description: action + ".",
        inputSchema: {},
        annotations: { readOnlyHint: false },
      },
      async () => {
        if (name === "back") await session.back();
        if (name === "forward") await session.forward();
        if (name === "reload") await session.reload();
        const page = await session.page();
        return json({ url: page.url(), title: await page.title().catch(() => "") });
      },
    );
  }

  defineTool(
    server,
    "status",
    {
      title: "Browser status",
      description:
        "Report the active engine, URL, tabs, capture buffers, resolved config, and which " +
        "engines are available on this machine.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const configView = redactedConfig(config);
      return json({
        ...session.status(),
        config: configView,
        available: {
          patchright: true,
          chromium: true,
          obscura: Boolean(config.obscuraPath && existsSync(config.obscuraPath)),
          obscuraPath: config.obscuraPath || null,
        },
      });
    },
  );

  defineTool(
    server,
    "tabs",
    {
      title: "Tabs",
      description:
        "List, create, switch, or close tabs. Switching preserves page state and JS globals.",
      inputSchema: {
        action: z.enum(["list", "new", "switch", "close"]),
        index: z.number().int().min(0).optional().describe("Tab index for switch/close."),
        url: z.string().optional().describe("URL for a new tab."),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      if (args.action === "new") await session.newTab(args.url);
      if (args.action === "switch") {
        if (args.index === undefined) throw new Error("switch requires index");
        await session.switchTab(args.index);
      }
      if (args.action === "close") {
        if (args.index === undefined) throw new Error("close requires index");
        await session.closeTab(args.index);
      }
      const tabs = await session.listTabs();
      return json({ tabs, active: tabs.find((tab) => tab.active)?.index ?? 0 });
    },
  );
}
