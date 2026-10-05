# OMP × Paseo DX integration research

Status: **final v1.0** — all three tracks complete (internal inventory, Paseo SDK
0.9.2→0.11-beta.3 + nightly, OMP 18.2.0→18.6.0). `[INFERENCE]` = not yet verified
against primary source or local code.

## 1. Where we stand (confirmed from repo)

- Plugin: `@omercnet/paseo-omp` v1.2.0, identities `omp-plugin` + `omp-plugin-<profile>`,
  never touches bundled `omp`. No auto-migration.
- Pins: Paseo `^0.9.2 || ^0.10.0 || ^0.11.0`, SDK `@getpaseo/plugin 0.11.0-beta.3`,
  OMP `18.1.15+` floor, canary passes on 18.1.15 + 18.2.0.
- Provider capabilities: **61.8%** — 10×100%, 2×50% (`session.configure` partial,
  `checkAvailability` implemented but never called by released daemons), 8×0%
  (`prompt.output_schema`, `session.archive`/`unarchive`, `session.revert.both`/`files`,
  `permission.tool_policy`, 0.11 `status()`, 0.11 usage-source).
- Server: ~17 RPCs (stores, hub processes/log tail, quotas, memory, sessions, config,
  models, plugins ×4, settings ×2, provider health, support report, MCP-browser auth)
  + 2 settings RPCs (composer pills, host inheritEnv). All store RPCs go through
  `scoped()` → `withOmpStore`; store = `{profile}` | `{agentDir}`, mutually exclusive.
- Client: 0.11 `addScreen(config)` + `addSidebarHeaderItem` Hub row with 0.9/0.10
  `addSurface` fallback; 7 config tabs (workspace drops composer); 2 workspace panels
  (memory, OMP panel); 3 command-center items; 5 composer pills (mcp gated on
  `isOmpPluginProvider`; prefs shared per-host, 15s poll, 4s hub / 30s quota polls);
  2 timeline renderers (images, MCP-auth card) + 1 tool_call transformer.
- DX choices: deny-by-default `inheritEnv` (built-in auth allowlist + host Plugin tab +
  profile names, host-first merge, ≤256 names, resolved at spawn, broad blocklist,
  `env -i`/`-u` rejected); `outputRedaction` defaults `none`, `configured-values` is
  best-effort literal replacement only; MCP forwarding keeps caller Paseo tools under
  native names (`create_agent`, `list_profiles`); typed approvals when both peers
  negotiate `typedToolApprovals: 1`, else bounded generic fallback (OMP 18.1.15 path).

## 2. Version drift (confirmed from primary sources)

- **OMP installed is 18.6.0; repo pins 18.2.0.** Four minor lines behind (18.3–18.6).
  Latest tags: v18.6.0, v18.5.1, v18.5.0, v18.4.12, v18.4.10, v18.4.4
  (`git tag --sort=-v:refname`, /tmp/omp-repo).
- **Paseo SDK pin is current**: latest tag is v0.11.0-beta.3
  (`git tag`, /tmp/researcher-paseo); main has newer unreleased commits.
- OMP 18.6.0 (2026-10-03, `packages/coding-agent/CHANGELOG.md`): `/models` Roles view
  + preset switching, secret-redaction perf, extension-loader perf, EPIPE fix.
- OMP 18.5.1 highlights: **RPC support for GPT live voice sessions** (start/stop/mute/
  phase/level/transcript/end); **machine-readable RPC wire schema +
  generated Python/Rust/Go clients** (protocol v2 negotiation, prompt-result, host
  tools, host URIs; Python client ships from SDK location); **read-only `archive`
  eval global** (`archive.enabled`, default on — prompt history, projects, past
  sessions, recaps).
- OMP 18.5.0 breaking: `task.completionProbeMs` → `task.completionProbe` (auto-migrate);
  `SessionStorage.claimSessionFile` → `claimSession(sessionId, path)` +
  `tryAcquireSessionLease`. New: `/dump all` (transcript zip), `/effort [level]`,
  per-call `model` selector for task/eval/workpool.
