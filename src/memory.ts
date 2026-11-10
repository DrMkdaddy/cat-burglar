import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type MemoryKind = "hint" | "workflow" | "note";

export interface MemoryStep {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  name?: string;
  text?: string;
  steps?: MemoryStep[];
  createdAt: number;
  lastUsed?: number;
  uses: number;
  successCount: number;
  confidence: number;
  source: "agent";
}

export interface SiteRecord {
  origin: string;
  entries: MemoryEntry[];
  updatedAt: number;
}

interface MemoryFile {
  version: 1;
  sites: Record<string, SiteRecord>;
}

export interface MemoryInput {
  kind: MemoryKind;
  name?: string;
  text?: string;
  steps?: MemoryStep[];
}

const MAX_TEXT = 2_000;
const MAX_STEPS = 30;
const MAX_ENTRIES_PER_SITE = 200;

function cleanText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

function newId(): string {
  return `m_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function canonicalOrigin(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return url.origin.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Per-origin site memory. Entries are agent-authored only: page text is never
 * ingested automatically, and entries are validated before they are replayed.
 */
export class SiteMemoryStore {
  readonly path: string;
  private data: MemoryFile | null = null;

  constructor(path: string) {
    this.path = path;
  }

  private load(): MemoryFile {
    if (this.data) return this.data;
    if (!existsSync(this.path)) {
      this.data = { version: 1, sites: {} };
      return this.data;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as MemoryFile;
      this.data =
        parsed && parsed.version === 1 && typeof parsed.sites === "object"
          ? parsed
          : { version: 1, sites: {} };
    } catch {
      this.data = { version: 1, sites: {} };
    }
    return this.data;
  }

  private save(): void {
    const data = this.load();
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
  }

  private site(origin: string, create = false): SiteRecord | undefined {
    const data = this.load();
    let record = data.sites[origin];
    if (!record && create) {
      record = { origin, entries: [], updatedAt: Date.now() };
      data.sites[origin] = record;
    }
    return record;
  }

  list(origin?: string, limit = 20): { origin: string; entries: MemoryEntry[] }[] {
    const data = this.load();
    const sites = origin
      ? [this.site(origin)].filter(Boolean)
      : Object.values(data.sites).sort((a, b) => b.updatedAt - a.updatedAt);
    return sites
      .filter((record) => record!.entries.length > 0)
      .map((record) => ({
        origin: record!.origin,
        entries: [...record!.entries]
          .sort((a, b) => score(b) - score(a))
          .slice(0, limit),
      }));
  }

  get(origin: string, id: string): MemoryEntry | undefined {
    return this.site(origin)?.entries.find((entry) => entry.id === id);
  }

  put(origin: string, input: MemoryInput): MemoryEntry {
    if (!origin) throw new Error("a canonical http(s) origin is required");
    if (!["hint", "workflow", "note"].includes(input.kind)) {
      throw new Error(`unknown memory kind "${input.kind}"`);
    }
    if (input.kind === "workflow" && (!input.steps || input.steps.length === 0)) {
      throw new Error("workflow memory requires steps");
    }
    const steps = input.steps
      ?.slice(0, MAX_STEPS)
      .map((step) => ({
        tool: String(step.tool ?? "").slice(0, 80),
        arguments:
          typeof step.arguments === "object" && step.arguments !== null ? step.arguments : {},
      }))
      .filter((step) => step.tool);
    if (input.kind === "workflow" && (!steps || steps.length === 0)) {
      throw new Error("workflow memory requires valid steps");
    }

    const record = this.site(origin, true)!;
    const entry: MemoryEntry = {
      id: newId(),
      kind: input.kind,
      ...(input.name ? { name: cleanText(input.name) } : {}),
      ...(input.text ? { text: cleanText(input.text) } : {}),
      ...(steps ? { steps } : {}),
      createdAt: Date.now(),
      uses: 0,
      successCount: 0,
      confidence: 0.6,
      source: "agent",
    };
    record.entries.push(entry);
    if (record.entries.length > MAX_ENTRIES_PER_SITE) {
      record.entries.sort((a, b) => score(b) - score(a));
      record.entries = record.entries.slice(0, MAX_ENTRIES_PER_SITE);
    }
    record.updatedAt = Date.now();
    this.save();
    return entry;
  }

  remove(origin: string, id: string): boolean {
    const data = this.load();
    const record = this.site(origin);
    if (!record) return false;
    const before = record.entries.length;
    record.entries = record.entries.filter((entry) => entry.id !== id);
    if (record.entries.length === before) return false;
    if (record.entries.length === 0) delete data.sites[origin];
    else record.updatedAt = Date.now();
    this.save();
    return true;
  }

  clear(origin?: string): number {
    const data = this.load();
    if (!origin) {
      const count = Object.values(data.sites).reduce((sum, site) => sum + site.entries.length, 0);
      data.sites = {};
      this.save();
      return count;
    }
    const record = this.site(origin);
    if (!record) return 0;
    const count = record.entries.length;
    delete data.sites[origin];
    this.save();
    return count;
  }

  touch(origin: string, id: string, success: boolean): void {
    const entry = this.get(origin, id);
    if (!entry) return;
    entry.uses += 1;
    entry.lastUsed = Date.now();
    if (success) {
      entry.successCount += 1;
      entry.confidence = Math.min(1, entry.confidence + 0.05);
    } else {
      entry.confidence = Math.max(0.1, entry.confidence - 0.15);
    }
    const record = this.site(origin);
    if (record) record.updatedAt = Date.now();
    this.save();
  }

  learn(origin: string, name: string, steps: MemoryStep[], text?: string): MemoryEntry {
    return this.put(origin, { kind: "workflow", name, steps, text });
  }

  hints(origin: string, limit: number): MemoryEntry[] {
    return (this.site(origin)?.entries ?? [])
      .filter((entry) => entry.kind === "hint" || entry.kind === "note")
      .sort((a, b) => score(b) - score(a))
      .slice(0, limit);
  }

  workflows(origin: string, limit: number): MemoryEntry[] {
    return (this.site(origin)?.entries ?? [])
      .filter((entry) => entry.kind === "workflow")
      .sort((a, b) => score(b) - score(a))
      .slice(0, limit);
  }
}

function score(entry: MemoryEntry): number {
  const recencyDays = entry.lastUsed
    ? (Date.now() - entry.lastUsed) / (1000 * 60 * 60 * 24)
    : (Date.now() - entry.createdAt) / (1000 * 60 * 60 * 24);
  const recency = 1 / (1 + recencyDays / 14);
  const usage = Math.log1p(entry.uses + entry.successCount);
  return entry.confidence * (1 + usage) * (0.5 + recency);
}

export function compactHint(entry: MemoryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.text ? { text: entry.text } : {}),
    ...(entry.steps
      ? {
          steps: entry.steps.map((step) => ({
            tool: step.tool,
            arguments: step.arguments,
          })),
        }
      : {}),
    confidence: Number(entry.confidence.toFixed(2)),
    uses: entry.uses,
  };
}
