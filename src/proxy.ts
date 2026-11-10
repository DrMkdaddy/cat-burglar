import { spawn } from "node:child_process";

export type ProxyMode = "round-robin" | "random" | "sticky";

export interface ProxyGeo {
  country?: string;
  city?: string;
  timezone?: string;
  locale?: string;
}

export interface ProxyEntry {
  id: string;
  url: string;
  label?: string;
  geo?: ProxyGeo;
}

export interface ProxyPoolOptions {
  mode: ProxyMode;
  healthCheckUrl: string;
  geoLookupUrl: string;
  rotateOnError: boolean;
  matchGeo: boolean;
  testOnLaunch: boolean;
  timeoutMs: number;
}

export interface ProxyHealth {
  id: string;
  ok: boolean;
  ip?: string;
  country?: string;
  city?: string;
  timezone?: string;
  latencyMs: number;
  checkedAt: number;
  error?: string;
}

export interface PlaywrightProxy {
  server: string;
  username?: string;
  password?: string;
}

export const DEFAULT_PROXY_OPTIONS: ProxyPoolOptions = {
  mode: "round-robin",
  healthCheckUrl: "https://ipapi.co/json/",
  geoLookupUrl: "https://ipapi.co/json/",
  rotateOnError: true,
  matchGeo: true,
  testOnLaunch: false,
  timeoutMs: 15_000,
};

function ensureScheme(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  if (value.includes("://")) return value;
  // host:port:user:pass
  const parts = value.split(":");
  if (parts.length === 4 && /^\d+$/.test(parts[1] ?? "")) {
    const [host, port, user, pass] = parts;
    return `http://${encodeURIComponent(user!)}:${encodeURIComponent(pass!)}@${host}:${port}`;
  }
  // user:pass@host:port
  if (value.includes("@")) return `http://${value}`;
  return `http://${value}`;
}

export function parseProxyUrl(raw: string): PlaywrightProxy {
  const normalized = ensureScheme(raw);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`invalid proxy URL: ${redactProxyUrl(raw)}`);
  }
  const protocol = url.protocol.replace(":", "").toLowerCase();
  if (!["http", "https", "socks5", "socks5h", "socks4"].includes(protocol)) {
    throw new Error(`unsupported proxy protocol: ${protocol}`);
  }
  const serverProtocol = protocol === "socks5h" ? "socks5" : protocol;
  const port = url.port || (serverProtocol === "https" ? "443" : serverProtocol.startsWith("socks") ? "1080" : "80");
  const server = `${serverProtocol}://${url.hostname}:${port}`;
  const result: PlaywrightProxy = { server };
  if (url.username) result.username = decodeURIComponent(url.username);
  if (url.password) result.password = decodeURIComponent(url.password);
  return result;
}

export function redactProxyUrl(raw: string): string {
  const normalized = ensureScheme(raw);
  try {
    const url = new URL(normalized);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "***";
  }
}

export function proxyEntriesFromConfig(value: unknown): ProxyEntry[] {
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.trim();
    if (!text) return [];
    try {
      parsed = JSON.parse(text);
    } catch {
      // Comma or newline separated URLs.
      parsed = text.split(/[\n,]/).map((url) => ({ url: url.trim() })).filter((item) => item.url);
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item, index) => {
      if (typeof item === "string") {
        return { id: `proxy-${index + 1}`, url: item };
      }
      if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        if (!record.url) return null;
        return {
          id: String(record.id ?? `proxy-${index + 1}`),
          url: String(record.url),
          ...(record.label ? { label: String(record.label) } : {}),
          ...(record.geo && typeof record.geo === "object"
            ? { geo: record.geo as ProxyGeo }
            : {}),
        };
      }
      return null;
    })
    .filter((entry): entry is ProxyEntry => entry !== null);
}

function escapeCurlConfig(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function curlThroughProxy(
  proxyUrl: string,
  targetUrl: string,
  timeoutMs: number,
): Promise<{ body: string; latencyMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(
      "curl",
      ["-sS", "-L", "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))), "-K", "-", targetUrl],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve({ body: stdout.trim(), latencyMs: Date.now() - started });
      } else {
        reject(new Error(stderr.trim() || `curl exited with ${code}`));
      }
    });
    child.stdin.write(`proxy = "${escapeCurlConfig(proxyUrl)}"\n`);
    child.stdin.end();
  });
}

