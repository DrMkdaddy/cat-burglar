import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProxyUrl,
  redactProxyUrl,
  proxyEntriesFromConfig,
  ProxyPool,
} from "../dist/proxy.js";

test("parseProxyUrl handles http, socks5, socks5h, and credentials", () => {
  assert.deepEqual(parseProxyUrl("http://user:p%40ss@127.0.0.1:8080"), {
    server: "http://127.0.0.1:8080",
    username: "user",
    password: "p@ss",
  });
  assert.deepEqual(parseProxyUrl("socks5://127.0.0.1:1080"), {
    server: "socks5://127.0.0.1:1080",
  });
  assert.equal(parseProxyUrl("socks5h://127.0.0.1:1080").server, "socks5://127.0.0.1:1080");
});

test("parseProxyUrl accepts host:port:user:pass shorthand", () => {
  assert.deepEqual(parseProxyUrl("127.0.0.1:8080:user:pass"), {
    server: "http://127.0.0.1:8080",
    username: "user",
    password: "pass",
  });
});

test("redactProxyUrl never returns credentials", () => {
  const redacted = redactProxyUrl("http://user:secret@proxy.example:8080");
  assert.doesNotMatch(redacted, /user|secret/);
  assert.match(redacted, /proxy\.example/);
});

test("proxyEntriesFromConfig accepts arrays and newline strings", () => {
  const entries = proxyEntriesFromConfig([
    { id: "a", url: "http://user:pass@a:1", geo: { timezone: "Europe/Berlin" } },
    "http://b:2",
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "a");
  assert.equal(entries[1].id, "proxy-2");
  assert.equal(proxyEntriesFromConfig("http://a:1\nhttp://b:2").length, 2);
});

test("proxy pool rotates and can skip the current entry", () => {
  const pool = new ProxyPool(proxyEntriesFromConfig(["http://a:1", "http://b:2"]), {
    mode: "round-robin",
  });
  const first = pool.select();
  assert.equal(first.id, "proxy-1");
  assert.equal(pool.next(first.id).id, "proxy-2");
});

test("sticky proxy mode reuses the key mapping", () => {
  const pool = new ProxyPool(proxyEntriesFromConfig(["http://a:1", "http://b:2"]), {
    mode: "sticky",
  });
  assert.equal(pool.select("tab-1").id, pool.select("tab-1").id);
});
