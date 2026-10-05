import { OmpPublicError } from "./security";

/**
 * Every hard reject that ships a "what to use instead" pointer. The message text is the persisted
 * contract: hints never replace or reword it, they ride alongside as a structured field so old
 * clients keep the exact string and new ones can render the substitute workflow.
 */
export type RejectCode =
  | "toolPolicy-at-open"
  | "toolPolicy-host-tools"
  | "outputSchema"
  | "live-settings"
  | "live-mode"
  | "revert-scope"
  | "archive-absent"
  | "fork-needs-floor";

export const INSTEAD_HINTS: Record<RejectCode, string> = {
  "toolPolicy-at-open":
    "Use paseoTools to choose which caller tools reach OMP as MCP host tools; disallowedTools covers known native OMP built-ins only.",
  "toolPolicy-host-tools":
    "Use paseoTools to scope caller tools instead; OMP cannot carry exact MCP preapproval through set_host_tools.",
  outputSchema:
    "Validate the response structure after the turn instead; OMP exposes no structured-output contract.",
  "live-settings":
    "Change the setting on the store and start a new session; OMP does not apply provider settings to a running session.",
  "live-mode": "Start a new session with the mode you want; OMP fixes approval mode at launch.",
  "revert-scope":
    "Use conversation rewind to return to an earlier message; file changes are not rewound.",
  "archive-absent":
    "Keep the session or delete it through OMP; there is no native archive state to toggle.",
  "fork-needs-floor":
    "Use conversation rewind to branch from this point, or upgrade OMP past 18.4.11 for a non-destructive fork.",
};

export function insteadHint(code: RejectCode): string {
  return INSTEAD_HINTS[code];
}

/**
 * The hint is non-enumerable on purpose. It is read by property access and survives zod `.parse`,
 * so real hosts receive it, while `JSON.stringify` and structural equality keep the previous
 * `{ message }` shape for every existing assertion and serialized payload.
 */
export type Hinted<T> = T & { readonly diagnostic: string };
export type RejectDetails = { message: string; diagnostic?: string };
export function withHint<T extends Error>(error: T, code: RejectCode): Hinted<T> {
  Object.defineProperty(error, "diagnostic", {
    value: INSTEAD_HINTS[code],
    enumerable: false,
    configurable: true,
    writable: true,
  });
  // defineProperty attached diagnostic above, invisible to the compiler
  const hinted: Hinted<T> = error as Hinted<T>;
  return hinted;
}

export function rejectWithHint(code: RejectCode, message: string): Hinted<OmpPublicError> {
  return withHint(new OmpPublicError(message), code);
}

/** Details object for handlers that emit `error` directly instead of throwing. */
export function rejectErrorDetails(code: RejectCode, message: string): RejectDetails {
  return rejectDetails(withHint(new OmpPublicError(message), code), message);
}

function hintOf(error: unknown): string | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  if (!("diagnostic" in error)) return undefined;
  const value: unknown = error.diagnostic;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Rebuilds the public `{ message }` error payload while preserving any attached hint. The provider
 * error mappers construct a fresh object, so the non-enumerable field has to be re-attached here or
 * it would be lost on the way to the event stream.
 */
export function rejectDetails(error: unknown, message: string): RejectDetails {
  const details: RejectDetails = { message };
  const hint = hintOf(error);
  if (hint !== undefined) {
    Object.defineProperty(details, "diagnostic", {
      value: hint,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return details;
}
