import type { RpcInput } from "@getpaseo/plugin";
import {
  assembleSupportBundle,
  type getOmpSupportBundle,
  renderTranscriptExcerpt,
  type SupportBundle,
  type TranscriptSelector,
  type TranscriptSlice,
} from "../shared/support-bundle";
import type { OmpOperationalFailureCollector } from "./operational-failure-diagnostics";
import type { OmpProtocolViolationCollector } from "./protocol-violation-diagnostics";
import {
  listOmpSessionDescriptors,
  readOmpPersistedSessionTranscript,
  validateNativeSessionId,
} from "./provider/session-descriptors";
import { resolveGetOmpSupportReport } from "./support-diagnostics";

type SupportBundleInput = RpcInput<typeof getOmpSupportBundle>;

function unavailable(note: string): TranscriptSlice {
  return { status: "unavailable", text: "", note };
}

/**
 * Journal-only transcript retrieval. The persisted journal is the ownership-checked, root-to-leaf
 * display history the provider itself replays, so the bundle never re-derives history from model
 * context and never bypasses the descriptor's identity and cwd checks. A `live` selector cannot be
 * served: the support RPC holds no attachable runtime handle, so it reports that plainly instead of
 * silently substituting another source.
 */
async function resolveTranscriptSlice(
  selector: TranscriptSelector | undefined,
  input: SupportBundleInput,
): Promise<TranscriptSlice> {
  if (!selector) return unavailable("Transcript excerpt not requested.");
  if (selector.source !== "journal") {
    return unavailable("Live transcript excerpts require an active session; none is attached.");
  }
  let sessionId: string;
  try {
    sessionId = validateNativeSessionId(selector.sessionId);
  } catch {
    return unavailable("Transcript session identifier is invalid.");
  }
  if (!input.cwd) {
    return unavailable("Transcript retrieval requires a workspace working directory.");
  }
  try {
    const descriptors = await listOmpSessionDescriptors({ cwd: input.cwd, sessionId, limit: 2 });
    const descriptor = descriptors.find((candidate) => candidate.id === sessionId);
    if (!descriptor?.transcriptFile) {
      return unavailable("No persisted transcript exists for this session in this workspace.");
    }
    const transcript = await readOmpPersistedSessionTranscript(
      descriptor.transcriptFile,
      sessionId,
      input.cwd,
    );
    return {
      status: "included",
      text: renderTranscriptExcerpt(transcript.messages, selector.maxBytes),
      note: null,
    };
  } catch {
    return unavailable("Transcript excerpt could not be read for this session.");
  }
}

export async function resolveGetOmpSupportBundle(
  input: SupportBundleInput,
  violations: OmpProtocolViolationCollector,
  operationalFailures: OmpOperationalFailureCollector,
  dependencies: {
    loadReport?: typeof resolveGetOmpSupportReport;
    loadTranscript?: (
      selector: TranscriptSelector | undefined,
      input: SupportBundleInput,
    ) => Promise<TranscriptSlice>;
  } = {},
): Promise<SupportBundle> {
  const [report, slice] = await Promise.all([
    (dependencies.loadReport ?? resolveGetOmpSupportReport)(input, violations, operationalFailures),
    (dependencies.loadTranscript ?? resolveTranscriptSlice)(input.transcript, input),
  ]);
  return assembleSupportBundle(report.report, slice);
}
