/**
 * Trust posture — the ONE-TIME autonomy choice that replaces per-action
 * approval dialogs (`~/.understudy/trust.json`).
 *
 * Doctrine: per-action confirmation dialogs die; smart defaults everywhere.
 * The few genuinely consequential boundaries — data leaving the machine,
 * money being spent, production traffic changing — become a single visible,
 * reversible posture choice instead of a recurring interruption. Every gate
 * in the toolchain consults this file instead of prompting; raising or
 * lowering the posture is one explicit action (`understudy trust set`).
 *
 * The schema id lives HERE, not in src/benchmark-artifacts.ts: that module's
 * charter is the codecs of files inside a benchmark directory, while
 * trust.json is global per-user config next to profile.json/credentials.json
 * (see src/config/paths.ts).
 *
 * Levels (orderable, lowest first):
 * - `local_sandbox` (default) — everything local and free proceeds; gates
 *   that spend money, upload data, or touch traffic return one-action
 *   guidance to raise the posture (never a per-call dialog).
 * - `bounded_experiments` — spend-adjacent experiment operations (multi-arm
 *   benchmark runs, experiment approval/verdict updates) proceed with a
 *   visible one-line notice instead of blocking.
 * - `hosted_ops` — hosted operations (provider upload, traffic changes)
 *   are additionally allowed by default.
 *
 * Per-boundary overrides always win over the level defaults. There is NO
 * default spend cap at any level (caps default unlimited — warn, don't
 * kill): `allow_spend_usd_per_run` is an opt-in generous stop-loss, not a
 * budget.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TRUST_POSTURE_SCHEMA = "understudy.trust_posture.v1";

export const TRUST_LEVELS = ["local_sandbox", "bounded_experiments", "hosted_ops"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export type TrustOverrides = {
  /** Data may leave the machine to a provider (uploads). Level default: hosted_ops+. */
  allow_provider_upload?: boolean;
  /**
   * Opt-in generous stop-loss per run, in USD. NO cap by default at any
   * level: absent = unlimited. Consumers warn-and-record at the threshold
   * and never hard-kill a run below 2x this value (stop-loss, not budget).
   */
  allow_spend_usd_per_run?: number;
  /** Live/production traffic changes (ramp dial). Level default: hosted_ops. */
  allow_traffic_changes?: boolean;
};

export type TrustPosture = {
  schema_version: typeof TRUST_POSTURE_SCHEMA;
  level: TrustLevel;
  /** ISO timestamp of the last explicit `understudy trust set`. */
  set_at: string | null;
  overrides: TrustOverrides;
};

export const DEFAULT_TRUST_POSTURE: TrustPosture = {
  schema_version: TRUST_POSTURE_SCHEMA,
  level: "local_sandbox",
  set_at: null,
  overrides: {},
};

type Obj = Record<string, unknown>;
const asObject = (value: unknown): Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};

/** `UNDERSTUDY_TRUST_FILE` overrides for tests/sandboxes; default is the global config dir. */
export function trustPosturePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.UNDERSTUDY_TRUST_FILE?.trim();
  return override ? override : join(homedir(), ".understudy", "trust.json");
}

const isTrustLevel = (value: unknown): value is TrustLevel =>
  typeof value === "string" && (TRUST_LEVELS as readonly string[]).includes(value);

/**
 * Read the posture in force. TOLERANT: a missing/unreadable/wrong-schema
 * file yields the default (`local_sandbox`, no overrides) — a typo'd file
 * must never silently widen autonomy. Recognized fields apply individually.
 */
