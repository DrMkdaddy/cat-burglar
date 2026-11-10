import test from "node:test";
import assert from "node:assert/strict";
import {
  checkUrl,
  isPrivateOrReservedIp,
  isTrackerHost,
  originAllowed,
} from "../dist/security.js";
import { loadConfig } from "../dist/config.js";

const config = {
  ...loadConfig(),
  allowPrivateNetwork: false,
  allowFileUrls: false,
  allowedOrigins: [],
  blockedOrigins: [],
  trackerAllowlist: [],
};

test("private and reserved IPv4 ranges are detected", () => {
  for (const ip of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
  ]) {
    assert.equal(isPrivateOrReservedIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1"]) {
    assert.equal(isPrivateOrReservedIp(ip), false, ip);
  }
});

test("private and reserved IPv6 ranges are detected", () => {
  for (const ip of [
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2001:db8::1",
  ]) {
    assert.equal(isPrivateOrReservedIp(ip), true, ip);
  }
  assert.equal(isPrivateOrReservedIp("2606:4700:4700::1111"), false);
});

test("checkUrl blocks private networks unless explicitly allowed", async () => {
  const blocked = await checkUrl("http://127.0.0.1:3000/", config, false);
  assert.equal(blocked.ok, false);
  const allowed = await checkUrl("http://127.0.0.1:3000/", config, true);
  assert.equal(allowed.ok, true);
  const lan = await checkUrl("http://192.168.0.10/", config, false);
  assert.equal(lan.ok, false);
});

test("cloud metadata endpoints are never allowed", async () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://[fd00:ec2::254]/",
    "http://metadata.google.internal/",
  ]) {
    const result = await checkUrl(url, config, true);
    assert.equal(result.ok, false, url);
  }
});

test("unsupported schemes and file URLs are rejected by default", async () => {
  assert.equal((await checkUrl("file:///etc/passwd", config, true)).ok, false);
  assert.equal((await checkUrl("ftp://example.com/file", config, true)).ok, false);
  assert.equal((await checkUrl("javascript:alert(1)", config, true)).ok, false);
});

test("origin allow and block lists use wildcard hosts", () => {
  const local = {
    ...config,
    allowedOrigins: ["https://*.example.com", "http://localhost:3000"],
    blockedOrigins: ["https://ads.example.com"],
  };
  assert.equal(originAllowed("https://app.example.com/x", local).ok, true);
  assert.equal(originAllowed("https://example.com/x", local).ok, true);
  assert.equal(originAllowed("https://other.com/x", local).ok, false);
  assert.equal(originAllowed("http://localhost:3000/x", local).ok, true);
  assert.equal(originAllowed("http://localhost:4000/x", local).ok, false);
  assert.equal(originAllowed("https://ads.example.com/x", local).ok, false);
});

test("tracker blocklist matches subdomains but not the parent site", () => {
  assert.equal(isTrackerHost("google-analytics.com", config), true);
  assert.equal(isTrackerHost("www.google-analytics.com", config), true);
  assert.equal(isTrackerHost("ssl.google-analytics.com", config), true);
  assert.equal(isTrackerHost("google.com", config), false);
  assert.equal(isTrackerHost("github.com", config), false);

  const allowlisted = { ...config, trackerAllowlist: ["google-analytics.com"] };
  assert.equal(isTrackerHost("www.google-analytics.com", allowlisted), false);
});
