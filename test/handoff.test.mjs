import test from "node:test";
import assert from "node:assert/strict";
import { HandoffServer } from "../dist/handoff.js";

function fakePage(calls) {
  return {
    screenshot: async () => Buffer.from("fake-jpeg"),
    mouse: {
      click: async (x, y, options) => calls.push(["click", x, y, options]),
      wheel: async (dx, dy) => calls.push(["wheel", dx, dy]),
    },
    keyboard: {
      type: async (text) => calls.push(["type", text]),
      press: async (key) => calls.push(["press", key]),
    },
  };
}

test("handoff server serves a token-protected frame and forwards input", async () => {
  const calls = [];
  const server = new HandoffServer(async () => fakePage(calls), { openWindow: false, timeoutMs: 5000 });
  const info = await server.start();
  try {
    const token = new URL(info.url).searchParams.get("token");
    assert.ok(token);
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\//);

    const forbidden = await fetch(`${info.url.replace(/\/\?.*$/, "/frame")}`);
    assert.equal(forbidden.status, 403);

    const frame = await fetch(`${info.url.replace("/?", "/frame?")}`);
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get("content-type"), "image/jpeg");
    assert.equal(Buffer.from(await frame.arrayBuffer()).toString(), "fake-jpeg");

    const base = info.url.replace(/\/\?.*$/, "");
    const click = await fetch(`${base}/input?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "click", x: 10, y: 20, button: "left" }),
    });
    assert.equal(click.status, 200);
    const type = await fetch(`${base}/input?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "text", text: "hello" }),
    });
    assert.equal(type.status, 200);
    assert.deepEqual(calls[0].slice(0, 3), ["click", 10, 20]);
    assert.deepEqual(calls[1], ["type", "hello"]);

    const done = await fetch(`${base}/done?token=${token}`, { method: "POST" });
    assert.equal(done.status, 200);
    assert.equal(server.active, false);
  } finally {
    await server.stop();
  }
});

test("handoff server stops after the timeout", async () => {
  const server = new HandoffServer(async () => fakePage([]), { openWindow: false, timeoutMs: 50 });
  await server.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(server.active, false);
  await server.stop();
});
