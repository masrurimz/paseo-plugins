import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { JsonValue } from "./provider/security";

// Local mirrors of @getpaseo/plugin/server/usage (0.11-only module): the 0.10
// daemon bundler rejects that specifier even for type imports, so these
// structural copies keep the bundle building on 0.9/0.10/0.11 hosts.
type UsageTone = "default" | "ok" | "warning" | "danger";
interface UsageWindow {
  id: string;
  label: string;
  shortLabel?: string;
  summary?: boolean;
  usedPct?: number | null;
  remainingPct?: number | null;
  resetsAt?: string | null;
  tone?: UsageTone;
}
type UsageProblem =
  | { kind: "expired"; expiresAt: string; refreshedBy?: string }
  | { kind: "rejected"; status: number; refreshedBy?: string }
  | { kind: "no_quota"; detail: string };
type UsageReport =
  | { status: "available"; windows: UsageWindow[]; balances?: []; details?: [] }
  | { status: "unavailable"; problem: UsageProblem }
  | { status: "error"; error: string };
interface UsageAccount {
  key: string;
  label?: string;
  input: JsonValue;
}
import { isOmpProfileName, OmpProfileNameSchema } from "../shared/omp-store";
import type { OmpQuota } from "../shared/quota";
import { ompCacheDir, ompDataDir, ompStateDir } from "./paths";
import { listOmpQuotasFrom } from "./quota";

// Inlined from @getpaseo/plugin/server/usage (0.11-only module): the 0.10 daemon
// bundler rejects that specifier, so these local copies keep semantics identical.
function windowFromUsedPct(input: {
  id: string;
  label: string;
  utilizationPct?: number | null;
  resetsAt?: string | null;
  shortLabel?: string;
  summary?: boolean;
  tone?: UsageWindow["tone"];
}): UsageWindow {
  const usedPct = typeof input.utilizationPct === "number" ? input.utilizationPct : null;
  const window: UsageWindow = {
    id: input.id,
    label: input.label,
    usedPct,
    remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
    resetsAt: input.resetsAt ?? null,
  };
  if (input.shortLabel !== undefined) window.shortLabel = input.shortLabel;
  if (input.summary) window.summary = true;
  if (input.tone) window.tone = input.tone;
  return window;
}

function toneFromUsedPct(usedPct: number | null): UsageWindow["tone"] {
  if (typeof usedPct !== "number") return "default";
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "ok";
}

export const OmpUsageRouteSchema = z
  .object({
    store: z.enum(["default", "profile"]),
    profile: OmpProfileNameSchema.optional(),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0"), "OMP usage store path must not contain NUL")
      .refine((value) => isAbsolute(value), "OMP usage store path must be absolute"),
  })
  .strict()
  .refine((value) => (value.store === "profile") === (value.profile !== undefined), {
    message: "Profile usage routes require a profile name",
  });
export type OmpUsageRoute = z.infer<typeof OmpUsageRouteSchema>;

export const OmpUsageInputSchema = z.object({ route: OmpUsageRouteSchema }).strict();
export type OmpUsageInput = z.infer<typeof OmpUsageInputSchema>;

export interface OmpUsageStore {
  profile: string | undefined;
  dbPath: string;
  label: string;
}

const MAX_PROFILES = 128;
const MAX_DIRECTORY_ENTRIES = 4_096;

/** Directory names only; never opens profile configuration, databases, or credentials. */
function listProfileNames(environment: NodeJS.ProcessEnv): string[] {
  const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
  const directory = join(home, environment.PI_CONFIG_DIR || ".omp", "profiles");
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const profiles: string[] = [];
  let count = 0;
  for (const entry of entries) {
    if (++count > MAX_DIRECTORY_ENTRIES) break;
    if (entry.isDirectory() && isOmpProfileName(entry.name)) profiles.push(entry.name);
  }
  return profiles.sort().slice(0, MAX_PROFILES);
}

function isAgentDbFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Every OMP store on this machine that has an agent database: the default store, the
 * OMP_PROFILE-selected store, the XDG data/state/cache roots, and each named profile
 * under ~/.omp/profiles (or PI_CONFIG_DIR). Existence checks only; nothing is created,
 * opened, or written. Deduplicated by resolved database path.
 */
