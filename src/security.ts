import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { BrowserContext, Route } from "playwright-core";
import type { Config } from "./config.js";
import { TRACKER_DOMAINS } from "./data/tracker-domains.js";

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

export interface GuardOptions {
  allowPrivate: boolean;
  blockTrackers: boolean;
  onBlock?: (url: string, reason: string) => void;
}

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data",
  "metadata",
]);

const METADATA_IPS = new Set([
  "169.254.169.254", // AWS / GCP / Azure / OpenStack
  "169.254.170.2", // AWS ECS task metadata
  "100.100.100.200", // Alibaba Cloud
  "192.0.0.192", // Oracle Cloud
  "fd00:ec2::254", // AWS IMDSv6
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8) + n;
  }
  return value >>> 0;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function parseIpv6(ip: string): number[] | null {
  let input = ip.toLowerCase();
  const zone = input.indexOf("%");
  if (zone !== -1) input = input.slice(0, zone);

  // Embedded IPv4 tail.
  let tail: number[] = [];
  const lastColon = input.lastIndexOf(":");
  const maybeV4 = input.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = ipv4ToInt(maybeV4);
    if (v4 === null) return null;
    tail = [(v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff];
    input = input.slice(0, lastColon + 1) + "0:0";
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = 8;
  if (halves.length === 1) {
    if (left.length !== groups) return null;
  } else if (left.length + right.length > groups - 1) {
    return null;
  }
  const words: number[] = [];
  for (const part of left) {
    const n = Number.parseInt(part || "0", 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    words.push(n);
  }
  const missing = groups - left.length - right.length - (tail.length ? 1 : 0);
  for (let i = 0; i < missing; i++) words.push(0);
  for (const part of right) {
    const n = Number.parseInt(part || "0", 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    words.push(n);
  }
  if (tail.length) words.push((tail[0]! << 8) | tail[1]!, (tail[2]! << 8) | tail[3]!);
  if (words.length !== 8) return null;
  return words;
}

function ipv6ToV4(words: number[]): string {
  const w = words.slice(6);
  return `${(w[0]! >> 8) & 0xff}.${w[0]! & 0xff}.${(w[1]! >> 8) & 0xff}.${w[1]! & 0xff}`;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    if (METADATA_IPS.has(ip)) return true;
    return (
      inCidr4(ip, "0.0.0.0", 8) ||
      inCidr4(ip, "10.0.0.0", 8) ||
      inCidr4(ip, "100.64.0.0", 10) ||
      inCidr4(ip, "127.0.0.0", 8) ||
      inCidr4(ip, "169.254.0.0", 16) ||
      inCidr4(ip, "172.16.0.0", 12) ||
      inCidr4(ip, "192.0.0.0", 24) ||
      inCidr4(ip, "192.0.2.0", 24) ||
      inCidr4(ip, "192.168.0.0", 16) ||
      inCidr4(ip, "198.18.0.0", 15) ||
      inCidr4(ip, "198.51.100.0", 24) ||
      inCidr4(ip, "203.0.113.0", 24) ||
      inCidr4(ip, "224.0.0.0", 4) ||
      inCidr4(ip, "240.0.0.0", 4)
    );
  }
  if (family === 6) {
    if (METADATA_IPS.has(ip)) return true;
    const w = parseIpv6(ip);
    if (!w) return true; // Unparseable: fail closed.
    const zero = w.every((x) => x === 0);
    if (zero) return true;
    if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
    if ((w[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((w[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((w[0]! & 0xff00) === 0xff00) return true; // ff00::/8
    if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // 2001:db8::/32
    // IPv4-mapped ::ffff:0:0/96
    if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) {
      return isPrivateOrReservedIp(ipv6ToV4(w));
    }
    // NAT64 64:ff9b::/96
    if (w[0] === 0x0064 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) {
      return isPrivateOrReservedIp(ipv6ToV4(w));
    }
    // 6to4 2002::/16
    if (w[0] === 0x2002) {
      const v4 = `${(w[1]! >> 8) & 0xff}.${w[1]! & 0xff}.${(w[2]! >> 8) & 0xff}.${w[2]! & 0xff}`;
      return isPrivateOrReservedIp(v4);
    }
    // Teredo 2001::/32
    if (w[0] === 0x2001 && w[1] === 0x0000) return true;
    return false;
  }
  return false;
}

const dnsCache = new Map<string, { at: number; addresses: string[] }>();
const DNS_TTL_MS = 60_000;

async function resolveHost(host: string): Promise<string[]> {
  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.at < DNS_TTL_MS) return cached.addresses;
  const result = await lookup(host, { all: true, verbatim: true });
  const addresses = result.map((entry) => entry.address);
  dnsCache.set(host, { at: Date.now(), addresses });
  return addresses;
}

export function clearDnsCache(): void {
  dnsCache.clear();
}

function wildcardHostMatch(host: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase().replace(/^\./, "");
  if (normalized === "*") return true;
  if (normalized.startsWith("*.")) {
    const base = normalized.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === normalized;
}

function originMatches(pattern: string, url: URL): boolean {
  let raw = pattern.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  if (!raw.includes("://")) raw = `*://${raw}`;
  const schemeWildcard = raw.startsWith("*://");
  if (schemeWildcard) raw = raw.slice(4);

  let scheme = "";
  if (!schemeWildcard) {
    const sep = raw.indexOf("://");
    if (sep !== -1) {
      scheme = raw.slice(0, sep).toLowerCase();
      raw = raw.slice(sep + 3);
    }
  }

  let port = "";
  const portMatch = raw.match(/:(\d+)$/);
  if (portMatch) {
    port = portMatch[1]!;
    raw = raw.slice(0, -portMatch[0].length);
  }
  const host = raw.split("/")[0]!.toLowerCase();

  if (scheme && scheme !== "*" && scheme !== url.protocol.replace(":", "")) return false;
  if (port && Number(port) !== Number(url.port || defaultPort(url.protocol))) return false;
  return wildcardHostMatch(url.hostname.toLowerCase(), host);
}

function defaultPort(protocol: string): string {
  if (protocol === "https:" || protocol === "wss:") return "443";
  if (protocol === "http:" || protocol === "ws:") return "80";
  return "";
}

export function originAllowed(rawUrl: string, config: Config): UrlCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (config.blockedOrigins.some((pattern) => originMatches(pattern, url))) {
    return { ok: false, reason: `origin blocked by BROWSER_MCP_BLOCKED_ORIGINS (${url.origin})` };
  }
  if (
    config.allowedOrigins.length > 0 &&
    !config.allowedOrigins.some((pattern) => originMatches(pattern, url))
  ) {
    return { ok: false, reason: `origin not in BROWSER_MCP_ALLOWED_ORIGINS (${url.origin})` };
  }
  return { ok: true };
}

function trackerAllowlistMatch(host: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase().replace(/^\./, "");
  if (normalized === "*") return true;
  if (normalized.startsWith("*.")) {
    const base = normalized.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  // A bare allowlist entry covers the domain and its subdomains.
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function isTrackerHost(host: string, config: Config): boolean {
  const normalized = host.toLowerCase();
  if (config.trackerAllowlist.some((pattern) => trackerAllowlistMatch(normalized, pattern))) {
    return false;
  }
  let domain = normalized;
  while (true) {
    if (TRACKER_DOMAINS.has(domain)) return true;
    const dot = domain.indexOf(".");
    if (dot === -1) return false;
    domain = domain.slice(dot + 1);
  }
}

/**
 * Validate a URL the agent asked to open. Mirrors Obscura's SSRF posture:
 * private networks are opt-in, cloud metadata endpoints never are.
 */
export async function checkUrl(
  rawUrl: string,
  config: Config,
  allowPrivate: boolean,
): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `invalid URL: ${rawUrl}` };
  }

  if (url.protocol === "file:") {
    return config.allowFileUrls
      ? { ok: true }
      : { ok: false, reason: "file:// URLs are disabled (set allowFileUrls)" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol: ${url.protocol}` };
  }

  const originCheck = originAllowed(rawUrl, config);
  if (!originCheck.ok) return originCheck;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (METADATA_HOSTS.has(host) || METADATA_IPS.has(host)) {
    return { ok: false, reason: `cloud metadata endpoint is never allowed: ${host}` };
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    if (!allowPrivate) return { ok: false, reason: `private network blocked: ${host}` };
  }

  if (isIP(host)) {
    if (METADATA_IPS.has(host)) {
      return { ok: false, reason: `cloud metadata endpoint is never allowed: ${host}` };
    }
    if (!allowPrivate && isPrivateOrReservedIp(host)) {
      return { ok: false, reason: `private network blocked: ${host}` };
    }
    return { ok: true };
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch (error) {
    return { ok: false, reason: `DNS lookup failed for ${host}: ${(error as Error).message}` };
  }
  for (const address of addresses) {
    if (METADATA_IPS.has(address)) {
      return { ok: false, reason: `cloud metadata endpoint is never allowed: ${address}` };
    }
    if (!allowPrivate && isPrivateOrReservedIp(address)) {
      return { ok: false, reason: `private network blocked: ${host} resolves to ${address}` };
    }
  }
  return { ok: true };
}

/**
 * Per-request guard. Catches redirects and subresources that would otherwise
 * bypass the navigation-time check (DNS rebinding included, up to the cache TTL).
 */
export async function installRequestGuard(
  context: BrowserContext,
  config: Config,
  options: GuardOptions,
): Promise<void> {
  const block = (route: Route, url: string, reason: string): void => {
    options.onBlock?.(url, reason);
    void route.abort("blockedbyclient").catch(() => undefined);
  };

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const scheme = url.split(":", 1)[0]!.toLowerCase();

    if (scheme === "data" || scheme === "blob" || scheme === "about" || scheme === "chrome-extension") {
      return route.continue().catch(() => undefined);
    }
    if (scheme === "file") {
      if (!config.allowFileUrls) return block(route, url, "file:// URL blocked");
      return route.continue().catch(() => undefined);
    }
    if (scheme !== "http" && scheme !== "https") {
      return block(route, url, `unsupported scheme ${scheme}:`);
    }

    const originCheck = originAllowed(url, config);
    if (!originCheck.ok) return block(route, url, originCheck.reason ?? "origin blocked");

    if (options.blockTrackers) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (isTrackerHost(host, config)) return block(route, url, `tracker blocked: ${host}`);
      } catch {
        // fall through
      }
    }

    const check = await checkUrl(url, config, options.allowPrivate);
    if (!check.ok) return block(route, url, check.reason ?? "blocked");
    return route.continue().catch(() => undefined);
  });
}
