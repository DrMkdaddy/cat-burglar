#!/usr/bin/env node
/**
 * browser-mcp benchmark runner.
 *
 * Runs the deterministic fixture task suite through the MCP server. Two modes:
 *   full     - full snapshots, no change observation after actions
 *   adaptive - diff snapshots (profile default) + change observation
 *
 * This is a tool-level reference-policy benchmark. It deliberately does not
 * claim to measure an LLM's browsing ability; plug in an LLM policy with
 * --llm when a model endpoint is available.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import { createFixtureServer } from "./fixture-server.mjs";
import { tasks } from "./tasks.mjs";

const PROFILES = {
  local: { snapshotChars: 1800 },
  flash: { snapshotChars: 2800 },
  frontier: { snapshotChars: 8000 },
  auto: { snapshotChars: 2800 },
};

function parseArgs(argv) {
  const args = {
    profile: "flash",
    engine: "chromium",
    compare: true,
    task: null,
    llm: false,
    server: "ours",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--engine") args.engine = argv[++i];
    else if (arg === "--task") args.task = argv[++i];
    else if (arg === "--no-compare") args.compare = false;
    else if (arg === "--llm") args.llm = true;
    else if (arg === "--server") args.server = argv[++i];
  }
  if (!PROFILES[args.profile]) throw new Error(`unknown profile ${args.profile}`);
  return args;
}

function toolText(result) {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function makeClient(profile, engine) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      BROWSER_MCP_ENGINE: engine,
      BROWSER_MCP_PROFILE: profile,
      BROWSER_MCP_ALLOW_PRIVATE_NETWORK: "1",
      BROWSER_MCP_SETTLE_MS: "120",
      BROWSER_MCP_RISKY_ACTION_POLICY: "warn",
      BROWSER_MCP_MEMORY_PATH: join(os.tmpdir(), `browser-mcp-bench-memory-${process.pid}.json`),
      BROWSER_MCP_ARTIFACT_DIR: resolve("bench/results/artifacts"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "browser-mcp-bench", version: "0.1.0" }, { capabilities: {} });
  return { client, transport };
}

function makeContext({ client, base, mode, profile, engine, budget }) {
  const metrics = {
    toolCalls: 0,
    errors: 0,
    observationChars: 0,
    latencyMs: 0,
    snapshots: 0,
  };

  const call = async (name, args = {}) => {
    const started = Date.now();
    const result = await client.callTool({ name, arguments: args });
    metrics.latencyMs += Date.now() - started;
    metrics.toolCalls += 1;
    if (result.isError) metrics.errors += 1;
    metrics.observationChars += toolText(result).length;
    return result;
  };

  const shouldObserve = (name, args) => {
    if (args.observe === false) return false;
    if (args.observe === true) return true;
    return !["fill", "type"].includes(name);
  };

  const ctx = {
    base,
    mode,
    profile,
    engine,
    budget,
    metrics,
    call,
    text: toolText,
    json(result) {
      const text = toolText(result);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`expected JSON, got: ${text.slice(0, 200)}`);
      }
    },
    async state() {
      const response = await fetch(`${base}/state`);
      return response.json();
    },
    snapshot(args = {}) {
      metrics.snapshots += 1;
      return call("snapshot", {
        max_chars: budget,
        ...args,
        diff: mode === "adaptive" ? (args.diff ?? true) : false,
      });
    },
    async action(name, args = {}) {
      const observe = shouldObserve(name, args);
      const result = await call(name, {
        ...args,
        observe: mode === "adaptive" ? observe : false,
      });
      // Full mode must pay for the equivalent state read a real agent needs.
      if (mode === "full" && observe) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await ctx.snapshot();
      }
      return result;
    },
    assert(condition, message) {
      if (!condition) throw new Error(message);
    },
  };
  return ctx;
}

async function runSuite({ profile, engine, mode, onlyTask }) {
  const fixture = createFixtureServer();
  const base = await fixture.listen();
  const { client, transport } = makeClient(profile, engine);
  await client.connect(transport);
  const selected = onlyTask ? tasks.filter((task) => task.id === onlyTask) : tasks;
  const results = [];

  try {
    for (const task of selected) {
      fixture.reset();
      await client.callTool({ name: "close", arguments: {} }).catch(() => undefined);
      const budget = PROFILES[profile].snapshotChars;
      const ctx = makeContext({ client, base, mode, profile, engine, budget });
      const started = Date.now();
      let success = false;
      let detail = "";
      try {
        detail = (await task.run(ctx)) ?? "ok";
        success = true;
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      const wallMs = Date.now() - started;
      results.push({
        id: task.id,
        name: task.name,
        success,
        detail,
        mode,
        profile,
        engine,
        wallMs,
        ...ctx.metrics,
      });
      process.stderr.write(
        `[bench] ${mode.padEnd(8)} ${task.id.padEnd(22)} ${success ? "PASS" : "FAIL"} ` +
          `${ctx.metrics.toolCalls} calls ${ctx.metrics.observationChars} chars ${wallMs}ms\n`,
      );
    }
  } finally {
    await client.callTool({ name: "close", arguments: {} }).catch(() => undefined);
    await client.close().catch(() => undefined);
    await fixture.close();
  }

  return results;
}

function summarize(results) {
  const total = results.length;
  const passed = results.filter((result) => result.success).length;
  const sum = (key) => results.reduce((acc, result) => acc + (result[key] ?? 0), 0);
  return {
    tasks: total,
    passed,
    failed: total - passed,
    successRate: total ? Number(((passed / total) * 100).toFixed(1)) : 0,
    toolCalls: sum("toolCalls"),
    errors: sum("errors"),
    observationChars: sum("observationChars"),
    latencyMs: sum("latencyMs"),
    wallMs: sum("wallMs"),
  };
}

function markdownReport(byMode, meta) {
  const modes = Object.keys(byMode);
  const lines = [
    "# browser-mcp benchmark",
    "",
    `Generated: ${meta.generatedAt}`,
    `Profile: \`${meta.profile}\` · Engine: \`${meta.engine}\` · Node: ${meta.node}`,
    `Fixture tasks: ${byMode[modes[0]].length} · Mode: scripted reference policy (tool-level, not an LLM)`,
    "",
    "## Summary",
    "",
    "| Mode | Success | Tool calls | Errors | Observation chars | Tool latency | Wall time |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const mode of modes) {
    const summary = summarize(byMode[mode]);
    lines.push(
      `| ${mode} | ${summary.passed}/${summary.tasks} (${summary.successRate}%) | ${summary.toolCalls} | ` +
        `${summary.errors} | ${summary.observationChars} | ${(summary.latencyMs / 1000).toFixed(2)}s | ` +
        `${(summary.wallMs / 1000).toFixed(2)}s |`,
    );
  }

  lines.push("", "## Per task", "");
  lines.push(`| Task | ${modes.map((mode) => `${mode} success`).join(" | ")} | ${modes.map((mode) => `${mode} chars`).join(" | ")} | Δ chars |`);
  lines.push(`| --- | ${modes.map(() => "---").join(" | ")} | ${modes.map(() => "---").join(" | ")} | --- |`);

  const taskIds = byMode[modes[0]].map((result) => result.id);
  for (const id of taskIds) {
    const cells = modes.map((mode) => byMode[mode].find((result) => result.id === id));
    const first = cells[0];
    const chars = cells.map((cell) => cell?.observationChars ?? 0);
    const delta =
      cells.length >= 2 && chars[0] && chars[1]
        ? `${(((chars[0] - chars[1]) / chars[0]) * 100).toFixed(1)}%`
        : "—";
    lines.push(
      `| ${first?.name ?? id} | ${cells.map((cell) => (cell?.success ? "PASS" : "FAIL")).join(" | ")} | ` +
        `${chars.join(" | ")} | ${delta} |`,
    );
  }

  lines.push("", "## Notes", "");
  lines.push(
    "- `observationChars` is the sum of text returned by MCP tools, not model tokens. It is a stable cost proxy; divide by ~4 for a rough token estimate.",
    "- `adaptive` uses diff snapshots and post-action change observation. `full` uses full snapshots and no automatic observation.",
    "- Hidden state is verified through `/state`; the injection task checks the exfiltration canary.",
    "- This suite measures the MCP tool layer and the reference policy. Use `bench/llm-agent.mjs` for model-level runs.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.llm) {
    const { runLlmSuite } = await import("./llm-agent.mjs");
    return runLlmSuite(args);
  }

  const modes = args.compare ? ["full", "adaptive"] : ["adaptive"];
  const byMode = {};
  for (const mode of modes) {
    byMode[mode] = await runSuite({
      profile: args.profile,
      engine: args.engine,
      mode,
      onlyTask: args.task,
    });
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    profile: args.profile,
    engine: args.engine,
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  };
  const payload = { meta, modes: byMode, summaries: Object.fromEntries(modes.map((mode) => [mode, summarize(byMode[mode])])) };

  const outDir = resolve("bench/results");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(outDir, `bench-${stamp}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  const markdown = markdownReport(byMode, meta);
  writeFileSync(join(outDir, "latest.md"), markdown);
  writeFileSync(join(outDir, `bench-${stamp}.md`), markdown);

  console.log(markdown);
  console.log(`\nJSON: ${jsonPath}`);
  console.log(`Report: ${join(outDir, "latest.md")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
