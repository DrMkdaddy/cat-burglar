#!/usr/bin/env node
/**
 * Measured comparison of local browser MCP servers: tool surface, context cost,
 * startup, first navigation, snapshot size, and process-tree RSS.
 *
 * Not a task-success benchmark. For that, use bench/llm-agent.mjs.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createFixtureServer } from "./fixture-server.mjs";

const SERVERS = [
  {
    name: "cat-burglar (ours)",
    command: "node",
    args: ["dist/index.js"],
    env: { BROWSER_MCP_ENGINE: "chromium", BROWSER_MCP_PROFILE: "flash" },
    navigate: "navigate",
    snapshot: "snapshot",
    close: "close",
  },
  {
    name: "Playwright MCP",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated", "--executable-path", "/usr/bin/chromium", "--image-responses", "omit"],
    navigate: "browser_navigate",
    snapshot: "browser_snapshot",
    close: "browser_close",
  },
  {
    name: "Chrome DevTools MCP",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest", "--headless", "--isolated", "--no-usage-statistics", "--executable-path", "/usr/bin/chromium"],
    navigate: "navigate_page",
    snapshot: "take_snapshot",
    close: "close_page",
    pageId: 1,
  },
  {
    name: "Obscura MCP",
    command: process.env.HOME + "/.local/bin/obscura",
    args: ["mcp", "--stealth"],
    env: { OBSCURA_ALLOW_PRIVATE_NETWORK: "1" },
    navigate: "browser_navigate",
    snapshot: "browser_snapshot",
    close: "browser_close",
  },
];

function toolText(result) {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function treePids(rootPid) {
  const parents = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      const ppid = Number(fields[1]);
      parents.set(Number(entry), ppid);
    } catch {}
  }
  const result = [rootPid];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of parents) {
      if (result.includes(ppid) && !result.includes(pid)) {
        result.push(pid);
        changed = true;
      }
    }
  }
  return result;
}

function treeRssMb(pid) {
  let kb = 0;
  for (const child of treePids(pid)) {
    try {
      const status = readFileSync(`/proc/${child}/status`, "utf8");
      const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
      if (match) kb += Number(match[1]);
    } catch {}
  }
  return Number((kb / 1024).toFixed(1));
}

async function measure(server, base) {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: process.cwd(),
    env: {
      ...process.env,
      BROWSER_MCP_ALLOW_PRIVATE_NETWORK: "1",
      ...server.env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "server-compare", version: "0.1.0" }, { capabilities: {} });
  const started = Date.now();
  const command = `${server.command} ${server.args.join(" ")}`.replace(homedir(), "~");
  const row = { server: server.name, command, ok: false };
  try {
    await client.connect(transport);
    row.startupMs = Date.now() - started;
    const catalog = await client.listTools();
    row.tools = catalog.tools.length;
    row.schemaBytes = JSON.stringify(catalog.tools).length;
    row.rssAfterInitMb = treeRssMb(transport.pid);

    const navStart = Date.now();
    const nav = await client.callTool({
      name: server.navigate,
      arguments: server.pageId
        ? { pageId: server.pageId, type: "url", url: `${base}/form` }
        : { url: `${base}/form` },
    });
    row.navigateMs = Date.now() - navStart;
    row.navigateError = nav.isError ?? false;
    row.navigateChars = toolText(nav).length;

    const snapStart = Date.now();
    const snap = await client.callTool({
      name: server.snapshot,
      arguments: server.pageId ? { pageId: server.pageId } : {},
    });
    row.snapshotMs = Date.now() - snapStart;
    row.snapshotChars = toolText(snap).length;
    row.snapshotError = snap.isError ?? false;
    row.rssAfterSnapshotMb = treeRssMb(transport.pid);
    row.totalMs = Date.now() - started;
    row.ok = !row.snapshotError;
    await client.callTool({ name: server.close, arguments: {} }).catch(() => undefined);
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
    row.totalMs = Date.now() - started;
  } finally {
    await client.close().catch(() => undefined);
  }
  return row;
}

function report(rows) {
  const lines = [
    "# Browser MCP server comparison",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Measured locally with a hermetic `/form` page. RSS is the full process tree after the first snapshot.",
    "This is a tool-layer comparison, not a model task-success benchmark.",
    "",
    "| Server | Tools | Schema bytes | Startup | Navigate | Snapshot chars | RSS (MB) | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.server} | ${row.tools ?? "—"} | ${row.schemaBytes ?? "—"} | ${
        row.startupMs !== undefined ? `${row.startupMs} ms` : "—"
      } | ${row.navigateMs !== undefined ? `${row.navigateMs} ms` : "—"} | ${
        row.snapshotChars ?? "—"
      } | ${row.rssAfterSnapshotMb ?? row.rssAfterInitMb ?? "—"} | ${
        row.ok ? "ok" : `failed: ${row.error ?? "snapshot error"}`
      } |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const fixture = createFixtureServer();
  const base = await fixture.listen();
  const rows = [];
  try {
    for (const server of SERVERS) {
      process.stderr.write(`[compare] ${server.name}\n`);
      rows.push(await measure(server, base));
    }
  } finally {
    await fixture.close();
  }
  const outDir = resolve("bench/results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "server-comparison.json"), `${JSON.stringify(rows, null, 2)}\n`);
  const markdown = report(rows);
  writeFileSync(resolve(outDir, "server-comparison.md"), `${markdown}\n`);
  console.log(markdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
