import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProfileName, resolveProfile, type ProfileLimits, type ProfileName } from "./profiles.js";

export type EngineKind = "patchright" | "chromium" | "obscura";
export type RiskPolicy = "off" | "warn" | "ask";

export interface Viewport {
  width: number;
  height: number;
}

export interface Config {
  defaultEngine: EngineKind;
  headless: boolean;
  allowPrivateNetwork: boolean;
  allowFileUrls: boolean;
  humanize: boolean;
  blockTrackers: boolean;
  proxy?: string;
  locale: string;
  timezone?: string;
  userAgent?: string;
  viewport: Viewport;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  settleMs: number;
  snapshotChars: number;
  markdownChars: number;
  maxControls: number;
  maxNetworkEntries: number;
  maxConsoleEntries: number;
  profile: ProfileName;
  limits: ProfileLimits;
  memoryPath: string;
  riskyActionPolicy: RiskPolicy;
  profileDir: string;
  artifactDir: string;
  obscuraPath: string;
  allowedOrigins: string[];
  blockedOrigins: string[];
  redactParams: string[];
  trackerAllowlist: string[];
}

const HOME = homedir();
const CONFIG_PATH = join(HOME, ".config", "browser-mcp", "config.json");

function readConfigFile(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (error) {
    throw new Error(`browser-mcp: invalid config at ${CONFIG_PATH}: ${(error as Error).message}`);
  }
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function envString(name: string, fallback: string | undefined): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  if (typeof value !== "string" || value.trim() === "") return [];
  return value.split(/[;,]/).map((v) => v.trim()).filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function expandHome(path: string): string {
  if (path === "~") return HOME;
  if (path.startsWith("~/")) return join(HOME, path.slice(2));
  return path;
}

function resolveExecutable(candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "";
}

export function loadConfig(): Config {
  const file = readConfigFile();
  const timeout = asRecord(file.timeout);
  const viewport = asRecord(file.viewport);

  const defaultEngine = (envString("BROWSER_MCP_ENGINE", file.defaultEngine as string) ??
    "patchright") as EngineKind;
  if (!["patchright", "chromium", "obscura"].includes(defaultEngine)) {
    throw new Error(`browser-mcp: unknown defaultEngine "${defaultEngine}"`);
  }

  const profileRaw = envString("BROWSER_MCP_PROFILE", file.profile as string) ?? "flash";
  if (!isProfileName(profileRaw)) {
    throw new Error(`browser-mcp: unknown profile "${profileRaw}"`);
  }
  const profile = profileRaw;
  const profileLimits = resolveProfile(profile);
  const snapshotChars = envInt(
    "BROWSER_MCP_SNAPSHOT_CHARS",
    (file.snapshotChars as number) ?? profileLimits.snapshotChars,
  );
  const markdownChars = envInt(
    "BROWSER_MCP_MARKDOWN_CHARS",
    (file.markdownChars as number) ?? profileLimits.markdownChars,
  );
  const maxControls = envInt(
    "BROWSER_MCP_MAX_CONTROLS",
    (file.maxControls as number) ?? profileLimits.maxControls,
  );
  const riskyRaw = (
    envString("BROWSER_MCP_RISKY_ACTION_POLICY", file.riskyActionPolicy as string) ?? "warn"
  ).toLowerCase();
  if (!["off", "warn", "ask"].includes(riskyRaw)) {
    throw new Error(`browser-mcp: unknown riskyActionPolicy "${riskyRaw}"`);
  }

  const obscuraPath =
    envString("BROWSER_MCP_OBSCURA_PATH", file.obscuraPath as string) ??
    process.env.OBSCURA_PATH ??
    resolveExecutable([
      join(HOME, ".local", "bin", "obscura"),
      "/usr/local/bin/obscura",
      "/usr/bin/obscura",
      join(HOME, "projects", "obscura", "target", "release", "obscura"),
    ]);

  return {
    defaultEngine,
    headless: envBool("BROWSER_MCP_HEADLESS", (file.headless as boolean) ?? true),
    allowPrivateNetwork: envBool(
      "BROWSER_MCP_ALLOW_PRIVATE_NETWORK",
      (file.allowPrivateNetwork as boolean) ?? false,
    ),
    allowFileUrls: envBool("BROWSER_MCP_ALLOW_FILE_URLS", (file.allowFileUrls as boolean) ?? false),
    humanize: envBool("BROWSER_MCP_HUMANIZE", (file.humanize as boolean) ?? true),
    blockTrackers: envBool("BROWSER_MCP_BLOCK_TRACKERS", (file.blockTrackers as boolean) ?? true),
    proxy: envString("BROWSER_MCP_PROXY", file.proxy as string),
    locale: envString("BROWSER_MCP_LOCALE", file.locale as string) ?? "en-US",
    timezone: envString("BROWSER_MCP_TIMEZONE", file.timezone as string),
    userAgent: envString("BROWSER_MCP_USER_AGENT", file.userAgent as string),
    viewport: {
      width: envInt("BROWSER_MCP_VIEWPORT_WIDTH", Number(viewport.width) || 1440),
      height: envInt("BROWSER_MCP_VIEWPORT_HEIGHT", Number(viewport.height) || 900),
    },
    navigationTimeoutMs: envInt(
      "BROWSER_MCP_NAV_TIMEOUT_MS",
      Number(timeout.navigationMs) || 45_000,
    ),
    actionTimeoutMs: envInt("BROWSER_MCP_ACTION_TIMEOUT_MS", Number(timeout.actionMs) || 10_000),
    settleMs: envInt("BROWSER_MCP_SETTLE_MS", Number(timeout.settleMs) || 400),
    snapshotChars,
    markdownChars,
    maxControls,
    maxNetworkEntries: envInt(
      "BROWSER_MCP_MAX_NETWORK_ENTRIES",
      (file.maxNetworkEntries as number) ?? 500,
    ),
    maxConsoleEntries: envInt(
      "BROWSER_MCP_MAX_CONSOLE_ENTRIES",
      (file.maxConsoleEntries as number) ?? 300,
    ),
    profile,
    limits: {
      ...profileLimits,
      snapshotChars,
      markdownChars,
      maxControls,
    },
    memoryPath: expandHome(
      envString("BROWSER_MCP_MEMORY_PATH", file.memoryPath as string) ??
        join(HOME, ".cache", "browser-mcp", "site-memory.json"),
    ),
    riskyActionPolicy: riskyRaw as RiskPolicy,
    profileDir: expandHome(
      envString("BROWSER_MCP_PROFILE_DIR", file.profileDir as string) ??
        join(HOME, ".cache", "browser-mcp", "profiles"),
    ),
    artifactDir: expandHome(
      envString("BROWSER_MCP_ARTIFACT_DIR", file.artifactDir as string) ??
        join(HOME, ".cache", "browser-mcp", "artifacts"),
    ),
    obscuraPath: expandHome(obscuraPath),
    allowedOrigins: splitList(
      process.env.BROWSER_MCP_ALLOWED_ORIGINS ?? file.allowedOrigins,
    ),
    blockedOrigins: splitList(
      process.env.BROWSER_MCP_BLOCKED_ORIGINS ?? file.blockedOrigins,
    ),
    redactParams: splitList(
      process.env.BROWSER_MCP_REDACT_PARAMS ?? file.redactParams,
    ).map((v) => v.toLowerCase()),
    trackerAllowlist: splitList(
      process.env.BROWSER_MCP_TRACKER_ALLOWLIST ?? file.trackerAllowlist,
    ),
  };
}

/** Serialize the non-secret parts for diagnostics. */
export function redactedConfig(config: Config): Record<string, unknown> {
  return {
    ...config,
    proxy: config.proxy ? redactProxy(config.proxy) : undefined,
  };
}

export function redactProxy(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.password) url.password = "***";
    if (url.username) url.username = "***";
    return url.toString();
  } catch {
    return "***";
  }
}