export function discoverOmpUsageStores(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): OmpUsageStore[] {
  const stores = new Map<string, OmpUsageStore>();
  const add = (store: OmpUsageStore): void => {
    const dbPath = resolve(store.dbPath);
    if (!stores.has(dbPath) && isAgentDbFile(dbPath)) stores.set(dbPath, { ...store, dbPath });
  };
  const addAreas = (storeEnvironment: NodeJS.ProcessEnv, profile: string | undefined): void => {
    const base = profile ? `OMP profile ${profile}` : "OMP default";
    try {
      add({
        profile,
        dbPath: join(ompDataDir(storeEnvironment, platform), "agent.db"),
        label: base,
      });
      add({
        profile,
        dbPath: join(ompStateDir(storeEnvironment, platform), "agent.db"),
        label: `${base} (state)`,
      });
      add({
        profile,
        dbPath: join(ompCacheDir(storeEnvironment, platform), "agent.db"),
        label: `${base} (cache)`,
      });
    } catch {
      return;
    }
  };

  // An explicit agent-directory override collapses every profile onto one store, so named
  // profiles cannot resolve distinctly while it is set; fall through to the default below.
  const hasAgentDirOverride = Boolean(
    environment.PASEO_OMP_AGENT_DIR ?? environment.OMP_AGENT_DIR,
  );
  const rawProfile =
    environment.OMP_PROFILE !== undefined ? environment.OMP_PROFILE : environment.PI_PROFILE;
  const currentProfile = rawProfile?.trim();
  const selectedProfile =
    currentProfile && currentProfile !== "default" && isOmpProfileName(currentProfile)
      ? currentProfile
      : undefined;
  if (!hasAgentDirOverride) {
    // Profile stores first so a path shared with the default keeps its profile label.
    if (selectedProfile) {
      addAreas({ ...environment, OMP_PROFILE: selectedProfile }, selectedProfile);
    }
    for (const profile of listProfileNames(environment)) {
      if (profile === selectedProfile) continue;
      addAreas({ ...environment, OMP_PROFILE: profile }, profile);
    }
  }
  const defaultEnvironment = { ...environment };
  delete defaultEnvironment.OMP_PROFILE;
  delete defaultEnvironment.PI_PROFILE;
  addAreas(defaultEnvironment, undefined);
  return [...stores.values()].sort((a, b) => (a.dbPath < b.dbPath ? -1 : 1));
}

/** Every account whose login store exists on this machine. Empty when none. */
export async function discoverOmpUsage(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<UsageAccount[]> {
  return discoverOmpUsageStores(environment, platform).map((store) => ({
    // Path-derived, never a credential or email; stable across token rotation.
    key: createHash("sha256").update(`paseo-omp-usage:${store.dbPath}`).digest("hex"),
    label: store.label,
    input: {
      route: {
        store: store.profile === undefined ? "default" : "profile",
        ...(store.profile === undefined ? {} : { profile: store.profile }),
        path: store.dbPath,
      },
    },
  }));
}

function windowIdFor(quota: OmpQuota, taken: Set<string>): string {
  const base = `${quota.provider}:${quota.label}:${quota.windowLabel ?? "window"}`;
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}#${suffix}`;
  return id;
}

function usageWindowsFor(quotas: readonly OmpQuota[]): UsageWindow[] {
  const taken = new Set<string>();
  return quotas.map((quota, index) => {
    const usedPct = quota.usedFraction === null ? null : quota.usedFraction * 100;
    const id = windowIdFor(quota, taken);
    taken.add(id);
    // usage_history stores epoch milliseconds; UsageWindow.resetsAt takes an ISO string.
    const resetsDate =
      quota.resetsAt === null || !Number.isFinite(quota.resetsAt)
        ? null
        : new Date(quota.resetsAt);
    const resetsAt =
      resetsDate === null || Number.isNaN(resetsDate.getTime())
        ? null
        : resetsDate.toISOString();
    return windowFromUsedPct({
      id,
      label: quota.label,
      shortLabel: quota.windowLabel ?? undefined,
      summary: index === 0,
      utilizationPct: usedPct,
      resetsAt,
      tone: toneFromUsedPct(usedPct),
    });
  });
}

/**
 * Re-reads the selected store read-only (same helper as the quota pill) and maps the
 * newest usage_history row per provider account limit to usage windows. Missing logins,
 * unreadable stores, and empty histories report unavailable with a generic detail: no
 * store paths or probe output ever leak into the report.
 */
export async function fetchOmpUsage(input: unknown): Promise<UsageReport> {
  const parsed = OmpUsageInputSchema.parse(input);
  const quotas = listOmpQuotasFrom(parsed.route.path);
  if (quotas.length === 0) {
    return {
      status: "unavailable",
      problem: {
        kind: "no_quota",
        detail: "No recorded OMP usage in this store yet",
      },
    };
  }
  return { status: "available", windows: usageWindowsFor(quotas), balances: [], details: [] };
}
