import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";
import { OmpStoreSchema } from "./omp-store";
import { OmpSupportReportTextSchema, supportReportByteLength } from "./support-diagnostics";

/** The transcript half of a bundled report is capped well below the report contract's own cap. */
export const OMP_SUPPORT_TRANSCRIPT_MAX_BYTES = 32 * 1024;
export const OMP_SUPPORT_TRANSCRIPT_TRUNCATION_MARKER = "\n<truncated>";

export type TranscriptSource = "journal" | "live";
export type TranscriptStatus = "included" | "unavailable";

export interface TranscriptSelector {
  source: TranscriptSource;
  sessionId: string;
  maxBytes: number;
}

export interface TranscriptSlice {
  status: TranscriptStatus;
  text: string;
  note: string | null;
}

export interface SupportBundle {
  report: string;
  transcript: TranscriptSlice;
}

/** Code-point-safe byte budget; the marker is part of the budget and never split. */
export function truncateUtf8Text(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (supportReportByteLength(value) <= maxBytes) return value;
  const markerBytes = supportReportByteLength(OMP_SUPPORT_TRANSCRIPT_TRUNCATION_MARKER);
  if (maxBytes <= markerBytes) return "";
  const budget = maxBytes - markerBytes;
  let used = 0;
  let end = 0;
  for (const character of value) {
    const size = supportReportByteLength(character);
    if (used + size > budget) break;
    used += size;
    end += character.length;
  }
  return `${value.slice(0, end)}${OMP_SUPPORT_TRANSCRIPT_TRUNCATION_MARKER}`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string" && record.text.length > 0) parts.push(record.text);
    }
    return parts.join("\n");
  }
  return "";
}

function transcriptLine(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" && record.role.length > 0 ? record.role : "entry";
  const text = contentText(record.content).trim();
  if (text.length === 0) return null;
  return `${role}: ${text}`;
}

/** Renders the display-text portion of a persisted transcript under a hard byte budget. */
export function renderTranscriptExcerpt(messages: readonly unknown[], maxBytes: number): string {
  const lines: string[] = [];
  for (const message of messages) {
    const line = transcriptLine(message);
    if (line) lines.push(line);
  }
  return truncateUtf8Text(lines.join("\n\n"), maxBytes);
}

/**
 * Pure bundle assembler: the report is passed through untouched so the pasted-report contract and
 * its 64 KiB cap stay owned by `formatOmpSupportReport`. Only the transcript half is bounded here.
 */
export function assembleSupportBundle(report: string, transcript: TranscriptSlice): SupportBundle {
  if (transcript.status === "unavailable") {
    return {
      report,
      transcript: {
        status: "unavailable",
        text: "",
        note: transcript.note ?? "Transcript excerpt unavailable.",
      },
    };
  }
  return {
    report,
    transcript: {
      status: "included",
      text: truncateUtf8Text(transcript.text, OMP_SUPPORT_TRANSCRIPT_MAX_BYTES),
      note: null,
    },
  };
}

export const OmpSupportTranscriptTextSchema = z
  .string()
  .refine((value) => supportReportByteLength(value) <= OMP_SUPPORT_TRANSCRIPT_MAX_BYTES, {
    message: "OMP transcript excerpt exceeds 32 KiB",
  });

export const OmpTranscriptSelectorSchema = z
  .object({
    source: z.enum(["journal", "live"]),
    sessionId: z.string().min(1).max(128),
    maxBytes: z.number().int().min(1).max(OMP_SUPPORT_TRANSCRIPT_MAX_BYTES),
  })
  .strict();

export const OmpTranscriptSliceSchema = z
  .object({
    status: z.enum(["included", "unavailable"]),
    text: OmpSupportTranscriptTextSchema,
    note: z.string().max(256).nullable(),
  })
  .strict();

export const getOmpSupportBundle = defineRpc({
  name: "paseo-omp.get-support-bundle",
  input: z
    .object({
      store: OmpStoreSchema.optional(),
      force: z.boolean().optional(),
      cwd: OmpWorkspaceCwdSchema.optional(),
      transcript: OmpTranscriptSelectorSchema.optional(),
    })
    .strict(),
  output: z
    .object({
      report: OmpSupportReportTextSchema,
      transcript: OmpTranscriptSliceSchema,
    })
    .strict(),
});

export type OmpSupportBundleInput = z.infer<typeof getOmpSupportBundle.input>;