- Installed-CLI spot check (`omp --help`, v18.6.0): flags possibly newer than 18.2 —
  `--goal`, `--prewalk/--no-prewalk/--prewalk-into`, `--plan-yolo/--plan-yolo-into`,
  `--advisor`, `--external-thinking`, `--from-claude/--from-codex`, `--add-dir`,
  `--export`, `--service-tier`, `--hide-thinking`. `[INFERENCE]` on which are post-18.2;
  deep track will version each.

## 3. Key protocol findings (confirmed)

- **RPC wire schema is the single source**: `packages/coding-agent/src/modes/rpc/wire/`
  (`rpc-wire.schema.json`, `rpc-wire.generated.ts`, `scripts/gen-rpc/` regenerates all;
  `test/rpc-wire/generated.test.ts` fails when stale). DX implication: our strict Zod
  parser maintenance (`server/provider/omp-rpc-protocol.ts`) could diff against this
  schema per release instead of hand-tracking frames; see §5.1.
- **`archive` eval global is NOT a transcript-archive op** (`src/archive/prelude-definition.ts`,
  `cfgArchiveEnabled` in `src/tools/settings.ts`, "read-only archive eval prelude").
  So `session.archive`/`unarchive` staying at 0% remains correct — no native op to map.
- `rpc-ui` vs `rpc`: `--mode rpc-ui` routes tool UI (e.g. ask) over protocol
  (`src/modes/rpc/rpc-mode.ts`, `hasUI = interactive || rpc-ui` in `main.ts`).
  Our typed-approval negotiation rides this distinction — keep documenting it.

## 4. Suspected DX gaps (from code; deep tracks confirming)

1. `session.configure` cliff — live approval-mode change needs a new session,
   non-empty `settings` rejected. Users hitting mode/permission changes mid-session
   get a restart, not a transition. Consider: pre-flight warning in config surface
   when pending changes require restart; one-click "clone session with new mode".
2. `status()` + usage-source unregistered on 0.11 — availability only fails at session
   start; quota pill is historical (`usage_history`), no live fetcher. Consider:
   re-evaluate `status()` registration now that 0.11 hosts are real (measure the
   custom-command misprobe risk with a probe that reads providerOptions instead of
   guessing); label quota pill "historical" until a live source exists.
3. `checkAvailability` dead path — bounded missing/unrunnable/incompatible/available
   probe exists but no released daemon calls it. DX cost is silent until launch.
   Consider: surface the same classification in Hub/diagnostics pre-launch.
4. `toolPolicy` fail-closed + `disallowedTools` native-only — exact Paseo preapproval
   unusable; MCP tools unfilterable through `disallowedTools`. This is a correctness
   win (never broadens access) but a DX cliff. Consider: config-surface copy that says
   exactly this + link to `paseoTools` scoping as the supported lever.
5. `output_schema` / archive / revert-scopes hard rejects — structured-output and
   file-only/atomic-rewind workflows unavailable by design (no native OMP contract).
   Consider: keep rejects loud (they are), but add "what to use instead" hints
   (e.g. eval-side schema validation, conversation-only rewind) at the call site.
6. Residual risks to keep visible: unkeyed `agent_end` ordered-fallback
   misattribution (same-agent); no terminal-hook auto-registration; profile add
   requires plugin reload; `inheritEnv` 256-name cap + blocklists need inline help.

## 5. Recommendations

### 5.1 Integration completeness

#### Paseo SDK 0.9.2 → 0.11.0-beta.3 + nightly (complete)

Capability list and `requiredProviderCapabilities` mapping are **byte-identical**
across 0.9.2 / 0.10.x / 0.11.0-beta.3 — all deltas are in registration, client
chrome, and usage (`PROVIDER_PROTOCOL_VERSION = 1` at every tag).
`catalog`, `session.interrupt`, `session.close` require zero capabilities (always
routable). Best-in-class: declare exactly what you implement, gate emits on the
negotiated set (paseo-omp does: `capabilities.includes(...)` + violations →
`handleRuntimeFailure`).