export function readTrustPosture(env: NodeJS.ProcessEnv = process.env): TrustPosture {
  let parsed: Obj;
  try {
    parsed = asObject(JSON.parse(readFileSync(trustPosturePath(env), "utf8")));
  } catch {
    return { ...DEFAULT_TRUST_POSTURE, overrides: {} };
  }
  if (parsed.schema_version !== TRUST_POSTURE_SCHEMA) return { ...DEFAULT_TRUST_POSTURE, overrides: {} };
  const rawOverrides = asObject(parsed.overrides);
  const overrides: TrustOverrides = {
    ...(typeof rawOverrides.allow_provider_upload === "boolean"
      ? { allow_provider_upload: rawOverrides.allow_provider_upload }
      : {}),
    ...(typeof rawOverrides.allow_spend_usd_per_run === "number" &&
    Number.isFinite(rawOverrides.allow_spend_usd_per_run) &&
    rawOverrides.allow_spend_usd_per_run > 0
      ? { allow_spend_usd_per_run: rawOverrides.allow_spend_usd_per_run }
      : {}),
    ...(typeof rawOverrides.allow_traffic_changes === "boolean"
      ? { allow_traffic_changes: rawOverrides.allow_traffic_changes }
      : {}),
  };
  return {
    schema_version: TRUST_POSTURE_SCHEMA,
    level: isTrustLevel(parsed.level) ? parsed.level : "local_sandbox",
    set_at: typeof parsed.set_at === "string" ? parsed.set_at : null,
    overrides,
  };
}

/**
 * Merge-write the posture (the ONE write path — `understudy trust set` and
 * the desktop app's posture UI both land here). Level and each override are
 * updated individually; `null` on an override key clears it back to the
 * level default.
 */
export function writeTrustPosture(
  patch: {
    level?: TrustLevel;
    overrides?: { [K in keyof TrustOverrides]?: TrustOverrides[K] | null };
  },
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): TrustPosture {
  const current = readTrustPosture(env);
  const overrides: TrustOverrides = { ...current.overrides };
  for (const key of ["allow_provider_upload", "allow_spend_usd_per_run", "allow_traffic_changes"] as const) {
    if (!patch.overrides || !(key in patch.overrides)) continue;
    const value = patch.overrides[key];
    if (value === null || value === undefined) delete overrides[key];
    else (overrides as Obj)[key] = value;
  }
  const next: TrustPosture = {
    schema_version: TRUST_POSTURE_SCHEMA,
    level: patch.level ?? current.level,
    set_at: now().toISOString(),
    overrides,
  };
  const file = trustPosturePath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/** True when the posture's level is at least `level` (local_sandbox < bounded_experiments < hosted_ops). */
export function trustAtLeast(posture: TrustPosture, level: TrustLevel): boolean {
  return TRUST_LEVELS.indexOf(posture.level) >= TRUST_LEVELS.indexOf(level);
}

export type ResolvedTrustBoundaries = {
  /** Data may leave the machine to a provider. */
  allow_provider_upload: boolean;
  /** Live/production traffic changes allowed. */
  allow_traffic_changes: boolean;
  /** Generous per-run spend stop-loss in USD; null = unlimited (the default at EVERY level). */
  spend_stop_loss_usd: number | null;
};

/**
 * The posture resolution matrix: explicit per-boundary overrides always win;
 * otherwise the level decides. Spend has NO level default — unlimited unless
 * the user opted into a stop-loss.
 */
export function resolveTrustBoundaries(posture: TrustPosture): ResolvedTrustBoundaries {
  const hosted = trustAtLeast(posture, "hosted_ops");
  return {
    allow_provider_upload: posture.overrides.allow_provider_upload ?? hosted,
    allow_traffic_changes: posture.overrides.allow_traffic_changes ?? hosted,
    spend_stop_loss_usd: posture.overrides.allow_spend_usd_per_run ?? null,
  };
}

/** The one-action fix a below-posture gate offers instead of a per-call dialog. */
export function raiseTrustHint(level: TrustLevel): string {
  return `understudy trust set ${level}`;
}

/** True when the trust file exists at all (posture explicitly chosen at least once). */
export function trustPostureChosen(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(trustPosturePath(env));
}
