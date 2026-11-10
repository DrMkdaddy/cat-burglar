import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function slugify(value: string, fallback = "artifact"): string {
  const slug = value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

export function safeArtifactPath(
  artifactDir: string,
  requested: string | undefined,
  prefix: string,
  extension: string,
): string {
  ensureDir(artifactDir);
  if (!requested) {
    return join(artifactDir, `${timestamp()}-${slugify(prefix)}${extension}`);
  }
  const root = resolve(artifactDir);
  const target = resolve(root, requested);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`artifact path must stay inside ${root}`);
  }
  return extname(target) ? target : `${target}${extension}`;
}

export function writeArtifact(path: string, data: Buffer | string): string {
  ensureDir(dirname(path));
  writeFileSync(path, data);
  return path;
}

export function describeArtifact(path: string, bytes: number): string {
  return `${basename(path)} (${(bytes / 1024).toFixed(1)} KiB) at ${path}`;
}