export class ProxyPool {
  readonly entries: ProxyEntry[];
  readonly options: ProxyPoolOptions;
  private index = 0;
  private sticky = new Map<string, string>();
  private health = new Map<string, ProxyHealth>();

  constructor(entries: ProxyEntry[], options: Partial<ProxyPoolOptions> = {}) {
    this.entries = entries.map((entry) => ({ ...entry, ...(entry.geo ? { geo: { ...entry.geo } } : {}) }));
    this.options = { ...DEFAULT_PROXY_OPTIONS, ...options };
  }

  get size(): number {
    return this.entries.length;
  }

  find(id: string): ProxyEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  select(key = "default"): ProxyEntry | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.options.mode === "sticky") {
      const id = this.sticky.get(key);
      const existing = id ? this.find(id) : undefined;
      if (existing) return existing;
    }
    if (this.options.mode === "random") {
      return this.entries[Math.floor(Math.random() * this.entries.length)];
    }
    const entry = this.entries[this.index % this.entries.length]!;
    this.index += 1;
    if (this.options.mode === "sticky") this.sticky.set(key, entry.id);
    return entry;
  }

  next(excludeId?: string): ProxyEntry | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.entries.length === 1) return this.entries[0];
    let candidate = this.entries[this.index % this.entries.length]!;
    this.index += 1;
    if (candidate.id === excludeId) {
      candidate = this.entries[this.index % this.entries.length]!;
      this.index += 1;
    }
    return candidate;
  }

  mark(id: string, ok: boolean): void {
    const health = this.health.get(id);
    if (health) health.ok = ok;
  }

  healthFor(id: string): ProxyHealth | undefined {
    return this.health.get(id);
  }

  redacted(): Array<Record<string, unknown>> {
    return this.entries.map((entry) => ({
      id: entry.id,
      url: redactProxyUrl(entry.url),
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.geo ? { geo: entry.geo } : {}),
      health: this.health.get(entry.id) ?? null,
    }));
  }

  async testEntry(
    entry: ProxyEntry,
    options: { force?: boolean; timeoutMs?: number } = {},
  ): Promise<ProxyHealth> {
    const cached = this.health.get(entry.id);
    if (!options.force && cached && Date.now() - cached.checkedAt < 5 * 60_000) {
      return cached;
    }
    const checkedAt = Date.now();
    try {
      const response = await curlThroughProxy(
        entry.url,
        this.options.healthCheckUrl,
        options.timeoutMs ?? this.options.timeoutMs,
      );
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(response.body) as Record<string, unknown>;
      } catch {
        payload = { ip: response.body.split(/\s+/)[0] };
      }
      const health: ProxyHealth = {
        id: entry.id,
        ok: Boolean(payload.ip),
        ...(payload.ip ? { ip: String(payload.ip) } : {}),
        ...(payload.country_code ? { country: String(payload.country_code) } : {}),
        ...(payload.country ? { country: String(payload.country) } : {}),
        ...(payload.city ? { city: String(payload.city) } : {}),
        ...(payload.timezone ? { timezone: String(payload.timezone) } : {}),
        latencyMs: response.latencyMs,
        checkedAt,
      };
      this.health.set(entry.id, health);
      return health;
    } catch (error) {
      const health: ProxyHealth = {
        id: entry.id,
        ok: false,
        latencyMs: Date.now() - checkedAt,
        checkedAt,
        error: (error as Error).message.slice(0, 300),
      };
      this.health.set(entry.id, health);
      return health;
    }
  }

  async test(
    id?: string,
    options: { force?: boolean; timeoutMs?: number } = {},
  ): Promise<ProxyHealth[]> {
    const targets = id ? [this.find(id)].filter(Boolean) : this.entries;
    const results: ProxyHealth[] = [];
    for (const entry of targets as ProxyEntry[]) {
      results.push(await this.testEntry(entry, options));
    }
    return results;
  }

  geoFor(entry: ProxyEntry, health?: ProxyHealth): ProxyGeo | undefined {
    const merged = {
      ...(entry.geo ?? {}),
      ...(health?.timezone ? { timezone: health.timezone } : {}),
      ...(health?.country ? { country: health.country } : {}),
      ...(health?.city ? { city: health.city } : {}),
    };
    return Object.keys(merged).length ? merged : undefined;
  }
}
