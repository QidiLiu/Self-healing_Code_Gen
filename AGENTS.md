# AGENTS.md

## Commands

```bash
npm run build           # tsc → dist/
npm start               # node dist/main.js (requires build first)
npm run dev             # build + run in one step
npm run typecheck       # tsc --noEmit
npm test                # unit + integration tests (node:test via tsx)
npm run check           # typecheck + test
./verify.sh             # end-to-end against the real provider (costs ~1 cent)
npx tsx src/main.ts     # run TypeScript directly, no build
```

Requires **Node >= 24** and **opencode CLI 2.x**. If `npm install` fails on
`tree-sitter-*` with a node-gyp error, the node headers are not reachable:
`export npm_config_nodedir="$(dirname "$(dirname "$(which node)")")"`.

## Architecture

Three-role agent loop that self-heals. The loop runs in `src/loop.ts`, driving independent opencode sessions per role. State persists to disk in `state/` so the system resumes after crashes. A web dashboard runs alongside the loop by default (port 4097, bound to 127.0.0.1) to visualize progress in real time.

```
Planner (src/roles/planner.ts)   → produces contract (JSON)
Generator (src/roles/generator.ts) → writes code in workspace/
Evaluator (src/roles/evaluator.ts) → scores against contract
```

If evaluation fails: loop retries Generator (same session), or escalates to Planner (replan, fresh session), or declares stuck. Controlled by `--max-retries` (4), `--max-replans` (2), and `--max-total-iterations` as a structural cap.

## opencode SDK 2.x

The host runs **in process** (`OpenCode.create`), not as a subprocess. There is no port and no stdout parsing; `--server-port` is gone. See `doc/SDK_COMPAT.md` for the full list of behaviours that differ from SDK 1.x. The three load-bearing ones:

- Role identities live in `workspace/opencode.json` as agents. `sessions.prompt()` has no `system` field, so prompts must not be prepended with the system prompt.
- `provider.list()` / `model.list()` return empty until an integration is connected. `integration.connect.key()` triggers it but reports failure even on success, so only `model.list()` becoming non-empty is trustworthy. `location.reload()` clears it again and must never be called during startup.
- `sessions.prompt()` only enqueues. The reply comes from `message.list()` after `sessions.wait()`; failures are in `message.error`, not in a thrown exception.

## Two kinds of failure

The loop distinguishes these, and only the first consumes the code budget:

| Kind | Counters | On limit |
|------|----------|----------|
| Code failure (evaluator rejected a contract item) | `retries`, `replanCount` | replan, then `stuck` |
| Infrastructure failure (provider error, unparseable response) | `infraErrors`, `parseErrors` | retry same phase, then `stuck` |

Both are appended to `state/errors.jsonl`. A bad API key must never look like a stubborn bug.

## Import style

- ESM only (`"type": "module"` in package.json).
- Local imports use `.js` extension: `import { foo } from "./config.js"`.
- Do NOT import without extension or with `.ts` extension — it will fail at runtime.

## Build output

`tsc` compiles `src/` → `dist/`. `src/__tests__/` is excluded from the build. `dist/`, `state/`, `workspace/`, `output/` are gitignored.

## Runtime config

- Default model: `deepseek/deepseek-flash` (`provider/model`).
- Credentials come from opencode's shared SQLite database (`~/.local/share/opencode/opencode.db`, override with `OPENCODE_DB_PATH`), so `opencode auth login` is enough and the project never holds the secret.
- Fallback key resolution: `--api-key` → `--api-key-env` → `meta/config.ini [model] api_key` → `<PROVIDER>_API_KEY` env → `doc/DEEPSEEK_KEY.md`. The env var name is derived from the model's provider.
- Requirements: `requirements/current.md`, ≥ 20 chars. `---` on its own line separates blocks, because reply instructions edit blocks.
- Unknown CLI flags exit 1 rather than being ignored.
- `AGENT_TRACE=1` writes raw agent activity to `state/trace.md`.

## Key source files

| File | Role |
|------|------|
| `src/main.ts` | Entry point, CLI args, orchestration, exit codes, awaited shutdown |
| `src/loop.ts` | Core loop state machine + `decideNextPhase` + failure classification |
| `src/config.ts` | Loads/validates AgentConfig, resolves the API key |
| `src/opencode.ts` | SDK 2.x wrapper: host lifecycle, hydration, sessions, prompts, preflight |
| `src/trace.ts` | Optional raw agent trace sink |
| `src/dashboard.ts` | Web dashboard (127.0.0.1 only), path-traversal safe |
| `src/json-parser.ts` | Robust LLM JSON extraction with 6 fallback strategies |
| `src/reply.ts` | Reply instruction parsing, block-level apply, file wait |
| `src/requirements.ts` | Requirements validation and `---` block splitting |
| `src/state.ts` | Checkpoint/contract/eval/log/usage persistence |
| `src/reporter.ts` | Progress printing and report generation |
| `src/types.ts` | Shared types, `RoleSpec` |

## Design constraints

- Roles communicate through files on disk (`state/contract.json`, `state/evaluation.json`), not through in-memory context.
- Generator is forbidden from evaluating its own code; Evaluator assumes code is broken and must prove otherwise.
- Evaluator self-reported counts are never trusted: `normalizeEvaluation` derives counts from the failure list and the contract, and overrides `allPass`.
- Checkpoint restores contract and evaluation alongside the phase, so a crash during `fixing` resumes rather than replans. Session ids are not persisted across processes: v2 sessions live inside one host.
- Reply instructions edit the requirements file at block granularity and are transactional: the whole batch is computed and validated before a single write.
- Provider errors are surfaced as typed errors (`OpencodeRequestError`, `ProviderError`, `EmptyResponseError`) and never reported as evaluation failures.
- A provider preflight runs before the loop: catalog hydrated, provider present, model id exists.
- Host shutdown is awaited and bounded. Exiting while native modules (node:sqlite, tree-sitter) are still tearing down crashes intermittently with SIGSEGV.
