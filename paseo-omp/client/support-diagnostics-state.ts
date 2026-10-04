import type { OmpStore } from "../shared/omp-store";

type SupportReportInput = { store?: OmpStore; cwd?: string; force?: boolean };
type SupportReportOutput = { report: string };

export async function refreshSupportReport(
  loadReport: (input: SupportReportInput) => Promise<SupportReportOutput>,
  input: Omit<SupportReportInput, "force">,
): Promise<SupportReportOutput> {
  return await loadReport({ ...input, force: true });
}

export type SupportReportCopyState = "idle" | "copying" | "copied" | "error";
export type SupportBundleCopyState = "idle" | "bundling" | "copied" | "error";

export interface SupportBundleViewState {
  bundleLabel: string;
  bundleDisabled: boolean;
  bundleFeedback: string | null;
  transcriptStatus: "not-requested" | "included" | "unavailable";
  transcriptNote: string | null;
  redactionReminder: string | null;
}

export interface SupportDiagnosticsViewState {
  refreshLabel: string;
  copyLabel: string;
  copyDisabled: boolean;
  loadingMessage: string | null;
  reportError: string | null;
  copyFeedback: string | null;
}

/** Maps request and copy state to the exact accessible feedback rendered by the Help tab. */
export function supportDiagnosticsViewState(input: {
  loading: boolean;
  refreshing: boolean;
  hasReport: boolean;
  reportFailed: boolean;
  copyState: SupportReportCopyState;
}): SupportDiagnosticsViewState {
  return {
    refreshLabel: input.refreshing ? "Refreshing…" : "Refresh",
    copyLabel: input.copyState === "copying" ? "Copying…" : "Copy report",
    copyDisabled: !input.hasReport || input.copyState === "copying",
    loadingMessage: input.loading ? "Collecting OMP diagnostics…" : null,
    reportError: input.reportFailed ? "Could not collect OMP diagnostics." : null,
    copyFeedback:
      input.copyState === "copied"
        ? "Report copied."
        : input.copyState === "error"
          ? "Could not copy. Select the report text and copy it manually."
          : null,
  };
}

const TRANSCRIPT_REDACTION_REMINDER =
  "Transcript excerpt may contain credentials. Review and redact before pasting.";

/**
 * Bundle view model. The transcript half is opt-in per copy, so the reminder only appears once the
 * user actually asked for an excerpt; a bundle without a transcript is a plain report copy.
 */
export function supportBundleViewState(input: {
  hasReport: boolean;
  copyState: SupportBundleCopyState;
  transcriptRequested: boolean;
  transcriptStatus: "not-requested" | "included" | "unavailable";
  transcriptNote: string | null;
}): SupportBundleViewState {
  const transcriptIncluded = input.transcriptStatus === "included";
  return {
    bundleLabel: input.copyState === "bundling" ? "Bundling…" : "Copy bundle",
    bundleDisabled: !input.hasReport || input.copyState === "bundling",
    bundleFeedback:
      input.copyState === "copied"
        ? transcriptIncluded
          ? "Bundle copied. Review the transcript excerpt before pasting."
          : "Bundle copied."
        : input.copyState === "error"
          ? "Could not copy the bundle. Select the report text and copy it manually."
          : null,
    transcriptStatus: input.transcriptStatus,
    transcriptNote: input.transcriptNote,
    redactionReminder:
      input.transcriptRequested && transcriptIncluded ? TRANSCRIPT_REDACTION_REMINDER : null,
  };
}
