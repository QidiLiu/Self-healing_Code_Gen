# AGENTS.md

## Commands

```bash
npm run build           # tsc → dist/
npm start               # node dist/main.js (requires build first)
npm run dev             # build + run in one step
npm run typecheck       # tsc --noEmit
npm test                # unit + integration tests (node:test via tsx)
npm run check           # typecheck + test
npx tsx src/main.ts     # run TypeScript directly, no build
```

## Architecture

Three-role agent loop that self-heals. The loop runs in `src/loop.ts`, driving independent opencode sessions per role. State persists to disk in `state/` so the system resumes after crashes. A web dashboard runs alongside the loop by default (port 4097) to visualize progress in real time.

```
Planner (src/roles/planner.ts)   → produces contract (JSON)
Generator (src/roles/generator.ts) → writes code in workspace/
Evaluator (src/roles/evaluator.ts) → scores against contract
```

If evaluation fails: loop retries Generator (same session), or escalates to Planner (replan), or declares stuck. Controlled by `--max-retries` (default 4), `--max-replans` (default 2), and `--max-total-iterations`.

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

`tsc` compiles `src/` → `dist/`. The `dist/` directory contains `.js`, `.d.ts`, `.js.map`, `.d.ts.map` files. `dist/`, `state/`, `workspace/`, `output/`, and `src/__tests__/` are excluded from the build. `dist/`, `state/`, `workspace/`, `output/` are gitignored.

## Runtime config

- Default model: `deepseek/deepseek-v4-pro` (`provider/model` format).
- API key resolution order: `--api-key` → `--api-key-env` → `meta/config.ini [model] api_key` → `<PROVIDER>_API_KEY` env → `doc/DEEPSEEK_KEY.md`. `loadConfig` throws if `main.ts` cannot use the result; startup exits 1.
- Requirements file: `requirements/current.md` by default. Must be ≥ 20 chars or main.ts rejects it.
- Dashboard: starts automatically on port 4097 (`--serve-port` to change). Binds `127.0.0.1` only. HTML lives at `dashboard/index.html`.
- Doc principles (`doc/CODING_PRINCIPLES.md`, `doc/LOOP_PRINCIPLES.md`) are read at runtime and injected into role system prompts. They are not compiled or imported. Resolution is against `config.rootDir`, not `process.cwd()`, and results are cached.
- Unknown or malformed CLI flags cause exit 1 rather than being silently ignored.

## Key source files

| File | Role |
|------|------|
| `src/main.ts` | Entry point, CLI args, orchestration, exit codes |
| `src/loop.ts` | Core loop state machine + `decideNextPhase` |
| `src/config.ts` | Loads/validates AgentConfig, resolves the API key |
| `src/opencode.ts` | opencode SDK wrapper (start, restart, sessions, prompts, preflight) |
| `src/dashboard.ts` | Web dashboard HTTP server (127.0.0.1 only, port 4097) |
| `src/json-parser.ts` | Robust LLM JSON extraction with 6 fallback strategies |
| `src/reply.ts` | Reply instruction parsing, block-level apply, file wait |
| `src/requirements.ts` | Requirements validation and `---` block splitting |
| `src/state.ts` | Checkpoint/contract/eval/log/usage persistence |
| `src/reporter.ts` | Progress printing and report generation |
| `src/types.ts` | All shared types (AgentPhase, Checkpoint, Contract, etc.) |

## Design constraints

- Three roles communicate through files on disk (`state/contract.json`, `state/evaluation.json`), not through in-memory context.
- Generator is forbidden from evaluating its own code; Evaluator assumes code is broken and must prove otherwise.
- Evaluator self-reported counts are never trusted: `normalizeEvaluation` derives counts from the failure list and the contract, and overrides `allPass`.
- Checkpoint (`state/checkpoint.json`) tracks phase, session IDs, retry/replan counts, and the iteration/infra/parse counters. On restart the loop restores contract and evaluation from disk so a crash during `fixing` resumes rather than replans.
- Reply instructions edit the requirements file at block granularity and are transactional: the whole batch is computed and validated before a single write.
- API calls (`sendPrompt`, `createSession`) include exponential-backoff retry with jitter, and retry only transient errors. Provider errors are surfaced as typed errors, never as evaluation failures.
- A provider preflight runs before the loop: provider loaded, key resolved, model id exists.
