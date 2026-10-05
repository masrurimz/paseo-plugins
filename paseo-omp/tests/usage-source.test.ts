import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import type { UsageReport } from "@getpaseo/plugin/server/usage";
import {
  discoverOmpUsage,
  discoverOmpUsageStores,
  fetchOmpUsage,
  OmpUsageInputSchema,
} from "../server/usage-source";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createUsageDatabase(path: string, rows: string): void {
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE usage_history (
    id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT,
    window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER, recorded_at INTEGER
  )`);
  if (rows) database.exec(rows);
  database.close();
}

function usageEnvironment(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home, PI_CONFIG_DIR: ".omp", ...extra };
}

describe("usage-source discover enumeration", () => {
  test("enumerates the default store and OMP_PROFILE store without writing stores", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-usage-discover-"));
    roots.push(home);
    const agentDir = join(home, ".omp", "agent");
    await mkdir(agentDir, { recursive: true });
    createUsageDatabase(
      join(agentDir, "agent.db"),
      `INSERT INTO usage_history VALUES (1, 'anthropic', 'account', 'daily', 'Daily', NULL, 0.5, 'ok', NULL, 10)`,
    );
    const before = await discoverOmpUsage(usageEnvironment(home), "linux");
    expect(before).toHaveLength(1);
    expect(before[0]).toEqual({
      key: expect.any(String),
      label: "OMP default",
      input: {
        route: { store: "default", path: join(agentDir, "agent.db") },
      },
    });

    const profileAgentDir = join(home, ".omp", "profiles", "team", "agent");
    await mkdir(profileAgentDir, { recursive: true });
    createUsageDatabase(
      join(profileAgentDir, "agent.db"),
      `INSERT INTO usage_history VALUES (1, 'openai', 'account', 'weekly', 'Weekly', NULL, 0.25, 'ok', NULL, 10)`,
    );
    const stores = discoverOmpUsageStores(
      usageEnvironment(home, { OMP_PROFILE: "team" }),
      "linux",
    );
    expect(stores.map((store) => store.profile).sort()).toContain("team");
    expect(stores.map((store) => store.dbPath)).toContain(join(agentDir, "agent.db"));

    const accounts = await discoverOmpUsage(
      usageEnvironment(home, { OMP_PROFILE: "team" }),
      "linux",
    );
    const keys = accounts.map((account) => account.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const account of accounts) {
      expect(OmpUsageInputSchema.safeParse(account.input).success).toBe(true);
    }
  });

  test("surfaces XDG roots and named profiles", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-usage-xdg-"));
    roots.push(home);
    const dataHome = join(home, "data");
    const stateHome = join(home, "state");
    await mkdir(join(dataHome, "omp"), { recursive: true });
    await mkdir(join(stateHome, "omp"), { recursive: true });
    createUsageDatabase(
      join(dataHome, "omp", "agent.db"),
      `INSERT INTO usage_history VALUES (1, 'anthropic', 'account', 'daily', 'Daily', NULL, 0.1, 'ok', NULL, 1)`,
    );
    createUsageDatabase(
      join(stateHome, "omp", "agent.db"),
      `INSERT INTO usage_history VALUES (1, 'anthropic', 'account', 'daily', 'Daily', NULL, 0.2, 'ok', NULL, 1)`,
    );
    const profileAgentDir = join(home, ".omp", "profiles", "nightly", "agent");
    await mkdir(profileAgentDir, { recursive: true });
    createUsageDatabase(
      join(profileAgentDir, "agent.db"),
      `INSERT INTO usage_history VALUES (1, 'openai', 'account', 'daily', 'Daily', NULL, 0.3, 'ok', NULL, 1)`,
    );
    const environment = usageEnvironment(home, {
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
    });
    const stores = discoverOmpUsageStores(environment, "linux");
    expect(stores.map((store) => store.dbPath)).toEqual(
      expect.arrayContaining([
        join(dataHome, "omp", "agent.db"),
        join(stateHome, "omp", "agent.db"),
        join(profileAgentDir, "agent.db"),
      ]),
    );
    expect(stores.find((store) => store.dbPath === join(profileAgentDir, "agent.db"))).toEqual(
      expect.objectContaining({ profile: "nightly" }),
    );
  });

  test("returns no accounts when no store exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-usage-empty-"));
    roots.push(home);
    expect(discoverOmpUsageStores(usageEnvironment(home), "linux")).toEqual([]);
    expect(await discoverOmpUsage(usageEnvironment(home), "linux")).toEqual([]);
  });
});

describe("usage-source fetch mapping", () => {
  test("maps the newest usage_history rows to available windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-usage-fetch-"));
    roots.push(root);
    const path = join(root, "agent.db");
    createUsageDatabase(
      path,
      `INSERT INTO usage_history VALUES
        (1, 'anthropic', 'account', 'five-hour', 'Claude 5 Hour', '5 Hour', 0.1, 'ok', 1700000000000, 1),
        (2, 'anthropic', 'account', 'five-hour', 'Claude 5 Hour', '5 Hour', 0.8, 'ok', 1700000000000, 2)`,
    );
    const report = (await fetchOmpUsage({
      route: { store: "default", path },
    })) as Extract<UsageReport, { status: "available" }>;
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows).toHaveLength(1);
    expect(report.windows[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        label: "Claude 5 Hour",
        shortLabel: "5 Hour",
        usedPct: 80,
        remainingPct: 20,
        resetsAt: new Date(1700000000000).toISOString(),
        tone: "warning",
        summary: true,
      }),
    );
  });

  test("reports unavailable for empty and missing stores without leaking paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-usage-unavailable-"));
    roots.push(root);
    const empty = join(root, "agent.db");
    createUsageDatabase(empty, "");
    for (const path of [empty, join(root, "missing.db")]) {
      const report = await fetchOmpUsage({ route: { store: "default", path } });
      expect(report).toEqual({
        status: "unavailable",
        problem: { kind: "no_quota", detail: "No recorded OMP usage in this store yet" },
      });
      expect(JSON.stringify(report)).not.toContain(path);
    }
  });

  test("reads read-only: fetch leaves the store byte-identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-usage-readonly-"));
    roots.push(root);
    const path = join(root, "agent.db");
    createUsageDatabase(
      path,
      `INSERT INTO usage_history VALUES (1, 'anthropic', 'account', 'daily', 'Daily', NULL, 0.5, 'ok', NULL, 10)`,
    );
    const before = await readFile(path);
    await fetchOmpUsage({ route: { store: "default", path } });
    await discoverOmpUsageStores(usageEnvironment(root), "linux");
    expect(await readFile(path)).toEqual(before);
  });

  test("isolates named profiles: fetch resolves one profile store only", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-usage-isolation-"));
    roots.push(home);
    const alphaDir = join(home, ".omp", "profiles", "alpha", "agent");
    const betaDir = join(home, ".omp", "profiles", "beta", "agent");
    await mkdir(alphaDir, { recursive: true });
    await mkdir(betaDir, { recursive: true });
    createUsageDatabase(
      join(alphaDir, "agent.db"),
      `INSERT INTO usage_history VALUES (1, 'anthropic', 'alpha', 'daily', 'Alpha Daily', NULL, 0.1, 'ok', NULL, 1)`,
    );
    createUsageDatabase(
      join(betaDir, "agent.db"),
      `INSERT INTO usage_history VALUES (1, 'openai', 'beta', 'daily', 'Beta Daily', NULL, 0.9, 'ok', NULL, 1)`,
    );
    const accounts = await discoverOmpUsage(usageEnvironment(home), "linux");
    const beta = accounts.find((account) =>
      JSON.stringify(account.input).includes(join(betaDir, "agent.db")),
    );
    expect(beta).toBeDefined();
    const report = (await fetchOmpUsage(beta?.input)) as Extract<
      UsageReport,
      { status: "available" }
    >;
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows.map((window) => window.label)).toEqual(["Beta Daily"]);
  });
});
