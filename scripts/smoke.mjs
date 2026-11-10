import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import { existsSync } from "node:fs";

function toolText(result) {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function parse(result) {
  const text = toolText(result);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const fixture = http.createServer((req, res) => {
  if (req.url === "/next") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Next</title><h1>Next page</h1><p>Done.</p>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Fixture Page</title>
  <meta name="description" content="A fixture for browser-mcp">
  <script type="application/ld+json">{"@type":"Article","headline":"Fixture"}</script>
  </head><body>
  <h1>Fixture</h1>
  <article><h2>Article heading</h2><p>${"Readable body text for the markdown extractor. ".repeat(30)}</p></article>
  <form>
    <label for="email">Email</label><input id="email" type="email" required>
    <button type="button" id="go" onclick="document.getElementById('out').textContent='clicked-ok';console.log('hello-console')">Go</button>
  </form>
  <div id="out"></div>
  <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
  <a href="/next">Next page</a>
  </body></html>`);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const port = fixture.address().port;
const base = `http://127.0.0.1:${port}/`;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    BROWSER_MCP_ENGINE: "chromium",
    BROWSER_MCP_ALLOW_PRIVATE_NETWORK: "1",
    BROWSER_MCP_SETTLE_MS: "150",
  },
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  console.log("connected");

  const tools = await client.listTools();
  console.log(`tools: ${tools.tools.length}`);
  check("tool catalog", tools.tools.length >= 25, String(tools.tools.length));
  check(
    "instructions present",
    typeof client.getInstructions() === "string" && client.getInstructions().includes("snapshot"),
  );

  let result = await client.callTool({ name: "open", arguments: { url: base, engine: "chromium" } });
  let data = parse(result);
  check("open + navigate", data.engine === "chromium" && data.page?.status === 200, toolText(result));

  result = await client.callTool({ name: "snapshot", arguments: {} });
  const snapshot = toolText(result);
  check("snapshot has controls", snapshot.includes("Controls (") && snapshot.includes("[e"));
  check("snapshot sees Email", snapshot.includes("Email"));
  check("snapshot sees Go button", snapshot.includes("Go"));
  check("snapshot is provenance-marked", snapshot.includes("untrusted"));

  const refs = Object.fromEntries(
    [...snapshot.matchAll(/\[(e\d+)\] (\w+) "([^"]*)"/g)].map((match) => [match[3], match[1]]),
  );
  check("ref map", Boolean(refs.Email && refs.Go), JSON.stringify(refs));

  result = await client.callTool({
    name: "fill",
    arguments: { ref: refs.Email, value: "agent@example.com" },
  });
  check("fill", !result.isError, toolText(result));

  result = await client.callTool({ name: "click", arguments: { ref: refs.Go } });
  check("click", !result.isError, toolText(result));
  check("click returns change observation", toolText(result).includes("Observation"), toolText(result).slice(0, 300));
  await new Promise((resolve) => setTimeout(resolve, 350));

  result = await client.callTool({ name: "snapshot", arguments: { diff: true } });
  check("diff snapshot", toolText(result).includes("diff from"), toolText(result).slice(0, 300));

  result = await client.callTool({
    name: "evaluate",
    arguments: { expression: "document.getElementById('out').textContent" },
  });
  check("click effect", toolText(result).includes("clicked-ok"), toolText(result));

  result = await client.callTool({ name: "markdown", arguments: {} });
  check("markdown extraction", toolText(result).includes("Readable body text"), toolText(result).slice(0, 200));

  result = await client.callTool({ name: "extract", arguments: { mode: "links" } });
  check("extract links", toolText(result).includes("/next"), toolText(result));

  result = await client.callTool({ name: "extract", arguments: { mode: "tables" } });
  check("extract tables", toolText(result).includes('"A"') && toolText(result).includes('"2"'));

  result = await client.callTool({ name: "screenshot", arguments: {} });
  check(
    "screenshot image",
    result.content.some((block) => block.type === "image" && block.mimeType === "image/png"),
    JSON.stringify(result.content.map((block) => block.type)),
  );

  result = await client.callTool({ name: "console", arguments: {} });
  check("console capture", toolText(result).includes("hello-console"), toolText(result));

  result = await client.callTool({ name: "network", arguments: { action: "summary" } });
  check("network summary", parse(result).requests >= 1, toolText(result));

  result = await client.callTool({ name: "perf", arguments: { action: "metrics" } });
  check("perf metrics", !result.isError && Object.keys(parse(result)).length > 5, toolText(result).slice(0, 200));

  result = await client.callTool({ name: "perf", arguments: { action: "vitals" } });
  check("perf vitals", !result.isError && typeof parse(result).fcp === "number", toolText(result));

  result = await client.callTool({ name: "tabs", arguments: { action: "new", url: `${base}next` } });
  const tabs = parse(result);
  check("tabs new", tabs.tabs.length === 2, toolText(result));
  result = await client.callTool({ name: "tabs", arguments: { action: "switch", index: 0 } });
  check("tabs switch", parse(result).active === 0, toolText(result));
  result = await client.callTool({ name: "tabs", arguments: { action: "close", index: 1 } });
  check("tabs close", parse(result).tabs.length === 1, toolText(result));

  result = await client.callTool({ name: "stealth", arguments: {} });
  check("stealth report", parse(result).report.webdriver === false, toolText(result));

  result = await client.callTool({
    name: "memory",
    arguments: { action: "put", kind: "hint", name: "email field", text: "Email input uses #email" },
  });
  check("memory put", !result.isError && toolText(result).includes("email field"), toolText(result));
  result = await client.callTool({ name: "memory", arguments: { action: "list" } });
  check("memory list", toolText(result).includes("email field"), toolText(result));
  result = await client.callTool({ name: "memory", arguments: { action: "learn", name: "fixture flow" } });
  check("memory learn", !result.isError && toolText(result).includes("fixture flow"), toolText(result));

  result = await client.callTool({ name: "cookies", arguments: { action: "get" } });
  check("cookies get", !result.isError, toolText(result));

  result = await client.callTool({ name: "storage", arguments: { action: "export" } });
  check("storage export", !result.isError, toolText(result));

  // Patchright stealth engine.
  result = await client.callTool({
    name: "open",
    arguments: { url: base, engine: "patchright", restart: true },
  });
  check("patchright open", !result.isError && parse(result).engine === "patchright", toolText(result));
  result = await client.callTool({ name: "snapshot", arguments: {} });
  check("patchright snapshot", toolText(result).includes("Email"), toolText(result).slice(0, 200));
  result = await client.callTool({ name: "stealth", arguments: {} });
  const stealth = parse(result);
  check("patchright stealth verdict", stealth.verdict === "ok", JSON.stringify(stealth.warnings));

  // Obscura engine, if installed.
  const obscura = `${process.env.HOME}/.local/bin/obscura`;
  if (existsSync(obscura)) {
    result = await client.callTool({
      name: "open",
      arguments: { url: base, engine: "obscura", restart: true, allow_private: true },
    });
    check("obscura open", !result.isError && parse(result).engine === "obscura", toolText(result));
    result = await client.callTool({ name: "snapshot", arguments: {} });
    check("obscura snapshot", toolText(result).includes("Go"), toolText(result).slice(0, 250));
    result = await client.callTool({ name: "markdown", arguments: {} });
    check("obscura markdown", toolText(result).includes("Readable body text"), toolText(result).slice(0, 200));
    result = await client.callTool({ name: "close", arguments: {} });
    check("obscura close", !result.isError, toolText(result));
  } else {
    console.log("  skip obscura (not installed)");
  }

  result = await client.callTool({ name: "close", arguments: {} });
  check("close", !result.isError, toolText(result));
} finally {
  await client.close().catch(() => undefined);
  fixture.close();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
