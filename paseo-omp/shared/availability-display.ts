import type { OmpProviderHealth } from "./provider-diagnostics";

/**
 * Pre-launch availability (QW2).
 *
 * The server already classifies availability (`probeOmpAvailability`, server/provider-diagnostics.ts)
 * as missing | unrunnable | incompatible | available, but no released daemon calls it before a
 * session starts. This module maps the *already allowlisted* health contract
 * (`shared/provider-diagnostics.ts`) into the same four-state union plus display copy, so the
 * Hub/diagnostics surfaces can show it pre-launch without a new RPC, a new probe, or any raw
 * probe-output leak: every string here is fixed copy, never stdout/stderr.
 *
 * Custom-command note: this module resolves, guesses, or probes no binary — there is no second
 * probe to get wrong. Per-agent correctness rests on the server's `checkAvailability`
 * (server/provider/registration.ts), which reads that agent's own `providerOptions.command`
 * (Doppler/env wrappers included) and probes exactly that binary via `probeOmpAvailability`.
 * The health reused here is probed once for the daemon-default binary, so surfaces MUST present
 * this classification as the default-binary signal, never as a per-agent guarantee for a
 * custom-command profile. `command`/`status()` stay unregistered by design: a daemon-resolved
 * launch cannot see per-agent options, so registering them would misjudge custom-command agents.
 */
export type AvailabilityStatus = "missing" | "unrunnable" | "incompatible" | "available";

export type AvailabilityAction = "open-diagnostics" | "retry";

export interface AvailabilityDisplay {
  status: AvailabilityStatus;
  /** Host tone vocabulary shared with `ProviderHealthTone`'s ok/warning/danger members. */
  tone: "ok" | "warning" | "danger";
  /** Short form for a dot/suffix: "Not found", "Cannot run", "Incompatible", "Available". */
  label: string;
  /** Banner headline. */
  title: string;
  /** One-line explanation; null when available. */
  detail: string | null;
  /** Suggested next step; null when available. */
  action: AvailabilityAction | null;
  /** False only when available, so available renders no badge at all. */
  showBadge: boolean;
}

export interface AvailabilityCopy {
  label: string;
  title: string;
  detail: string;
  tone: AvailabilityDisplay["tone"];
  action: AvailabilityAction | null;
}

/** Allowlisted copy per status — the single place these strings live. */
export const AVAILABILITY_COPY: Record<
  Exclude<AvailabilityStatus, "available">,
  AvailabilityCopy
> = {
  missing: {
    label: "Not found",
    title: "OMP not found",
    detail: "No OMP executable resolved for this profile. Set the launch command or install OMP.",
    tone: "danger",
    action: "open-diagnostics",
  },
  unrunnable: {
    label: "Cannot run",
    title: "OMP cannot run",
    detail: "The executable was found but the probe failed. Check permissions, then retry.",
    tone: "danger",
    action: "retry",
  },
  incompatible: {
    label: "Incompatible",
    title: "OMP is incompatible",
    detail: "This OMP build does not advertise rpc-ui support. Upgrade OMP or fix the command.",
    tone: "warning",
    action: "open-diagnostics",
  },
};

const AVAILABLE_DISPLAY: AvailabilityDisplay = {
  status: "available",
  tone: "ok",
  label: "Available",
  title: "OMP available",
  detail: null,
  action: null,
  showBadge: false,
};

/**
 * Pure map from the existing health contract to the four-state union, mirroring the precedence
 * of `probeOmpAvailability` (cleanup failure, then version status, then rpc-ui detection) so the
 * pre-launch prediction matches what a launch would find.
 */
export function displayForStatus(status: AvailabilityStatus): AvailabilityDisplay {
  if (status === "available") return { ...AVAILABLE_DISPLAY };
  const copy = AVAILABILITY_COPY[status];
  return {
    status,
    tone: copy.tone,
    label: copy.label,
    title: copy.title,
    detail: copy.detail,
    action: copy.action,
    showBadge: true,
  };
}

/**
 * Pure map from the existing health contract to the four-state union, mirroring the precedence
 * of `probeOmpAvailability` (cleanup failure, then version status, then rpc-ui detection) so the
 * pre-launch prediction matches what a launch would find. Single construction site for health:
 * classify here, build copy via `displayForStatus`, so callers holding a daemon-observed failure
 * with no health (e.g. a custom-command profile the default-binary probe cannot speak for)
 * build the same allowlisted copy without inventing a second probe or leaking probe output.
 */
export function toAvailabilityDisplay(
  health: Pick<OmpProviderHealth, "binary" | "rpcUi">,
): AvailabilityDisplay {
  return displayForStatus(classifyAvailability(health));
}

export function classifyAvailability(
  health: Pick<OmpProviderHealth, "binary" | "rpcUi">,
): AvailabilityStatus {
  const { binary, rpcUi } = health;
  if (!binary.installed) return "missing";
  if (binary.processCleanupFailed) return "unrunnable";
  switch (binary.versionStatus) {
    case "ok":
      break;
    case "not-found":
      return "missing";
    case "malformed":
      return "incompatible";
    default:
      return "unrunnable";
  }
  if (!rpcUi.checked) return "unrunnable";
  if (rpcUi.supported === false) return "incompatible";
  if (rpcUi.supported === null) return "unrunnable";
  return "available";
}
