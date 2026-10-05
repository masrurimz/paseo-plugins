import type {
  OmpLspDiagnostics,
  OmpMcpDiagnostics,
  OmpProcessDiagnostics,
  OmpProviderHealth,
  OmpVersion,
  OmpVersionStatus,
  PathState,
} from "../shared/provider-diagnostics";
import { isOmpProvider } from "./omp-store-state";
import type { PaseoApi, PaseoProviderSnapshotResult } from "./paseo-types";

import type { AvailabilityDisplay } from "../shared/availability-display";
import { displayForStatus } from "../shared/availability-display";

export type { AvailabilityDisplay, AvailabilityStatus } from "../shared/availability-display";
export { displayForStatus, toAvailabilityDisplay } from "../shared/availability-display";

/**
 * Cache identity the config surface's health query uses for the default store and the
 * daemon working directory. The Hub sidebar reuses the same key so its availability dot reads an
 * existing result rather than starting a second probe; it adds no new RPC contract and no timer.
 */
export const HUB_AVAILABILITY_QUERY_KEY = [
  "paseo-omp",
  "provider-health",
  "default",
  "global",
] as const;

export type ProviderHealthTone = "ok" | "warning" | "danger" | "muted";
export const OMP_PROVIDER_IDS = ["omp", "omp-plugin"] as const;

export function isUnsupportedHostError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return (
    candidate.name === "PaseoUpdateHostError" ||
    candidate.code === "UPDATE_HOST_REQUIRED" ||
    candidate.code === "UNSUPPORTED_FEATURE"
  );
}

type ProviderActions = Pick<PaseoApi["providers"], "refresh" | "snapshot" | "waitForReady">;

/** Initial and post-refresh discovery waits for a settled snapshot; only known old-host errors
 * fall back to the immediate snapshot API. */
export async function loadReadyProviderSnapshot(
  providers: ProviderActions,
): Promise<PaseoProviderSnapshotResult> {
  try {
    return await providers.waitForReady({ timeoutMs: 60_000 });
  } catch (error) {
    if (!isUnsupportedHostError(error)) throw error;
    return providers.snapshot({});
  }
}

export interface RefreshDiagnosticsOptions {
  providers: ProviderActions;
  providerIds?: readonly string[];
  loadForcedHealth(): Promise<OmpProviderHealth>;
  cacheHealth(health: OmpProviderHealth): void;
  cacheProviders(snapshot: PaseoProviderSnapshotResult): void;
}

/** Provider refresh and forced health run independently. Each successful result reaches its
 * cache even when another branch fails; the boolean reports any non-suppressed partial failure. */
export async function refreshProviderDiagnostics(
  options: RefreshDiagnosticsOptions,
): Promise<{ failed: boolean }> {
  const [providerRefresh, forcedHealth] = await Promise.allSettled([
    options.providers.refresh({
      providers: [
        ...new Set([...OMP_PROVIDER_IDS, ...(options.providerIds ?? []).filter(isOmpProvider)]),
      ],
    }),
    options.loadForcedHealth(),
  ]);
  if (forcedHealth.status === "fulfilled") options.cacheHealth(forcedHealth.value);

  const providerSnapshot = await Promise.allSettled([loadReadyProviderSnapshot(options.providers)]);
  if (providerSnapshot[0].status === "fulfilled") {
    options.cacheProviders(providerSnapshot[0].value);
  }
  const providerRefreshFailed =
    providerRefresh.status === "rejected" && !isUnsupportedHostError(providerRefresh.reason);
  return {
    failed:
      providerRefreshFailed ||
      forcedHealth.status === "rejected" ||
      providerSnapshot[0].status === "rejected",
  };
}

const VERSION_STATUS_LABELS: Record<OmpVersionStatus, string> = {
  ok: "Installed",
  "not-found": "Not installed",
  unrunnable: "Found but could not run",
  timeout: "Version check timed out",
  "probe-failed": "Version check failed",
  malformed: "Unrecognized version output",
};

