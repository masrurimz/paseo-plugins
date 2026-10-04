#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Wire + SDK drift lever for the OMP RPC compatibility intake (offline; see USAGE). */

const EXIT_CLEAN = 0;
const EXIT_BLOCKING = 2;
const EXIT_USAGE = 1;

const USAGE = `Usage:
  node scripts/omp-wire-diff.mjs --self-check
  node scripts/omp-wire-diff.mjs --omp <path|tag> --protocol <protocol.ts> [--baseline <schema.json>]
  node scripts/omp-wire-diff.mjs --sdk <provider.d.ts|dir> --ledger <README.md> [--matrix <TESTING.md>]

Options:
  --omp <path|tag>     Upstream rpc-wire.schema.json, its directory, or a tag with a cached snapshot.
  --protocol <path>    server/provider/omp-rpc-protocol.ts to read command policies from.
  --baseline <path>    Optional previous schema JSON; per-command signature changes become type-change.
  --sdk <path>         @getpaseo/plugin server provider declaration or its directory.
  --ledger <path>      README capability ledger to diff SDK capabilities against.
  --matrix <path>      Optional TESTING.md evidence matrix to mention in the SDK report.
  --self-check         Run built-in offline fixtures and verify the exit-code contract.
  --help               Print this message.

Classification: clean | additive-optional | additive-required | removed-or-renamed | type-change.
Exit 2 on any additive-required, removed-or-renamed, or type-change entry.`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = EXIT_USAGE;
}

function readText(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail(`${label} could not be read: ${path}`);
    return null;
  }
}

