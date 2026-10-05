export type SettingImpact = "live" | "new-sessions" | "restart";

export type RestartReason = "approval-mode" | "settings-live-reject" | "both";

export interface RestartRequired {
  requiresRestart: boolean;
  reason: RestartReason | null;
  affectedPaths: readonly string[];
}

const LIVE_SETTING_PATHS: Record<string, true> = { model: true, thinking: true };

export function classifySettingImpact(path: string): SettingImpact {
  const normalized = path.toLowerCase().replace(/[_.-]/g, "");
  // OMP fixes approval mode for the session (server/provider/session.ts:1534-1537), so a mode
  // edit lands only in a session started afterwards.
  if (normalized === "mode" || normalized.includes("approval")) return "new-sessions";
  // Model and thinking are the two selections OMP accepts on a live session
  // (server/provider/session.ts:1561-1562), so they raise no restart warning.
  if (LIVE_SETTING_PATHS[normalized]) return "live";
  // Every other OMP setting is rejected on the live channel (session.ts:1539-1541) and is read
  // when the process launches.
  return "restart";
}

export function deriveRestartRequired(draftPaths: readonly string[]): RestartRequired {
  const seen = new Set<string>();
  const affectedPaths: string[] = [];
  let approval = false;
  let settings = false;
  for (const path of draftPaths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const impact = classifySettingImpact(path);
    if (impact === "live") continue;
    affectedPaths.push(path);
    if (impact === "new-sessions") approval = true;
    else settings = true;
  }
  const reason: RestartReason | null =
    approval && settings
      ? "both"
      : approval
        ? "approval-mode"
        : settings
          ? "settings-live-reject"
          : null;
  return { requiresRestart: affectedPaths.length > 0, reason, affectedPaths };
}
