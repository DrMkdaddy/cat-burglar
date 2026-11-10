import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  at: string;
  tool: string;
  args: Record<string, unknown>;
  origin?: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

const SECRET_KEY = /pass(word)?|token|secret|authorization|cookie|api[_-]?key|headers|body|content|state|cdp_url|proxy_url/i;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) result[key] = "[redacted]";
      else result[key] = sanitizeValue(item, depth + 1);
    }
    return result;
  }
  return value;
}

export function sanitizeAuditArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const clean = sanitizeValue(args) as Record<string, unknown>;
  if (tool === "fill" && "value" in clean) clean.value = "[redacted]";
  if (tool === "type" && "text" in clean) clean.text = "[redacted]";
  if (tool === "upload" && "paths" in clean) clean.paths = ["[file]"];
  if (tool === "proxy" && "url" in clean) clean.url = "[redacted]";
  return clean;
}

export class AuditLog {
  readonly enabled: boolean;
  readonly path: string;

  constructor(path: string, enabled = true) {
    this.path = path;
    this.enabled = enabled;
  }

  append(entry: AuditEntry): void {
    if (!this.enabled) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (existsSync(this.path) && statSync(this.path).size > 5 * 1024 * 1024) {
        writeFileSync(this.path, "");
      }
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Auditing must never break the tool call.
    }
  }

  list(limit = 50): AuditEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const lines = readFileSync(this.path, "utf8").trim().split(/\r?\n/).filter(Boolean);
      return lines.slice(-Math.max(1, limit)).map((line) => JSON.parse(line) as AuditEntry).reverse();
    } catch {
      return [];
    }
  }

  clear(): void {
    if (!this.enabled) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, "");
    } catch {
      // ignore
    }
  }
}
