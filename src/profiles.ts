export type ProfileName = "local" | "flash" | "frontier" | "auto";

export interface ProfileLimits {
  /** Character budget for a full snapshot (controls get priority). */
  snapshotChars: number;
  /** Maximum controls included in one snapshot. */
  maxControls: number;
  /** Character budget for markdown extraction. */
  markdownChars: number;
  /** Character budget for the text delta returned after a mutating action. */
  observationChars: number;
  /** Default to diff snapshots instead of full ones. */
  diffDefault: boolean;
  /** Number of site-memory hints injected on navigate. */
  hintLimit: number;
  /** How much guidance tool results include. */
  verbosity: "minimal" | "short" | "rich";
}

/**
 * These are starting hypotheses, not constants. The benchmark harness exists to
 * measure them per model; change them when the data disagrees.
 */
export const PROFILES: Record<Exclude<ProfileName, "auto">, ProfileLimits> = {
  local: {
    snapshotChars: 1_800,
    maxControls: 50,
    markdownChars: 4_000,
    observationChars: 300,
    diffDefault: true,
    hintLimit: 3,
    verbosity: "minimal",
  },
  flash: {
    snapshotChars: 2_800,
    maxControls: 70,
    markdownChars: 6_000,
    observationChars: 400,
    diffDefault: true,
    hintLimit: 3,
    verbosity: "short",
  },
  frontier: {
    snapshotChars: 8_000,
    maxControls: 160,
    markdownChars: 14_000,
    observationChars: 900,
    diffDefault: false,
    hintLimit: 5,
    verbosity: "rich",
  },
};

export function resolveProfile(name: ProfileName): ProfileLimits {
  // "auto" uses the flash-safe profile until per-model probing is available.
  return PROFILES[name === "auto" ? "flash" : name];
}

export function isProfileName(value: string): value is ProfileName {
  return ["local", "flash", "frontier", "auto"].includes(value);
}
