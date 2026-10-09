import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type { listOmpQuotas, OmpQuota } from "../shared/quota";
import { ompDataDir } from "./paths";

const QuotaRowSchema = z.object({
  provider: z.string(),
  label: z.string(),
  windowLabel: z.string().nullable(),
  usedFraction: z.number().min(0).nullable(),
  status: z.string().nullable(),
  resetsAt: z.number().int().nullable(),
  recordedAt: z.number().int(),
});

// OMP limit_ids embed reset timestamps, so each historical window is its own
// series and newest-per-series keeps dead windows forever. The liveness filter
// below keeps the pill aggregate and the popover on live windows only.
export const QUOTA_STALE_AFTER_MS = 30 * 24 * 3_600_000;

export function listOmpQuotasFrom(path: string, now: number = Date.now()): OmpQuota[] {
  try {
    const database = new DatabaseSync(path, { readOnly: true, timeout: 500 });
    try {
      const rows = database
        .prepare(
          `SELECT provider, label, window_label AS windowLabel, used_fraction AS usedFraction,
                  status, resets_at AS resetsAt, recorded_at AS recordedAt
           FROM (
             SELECT provider, account_key, limit_id, label, window_label, used_fraction, status,
                    resets_at, recorded_at, id,
                    ROW_NUMBER() OVER (
                      PARTITION BY provider, account_key, limit_id
                      ORDER BY recorded_at DESC, id DESC
                    ) AS position
             FROM usage_history
           )
           WHERE position = 1
             AND (resets_at IS NULL OR resets_at > ?)
             AND (resets_at IS NOT NULL OR recorded_at > ?)
           ORDER BY COALESCE(usedFraction, -1) DESC, provider, label`,
        )
        .all(now, now - QUOTA_STALE_AFTER_MS);
      return rows.flatMap((row) => {
        const parsed = QuotaRowSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
    } finally {
      database.close();
    }
  } catch {
    return [];
  }
}

export function resolveListOmpQuotas(_input: RpcInput<typeof listOmpQuotas>): {
  quotas: OmpQuota[];
} {
  return { quotas: listOmpQuotasFrom(join(ompDataDir(), "agent.db")) };
}
