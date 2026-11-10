import { loadConfig } from "../dist/config.js";
import { BrowserSession } from "../dist/session.js";
import http from "node:http";

const fixture = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Fixture Page</title>
  <meta name="description" content="test page">
  <script type="application/ld+json">{"@type":"Article","headline":"Hi"}</script>
  </head><body>
  <h1>Fixture</h1>
  <article><h2>Article</h2><p>${"Readable body text. ".repeat(40)}</p></article>
  <form><label for="email">Email</label><input id="email" type="email" required>
  <button type="button" id="go" onclick="document.getElementById('out').textContent='clicked';console.log('hello-console')">Go</button></form>
  <div id="out"></div>
  <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
  <a href="/next">Next page</a>
  </body></html>`);
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const port = fixture.address().port;

const config = loadConfig();
config.defaultEngine = process.env.ENGINE || "chromium";
config.allowPrivateNetwork = true;
const session = new BrowserSession(config);
try {
  await session.launch({ engine: process.env.ENGINE || "chromium", allowPrivate: true });
  console.log("engine", session.engine);
  console.log("nav", await session.navigate(`http://127.0.0.1:${port}/`));
  const snap = (await session.snapshot(4000, 120)).data;
  console.log("snapshot controls", snap.controls.map((c) => `${c.ref}:${c.role}:${c.name}`));
  console.log("snapshot text len", snap.text.length);
  const md = await session.markdown();
  console.log("markdown html len", md.html.length, md.title);
  const links = await session.extract("links");
  console.log("links", JSON.stringify(links).slice(0, 300));
  await session.fill({ ref: snap.controls.find((c) => c.role === "textbox")?.ref }, "a@b.co");
  await session.click({ text: "Go" });
  await new Promise((r) => setTimeout(r, 300));
  console.log("out", await session.evaluate("document.getElementById('out').textContent"));
  console.log("console", session.consoleMessages({ limit: 10 }).map((m) => m.text));
  console.log("network summary", session.networkSummary());
  console.log("vitals", await session.vitals());
  try { console.log("metrics", Object.keys(await session.perfMetrics()).length); } catch (e) { console.log("metrics skipped", e.message); }
  const shot = await session.screenshot({});
  console.log("screenshot bytes", shot.buffer.length);
  await session.newTab(`http://127.0.0.1:${port}/next`);
  console.log("tabs", await session.listTabs());
  await session.closeTab(1);
  console.log("stealth", (await session.stealthReport()).webdriver);
} finally {
  await session.close();
  fixture.close();
}