const VERSION_STATUS_TONES: Record<OmpVersionStatus, ProviderHealthTone> = {
  ok: "ok",
  "not-found": "danger",
  unrunnable: "danger",
  timeout: "warning",
  "probe-failed": "warning",
  malformed: "warning",
};

export function formatOmpVersion(version: OmpVersion): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${core}-${version.prerelease}` : core;
}

export interface BinaryHealthSummary {
  label: string;
  tone: ProviderHealthTone;
}

/** Combines version status and the parsed version into one display-ready label and tone. */
export function summarizeBinaryHealth(binary: OmpProviderHealth["binary"]): BinaryHealthSummary {
  const label =
    binary.versionStatus === "ok" && binary.version
      ? `${VERSION_STATUS_LABELS.ok} (${formatOmpVersion(binary.version)})`
      : VERSION_STATUS_LABELS[binary.versionStatus];
  return { label, tone: VERSION_STATUS_TONES[binary.versionStatus] };
}

/** Distinguishes "not supported" from "we could not tell" so the UI never overclaims. */
export function summarizeRpcUiSupport(rpcUi: OmpProviderHealth["rpcUi"]): string {
  if (!rpcUi.checked) return "Unknown (omp binary unavailable)";
  if (rpcUi.supported === null) return "Unknown (probe failed, empty, or truncated)";
  return rpcUi.supported ? "Supported" : "Not advertised by this build";
}

export function rpcUiTone(rpcUi: OmpProviderHealth["rpcUi"]): ProviderHealthTone {
  if (!rpcUi.checked || rpcUi.supported === null) return "muted";
  return rpcUi.supported ? "ok" : "muted";
}

export function summarizeLspSupport(lsp: OmpLspDiagnostics): string {
  if (lsp.status === "supported") return "Supported";
  if (lsp.status === "not-advertised") return "Not advertised by this build";
  return "Unknown (probe failed, empty, or truncated)";
}

export function lspTone(lsp: OmpLspDiagnostics): ProviderHealthTone {
  return lsp.status === "supported" ? "ok" : "muted";
}

export function summarizeMcpDiagnostics(mcp: OmpMcpDiagnostics): string {
  if (mcp.status === "configured") return `${mcp.serverCount ?? 0} configured`;
  const label =
    mcp.status === "unavailable"
      ? "Unavailable"
      : mcp.status === "unreadable"
        ? "Unreadable"
        : mcp.status === "wrong-type"
          ? "Wrong type"
          : "Invalid";
  return `${label} (${mcp.reason ?? "no detail"})`;
}

export function mcpTone(mcp: OmpMcpDiagnostics): ProviderHealthTone {
  if (mcp.status === "configured") return "ok";
  if (mcp.status === "unavailable") return "muted";
  return "warning";
}

export function summarizeProcessDiagnostics(diagnostics: OmpProcessDiagnostics): string {
  if (diagnostics.status === "unavailable") return "No hub run directory found";
  if (diagnostics.status === "unknown") return "Unknown (could not read the hub run directory)";
  const count = diagnostics.trackedCount ?? 0;
  const statesKnown =
    diagnostics.activeCount != null &&
    diagnostics.historicalCount != null &&
    diagnostics.unknownCount != null;
  const detail = statesKnown
    ? `${diagnostics.activeCount} active-state, ${diagnostics.historicalCount} historical, ${diagnostics.unknownCount} unknown`
    : "states not reported";
  return `${count} metadata records (${detail}${diagnostics.status === "partial" ? "; partial access" : ""}); live processes not verified`;
}

export function processTone(diagnostics: OmpProcessDiagnostics): ProviderHealthTone {
  if (diagnostics.status === "unknown") return "warning";
  if (diagnostics.status === "partial") return "warning";
  if (diagnostics.status === "unavailable") return "muted";
  return "muted";
}

const PATH_STATE_LABELS: Record<PathState, string> = {
  available: "Found",
  missing: "Missing",
  unreadable: "Unreadable",
  invalid: "Invalid",
  "wrong-type": "Wrong type on disk",
};

const PATH_STATE_TONES: Record<PathState, ProviderHealthTone> = {
  available: "ok",
  missing: "danger",
  unreadable: "warning",
  invalid: "warning",
  "wrong-type": "warning",
};

export interface PathStateSummary {
  label: string;
  tone: ProviderHealthTone;
}

/** Never collapses unreadable/invalid/wrong-type into missing; each state gets its own label. */
export function summarizePathState(state: PathState): PathStateSummary {
  return { label: PATH_STATE_LABELS[state], tone: PATH_STATE_TONES[state] };
}

/**
 * A null memory backend is ambiguous on its own: the config could be genuinely unset, or simply
 * unavailable/invalid/wrong-type. Only a truly "available" config licenses "Not configured";
 * every other state reports its own unavailability instead of guessing.
 */
export function summarizeMemoryBackend(health: OmpProviderHealth): string {
  if (health.roots.configState !== "available") {
    return `Unknown (config ${PATH_STATE_LABELS[health.roots.configState].toLowerCase()})`;
  }
  return health.memoryBackend ?? "Not configured";
}

export interface KnownOmpProviderSummary {
  id: string;
  label: string;
  status: string;
  enabled: boolean;
}

export interface ProviderStatusSummary {
  label: string;
  tone: ProviderHealthTone;
}

export function summarizeProviderStatus(
  provider: Pick<KnownOmpProviderSummary, "enabled" | "status">,
): ProviderStatusSummary {
  if (!provider.enabled) return { label: "Disabled", tone: "muted" };
  switch (provider.status) {
    case "ready":
      return { label: "Ready", tone: "ok" };
    case "loading":
      return { label: "Loading", tone: "warning" };
    case "error":
      return { label: "Error", tone: "danger" };
    case "unavailable":
      return { label: "Unavailable", tone: "danger" };
    default:
      return { label: "Unknown", tone: "muted" };
  }
}

/** Narrows a full provider snapshot to the native and plugin OMP identities. */
export function selectKnownOmpProviders(
  entries: readonly PaseoProviderSnapshotResult["entries"][number][],
): KnownOmpProviderSummary[] {
  return entries.flatMap((entry) =>
    isOmpProvider(entry.provider)
      ? [
          {
            id: entry.provider,
            label: entry.label ?? entry.provider,
            status: entry.status,
            enabled: entry.enabled ?? true,
          },
        ]
      : [],
  );
}

export interface PerProfileAvailabilityInput {
  /** Snapshot entries narrow the candidate profiles; only OMP identities are considered. */
  providers: readonly PaseoProviderSnapshotResult["entries"][number][];
  /** Default-binary classification from the already-fetched health result, if any. */
  defaultDisplay?: AvailabilityDisplay;
}

/**
 * Pre-launch availability per OMP profile without a new probe or status registration.
 *
 * The `omp`/`omp-plugin` identities reuse the shared default-binary classification. Named
 * profiles (`omp-plugin-<profile>`) keep plugin-owned launch, so their own
 * `providerOptions.command` (Doppler/env wrappers included) is the only binary that could
 * speak for them — and the client never sees per-agent options. The daemon observes each
 * profile through `checkAvailability` at refresh time and records the outcome on the snapshot
 * entry, so an entry reading `unavailable`/`error` maps to that profile's own `unrunnable`
 * copy while every other case stays silent rather than guessing the wrong binary. The custom
 * command itself is never displayed: all strings are the fixed `AVAILABILITY_COPY` allowlist.
 */
export function selectPerProfileAvailability(
  input: PerProfileAvailabilityInput,
): Record<string, AvailabilityDisplay> {
  const known = selectKnownOmpProviders(input.providers);
  const result: Record<string, AvailabilityDisplay> = {};
  for (const provider of known) {
    if (!provider.enabled) continue;
    const isDefaultProfile = provider.id === "omp" || provider.id === "omp-plugin";
    if (isDefaultProfile) {
      if (input.defaultDisplay?.showBadge) result[provider.id] = input.defaultDisplay;
      continue;
    }
    if (provider.status === "unavailable" || provider.status === "error") {
      result[provider.id] = displayForStatus("unrunnable");
    }
  }
  return result;
}
