import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Config, EngineKind } from "./config.js";
import { resolveProfile, type ProfileLimits, type ProfileName } from "./profiles.js";
import { canonicalOrigin } from "./memory.js";
import {
  ProxyPool,
  parseProxyUrl,
  redactProxyUrl,
  type ProxyEntry,
  type ProxyHealth,
  type ProxyGeo,
} from "./proxy.js";
import {
  diffControls,
  textDelta,
  type ControlChange,
  type ControlDiff,
  type SnapshotRecord,
  type TextDelta,
} from "./diff.js";
import { checkUrl, installRequestGuard } from "./security.js";
import {
  extractReadable,
  extractStructured,
  installVitals as installVitalsPageScript,
  readVitals as readVitalsPageScript,
  resourceTimings as resourceTimingsPageScript,
  snapshotPage,
  detectCaptcha,
  stealthReport as stealthReportPageScript,
  type CaptchaReport,
  type ControlInfo,
  type ExtractMode,
  type ExtractMode as ExtractModeType,
  type ReadableResult,
  type SelectorField,
  type SnapshotData,
  type StealthReport,
  type VitalsData,
} from "./page-scripts.js";
import { ensureDir, safeArtifactPath, timestamp, writeArtifact } from "./artifacts.js";
import { HandoffServer, type HandoffInfo } from "./handoff.js";

export interface NetworkEntry {
  id: number;
  page: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  size?: number;
  durationMs?: number;
  failed?: string;
  startedAt: number;
}

export interface ConsoleEntry {
  id: number;
  page: number;
  type: string;
  text: string;
  url?: string;
  line?: number;
  at: number;
}

export interface TabInfo {
  index: number;
  active: boolean;
  url: string;
  title: string;
  closed: boolean;
}

export interface OpenOptions {
  engine?: EngineKind;
  profile?: ProfileName;
  headless?: boolean;
  proxy?: string;
  proxyId?: string;
  proxyTest?: boolean;
  matchGeo?: boolean;
  cdpUrl?: string;
  cdpHeaders?: Record<string, string>;
  cdpTimeout?: number;
  liveViewUrl?: string;
  captchaOpenWindow?: boolean;
  stealth?: boolean;
  allowPrivate?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezone?: string;
  humanize?: boolean;
  blockTrackers?: boolean;
  blockMedia?: boolean;
}

export interface ClickOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  humanize?: boolean;
}

export interface SnapshotDiff {
  controls: ControlDiff;
  text: TextDelta | null;
}

export interface SnapshotResult {
  data: SnapshotData;
  id: string;
  previousId?: string;
  diff?: SnapshotDiff;
}

export interface Observation {
  snapshotId: string;
  previousId?: string;
  url: string;
  title: string;
  urlChanged?: boolean;
  titleChanged?: boolean;
  diff?: SnapshotDiff;
  changed: boolean;
}

export interface ActionRecord {
  tool: string;
  arguments: Record<string, unknown>;
  url: string;
  at: number;
}

export interface HarResult {
  path: string;
  entries: number;
  bytes: number;
}

export interface CpuProfileResult {
  path: string;
  durationMs: number;
  nodes: number;
  top: Array<{ function: string; url: string; hits: number }>;
}

export interface CoverageEntry {
  url: string;
  totalBytes: number;
  usedBytes: number;
  unusedBytes: number;
  unusedPercent: number;
}

export interface ThrottleOptions {
  offline?: boolean;
  latencyMs?: number;
  downloadKbps?: number;
  uploadKbps?: number;
  cpuRate?: number;
}

export interface PerfSummary {
  artifact?: string;
  durationMs: number;
  longTasks: Array<{ durationMs: number; url: string }>;
  scripts: Array<{ url: string; totalMs: number; calls: number }>;
  counts: Record<string, number>;
  totals: Record<string, number>;
}

const CHROMIUM_CANDIDATES = [
  process.env.BROWSER_MCP_CHROMIUM_PATH,
  process.env.CHROME_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
].filter(Boolean) as string[];

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not allocate a port for Obscura");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function parseProxy(proxy: string | undefined): Record<string, string> | undefined {
  if (!proxy) return undefined;
  try {
    const url = new URL(proxy);
    const server = `${url.protocol}//${url.host}`;
    const result: Record<string, string> = { server };
    if (url.username) result.username = decodeURIComponent(url.username);
    if (url.password) result.password = decodeURIComponent(url.password);
    return result;
  } catch {
    return { server: proxy };
  }
}

export function redactUrl(raw: string, redactParams: string[]): string {
  if (redactParams.length === 0) return raw;
  try {
    const url = new URL(raw);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (redactParams.includes(key.toLowerCase())) {
        url.searchParams.set(key, "[redacted]");
        changed = true;
      }
    }
    return changed ? url.toString() : raw;
  } catch {
    return raw;
  }
}

export class BrowserSession {
  readonly config: Config;
  engine: EngineKind | null = null;
  profile: ProfileName;
  limits: ProfileLimits;
  allowPrivate: boolean;
  humanize: boolean;
  blockTrackers: boolean;
  blockMedia = false;
  guardActive = true;

  private context: any = null;
  private browser: any = null;
  private obscuraProcess: ChildProcess | null = null;
  private obscuraLogs: string[] = [];
  private pages: any[] = [];
  private activeIndex = 0;
  private attached = new WeakSet<object>();
  private pageByKey = new Map<string, any>();
  private objectKeys = new WeakMap<object, string>();
  private nextObjectKey = 0;
  private network: NetworkEntry[] = [];
  private requestIds = new WeakMap<object, NetworkEntry>();
  private consoleEntries: ConsoleEntry[] = [];
  private entryId = 0;
  private downloads: Array<{ path: string; url: string; at: number }> = [];
  private traceClients = new Map<object, { client: any; startedAt: number }>();
  private viewport: { width: number; height: number };
  private snapshotHistory = new Map<string, SnapshotRecord[]>();
  private snapshotSeq = 0;
  private actionLog: ActionRecord[] = [];
  readonly proxyPool: ProxyPool;
  currentProxy?: ProxyEntry;
  currentProxyHealth?: ProxyHealth;
  private cdpUrl?: string;
  private lastLaunchOptions: OpenOptions = {};
  private harSessions = new Map<object, { client: any; entries: Map<string, any>; startedAt: number }>();
  private cpuSessions = new Map<object, { client: any; startedAt: number }>();
  private coverageSessions = new Map<object, { client: any; startedAt: number }>();
  private idleTimer: NodeJS.Timeout | null = null;
  private handoff?: HandoffServer;
  private handoffUrl?: string;
  private liveViewUrl?: string;
  private windowHandoff = false;
  profileFallback?: string;

  constructor(config: Config) {
    this.config = config;
    this.proxyPool = new ProxyPool(config.proxyPool, config.proxyOptions);
    this.profile = config.profile;
    this.limits = resolveProfile(config.profile);
    this.allowPrivate = config.allowPrivateNetwork;
    this.humanize = config.humanize;
    this.blockTrackers = config.blockTrackers;
    this.viewport = { ...config.viewport };
  }

  get running(): boolean {
    return Boolean(this.context);
  }

  status(): Record<string, unknown> {
    return {
      running: this.running,
      engine: this.engine,
      profile: this.profile,
      profileFallback: this.profileFallback ?? null,
      limits: this.limits,
      allowPrivate: this.allowPrivate,
      humanize: this.humanize,
      blockTrackers: this.blockTrackers,
      blockMedia: this.blockMedia,
      guard: this.guardActive,
      viewport: this.viewport,
      proxy: this.currentProxy
        ? {
            id: this.currentProxy.id,
            label: this.currentProxy.label,
            url: redactProxyUrl(this.currentProxy.url),
            health: this.currentProxyHealth ?? null,
          }
        : null,
      proxyPool: this.proxyPool.size,
      cdp: this.safeCdpUrl(),
      handoff: this.handoffStatus(),
      tabs: this.pages.length,
      url: this.safeUrl(),
      networkEntries: this.network.length,
      consoleEntries: this.consoleEntries.length,
      downloads: this.downloads.slice(-5),
    };
  }