| SDK surface | Since | DX note + paseo-omp gap |
| --- | --- | --- |
| `ProviderRegistration {id,label,icon}` + `getCatalogCacheKey` + `connect({versions,capabilities})` | ≤0.9.2 | None — `omp-plugin` identity + SVG, hash covers options/env/settings/scope/cwd/command. [verified] |
| `ProviderRegistration.command` + `ProviderLaunch` (daemon-resolved) | 0.11.0-beta.1 | **Gap, deliberate: `command` not declared** — would move launch ownership to daemon; `status()` probe couldn't see per-agent `providerOptions.command`. [verified] |
| `status()` → `{available, diagnostic}` | 0.11.0-beta.1 | **Gap, deliberate: not registered** (README:108, TESTING:16). Re-evaluate once per-agent options can flow into probe. [verified] |
| `providerOptionsSchema` / `checkAvailability` / catalog `providerOptions`+`settings` / session-open `deniedTools` | unreleased nightly expectation (absent even at HEAD) | **Gap, bridged: `ProviderRegistrationCompat` shim** (`OmpProviderOptionsSchema`, bounded `checkAvailability`, compat options). Remove per `omp-maintenance.1` when upstream types land. [verified] |
| Catalog models/modes/thinking + `session.config`/`session.commands`/`session.usage` events | ≤0.9.2 | None — native→opaque IDs, permission-gated modes, reactive events incl. periodic/post-compaction/terminal usage samples. [verified claim] |
| `ProviderSessionConfig` + `ProviderMcpServerConfig` | ≤0.9.2 | **Partial: servers forwarded, policy refused** — open with `toolPolicy` throws (`connection.ts:138`), `set_host_tools` can't preserve exact policy (`host-tools.ts:242`). Documented fail-closed. [verified] |
| `ProviderPrompt` (all attachment variants) + `prompt.output_schema` | ≤0.9.2 | `output_schema` withheld by design — schema prompts daemon-rejected. Confirm product intent. [capability absence verified] |
| Typed permissions + timeline items + `session.opened` parent linkage + persistence/revert | ≤0.9.2 | None on implemented paths; only `conversation` revert offered (`files`/`both` withheld), archive/unarchive withheld. [verified] |
| `registerSettings` + `handle(defineRpc)` | ≤0.9.2 | None — composer-pill + launch settings, ~15 RPC handlers. [verified] |
| `on(...)` / `before(...)` lifecycle (`agent.session_open`, etc.) | ≤0.9.2, identical sets at 0.9.2 and 0.11b3 | **[INFERENCE] Suspected gap: no lifecycle hooks registered** — env injection done inline at session open instead of `before:"agent.session_open"`. [INFERENCE] |
| `registerUsageSource({discover,fetch})` + tone helpers | 0.11.0-beta.1 | **Gap, deliberate: not registered** — `quota.ts` reads historical `usage_history`; upstream Claude/Codex sources cover only default/`OMP_PROFILE` stores. Implement `discover()` over OMP auth stores or keep historical pill + document. [verified] |
| `addSurface`/`addSidebarItem`/`openSurface` → `addScreen`/`addSidebarHeaderItem`/`openScreen` | 0.11.0-beta.1 deprecations, current at HEAD | None — dual-path registration with `usesScreens` branch. [verified] |
| `addSidebarHeaderItem` + `SidebarRow` | 0.11.0-beta.1 | Header used (Hub + config rows); **[INFERENCE] footer unused** — move Hub/quota status to `addSidebarFooterItem` per upstream pattern. [partially verified] |
| `addWorkspacePanel` / `addSettingsScreen` / `addSlashCommand` / `addAttachmentSource` / `addTheme` | ≤0.9.2 | **[INFERENCE] All unused** — correctly unused for theme; evaluate workspace panels (memory/sessions), attachment sources (file/review/issue), slash commands. [INFERENCE] |
| `addCommandCenterItem` / `addHeaderButton`/`addComposerPill` / `addTimelineTransformer`+`addTimelineRenderer` / `openExternalUrl` | ≤0.9.2 (externalUrl ≤0.10) | None — commands, 5 pills with teardown, image + MCP-auth pairs, validated URLs. [verified] |
| `useHosts`/`getPaseoClient` | ≤0.9.2–0.10 | [INFERENCE] Unused — Hub is single-host. [INFERENCE] |
| `playAudio({base64,mimeType})` | nightly HEAD (`42806cdb`, #5976, 2026-10-03) | New file-only playback for approval/completion cues. Unused. [INFERENCE] |
| Usage streaming (scoped per-agent streams, unpinned window rows) | nightly (`5eb4c8af`, `73d25317`) | Reinforces `registerUsageSource` gap: sources must resolve scope without lifecycle hooks. |

#### OMP 18.2.0 → 18.6.0 delta (complete)

Full report: `agent://OmpUpstreamResearch/report`. Absence claims grep-verified
unless marked [INFERENCE]. Wire baseline: `prompt/steer/follow_up/abort/get_state/
get_messages(+page)/branch/handoff/compact/get_available_commands` implemented;
`new_session/switch_session/set_session_name/get_entries/get_tree/
get_last_assistant_text/open_session/abort_and_prompt/set_todos/set_event_filter/
set_fast_mode` marked `"unsupported"` (`server/provider/omp-rpc-protocol.ts:91-141`).

| OMP feature | Since | DX note + paseo-omp gap |
| --- | --- | --- |
| Reliable prompt lifecycle (`prompt_result` + `session_settled`, `isSettled/hasPendingAsyncWork`) | 18.3.1 | Covered — already emits `session.prompt_result`. Wait on `prompt_result`+`settled`, never `agent_end` alone. |
| `open_session {sessionDir}` (resume-or-create per directory) | 18.3.1 | **Gap**: marked unsupported — no directory-scoped resume; Paseo manages session files itself. |
| Queue mgmt (`queuedMessages`, `queue_update`, `remove/promote_queued_message`) | 18.4.4 | **Gap (verified absent)**: Paseo can't show/edit the pending queue. |
| `fork {entryId?}` (non-destructive try-from-here; `branch` drops leaf) | 18.4.11 | **Gap (verified absent)**: only `branch` wrapped. |
| Goal RPC (`goal get/create/resume/pause/drop`, token budget, `--goal`) | 18.4.11 | Half-gap: `goal_updated` consumed for timeline, `goal` command absent — shows goals, can't manage them. |
| Subagent `cancel/steer_subagent` | 18.4.9 | **Gap (verified absent)**: can't kill/steer one subagent. |
| `set_event_filter {messageUpdates: full/delta}` | `delta` 18.4.5 | **Gap**: always full snapshots — bandwidth loss on web-hosted timelines. |
| Steering/follow-up/interrupt mode setters | ≤18.2.0 | **Gap**: marked unsupported — can't configure queue/interrupt behavior. |
| `/effort [level]` (thinking without model switch) | 18.5.0 | **Gap**: not surfaced — natural effort-slider candidate. |
| Model presets (`/modelpreset`, Roles-view switching) | 18.4.5 / 18.6.0 | **Gap**: workspace-level preset switching missing. |
| `/fast [ultra]` priority tier + `/slow` + wrap-up allowance | 18.4.4 / 18.3.1 | **Gap**: `set_fast_mode` unsupported; slow-mode/reset-clock invisible to subscribers. |
| Cache warming (`set_cache_warming`, `cache_warming_start/end`) | 18.4.5 | **Gap (verified absent)**: 5-min-cache saver unavailable for idle-paused sessions. |
| `set_ask_dialog` (batched-question dialogs) | 18.4.9 | **Gap (verified absent)**: ask falls back to per-question prompts. |
| `set_host_uri_schemes` (custom read/write addressing) | ≤18.2.0 wire | **Gap**: no custom URI schemes. |
| GPT live voice (`live_start/stop/mute` + phase/level/transcript/end) | 18.5.1 | **Gap (verified absent)**. |
| Word completion (`predict_word` + feedback) | 18.3.3/18.4.9 | **Gap (verified absent)** — no ghost-text in composer. |
| Usage history/resets (`omp usage --history/clients`, `/usage reset`, wrap-up) | 18.2.9–18.4.4 | Likely gap [INFERENCE]: history/clients/resets not surfaced. |
| New slash commands (`/cleanse`, `/ratchet`, `/dump all`, `/vision`, `/record`+`omp play`, `/annotate`, `/review`, `/jobs full`, …) | 18.2.1–18.5.0 | Catalog consumed so names appear; dedicated UX for high-value ones missing [INFERENCE]. Note: no `/autocompact`/`/steer`/`/follow-up` slash commands exist — RPC-only verbs. |
| Protocol v2 + `rpc-wire.schema.json` + generated Python/Rust/Go clients | 18.5.1 | Covered (negotiation implemented, conformance tests exist) — adopt schema-diff per release (§5.3). |
| Breaking: `task.completionProbeMs`→bool, `solutionSpace` (was `complexity`), storage `claimSession`, `hub` deprecated, telemetry `pi.*`→`omp.*` | 18.3.0–18.5.0 | Paseo shells via RPC (no custom storage) — likely unaffected except telemetry dashboards [INFERENCE: check OTLP `pi.*` usage]. |
| Floor note: `--mode json` nonzero exit on fatal turn | 18.1.19 | Pin floor 18.1.15 lacks it — require ≥18.1.19 for headless exit-code reliance. |
| No `typedToolApprovals` key in OMP source (per-tool `tools.approval.<tool>`) | verified zero matches at 18.6 | Keep documenting the negotiated typed-approval path as-is; posture key is `tools.approvalMode`. |
| `tool_approval_request` vs wire `extension_ui_request` discrepancy | — | Open verification: confirm frame origin in `src/modes/rpc/` server source (only `wire/` read). |

### 5.2 DX quick wins (no protocol change)

- Config surface: restart-required badges on approval-mode/`settings` edits;
  "historical" label on quota pill; `toolPolicy` vs `paseoTools` vs `disallowedTools`
  explainer with the fail-closed rule stated once.
- Hub/diagnostics: run the existing `checkAvailability` classification pre-launch and
  show missing/unrunnable/incompatible distinctly (no probe-output leak).
- Composer pills: keep 15s/4s/30s polls but add stale/error states with retry
  (pills currently reconcile silently).
- Support flow: bundle `/dump all`-style transcript + `getOmpSupportReport` in one
  click (both exist; not linked).

### 5.3 Process (keep the ratchets)

- Keep the mechanical 100/50/0 scoring + "new capability starts at 0%" rule; it is
  what makes releases comparable.
- Per OMP release: diff `rpc-wire.schema.json` + CHANGELOG against
  `server/provider/omp-rpc-protocol.ts` strict schemas; additive-required/removed/
  renamed/type-change items go through the RPC-compatibility intake (issue template,
  dual-binary repro 18.1.15 + reported, no `passthrough` widening).
- Per SDK release: diff `PROVIDER_CAPABILITIES` + client `dist/*.d.ts` against README
  ledger + `TESTING.md` evidence matrix before claiming support.
- Canary floor: extend the pinned matrix past 18.2.0 deliberately (18.5.x/18.6.0 are
  candidates given RPC schema + voice + breaking storage changes); nightly
  `omp-latest`/`paseo-latest` stays advisory until pinned.

## Sources

- Repo: `paseo-omp/README.md` (capability ledger), `SUPPORT.md`, `TESTING.md`,
  `docs/configuration.md`, `docs/core-provider-issue-audit.md`, `index.server.ts`,
  `index.client.tsx`, `shared/*`, `server/provider/*`, `client/*`.
- OMP: `can1357/oh-my-pi` at v18.6.0 — `packages/coding-agent/CHANGELOG.md`
  (18.2.0→18.6.0 deltas) + `packages/agent-core/CHANGELOG.md`,
  `packages/coding-agent/src/modes/rpc/wire/{commands,state,frames}.ts`,
  `src/archive/prelude-definition.ts`, `src/tools/settings.ts`, `src/main.ts`,
  `src/slash-commands/builtin-*.ts`, `omp --help` / `omp plugin/usage/config --help`
  (v18.6.0 installed). Full report: `agent://OmpUpstreamResearch/report`.
- Paseo SDK: `@getpaseo/plugin/dist/server/provider.{d.ts,js}` (`PROVIDER_CAPABILITIES`,
  17 entries), `getpaseo/paseo` tags v0.9.2 / v0.10.0 / v0.11.0-beta.1..3 + HEAD
  (`packages/plugin/src/server/{provider,lifecycle,usage,acp}.ts`,
  `packages/plugin/src/{settings,rpc}.ts`, `packages/plugin/src/client/{contracts,ui,index,buttons}.ts`;
  deprecations in `client/contracts.ts`, nightly `playAudio` commit `42806cdb` #5976,
  usage-streaming commits `5eb4c8af`/`73d25317`). Full report:
  `agent://PaseoSdkResearch/result`.