function readJson(path, label) {
  const text = readText(path, label);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON: ${path}`);
    return null;
  }
}

/** Reads `OMP_RPC_COMMAND_POLICIES` from the strict parser without importing it. */
export function readProtocolPolicies(text) {
  const marker = "OMP_RPC_COMMAND_POLICIES";
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return null;
  const openIndex = text.indexOf("{", markerIndex);
  const closeIndex = text.indexOf("} as const", openIndex);
  if (openIndex === -1 || closeIndex === -1) return null;
  const body = text.slice(openIndex + 1, closeIndex);
  const policies = new Map();
  for (const match of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]+)"/gu)) {
    policies.set(match[1], match[2]);
  }
  return policies.size > 0 ? policies : null;
}

/** Reads the canonical `{ commands: { <name>: { required, signature } } }` wire form. */
export function readWireSchema(schema) {
  const raw = schema?.commands ?? schema?.rpc?.commands;
  const commands = new Map();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      const record = value && typeof value === "object" ? value : {};
      commands.set(name, {
        required: record.required === true || record.mandatory === true,
        signature: typeof record.signature === "string" ? record.signature : null,
      });
    }
  }
  return commands;
}

export function classifyWireDiff(wireCommands, policies, baselineCommands) {
  const rows = [];
  for (const [name, entry] of wireCommands) {
    const policy = policies.get(name);
    const baseline = baselineCommands?.get(name);
    if (baseline && entry.signature && baseline.signature !== entry.signature) {
      rows.push({ command: name, verdict: "type-change" });
      continue;
    }
    if (policy === "implemented") {
      rows.push({ command: name, verdict: "clean" });
      continue;
    }
    rows.push({
      command: name,
      verdict: entry.required ? "additive-required" : "additive-optional",
    });
  }
  for (const [name, policy] of policies) {
    if (policy === "implemented" && !wireCommands.has(name)) {
      rows.push({ command: name, verdict: "removed-or-renamed" });
    }
  }
  return rows.sort((a, b) => a.command.localeCompare(b.command));
}

const BLOCKING_VERDICTS = new Set(["additive-required", "removed-or-renamed", "type-change"]);

export function renderWireTable(rows) {
  const nameWidth = Math.max(7, ...rows.map((row) => row.command.length));
  const header = `${"command".padEnd(nameWidth)}  verdict`;
  const lines = [header, `${"-".repeat(nameWidth)}  ${"-".repeat(11)}`];
  for (const row of rows) lines.push(`${row.command.padEnd(nameWidth)}  ${row.verdict}`);
  return lines.join("\n");
}

export function readSdkCapabilities(text) {
  const marker = "PROVIDER_CAPABILITIES";
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return null;
  const start = text.indexOf("[", markerIndex);
  const end = text.indexOf("]", start);
  if (start === -1 || end === -1) return null;
  const capabilities = [];
  for (const match of text.slice(start, end).matchAll(/"([^"]+)"/gu)) capabilities.push(match[1]);
  return capabilities.length > 0 ? capabilities : null;
}

export function classifySdkDiff(capabilities, ledgerText) {
  const claimed = new Set();
  for (const line of ledgerText.split("\n")) {
    const match = /^\|\s*`([a-z0-9_.]+)`\s*\|/u.exec(line);
    if (match) claimed.add(match[1]);
  }
  const rows = [];
  for (const capability of capabilities) {
    rows.push({
      command: capability,
      verdict: claimed.has(capability) ? "clean" : "removed-or-renamed",
    });
  }
  return rows.sort((a, b) => a.command.localeCompare(b.command));
}

function runWireDiff({ ompPath, protocolPath, baselinePath }) {
  const schemaPath = resolveOmpSchema(ompPath);
  if (schemaPath === null) return EXIT_USAGE;
  const schema = readJson(schemaPath, "wire schema");
  const protocolText = readText(protocolPath, "protocol file");
  if (schema === null || protocolText === null) return EXIT_USAGE;
  const policies = readProtocolPolicies(protocolText);
  if (policies === null) {
    fail(`no OMP_RPC_COMMAND_POLICIES table found in ${protocolPath}`);
    return EXIT_USAGE;
  }
  let baseline = null;
  if (baselinePath) {
    const baselineSchema = readJson(baselinePath, "baseline schema");
    if (baselineSchema === null) return EXIT_USAGE;
    baseline = readWireSchema(baselineSchema);
  }
  const rows = classifyWireDiff(readWireSchema(schema), policies, baseline);
  process.stdout.write(`${renderWireTable(rows)}\n`);
  return rows.some((row) => BLOCKING_VERDICTS.has(row.verdict)) ? EXIT_BLOCKING : EXIT_CLEAN;
}

function resolveOmpSchema(ompPath) {
  if (!ompPath) {
    fail("--omp is required with --protocol");
    return null;
  }
  const candidate = resolve(ompPath);
  try {
    const direct = readFileSync(candidate, "utf8");
    JSON.parse(direct);
    return candidate;
  } catch {
    // Not a schema file; try a directory or a cached tag snapshot next.
  }
  const inDirectory = join(candidate, "rpc-wire.schema.json");
  try {
    readFileSync(inDirectory, "utf8");
    return inDirectory;
  } catch {
    fail(`no rpc-wire.schema.json at ${candidate}; tag sources need a cached snapshot file path`);
    return null;
  }
}

function runSdkDiff({ sdkPath, ledgerPath, matrixPath }) {
  const declaration = resolveSdkDeclaration(sdkPath);
  if (declaration === null) return EXIT_USAGE;
  const declarationText = readText(declaration, "SDK provider declaration");
  const ledgerText = readText(ledgerPath, "ledger");
  if (declarationText === null || ledgerText === null) return EXIT_USAGE;
  const capabilities = readSdkCapabilities(declarationText);
  if (capabilities === null) {
    fail(`no PROVIDER_CAPABILITIES list found in ${declaration}`);
    return EXIT_USAGE;
  }
  const rows = classifySdkDiff(capabilities, ledgerText);
  process.stdout.write(`${renderWireTable(rows)}\n`);
  if (matrixPath) process.stdout.write(`\nEvidence matrix: ${matrixPath}\n`);
  return rows.some((row) => BLOCKING_VERDICTS.has(row.verdict)) ? EXIT_BLOCKING : EXIT_CLEAN;
}

function resolveSdkDeclaration(sdkPath) {
  if (!sdkPath) {
    fail("--sdk is required with --ledger");
    return null;
  }
  const candidate = resolve(sdkPath);
  try {
    if (readFileSync(candidate, "utf8")) return candidate;
  } catch {
    // Fall through to the directory form.
  }
  const inDirectory = join(candidate, "provider.d.ts");
  try {
    readFileSync(inDirectory, "utf8");
    return inDirectory;
  } catch {
    fail(`no provider declaration at ${candidate}`);
    return null;
  }
}

/** Offline fixtures that pin the exit-code contract without any upstream checkout. */
export function selfCheck() {
  const directory = mkdtempSync(join(tmpdir(), "omp-wire-diff-"));
  try {
    const protocol = join(directory, "omp-rpc-protocol.ts");
    writeFileSync(
      protocol,
      'export const OMP_RPC_COMMAND_POLICIES = {\n  prompt: "implemented",\n  get_state: "implemented",\n  new_session: "unsupported",\n} as const;\n',
    );
    const cleanSchema = join(directory, "clean.json");
    writeFileSync(
      cleanSchema,
      JSON.stringify({
        commands: {
          prompt: { required: true, signature: "a" },
          get_state: { required: false },
          handoff: { required: false },
        },
      }),
    );
    const blockingSchema = join(directory, "blocking.json");
    writeFileSync(
      blockingSchema,
      JSON.stringify({
        commands: {
          prompt: { required: true, signature: "a" },
          mandatory_new_command: { required: true },
        },
      }),
    );
    const baseline = join(directory, "baseline.json");
    writeFileSync(baseline, JSON.stringify({ commands: { prompt: { signature: "old" } } }));

    const cleanExit = runWireDiff({
      ompPath: cleanSchema,
      protocolPath: protocol,
      baselinePath: null,
    });
    const blockingExit = runWireDiff({
      ompPath: blockingSchema,
      protocolPath: protocol,
      baselinePath: null,
    });
    const typeChangeExit = runWireDiff({
      ompPath: cleanSchema,
      protocolPath: protocol,
      baselinePath: baseline,
    });

    const results = [
      ["clean schema", cleanExit, EXIT_CLEAN],
      ["required drift", blockingExit, EXIT_BLOCKING],
      ["signature change", typeChangeExit, EXIT_BLOCKING],
    ];
    let ok = true;
    for (const [label, actual, expected] of results) {
      const passed = actual === expected;
      ok = ok && passed;
      process.stdout.write(
        `${passed ? "ok  " : "FAIL"} ${label}: exit ${actual} (want ${expected})\n`,
      );
    }
    process.exitCode = ok ? EXIT_CLEAN : EXIT_USAGE;
    return ok;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[token.slice(2)] = true;
      continue;
    }
    flags[token.slice(2)] = next;
    index += 1;
  }
  return flags;
}

function main(argv) {
  const flags = parseArguments(argv);
  if (flags.help || argv.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = EXIT_CLEAN;
    return;
  }
  if (flags["self-check"]) {
    selfCheck();
    return;
  }
  if (flags.sdk !== undefined) {
    process.exitCode = runSdkDiff({
      sdkPath: flags.sdk === true ? undefined : flags.sdk,
      ledgerPath: flags.ledger === true ? undefined : flags.ledger,
      matrixPath: flags.matrix === true ? undefined : flags.matrix,
    });
    return;
  }
  if (flags.omp !== undefined) {
    process.exitCode = runWireDiff({
      ompPath: flags.omp === true ? undefined : flags.omp,
      protocolPath: flags.protocol === true ? undefined : flags.protocol,
      baselinePath: flags.baseline === true ? undefined : flags.baseline,
    });
    return;
  }
  fail("no mode selected");
  process.stdout.write(`${USAGE}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main(process.argv.slice(2));
}

export { EXIT_BLOCKING, EXIT_CLEAN, EXIT_USAGE, main, USAGE };
