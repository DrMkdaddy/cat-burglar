import type { ControlInfo } from "./page-scripts.js";

export interface SnapshotRecord {
  id: string;
  controls: ControlInfo[];
  text: string;
  url: string;
  title: string;
  at: number;
}

export interface ControlChange {
  ref: string;
  role: string;
  name: string;
  changes: string[];
}

export interface ControlDiff {
  added: ControlInfo[];
  removed: ControlInfo[];
  changed: ControlChange[];
  unchanged: number;
}

function identityMap(controls: ControlInfo[]): Map<string, ControlInfo> {
  // Refs are stable while an element stays in the DOM (see snapshotPage).
  return new Map(controls.map((control) => [control.ref, control]));
}

export function diffControls(
  previous: ControlInfo[],
  next: ControlInfo[],
  limit = 20,
): ControlDiff {
  const prevMap = identityMap(previous);
  const nextMap = identityMap(next);
  const added: ControlInfo[] = [];
  const removed: ControlInfo[] = [];
  const changed: ControlChange[] = [];
  let unchanged = 0;

  for (const [key, control] of nextMap) {
    const before = prevMap.get(key);
    if (!before) {
      if (added.length < limit) added.push(control);
      continue;
    }
    const changes: string[] = [];
    if ((before.value ?? "") !== (control.value ?? "")) {
      changes.push(`value ${JSON.stringify(before.value ?? "")} -> ${JSON.stringify(control.value ?? "")}`);
    }
    const beforeStates = before.states.join(",");
    const nextStates = control.states.join(",");
    if (beforeStates !== nextStates) changes.push(`states [${beforeStates}] -> [${nextStates}]`);
    if (changes.length) {
      if (changed.length < limit) {
        changed.push({ ref: control.ref, role: control.role, name: control.name, changes });
      }
    } else {
      unchanged += 1;
    }
  }
  for (const [key, control] of prevMap) {
    if (!nextMap.has(key) && removed.length < limit) removed.push(control);
  }

  return { added, removed, changed, unchanged };
}

export interface TextDelta {
  before: string;
  after: string;
}

export function textDelta(previous: string, next: string, maxChars = 500): TextDelta | null {
  if (previous === next) return null;
  const max = Math.max(40, Math.floor(maxChars / 2));
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
  let endPrev = previous.length - 1;
  let endNext = next.length - 1;
  while (endPrev >= start && endNext >= start && previous[endPrev] === next[endNext]) {
    endPrev -= 1;
    endNext -= 1;
  }
  const context = Math.min(30, Math.floor(max / 4));
  const clip = (value: string): string => {
    const trimmed = value.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  };
  const before = clip(previous.slice(Math.max(0, start - context), endPrev + 1));
  const after = clip(next.slice(Math.max(0, start - context), endNext + 1));
  return { before, after };
}