  private safeUrl(): string | undefined {
    try {
      return this.context ? this.activePageSync()?.url() : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Obscura sometimes emits two Page wrappers for one CDP target. Playwright's
   * internal target guid is the stable identity, so dedupe on it and replace the
   * old wrapper in place when a newer one arrives.
   */
  private pageKey(page: any): string {
    const guid = page?._guid;
    if (typeof guid === "string" && guid) return `guid:${guid}`;
    let key = this.objectKeys.get(page);
    if (!key) {
      key = `obj:${++this.nextObjectKey}`;
      this.objectKeys.set(page, key);
    }
    return key;
  }

  private registerPage(page: any): void {
    const key = this.pageKey(page);
    const existing = this.pageByKey.get(key);
    if (!existing) {
      this.pageByKey.set(key, page);
      this.pages.push(page);
      this.attachPage(page);
      return;
    }
    if (existing !== page) {
      const index = this.pages.indexOf(existing);
      if (index === -1) this.pages.push(page);
      else this.pages[index] = page;
      this.pageByKey.set(key, page);
      this.attachPage(page);
    }
  }

  private unregisterPage(page: any): void {
    const key = this.pageKey(page);
    this.pageByKey.delete(key);
    const index = this.pages.indexOf(page);
    if (index !== -1) {
      this.pages.splice(index, 1);
      if (index < this.activeIndex) this.activeIndex -= 1;
      if (this.activeIndex >= this.pages.length) {
        this.activeIndex = Math.max(0, this.pages.length - 1);
      }
    }
  }

  private activePageSync(): any | undefined {
    const alive = this.pages.filter((page) => !page.isClosed());
    if (alive.length === 0) return undefined;
    if (this.activeIndex >= alive.length) this.activeIndex = 0;
    return alive[this.activeIndex];
  }

  private safeCdpUrl(): string | null {
    if (!this.cdpUrl) return null;
    try {
      const url = new URL(this.cdpUrl);
      for (const key of [...url.searchParams.keys()]) {
        if (/key|token|secret|auth/i.test(key)) url.searchParams.set(key, "***");
      }
      if (url.username) url.username = "***";
      if (url.password) url.password = "***";
      return url.toString();
    } catch {
      return "***";
    }
  }

  private touch(): void {
    if (this.config.idleTimeoutMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, this.config.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async page(): Promise<any> {
    if (!this.context) throw new Error("browser is not open; call open/navigate first");
    this.touch();
    const alive = this.pages.filter((page) => !page.isClosed());
    if (alive.length === 0) {
      const page = await this.context.newPage();
      this.registerPage(page);
      this.activeIndex = this.pages.indexOf(page);
      return this.pageByKey.get(this.pageKey(page)) ?? page;
    }
    this.pages = alive;
    if (this.activeIndex >= alive.length) this.activeIndex = 0;
    return alive[this.activeIndex];
  }

  async launch(options: OpenOptions = {}): Promise<void> {
    const engine = options.engine ?? this.config.defaultEngine;
    if (!["patchright", "chromium", "obscura", "remote"].includes(engine)) {
      throw new Error(`unknown engine "${engine}"`);
    }
    if (this.running) await this.close();
    this.lastLaunchOptions = { ...options };
    this.liveViewUrl = options.liveViewUrl;

    this.engine = engine;
    this.profile = options.profile ?? this.config.profile;
    this.limits = resolveProfile(this.profile);
    this.snapshotHistory.clear();
    this.actionLog = [];
    this.allowPrivate = options.allowPrivate ?? this.config.allowPrivateNetwork;
    this.humanize = options.humanize ?? this.config.humanize;
    this.blockTrackers = options.blockTrackers ?? this.config.blockTrackers;
    this.blockMedia = Boolean(options.blockMedia);
    this.viewport = options.viewport ?? { ...this.config.viewport };
    this.network = [];
    this.consoleEntries = [];
    this.entryId = 0;

    const cdpUrl = options.cdpUrl ?? this.config.cdpUrl;
    if (engine === "remote" || cdpUrl) {
      await this.launchRemote({ ...options, cdpUrl });
      return;
    }

    let proxyEntry: ProxyEntry | undefined;
    if (options.proxy) {
      proxyEntry = { id: "custom", url: options.proxy };
    } else if (this.proxyPool.size > 0) {
      proxyEntry = options.proxyId
        ? this.proxyPool.find(options.proxyId)
        : this.proxyPool.select("session");
      if (options.proxyId && !proxyEntry) throw new Error(`unknown proxy id "${options.proxyId}"`);
    }

    let proxyHealth: ProxyHealth | undefined;
    const wantsGeo = options.matchGeo ?? this.config.proxyOptions.matchGeo ?? false;
    const needsProxyTest =
      options.proxyTest === true ||
      this.config.proxyOptions.testOnLaunch === true ||
      (wantsGeo && !proxyEntry?.geo?.timezone);
    if (proxyEntry && needsProxyTest) {
      proxyHealth = await this.proxyPool.testEntry(proxyEntry, { force: options.proxyTest === true });
      if (
        !proxyHealth.ok &&
        this.config.proxyOptions.rotateOnError &&
        this.proxyPool.size > 1 &&
        !options.proxy
      ) {
        const next = this.proxyPool.next(proxyEntry.id);
        if (next) {
          proxyEntry = next;
          proxyHealth = await this.proxyPool.testEntry(next, { force: true });
        }
      }
    }
    this.currentProxy = proxyEntry;
    this.currentProxyHealth = proxyHealth;
    const geo: ProxyGeo | undefined = proxyEntry
      ? this.proxyPool.geoFor(proxyEntry, proxyHealth)
      : undefined;
    const locale = options.locale ?? geo?.locale ?? this.config.locale;
    const timezone = options.timezone ?? geo?.timezone ?? this.config.timezone;

    if (engine === "obscura") {
      await this.launchObscura({ ...options, proxy: proxyEntry?.url });
      return;
    }

    const chromium = await this.loadChromium(engine);
    const executablePath = firstExisting(CHROMIUM_CANDIDATES);
    const profileDir = join(this.config.profileDir, engine);
    ensureDir(profileDir);

    const launchOptions: Record<string, unknown> = {
      headless: options.headless ?? this.config.headless,
      viewport: this.viewport,
      locale,
      timezoneId: timezone,
      userAgent: options.userAgent ?? this.config.userAgent,
      proxy: proxyEntry ? parseProxyUrl(proxyEntry.url) : undefined,
      acceptDownloads: true,
      ignoreHTTPSErrors: false,
      args: [
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-pings",
        "--no-first-run",
        "--no-default-browser-check",
        "--force-color-profile=srgb",
        "--disable-blink-features=AutomationControlled",
        ...(proxyEntry
          ? [
              "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
              "--webrtc-ip-handling-policy=disable_non_proxied_udp",
            ]
          : []),
        ...(process.env.BROWSER_MCP_NO_SANDBOX === "1" || process.getuid?.() === 0
          ? ["--no-sandbox", "--disable-setuid-sandbox"]
          : []),
      ],
    };
    if (executablePath) launchOptions.executablePath = executablePath;
    if (launchOptions.proxy === undefined) delete launchOptions.proxy;
    if (launchOptions.userAgent === undefined) delete launchOptions.userAgent;
    if (launchOptions.timezoneId === undefined) delete launchOptions.timezoneId;

    this.context = await this.launchContext(chromium, profileDir, launchOptions);
    this.browser = this.context.browser?.() ?? null;
    await this.afterContextReady();
  }

  private async loadChromium(engine: "patchright" | "chromium"): Promise<any> {
    if (engine === "patchright") {
      const module = await import("patchright");
      return module.chromium;
    }
    const module = await import("playwright-core");
    return module.chromium;
  }

  private async launchContext(
    chromium: any,
    profileDir: string,
    launchOptions: Record<string, unknown>,
  ): Promise<any> {
    try {
      this.profileFallback = undefined;
      return await chromium.launchPersistentContext(profileDir, launchOptions);
    } catch (error) {
      const message = (error as Error).message ?? "";
      if (!/ProcessSingleton|profile.*(?:in use|already)|SingletonLock/i.test(message)) throw error;
      const fallback = join(this.config.profileDir, `${this.engine ?? "browser"}-${process.pid}`);
      ensureDir(fallback);
      this.profileFallback = fallback;
      if (process.env.BROWSER_MCP_DEBUG) {
        process.stderr.write(
          `[cat-burglar] profile busy, using isolated profile ${fallback}\n`,
        );
      }
      return chromium.launchPersistentContext(fallback, launchOptions);
    }
  }

  private async launchObscura(options: OpenOptions): Promise<void> {
    const binary = this.config.obscuraPath;
    if (!binary || !existsSync(binary)) {
      throw new Error(
        "Obscura is not installed. Run `npm run install:obscura` or set BROWSER_MCP_OBSCURA_PATH.",
      );
    }

    const port = await findFreePort();
    const storageDir = join(this.config.profileDir, "obscura");
    ensureDir(storageDir);
    const args = ["serve", "--port", String(port), "--storage-dir", storageDir, "--workers", "1"];
    if (options.stealth ?? true) args.push("--stealth");
    if (this.allowPrivate) args.push("--allow-private-network");
    const proxy = options.proxy ?? this.config.proxy;
    if (proxy) args.push("--proxy", proxy);

    this.obscuraLogs = [];
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.obscuraProcess = child;
    const collect = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.obscuraLogs.push(line);
        if (this.obscuraLogs.length > 60) this.obscuraLogs.shift();
      }
    };
    child.stderr?.on("data", collect);
    child.stdout?.on("data", collect);

    const chromium = await this.loadChromium("chromium");
    let connected = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) break;
      try {
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
          timeout: 1_500,
        });
        connected = true;
        break;
      } catch (error) {
        lastError = error;
        await sleep(125);
      }
    }
    if (!connected) {
      this.killObscura();
      throw new Error(
        `could not connect to Obscura on port ${port}: ${
          (lastError as Error)?.message ?? this.obscuraLogs.slice(-10).join("\n")
        }`,
      );
    }

    const contexts = this.browser.contexts();
    this.context = contexts[0] ?? (await this.browser.newContext());
    await this.afterContextReady();
  }

  private async launchRemote(options: OpenOptions): Promise<void> {
    const cdpUrl = options.cdpUrl ?? this.config.cdpUrl;
    if (!cdpUrl) throw new Error("remote engine requires cdp_url or BROWSER_MCP_CDP_URL");
    this.engine = "remote";
    this.cdpUrl = cdpUrl;
    this.currentProxy = undefined;
    this.currentProxyHealth = undefined;
    const chromium = await this.loadChromium("chromium");
    this.browser = await chromium.connectOverCDP(cdpUrl, {
      headers: options.cdpHeaders ?? this.config.cdpHeaders,
      timeout: options.cdpTimeout ?? 30_000,
    });
    const contexts = this.browser.contexts();
    this.context = contexts[0] ?? (await this.browser.newContext());
    await this.afterContextReady();
  }

  proxyStatus(): Record<string, unknown> {
    return {
      engine: this.engine,
      pool: this.proxyPool.redacted(),
      count: this.proxyPool.size,
      current: this.currentProxy
        ? {
            id: this.currentProxy.id,
            label: this.currentProxy.label,
            url: redactProxyUrl(this.currentProxy.url),
            health: this.currentProxyHealth ?? null,
          }
        : null,
      mode: this.proxyPool.options.mode,
    };
  }

  async proxyTest(id?: string, force = false): Promise<ProxyHealth[]> {
    return this.proxyPool.test(id, { force });
  }

  async rotateProxy(): Promise<Record<string, unknown>> {
    if (this.engine === "remote") throw new Error("cannot rotate the proxy of a remote CDP browser");
    if (this.proxyPool.size === 0) throw new Error("no proxy pool configured");
    const next = this.proxyPool.next(this.currentProxy?.id);
    if (!next) throw new Error("no proxy available");
    await this.launch({ ...this.lastLaunchOptions, proxy: undefined, proxyId: next.id });
    return this.proxyStatus();
  }

  resources(): Record<string, unknown> {
    const own = process.memoryUsage();
    const rssMb = Number((own.rss / 1024 / 1024).toFixed(1));
    const pids = this.processTree(process.pid);
    let treeRssKb = 0;
    for (const pid of pids) {
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
        if (match) treeRssKb += Number(match[1]);
      } catch {
        // ignore
      }
    }
    return {
      processRssMb: rssMb,
      treeRssMb: Number((treeRssKb / 1024).toFixed(1)),
      processes: pids.length,
      pages: this.pages.filter((page) => !page.isClosed()).length,
      networkEntries: this.network.length,
      consoleEntries: this.consoleEntries.length,
      snapshotTabs: this.snapshotHistory.size,
      engine: this.engine,
      profile: this.profile,
      profileFallback: this.profileFallback ?? null,
      limits: this.limits,
    };
  }

  private processTree(rootPid: number): number[] {
    const parents = new Map<number, number>();
    try {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          const close = stat.lastIndexOf(")");
          const fields = stat.slice(close + 2).split(" ");
          parents.set(Number(entry), Number(fields[1]));
        } catch {
          // ignore
        }
      }
    } catch {
      return [rootPid];
    }
    const result = [rootPid];
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of parents) {
        if (result.includes(parent) && !result.includes(pid)) {
          result.push(pid);
          changed = true;
        }
      }
    }
    return result;
  }

  private async afterContextReady(): Promise<void> {
    this.context.setDefaultTimeout(this.config.actionTimeoutMs);
    this.guardActive = true;
    try {
      await installRequestGuard(this.context, this.config, {
        allowPrivate: this.allowPrivate,
        blockTrackers: this.blockTrackers,
        blockMedia: this.blockMedia,
        onBlock: (url, reason) => {
          if (process.env.BROWSER_MCP_DEBUG) {
            process.stderr.write(`[browser-mcp] blocked ${url}: ${reason}\n`);
          }
        },
      });
    } catch (error) {
      if (this.engine !== "remote") throw error;
      this.guardActive = false;
      if (process.env.BROWSER_MCP_DEBUG) {
        process.stderr.write(`[browser-mcp] remote request guard unavailable: ${(error as Error).message}\n`);
      }
    }

    this.pages = [];
    this.pageByKey.clear();
    this.activeIndex = 0;
    for (const page of this.context.pages()) {
      this.registerPage(page);
    }
    this.context.on("page", (page: any) => {
      this.registerPage(page);
      this.activeIndex = Math.max(0, this.pages.indexOf(page));
    });

    if (this.pages.length === 0) {
      const page = await this.context.newPage();
      this.registerPage(page);
    }
    this.activeIndex = 0;
    this.touch();
  }

  private attachPage(page: any): void {
    if (this.attached.has(page)) return;
    this.attached.add(page);

    page.on("console", (message: any) => {
      this.pushConsole({
        type: message.type(),
        text: message.text(),
        url: message.location()?.url,
        line: message.location()?.lineNumber,
      });
    });
    page.on("pageerror", (error: Error) => {
      this.pushConsole({ type: "pageerror", text: `${error.name}: ${error.message}` });
    });
    page.on("request", (request: any) => this.onRequest(request));
    page.on("response", (response: any) => this.onResponse(response));
    page.on("requestfinished", (request: any) => void this.onRequestFinished(request));
    page.on("requestfailed", (request: any) => this.onRequestFailed(request));
    page.on("download", (download: any) => void this.onDownload(download));
    page.on("close", () => {
      const key = this.pageKey(page);
      if (this.pageByKey.get(key) !== page) return;
      this.unregisterPage(page);
    });
  }

  private pushConsole(entry: Omit<ConsoleEntry, "id" | "page" | "at">): void {
    this.consoleEntries.push({
      ...entry,
      id: ++this.entryId,
      page: this.activeIndex,
      at: Date.now(),
    });
    if (this.consoleEntries.length > this.config.maxConsoleEntries) {
      this.consoleEntries.splice(0, this.consoleEntries.length - this.config.maxConsoleEntries);
    }
  }

  private onRequest(request: any): void {
    const entry: NetworkEntry = {
      id: ++this.entryId,
      page: this.activeIndex,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      startedAt: Date.now(),
    };
    this.requestIds.set(request, entry);
    this.network.push(entry);
    if (this.network.length > this.config.maxNetworkEntries) {
      this.network.splice(0, this.network.length - this.config.maxNetworkEntries);
    }
  }

  private onResponse(response: any): void {
    const entry = this.requestIds.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    entry.statusText = response.statusText();
    entry.mimeType = response.headers()["content-type"];
  }

  private async onRequestFinished(request: any): Promise<void> {
    const entry = this.requestIds.get(request);
    if (!entry) return;
    try {
      const sizes = await request.sizes();
      entry.size = sizes.responseBodySize || sizes.requestBodySize || 0;
    } catch {
      // ignore
    }
    try {
      const timing = request.timing();
      if (timing?.responseEnd > 0) entry.durationMs = Math.round(timing.responseEnd);
      else entry.durationMs = Date.now() - entry.startedAt;
    } catch {
      entry.durationMs = Date.now() - entry.startedAt;
    }
  }

  private onRequestFailed(request: any): void {
    const entry = this.requestIds.get(request);
    if (!entry) return;
    entry.failed = request.failure()?.errorText ?? "failed";
    entry.durationMs = Date.now() - entry.startedAt;
  }

  private async onDownload(download: any): Promise<void> {
    try {
      const dir = join(this.config.artifactDir, "downloads");
      ensureDir(dir);
      const name = `${timestamp()}-${(download.suggestedFilename() || "download").replace(/[^\w.-]+/g, "_")}`;
      const path = join(dir, name);
      await download.saveAs(path);
      this.downloads.push({ path, url: download.url(), at: Date.now() });
      if (this.downloads.length > 50) this.downloads.shift();
    } catch {
      // ignore download failures
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.traceClients.clear();
    try {
      await this.context?.close();
    } catch {
      // ignore
    }
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
    this.context = null;
    this.browser = null;
    this.pages = [];
    this.activeIndex = 0;
    this.snapshotHistory.clear();
    this.actionLog = [];
    this.currentProxy = undefined;
    this.currentProxyHealth = undefined;
    this.cdpUrl = undefined;
    await this.stopHandoff();
    this.windowHandoff = false;
    this.liveViewUrl = undefined;
    this.killObscura();
    this.engine = null;
  }

  private killObscura(): void {
    if (this.obscuraProcess) {
      try {
        this.obscuraProcess.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.obscuraProcess = null;
    }
  }

  async navigate(url: string, waitUntil: "load" | "domcontentloaded" | "networkidle" = "load"): Promise<{
    url: string;
    title: string;
    status: number | null;
    captcha?: CaptchaReport;
  }> {
    if (!this.running) await this.launch();
    const check = await checkUrl(url, this.config, this.allowPrivate);
    if (!check.ok) throw new Error(check.reason ?? "URL blocked");
    const page = await this.page();
    // An explicit navigation starts a new observation context.
    this.snapshotHistory.delete(this.pageKey(page));
    const response = await page.goto(url, {
      waitUntil,
      timeout: this.config.navigationTimeoutMs,
    });
    await page.waitForTimeout(this.config.settleMs);
    const captcha = (await page.evaluate(detectCaptcha).catch(() => null)) as CaptchaReport | null;
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      status: response?.status() ?? null,
      ...(captcha?.detected ? { captcha } : {}),
    };
  }

  async back(): Promise<void> {
    const page = await this.page();
    await page.goBack({ timeout: this.config.navigationTimeoutMs, waitUntil: "load" });
  }

  async forward(): Promise<void> {
    const page = await this.page();
    await page.goForward({ timeout: this.config.navigationTimeoutMs, waitUntil: "load" });
  }

  async reload(): Promise<void> {
    const page = await this.page();
    await page.reload({ timeout: this.config.navigationTimeoutMs, waitUntil: "load" });
  }

  currentOrigin(): string {
    return canonicalOrigin(this.safeUrl() ?? "");
  }

  recordAction(tool: string, args: Record<string, unknown>): void {
    const safe: Record<string, unknown> = { ...args };
    delete safe.confirm;
    delete safe.humanize;
    delete safe.observe;
    if (tool === "fill") safe.value = "<value>";
    if (tool === "type") safe.text = "<text>";
    if (tool === "upload") safe.paths = ["<file>"];
    this.actionLog.push({
      tool,
      arguments: safe,
      url: this.safeUrl() ?? "",
      at: Date.now(),
    });
    if (this.actionLog.length > 80) this.actionLog.shift();
  }

  recentActions(origin?: string, limit = 20): ActionRecord[] {
    const filtered = origin
      ? this.actionLog.filter((entry) => canonicalOrigin(entry.url) === origin)
      : this.actionLog;
    return filtered.slice(-limit);
  }

  private historyFor(page: any): SnapshotRecord[] {
    const key = this.pageKey(page);
    const existing = this.snapshotHistory.get(key);
    if (existing) return existing;
    const created: SnapshotRecord[] = [];
    this.snapshotHistory.set(key, created);
    return created;
  }

  private storeSnapshot(page: any, data: SnapshotData): { record: SnapshotRecord; previous?: SnapshotRecord } {
    const history = this.historyFor(page);
    const previous = history[history.length - 1];
    const record: SnapshotRecord = {
      id: `s${++this.snapshotSeq}`,
      controls: data.controls,
      text: data.text,
      url: data.url,
      title: data.title,
      at: Date.now(),
    };
    history.push(record);
    if (history.length > 12) history.shift();
    return { record, previous };
  }

  private diffOf(previous: SnapshotRecord | undefined, data: SnapshotData, maxChars: number): SnapshotDiff | undefined {
    if (!previous) return undefined;
    return {
      controls: diffControls(previous.controls, data.controls),
      text: textDelta(previous.text, data.text, Math.min(maxChars, 900)),
    };
  }

  async snapshot(
    maxChars: number,
    maxControls: number,
    since?: string,
    viewportOnly?: boolean,
  ): Promise<SnapshotResult> {
    const page = await this.page();
    const data = (await page.evaluate(snapshotPage, {
      maxControls,
      maxText: maxChars,
      viewportOnly: Boolean(viewportOnly),
    })) as SnapshotData;
    const history = this.historyFor(page);
    const previous =
      (since ? history.find((entry) => entry.id === since) : undefined) ??
      history[history.length - 1];
    const { record } = this.storeSnapshot(page, data);
    return {
      data,
      id: record.id,
      ...(previous ? { previousId: previous.id, diff: this.diffOf(previous, data, maxChars) } : {}),
    };
  }

  /**
   * Agent-E style change observation: after a mutation, return only what
   * changed, bounded to the active profile's observation budget.
   */
  async observe(maxChars?: number): Promise<Observation> {
    const page = await this.page();
    await page
      .waitForLoadState("domcontentloaded", { timeout: 1_500 })
      .catch(() => undefined);
    await page.waitForTimeout(80);

    const budget = maxChars ?? this.limits.observationChars;
    const data = (await page.evaluate(snapshotPage, {
      maxControls: Math.min(this.limits.maxControls, 80),
      maxText: Math.max(budget, 400),
    })) as SnapshotData;
    const history = this.historyFor(page);
    const previous = history[history.length - 1];
    const { record } = this.storeSnapshot(page, data);
    const diff = this.diffOf(previous, data, budget);
    return {
      snapshotId: record.id,
      ...(previous ? { previousId: previous.id } : {}),
      url: data.url,
      title: data.title,
      ...(previous
        ? { urlChanged: previous.url !== data.url, titleChanged: previous.title !== data.title }
        : {}),
      ...(diff ? { diff } : {}),
      changed: Boolean(
        diff &&
          (diff.controls.added.length ||
            diff.controls.removed.length ||
            diff.controls.changed.length ||
            diff.text),
      ),
    };
  }

  async markdown(): Promise<ReadableResult> {
    const page = await this.page();
    return page.evaluate(extractReadable) as Promise<ReadableResult>;
  }

  async extract(
    mode: ExtractMode,
    options: {
      selector?: Record<string, string | SelectorField>;
      limit?: number;
    } = {},
  ): Promise<unknown> {
    const page = await this.page();
    return page.evaluate(extractStructured, {
      mode,
      selector: options.selector,
      limit: options.limit ?? 100,
    });
  }

  async stealthReport(): Promise<StealthReport> {
    const page = await this.page();
    return page.evaluate(stealthReportPageScript) as Promise<StealthReport>;
  }

  async evaluate(expression: string): Promise<unknown> {
    const page = await this.page();
    // Playwright evaluates the string in the page and awaits returned promises.
    return page.evaluate(expression);
  }

  async resolveHandle(target: {
    ref?: string;
    selector?: string;
    text?: string;
    role?: string;
    name?: string;
    exact?: boolean;
  }): Promise<any> {
    const page = await this.page();
    if (target.ref) {
      const handle = await page.evaluateHandle((ref: string) => {
        const map = (window as any).__bmRefs;
        return map?.get(ref) ?? null;
      }, target.ref);
      const element = handle.asElement();
      if (!element) throw new Error(`stale or unknown ref "${target.ref}"; take a fresh snapshot`);
      const connected = await element.evaluate((node: Element) => node.isConnected).catch(() => false);
      if (!connected) {
        throw new Error(`stale ref "${target.ref}" (element left the DOM); take a fresh snapshot`);
      }
      return element;
    }
    if (target.selector) {
      const element = await page.$(target.selector);
      if (!element) throw new Error(`no element matches selector "${target.selector}"`);
      return element;
    }
    if (target.role) {
      const locator = page.getByRole(target.role, target.name ? { name: target.name, exact: !!target.exact } : {});
      const element = await locator.first().elementHandle();
      if (!element) throw new Error(`no element with role "${target.role}"${target.name ? ` named "${target.name}"` : ""}`);
      return element;
    }
    if (target.text) {
      const locator = page.getByText(target.text, { exact: !!target.exact });
      const element = await locator.first().elementHandle();
      if (!element) throw new Error(`no element containing text "${target.text}"`);
      return element;
    }
    throw new Error("provide ref, selector, text, or role/name");
  }

  async click(
    target: { ref?: string; selector?: string; text?: string; role?: string; name?: string; exact?: boolean },
    options: ClickOptions = {},
  ): Promise<void> {
    const element = await this.resolveHandle(target);
    await element.scrollIntoViewIfNeeded().catch(() => undefined);
    const button = options.button ?? "left";
    const clickCount = options.clickCount ?? 1;
    const humanize = options.humanize ?? this.humanize;

    if (!humanize) {
      await element.click({ button, clickCount });
      return;
    }

    const page = await this.page();
    const box = await element.boundingBox();
    if (!box || box.width < 2 || box.height < 2) {
      await element.click({ button, clickCount });
      return;
    }
    const random = (min: number, max: number): number => min + Math.random() * (max - min);
    const targetX = box.x + box.width * random(0.3, 0.7);
    const targetY = box.y + box.height * random(0.3, 0.7);
    const startX = Math.max(0, targetX + random(-140, 140));
    const startY = Math.max(0, targetY + random(-90, 90));
    await page.mouse.move(startX, startY);
    const steps = Math.round(random(9, 16));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const eased = 1 - (1 - t) * (1 - t);
      const x = startX + (targetX - startX) * eased + random(-1.2, 1.2);
      const y = startY + (targetY - startY) * eased + random(-1.2, 1.2);
      await page.mouse.move(x, y);
      await sleep(random(2, 7));
    }
    await sleep(random(30, 120));
    for (let i = 0; i < clickCount; i++) {
      await page.mouse.down({ button });
      await sleep(random(25, 70));
      await page.mouse.up({ button });
      if (i + 1 < clickCount) await sleep(random(70, 140));
    }
  }

  async hover(target: Parameters<BrowserSession["resolveHandle"]>[0]): Promise<void> {
    const element = await this.resolveHandle(target);
    await element.scrollIntoViewIfNeeded().catch(() => undefined);
    const page = await this.page();
    const box = await element.boundingBox();
    if (!box) {
      await element.hover();
      return;
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  }

  async fill(target: Parameters<BrowserSession["resolveHandle"]>[0], value: string): Promise<void> {
    const element = await this.resolveHandle(target);
    await element.fill(value);
  }

  async type(
    target: Parameters<BrowserSession["resolveHandle"]>[0],
    text: string,
    options: { delay?: number; clear?: boolean; submit?: boolean } = {},
  ): Promise<void> {
    const element = await this.resolveHandle(target);
    await element.scrollIntoViewIfNeeded().catch(() => undefined);
    await element.click().catch(() => undefined);
    if (options.clear) {
      await element.fill("");
    }
    const page = await this.page();
    if (this.humanize && options.delay === undefined) {
      for (const char of text) {
        await page.keyboard.type(char);
        await sleep(35 + Math.random() * 85);
        if (Math.random() < 0.03) await sleep(150 + Math.random() * 250);
      }
    } else {
      await page.keyboard.type(text, { delay: options.delay ?? 0 });
    }
    if (options.submit) await page.keyboard.press("Enter");
  }

  async press(key: string): Promise<void> {
    const page = await this.page();
    await page.keyboard.press(key);
  }

  async select(
    target: Parameters<BrowserSession["resolveHandle"]>[0],
    values: string[],
  ): Promise<string[]> {
    const element = await this.resolveHandle(target);
    return element.selectOption(values);
  }

  async scroll(options: {
    direction?: "up" | "down" | "left" | "right" | "top" | "bottom";
    amount?: number;
    ref?: string;
    selector?: string;
  }): Promise<{ scrollY: number; scrollHeight: number }> {
    const page = await this.page();
    if (options.ref || options.selector) {
      const element = await this.resolveHandle({ ref: options.ref, selector: options.selector });
      await element.scrollIntoViewIfNeeded();
    } else {
      const direction = options.direction ?? "down";
      const amount = options.amount ?? 600;
      if (direction === "top") await page.evaluate(() => window.scrollTo(0, 0));
      else if (direction === "bottom")
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      else {
        const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
        const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
        if (this.humanize) {
          const steps = Math.round(Math.abs(dy) / 80) || 1;
          for (let i = 0; i < steps; i++) {
            await page.mouse.wheel(dx / steps, dy / steps);
            await sleep(20 + Math.random() * 50);
          }
        } else {
          await page.mouse.wheel(dx, dy);
        }
      }
    }
    await sleep(120);
    return page.evaluate(() => ({
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
    }));
  }

  async upload(
    target: Parameters<BrowserSession["resolveHandle"]>[0],
    paths: string[],
  ): Promise<number> {
    const element = await this.resolveHandle(target);
    await element.setInputFiles(paths);
    return paths.length;
  }

  async waitFor(options: {
    selector?: string;
    text?: string;
    timeout?: number;
    state?: "attached" | "detached" | "visible" | "hidden";
  }): Promise<void> {
    const page = await this.page();
    const timeout = options.timeout ?? this.config.actionTimeoutMs;
    if (options.selector) {
      await page.waitForSelector(options.selector, { timeout, state: options.state ?? "visible" });
      return;
    }
    if (options.text) {
      await page.getByText(options.text).first().waitFor({ timeout, state: "visible" });
      return;
    }
    await page.waitForTimeout(timeout);
  }

  async screenshot(options: {
    fullPage?: boolean;
    path?: string;
    selector?: string;
  }): Promise<{ buffer: Buffer; path?: string }> {
    const page = await this.page();
    const target = options.selector
      ? await this.resolveHandle({ selector: options.selector })
      : null;
    const buffer = target
      ? await target.screenshot({ type: "png" })
      : await page.screenshot({ fullPage: options.fullPage ?? false, type: "png" });
    if (options.path) {
      const path = safeArtifactPath(this.config.artifactDir, options.path, "screenshot", ".png");
      writeArtifact(path, buffer);
      return { buffer, path };
    }
    return { buffer };
  }

  async pdf(options: {
    path?: string;
    landscape?: boolean;
    printBackground?: boolean;
    format?: "A4" | "Letter" | "Legal" | "A3" | "A5";
  }): Promise<{ buffer: Buffer; path: string }> {
    const page = await this.page();
    const buffer = await page.pdf({
      landscape: options.landscape ?? false,
      printBackground: options.printBackground ?? true,
      format: options.format ?? "A4",
    });
    const path = safeArtifactPath(this.config.artifactDir, options.path, "page", ".pdf");
    writeArtifact(path, buffer);
    return { buffer, path };
  }

  async cookies(urls?: string[]): Promise<unknown[]> {
    if (!this.context) throw new Error("browser is not open");
    return this.context.cookies(urls);
  }

  async setCookies(cookies: Array<Record<string, unknown>>): Promise<void> {
    if (!this.context) throw new Error("browser is not open");
    const normalized = cookies.map((cookie) => {
      const sameSite = String(cookie.sameSite ?? "Lax").toLowerCase();
      const mapped =
        sameSite === "strict"
          ? "Strict"
          : sameSite === "none" || sameSite === "no_restriction"
            ? "None"
            : "Lax";
      return {
        name: String(cookie.name),
        value: String(cookie.value),
        ...(cookie.url ? { url: String(cookie.url) } : {}),
        ...(cookie.domain ? { domain: String(cookie.domain) } : {}),
        path: cookie.path ? String(cookie.path) : "/",
        expires: typeof cookie.expires === "number" ? cookie.expires : -1,
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure),
        sameSite: mapped as "Strict" | "Lax" | "None",
      };
    });
    await this.context.addCookies(normalized);
  }

  async clearCookies(): Promise<void> {
    if (!this.context) throw new Error("browser is not open");
    await this.context.clearCookies();
  }

  async exportStorage(path?: string): Promise<{ state: any; path?: string }> {
    if (!this.context) throw new Error("browser is not open");
    if (!path) return { state: await this.context.storageState() };
    const target = safeArtifactPath(this.config.artifactDir, path, "storage", ".json");
    const state = await this.context.storageState({ path: target });
    return { state, path: target };
  }

  async importStorage(state: {
    cookies?: Array<Record<string, unknown>>;
    origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
  }): Promise<{ cookies: number; localStorage: number; warnings: string[] }> {
    if (!this.context) throw new Error("browser is not open");
    const warnings: string[] = [];
    if (state.cookies?.length) await this.setCookies(state.cookies);

    let count = 0;
    if (state.origins?.length) {
      const page = await this.page();
      try {
        const client = await this.context.newCDPSession(page);
        await client.send("DOMStorage.enable");
        for (const origin of state.origins) {
          for (const item of origin.localStorage ?? []) {
            await client.send("DOMStorage.setDOMStorageItem", {
              storageId: { securityOrigin: origin.origin, isLocalStorage: true },
              key: item.name,
              value: item.value,
            });
            count += 1;
          }
        }
      } catch (error) {
        warnings.push(
          `localStorage import needs a Chromium CDP session: ${(error as Error).message}`,
        );
      }
    }
    return { cookies: state.cookies?.length ?? 0, localStorage: count, warnings };
  }

  async newTab(url?: string): Promise<{ index: number; url: string }> {
    if (!this.context) await this.launch();
    const page = await this.context.newPage();
    this.registerPage(page);
    const canonical = this.pageByKey.get(this.pageKey(page)) ?? page;
    this.activeIndex = Math.max(0, this.pages.indexOf(canonical));
    if (url) {
      await this.navigate(url);
    }
    return { index: this.activeIndex, url: canonical.url() };
  }

  async listTabs(): Promise<TabInfo[]> {
    const alive = this.pages.filter((page) => !page.isClosed());
    this.pages = alive;
    return Promise.all(
      alive.map(async (page, index) => ({
        index,
        active: index === this.activeIndex,
        url: page.url(),
        title: await page.title().catch(() => ""),
        closed: false,
      })),
    );
  }

  async switchTab(index: number): Promise<void> {
    const alive = this.pages.filter((page) => !page.isClosed());
    if (index < 0 || index >= alive.length) {
      throw new Error(`tab index ${index} out of range (0..${alive.length - 1})`);
    }
    this.pages = alive;
    this.activeIndex = index;
    await alive[index]!.bringToFront().catch(() => undefined);
  }

  async closeTab(index: number): Promise<void> {
    const alive = this.pages.filter((page) => !page.isClosed());
    if (index < 0 || index >= alive.length) {
      throw new Error(`tab index ${index} out of range (0..${alive.length - 1})`);
    }
    this.pages = alive;
    const page = alive[index]!;
    await page.close();
    // The close event normally unregisters the page; this covers Obscura wrappers
    // that close without emitting it.
    const key = this.pageKey(page);
    if (this.pageByKey.get(key) === page) this.unregisterPage(page);
  }

  networkEntries(options: {
    filter?: string;
    type?: string;
    failedOnly?: boolean;
    limit?: number;
    statusMin?: number;
  }): Array<Record<string, unknown>> {
    let entries = this.network;
    if (options.filter) {
      const needle = options.filter.toLowerCase();
      entries = entries.filter((entry) => entry.url.toLowerCase().includes(needle));
    }
    if (options.type) {
      const type = options.type.toLowerCase();
      entries = entries.filter((entry) => entry.resourceType.toLowerCase() === type);
    }
    if (options.failedOnly) entries = entries.filter((entry) => entry.failed || (entry.status ?? 0) >= 400);
    if (options.statusMin !== undefined) {
      entries = entries.filter((entry) => (entry.status ?? 0) >= options.statusMin!);
    }
    const limit = options.limit ?? 80;
    return entries.slice(-limit).map((entry) => ({
      id: entry.id,
      method: entry.method,
      url: redactUrl(entry.url, this.config.redactParams),
      type: entry.resourceType,
      status: entry.status,
      mime: entry.mimeType?.split(";")[0],
      size: entry.size,
      durationMs: entry.durationMs,
      failed: entry.failed,
    }));
  }

  networkSummary(): Record<string, unknown> {
    const totalBytes = this.network.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    const byType = new Map<string, { count: number; bytes: number }>();
    for (const entry of this.network) {
      const current = byType.get(entry.resourceType) ?? { count: 0, bytes: 0 };
      current.count += 1;
      current.bytes += entry.size ?? 0;
      byType.set(entry.resourceType, current);
    }
    const slowest = [...this.network]
      .filter((entry) => entry.durationMs !== undefined)
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
      .slice(0, 10)
      .map((entry) => ({
        url: redactUrl(entry.url, this.config.redactParams),
        type: entry.resourceType,
        durationMs: entry.durationMs,
        size: entry.size,
        status: entry.status,
      }));
    return {
      requests: this.network.length,
      totalBytes,
      byType: Object.fromEntries(byType),
      slowest,
      failed: this.network.filter((entry) => entry.failed || (entry.status ?? 0) >= 400).length,
    };
  }

  consoleMessages(options: { level?: string; limit?: number; filter?: string }): ConsoleEntry[] {
    const rank: Record<string, number> = { debug: 0, log: 1, info: 2, warning: 3, error: 4, pageerror: 5 };
    const min = rank[options.level ?? "log"] ?? 0;
    let entries = this.consoleEntries.filter((entry) => (rank[entry.type] ?? 1) >= min);
    if (options.filter) {
      const needle = options.filter.toLowerCase();
      entries = entries.filter((entry) => entry.text.toLowerCase().includes(needle));
    }
    return entries.slice(-(options.limit ?? 80)).map((entry) => ({
      ...entry,
      text: entry.text.slice(0, 2_000),
    }));
  }

  clearNetwork(): void {
    this.network = [];
  }

  clearConsole(): void {
    this.consoleEntries = [];
  }

  listDownloads(): Array<{ path: string; url: string; at: number }> {
    return [...this.downloads];
  }

  async vitals(): Promise<VitalsData> {
    const page = await this.page();
    let data = (await page.evaluate(readVitalsPageScript)) as VitalsData | null;
    if (!data) {
      await page.evaluate(installVitalsPageScript);
      data = (await page.evaluate(readVitalsPageScript)) as VitalsData | null;
    }
    return (
      data ?? {
        lcp: 0,
        cls: 0,
        fcp: 0,
        ttfb: 0,
        longTasks: 0,
        longTaskDuration: 0,
        firstInput: null,
        domContentLoaded: 0,
        load: 0,
      }
    );
  }

  async resourceTimings(limit: number): Promise<Array<Record<string, unknown>>> {
    const page = await this.page();
    return page.evaluate(resourceTimingsPageScript, limit) as Promise<Array<Record<string, unknown>>>;
  }

  async harStart(): Promise<{ started: true }> {
    const page = await this.page();
    if (this.harSessions.has(page)) throw new Error("HAR capture is already running");
    const client = await this.context.newCDPSession(page);
    const entries = new Map<string, any>();
    await client.send("Network.enable", {
      maxTotalBufferSize: 100_000_000,
      maxResourceBufferSize: 10_000_000,
      maxPostDataSize: 1_000_000,
    });
    client.on("Network.requestWillBeSent", (event: any) => {
      const current = entries.get(event.requestId) ?? {};
      entries.set(event.requestId, {
        ...current,
        requestId: event.requestId,
        url: event.request.url,
        method: event.request.method,
        requestHeaders: event.request.headers ?? {},
        postData: event.request.postData,
        startedAt: Date.now(),
        wallTime: event.wallTime,
      });
    });
    client.on("Network.responseReceived", (event: any) => {
      const current = entries.get(event.requestId) ?? {};
      entries.set(event.requestId, {
        ...current,
        status: event.response.status,
        statusText: event.response.statusText,
        mimeType: event.response.mimeType,
        responseHeaders: event.response.headers ?? {},
      });
    });
    client.on("Network.loadingFinished", (event: any) => {
      const current = entries.get(event.requestId) ?? {};
      entries.set(event.requestId, {
        ...current,
        finishedAt: Date.now(),
        encodedDataLength: event.encodedDataLength,
      });
    });
    client.on("Network.loadingFailed", (event: any) => {
      const current = entries.get(event.requestId) ?? {};
      entries.set(event.requestId, {
        ...current,
        finishedAt: Date.now(),
        failed: event.errorText,
      });
    });
    this.harSessions.set(page, { client, entries, startedAt: Date.now() });
    return { started: true };
  }

  async harStop(includeBodies = false): Promise<HarResult> {
    const page = await this.page();
    const session = this.harSessions.get(page);
    if (!session) throw new Error("no HAR capture is running");
    this.harSessions.delete(page);
    const { client, entries } = session;
    const harEntries: any[] = [];
    for (const entry of entries.values()) {
      let body: { text?: string; encoding?: string } = {};
      if (includeBodies) {
        try {
          const response = await client.send("Network.getResponseBody", {
            requestId: entry.requestId,
          });
          body = {
            text: response.base64Encoded
              ? response.body
              : response.body,
            ...(response.base64Encoded ? { encoding: "base64" } : {}),
          };
        } catch {
          // body was evicted or unavailable
        }
      }
      const headers = (values: Record<string, string> | undefined): Array<{ name: string; value: string }> =>
        Object.entries(values ?? {}).map(([name, value]) => ({ name, value: String(value) }));
      harEntries.push({
        startedDateTime: new Date(entry.startedAt ?? Date.now()).toISOString(),
        time: Math.max(0, (entry.finishedAt ?? Date.now()) - (entry.startedAt ?? Date.now())),
        request: {
          method: entry.method ?? "GET",
          url: entry.url ?? "",
          httpVersion: "HTTP/1.1",
          headers: headers(entry.requestHeaders),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: entry.postData?.length ?? 0,
          ...(entry.postData ? { postData: { mimeType: "application/x-www-form-urlencoded", text: entry.postData } } : {}),
        },
        response: {
          status: entry.status ?? 0,
          statusText: entry.statusText ?? "",
          httpVersion: "HTTP/1.1",
          headers: headers(entry.responseHeaders),
          cookies: [],
          content: {
            size: entry.encodedDataLength ?? 0,
            mimeType: entry.mimeType ?? "",
            ...body,
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: entry.encodedDataLength ?? 0,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
        ...(entry.failed ? { _error: entry.failed } : {}),
      });
    }
    const har = {
      log: {
        version: "1.2",
        creator: { name: "cat-burglar", version: "0.4.0" },
        pages: [],
        entries: harEntries,
      },
    };
    const path = safeArtifactPath(this.config.artifactDir, undefined, "network", ".har");
    const data = JSON.stringify(har, null, 2);
    writeArtifact(path, data);
    await client.send("Network.disable").catch(() => undefined);
    await client.detach().catch(() => undefined);
    return { path, entries: harEntries.length, bytes: Buffer.byteLength(data) };
  }

  async cpuProfileStart(): Promise<{ started: true }> {
    const page = await this.page();
    if (this.cpuSessions.has(page)) throw new Error("CPU profiling is already running");
    const client = await this.context.newCDPSession(page);
    await client.send("Profiler.enable");
    await client.send("Profiler.setSamplingInterval", { interval: 1000 });
    await client.send("Profiler.start");
    this.cpuSessions.set(page, { client, startedAt: Date.now() });
    return { started: true };
  }

  async cpuProfileStop(): Promise<CpuProfileResult> {
    const page = await this.page();
    const session = this.cpuSessions.get(page);
    if (!session) throw new Error("no CPU profile is running");
    this.cpuSessions.delete(page);
    const { client, startedAt } = session;
    const { profile } = await client.send("Profiler.stop");
    const path = safeArtifactPath(this.config.artifactDir, undefined, "cpu", ".cpuprofile");
    writeArtifact(path, JSON.stringify(profile));
    const nodes = Array.isArray(profile.nodes) ? profile.nodes : [];
    const top = nodes
      .map((node: any) => ({
        function: node.callFrame?.functionName || "(anonymous)",
        url: node.callFrame?.url || "",
        hits: node.hitCount ?? 0,
      }))
      .filter((node: any) => node.hits > 0)
      .sort((a: any, b: any) => b.hits - a.hits)
      .slice(0, 10);
    await client.send("Profiler.disable").catch(() => undefined);
    await client.detach().catch(() => undefined);
    return { path, durationMs: Date.now() - startedAt, nodes: nodes.length, top };
  }

  async heapSnapshot(): Promise<{ path: string; bytes: number }> {
    const page = await this.page();
    const client = await this.context.newCDPSession(page);
    await client.send("HeapProfiler.enable");
    const chunks: string[] = [];
    const onChunk = (event: any) => chunks.push(event.chunk);
    client.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
    await client.send("HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
      captureNumericValue: false,
    });
    client.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    const path = safeArtifactPath(this.config.artifactDir, undefined, "heap", ".heapsnapshot");
    const data = chunks.join("");
    writeArtifact(path, data);
    await client.detach().catch(() => undefined);
    return { path, bytes: Buffer.byteLength(data) };
  }

  async coverageStart(): Promise<{ started: true }> {
    const page = await this.page();
    if (this.coverageSessions.has(page)) throw new Error("coverage is already running");
    const client = await this.context.newCDPSession(page);
    await client.send("Profiler.enable");
    await client.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    this.coverageSessions.set(page, { client, startedAt: Date.now() });
    return { started: true };
  }

  async coverageStop(): Promise<CoverageEntry[]> {
    const page = await this.page();
    const session = this.coverageSessions.get(page);
    if (!session) throw new Error("no coverage capture is running");
    this.coverageSessions.delete(page);
    const { client } = session;
    const { result } = await client.send("Profiler.takePreciseCoverage");
    const rows: CoverageEntry[] = [];
    for (const script of result ?? []) {
      let totalBytes = 0;
      let usedBytes = 0;
      for (const fn of script.functions ?? []) {
        for (const range of fn.ranges ?? []) {
          const length = Math.max(0, (range.endOffset ?? 0) - (range.startOffset ?? 0));
          totalBytes = Math.max(totalBytes, range.endOffset ?? 0);
          if ((range.count ?? 0) > 0) usedBytes += length;
        }
      }
      if (totalBytes === 0) continue;
      usedBytes = Math.min(totalBytes, usedBytes);
      rows.push({
        url: script.url || "(inline)",
        totalBytes,
        usedBytes,
        unusedBytes: totalBytes - usedBytes,
        unusedPercent: Number((((totalBytes - usedBytes) / totalBytes) * 100).toFixed(1)),
      });
    }
    await client.send("Profiler.disable").catch(() => undefined);
    await client.detach().catch(() => undefined);
    return rows.sort((a, b) => b.unusedBytes - a.unusedBytes).slice(0, 30);
  }

  async throttle(options: ThrottleOptions): Promise<Record<string, unknown>> {
    const page = await this.page();
    const client = await this.context.newCDPSession(page);
    await client.send("Network.enable");
    const download = options.downloadKbps === undefined ? -1 : Math.round((options.downloadKbps * 1024) / 8);
    const upload = options.uploadKbps === undefined ? -1 : Math.round((options.uploadKbps * 1024) / 8);
    await client.send("Network.emulateNetworkConditions", {
      offline: options.offline ?? false,
      latency: options.latencyMs ?? 0,
      downloadThroughput: download,
      uploadThroughput: upload,
    });
    if (options.cpuRate !== undefined) {
      await client.send("Emulation.setCPUThrottlingRate", { rate: options.cpuRate });
    }
    await client.detach().catch(() => undefined);
    return {
      offline: options.offline ?? false,
      latencyMs: options.latencyMs ?? 0,
      downloadKbps: options.downloadKbps ?? null,
      uploadKbps: options.uploadKbps ?? null,
      cpuRate: options.cpuRate ?? 1,
    };
  }

  hasLiveView(): boolean {
    return Boolean(this.liveViewUrl);
  }

  canOpenWindow(): boolean {
    if (this.engine === "remote" || this.engine === "obscura") return false;
    if (process.platform !== "linux") return true;
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }

  async openHeadedWindow(): Promise<{ mode: "window"; url: string; relaunched: boolean }> {
    if (!this.canOpenWindow()) throw new Error("no local display available");
    const page = await this.page();
    const currentUrl = page.url();
    const wasHeaded = (this.lastLaunchOptions.headless ?? this.config.headless) === false;
    if (!wasHeaded) {
      const options = { ...this.lastLaunchOptions, headless: false };
      await this.launch(options);
      if (currentUrl && currentUrl !== "about:blank") {
        await this.navigate(currentUrl, "domcontentloaded");
      }
    }
    this.windowHandoff = true;
    return { mode: "window", url: this.safeUrl() ?? currentUrl, relaunched: !wasHeaded };
  }

  async finishHandoff(): Promise<void> {
    this.windowHandoff = false;
    await this.stopHandoff();
  }

  async startHandoff(options: { openWindow?: boolean; timeoutMs?: number } = {}): Promise<
    | ({ mode: "remote" } & { url: string })
    | ({ mode: "local" } & HandoffInfo)
  > {
    if (this.liveViewUrl) {
      return { mode: "remote", url: this.liveViewUrl };
    }
    if (!this.handoff) {
      this.handoff = new HandoffServer(() => this.page(), {
        openWindow: options.openWindow ?? this.lastLaunchOptions.captchaOpenWindow ?? true,
        timeoutMs: options.timeoutMs ?? 5 * 60_000,
      });
    }
    const info = await this.handoff.start();
    this.handoffUrl = info.url;
    return { mode: "local", ...info };
  }

  async stopHandoff(): Promise<void> {
    if (this.handoff) {
      await this.handoff.stop();
      this.handoff = undefined;
    }
    this.handoffUrl = undefined;
  }

  handoffStatus(): {
    active: boolean;
    url: string | null;
    mode: "remote" | "local" | "window" | null;
  } {
    if (this.liveViewUrl) return { active: true, url: this.liveViewUrl, mode: "remote" };
    if (this.windowHandoff) return { active: true, url: this.safeUrl() ?? null, mode: "window" };
    return { active: Boolean(this.handoff?.active), url: this.handoffUrl ?? null, mode: this.handoff ? "local" : null };
  }

  addProxy(entry: ProxyEntry): void {
    this.proxyPool.entries.push(entry);
  }

  removeProxy(id: string): boolean {
    const index = this.proxyPool.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.proxyPool.entries.splice(index, 1);
    return true;
  }

  async perfMetrics(): Promise<Record<string, number>> {
    const page = await this.page();
    const client = await this.context.newCDPSession(page);
    try {
      await client.send("Performance.enable");
      const response = await client.send("Performance.getMetrics");
      const metrics = response?.metrics;
      if (!Array.isArray(metrics)) {
        throw new Error(`Performance.getMetrics returned no metrics (engine=${this.engine})`);
      }
      const result: Record<string, number> = {};
      for (const metric of metrics) result[metric.name] = metric.value;
      return result;
    } finally {
      await client.detach().catch(() => undefined);
    }
  }

  async startTrace(): Promise<void> {
    const page = await this.page();
    if (this.traceClients.has(page)) throw new Error("a trace is already running on this tab");
    const client = await this.context.newCDPSession(page);
    await client.send("Tracing.start", {
      categories: [
        "devtools.timeline",
        "v8.execute",
        "blink.user_timing",
        "loading",
        "disabled-by-default-devtools.timeline",
      ].join(","),
      transferMode: "ReturnAsStream",
    });
    this.traceClients.set(page, { client, startedAt: Date.now() });
  }

  async stopTrace(): Promise<PerfSummary> {
    const page = await this.page();
    const active = this.traceClients.get(page);
    if (!active) throw new Error("no trace is running; call perf with action=start first");
    this.traceClients.delete(page);
    const { client, startedAt } = active;

    const complete = new Promise<any>((resolve) =>
      client.once("Tracing.tracingComplete", (event: any) => resolve(event)),
    );
    await client.send("Tracing.end");
    const event = await complete;
    const chunks: Buffer[] = [];
    if (event.stream) {
      for (;;) {
        const chunk = await client.send("IO.read", { handle: event.stream });
        chunks.push(
          chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : Buffer.from(chunk.data),
        );
        if (chunk.eof) break;
      }
      await client.send("IO.close", { handle: event.stream }).catch(() => undefined);
    }
    await client.detach().catch(() => undefined);

    const raw = Buffer.concat(chunks);
    const path = safeArtifactPath(this.config.artifactDir, undefined, "trace", ".json");
    writeArtifact(path, raw);

    let events: any[] = [];
    try {
      events = JSON.parse(raw.toString("utf8")).traceEvents ?? [];
    } catch {
      // leave empty
    }

    const longTasks = events
      .filter((entry) => entry.name === "RunTask" && (entry.dur ?? 0) > 50_000)
      .map((entry) => ({
        durationMs: Math.round((entry.dur ?? 0) / 1000),
        url: entry.args?.data?.url ?? "",
      }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 10);

    const scripts = new Map<string, { totalUs: number; calls: number }>();
    for (const entry of events) {
      if (!["FunctionCall", "EvaluateScript", "v8.compile"].includes(entry.name)) continue;
      const url = entry.args?.data?.url ?? entry.args?.data?.beginData?.url ?? "(inline)";
      const current = scripts.get(url) ?? { totalUs: 0, calls: 0 };
      current.totalUs += entry.dur ?? 0;
      current.calls += 1;
      scripts.set(url, current);
    }

    const counts: Record<string, number> = {};
    const totals: Record<string, number> = {};
    for (const entry of events) {
      if (!["Layout", "UpdateLayoutTree", "Paint", "RunTask", "FunctionCall", "EvaluateScript"].includes(entry.name)) {
        continue;
      }
      counts[entry.name] = (counts[entry.name] ?? 0) + 1;
      totals[entry.name] = (totals[entry.name] ?? 0) + Math.round((entry.dur ?? 0) / 1000);
    }

    return {
      artifact: path,
      durationMs: Date.now() - startedAt,
      longTasks,
      scripts: [...scripts.entries()]
        .map(([url, value]) => ({
          url,
          totalMs: Math.round(value.totalUs / 1000),
          calls: value.calls,
        }))
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, 10),
      counts,
      totals,
    };
  }
}

export type { ExtractModeType };
