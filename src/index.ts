#!/usr/bin/env node
/**
 * Cat Burglar: a stealth browser MCP server.
 *
 * stdio transport: stdout is reserved for the MCP protocol in server mode.
 * CLI helpers (--help, --version, doctor, install) print to stdout and exit.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp(): void {
  console.log(`Cat Burglar ${packageVersion()}

Usage:
  cat-burglar [--slim]          Start the MCP server over stdio
  cat-burglar doctor            Check Node, Chromium, Obscura, and config
  cat-burglar install --client <name> [--slim]
                                Print a client config snippet
  cat-burglar --version
  cat-burglar --help

Clients for install:
  claude-code, claude-desktop, cursor, codex, gemini, vscode,
  windsurf, cline, opencode, generic

Flags:
  --slim    Expose 14 core tools instead of 30. Useful for clients
            that pay for every tool schema in context.
`);
}

function chromiumPath(): string | null {
  const candidates = [
    process.env.BROWSER_MCP_CHROMIUM_PATH,
    process.env.CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function doctor(): void {
  let config: ReturnType<typeof loadConfig> | null = null;
  let configError = "";
  try {
    config = loadConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const chromium = chromiumPath();
  const obscura = config?.obscuraPath ?? "";
  const configPath = join(homedir(), ".config", "browser-mcp", "config.json");
  const memoryPath = config?.memoryPath ?? join(homedir(), ".cache", "browser-mcp", "site-memory.json");

  const line = (label: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? "ok  " : "warn"}  ${label.padEnd(12)} ${detail}`);
  };

  console.log(`Cat Burglar ${packageVersion()}`);
  line("node", nodeMajor >= 22, `${process.version}${nodeMajor >= 22 ? "" : " (need >= 22)"}`);
  line("package", existsSync(new URL("../package.json", import.meta.url)), new URL("../package.json", import.meta.url).pathname);
  line("chromium", Boolean(chromium), chromium ?? "not found; set BROWSER_MCP_CHROMIUM_PATH");
  line("obscura", Boolean(obscura && existsSync(obscura)), obscura || "not installed; run npm run install:obscura");
  line("config", !configError, configError || configPath);
  line("memory", !configError, memoryPath);
  if (config) {
    line("profile", true, `${config.profile} (${config.limits.snapshotChars} snapshot chars)`);
    line("network", true, config.allowPrivateNetwork ? "private network allowed" : "private network blocked");
  }
}

function installSnippet(argv: string[]): void {
  let client = "generic";
  let slim = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--client") client = argv[++i] ?? "generic";
    else if (argv[i] === "--slim") slim = true;
  }

  const args = slim ? ["--slim"] : [];
  const command = { command: "cat-burglar", ...(args.length ? { args } : {}) };
  const mcpServers = { mcpServers: { catburglar: command } };
  const vscode = { servers: { catburglar: { type: "stdio", ...command } } };
  const opencode = {
    mcp: {
      servers: {
        catburglar: {
          type: "local",
          command: ["cat-burglar", ...args],
          environment: { BROWSER_MCP_ALLOW_PRIVATE_NETWORK: "1" },
        },
      },
    },
  };
  const codex = `[mcp_servers.catburglar]
command = "cat-burglar"
${args.length ? `args = ${JSON.stringify(args)}\n` : ""}`;

  switch (client) {
    case "claude-code":
      console.log(`claude mcp add catburglar -- cat-burglar${args.length ? ` ${args.join(" ")}` : ""}`);
      break;
    case "claude-desktop":
    case "cursor":
    case "windsurf":
    case "cline":
    case "gemini":
    case "generic":
      console.log(JSON.stringify(mcpServers, null, 2));
      break;
    case "vscode":
      console.log(JSON.stringify(vscode, null, 2));
      break;
    case "opencode":
      console.log(JSON.stringify(opencode, null, 2));
      break;
    case "codex":
      console.log(codex);
      break;
    default:
      console.error(`unknown client "${client}"`);
      console.error("clients: claude-code, claude-desktop, cursor, codex, gemini, vscode, windsurf, cline, opencode, generic");
      process.exit(1);
  }
}

async function startServer(): Promise<void> {
  const config = loadConfig();
  if (process.env.BROWSER_MCP_DEBUG) {
    process.stderr.write(
      `[cat-burglar] starting: engine=${config.defaultEngine} headless=${config.headless} ` +
        `profile=${config.profile} allowPrivate=${config.allowPrivateNetwork} ` +
        `obscura=${config.obscuraPath || "not found"}\n`,
    );
  }

  const { server, session } = createServer(config);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    if (process.env.BROWSER_MCP_DEBUG) process.stderr.write(`[cat-burglar] ${signal}, closing\n`);
    await session.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[cat-burglar] uncaught: ${error.stack ?? error.message}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[cat-burglar] unhandled rejection: ${String(reason)}\n`);
  });

  await server.connect(transport);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(packageVersion());
    return;
  }
  if (argv[0] === "doctor") {
    doctor();
    return;
  }
  if (argv[0] === "install") {
    installSnippet(argv.slice(1));
    return;
  }
  await startServer();
}

main().catch((error) => {
  process.stderr.write(`[cat-burglar] fatal: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
