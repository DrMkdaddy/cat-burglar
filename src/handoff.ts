import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";

export interface HandoffOptions {
  openWindow?: boolean;
  timeoutMs?: number;
}

export interface HandoffInfo {
  url: string;
  token: string;
  expiresInMs: number;
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cat Burglar handoff</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b1114; color: #e5e7eb; font: 14px/1.4 Inter, system-ui, sans-serif; }
  header { display: flex; gap: 12px; align-items: center; padding: 10px 14px; border-bottom: 1px solid #1f2937; }
  header strong { color: #f9fafb; }
  header span { color: #9ca3af; }
  main { padding: 12px; }
  img { display: block; width: 100%; max-width: 1280px; margin: 0 auto; border: 1px solid #1f2937; border-radius: 8px; cursor: crosshair; background: #111827; }
  button { background: #16a34a; color: white; border: 0; border-radius: 6px; padding: 8px 12px; cursor: pointer; font: inherit; }
  button.secondary { background: #334155; }
  #status { margin-left: auto; color: #fbbf24; }
  .hint { max-width: 1280px; margin: 8px auto 0; color: #9ca3af; }
</style>
</head>
<body>
<header>
  <strong>Cat Burglar handoff</strong>
  <span>Solve the challenge, then click Done.</span>
  <span id="status">live</span>
  <button class="secondary" id="reload">Refresh</button>
  <button id="done">Done</button>
</header>
<main>
  <img id="screen" alt="Live browser view">
  <p class="hint">Click inside the page to click. Type to send keys. This view is local and token-protected.</p>
</main>
<script>
const token = new URLSearchParams(location.search).get("token") || "";
const img = document.getElementById("screen");
const status = document.getElementById("status");
let seq = 0;
function refresh() {
  img.src = "/frame?token=" + encodeURIComponent(token) + "&t=" + (++seq);
}
refresh();
setInterval(refresh, 500);
function send(payload) {
  fetch("/input?token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => { status.textContent = "input failed"; });
}
img.addEventListener("click", (event) => {
  const rect = img.getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width) * img.naturalWidth);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * img.naturalHeight);
  send({ type: "click", x, y, button: event.button === 2 ? "right" : "left" });
});
img.addEventListener("wheel", (event) => {
  event.preventDefault();
  send({ type: "scroll", dx: event.deltaX, dy: event.deltaY });
}, { passive: false });
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    send({ type: "key", key: (event.ctrlKey ? "Control+" : "") + (event.metaKey ? "Meta+" : "") + (event.altKey ? "Alt+" : "") + event.key });
    return;
  }
  if (event.key.length === 1) send({ type: "text", text: event.key });
  else send({ type: "key", key: event.key });
  if (event.key === "Enter") event.preventDefault();
});
document.getElementById("reload").addEventListener("click", refresh);
document.getElementById("done").addEventListener("click", async () => {
  status.textContent = "closing";
  await fetch("/done?token=" + encodeURIComponent(token), { method: "POST" }).catch(() => {});
  status.textContent = "done";
});
</script>
</body>
</html>`;

function openExternal(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command[0] as string, command[1] as string[], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // The URL is still returned to the agent.
  }
}

export class HandoffServer {
  private server: http.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private token = randomBytes(16).toString("hex");
  private pageGetter: () => Promise<any>;
  private options: Required<HandoffOptions>;
  url: string | null = null;
  active = false;

  constructor(pageGetter: () => Promise<any>, options: HandoffOptions = {}) {
    this.pageGetter = pageGetter;
    this.options = {
      openWindow: options.openWindow ?? true,
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
    };
  }

  async start(): Promise<HandoffInfo> {
    if (this.active && this.url) {
      return { url: this.url, token: this.token, expiresInMs: this.options.timeoutMs };
    }
    this.server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const token = url.searchParams.get("token") ?? "";
        if (token !== this.token) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("forbidden");
          return;
        }
        if (url.pathname === "/" && req.method === "GET") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(PAGE);
          return;
        }
        if (url.pathname === "/frame" && req.method === "GET") {
          const page = await this.pageGetter();
          const buffer = await page.screenshot({ type: "jpeg", quality: 70 });
          res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
          res.end(buffer);
          return;
        }
        if (url.pathname === "/input" && req.method === "POST") {
          const body = await readBody(req);
          let payload: any = {};
          try {
            payload = JSON.parse(body);
          } catch {
            payload = {};
          }
          const page = await this.pageGetter();
          if (payload.type === "click" && Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
            await page.mouse.click(payload.x, payload.y, {
              button: payload.button === "right" ? "right" : "left",
            });
          } else if (payload.type === "text" && typeof payload.text === "string") {
            await page.keyboard.type(payload.text);
          } else if (payload.type === "key" && typeof payload.key === "string") {
            await page.keyboard.press(payload.key);
          } else if (payload.type === "scroll") {
            await page.mouse.wheel(Number(payload.dx) || 0, Number(payload.dy) || 0);
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (url.pathname === "/done" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          await this.stop();
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end((error as Error).message);
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    this.url = `http://127.0.0.1:${port}/?token=${this.token}`;
    this.active = true;
    this.timer = setTimeout(() => void this.stop(), this.options.timeoutMs);
    this.timer.unref?.();
    if (this.options.openWindow) openExternal(this.url);
    return { url: this.url, token: this.token, expiresInMs: this.options.timeoutMs };
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.active = false;
    this.url = null;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
