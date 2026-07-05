# AGENTS.md

## Commands

```bash
npm run build           # tsc → dist/
npm start               # node dist/main.js (requires build first)
npm run dev             # build + run in one step
npx tsx src/main.ts     # run TypeScript directly, no build
```

No lint, test, typecheck, or formatting scripts are configured.

## Architecture

Three-role agent loop that self-heals. The loop runs in `src/loop.ts`, driving independent opencode sessions per role. State persists to disk in `state/` so the system resumes after crashes. A web dashboard runs alongside the loop by default (port 4097) to visualize progress in real time.

```
Planner (src/roles/planner.ts)   → produces contract (JSON)
Generator (src/roles/generator.ts) → writes code in workspace/
Evaluator (src/roles/evaluator.ts) → scores against contract
```

If evaluator fails: loop retries Generator (same session), or escalates to replan (new Planner run), or declares stuck. All controlled by `--max-retries` (default 4) and `--max-replans` (default 2).

## Import style

- ESM only (`"type": "module"` in package.json).
- Local imports use `.js` extension: `import { foo } from "./config.js"`.
- Do NOT import without extension or with `.ts` extension — it will fail at runtime.

## Build output

`tsc` compiles `src/` → `dist/`. The `dist/` directory contains `.js`, `.d.ts`, `.js.map`, `.d.ts.map` files. `dist/`, `state/`, `workspace/`, and `output/` are all gitignored.

## Runtime config

- Default model: `deepseek/deepseek-v4-pro` (`provider/model` format).
- API key: read from env var (e.g. `DEEPSEEK_API_KEY`), or `doc/DEEPSEEK_KEY.md`, or `--api-key` flag.
- Requirements file: `requirements/current.md` by default. Must be ≥ 20 chars or main.ts rejects it.
- Dashboard: starts automatically on port 4097 (`--serve-port` to change). HTML lives at `dashboard/index.html`.
- Doc principles (`doc/CODING_PRINCIPLES.md`, `doc/LOOP_PRINCIPLES.md`) are read at runtime and injected into role system prompts. They are not compiled or imported.

## Key source files

| File | Role |
|------|------|
| `src/main.ts` | Entry point, CLI args, orchestration |
| `src/loop.ts` | Core loop state machine |
| `src/config.ts` | Loads and validates AgentConfig |
| `src/opencode.ts` | opencode SDK wrapper (start, restart, sessions, prompts) |
| `src/dashboard.ts` | Web dashboard HTTP server (starts by default, port 4097) |
| `src/json-parser.ts` | Robust LLM JSON extraction with 8 fallback strategies |
| `src/state.ts` | Checkpoint/contract/eval/log persistence |
| `src/reporter.ts` | Progress printing and report generation |
| `src/types.ts` | All shared types (AgentPhase, Checkpoint, Contract, etc.) |

## Design constraints

- Three roles communicate through files on disk (`state/contract.json`, `state/evaluation.json`), not through in-memory context.
- Generator is forbidden from evaluating its own code; Evaluator assumes code is broken and must prove otherwise.
- Checkpoint (`state/checkpoint.json`) tracks phase, session IDs, retry/replan counts. On restart the loop resumes from the last saved phase.
- API calls (`sendPrompt`, `createSession`) include exponential-backoff retry (3 attempts, 2s base delay).
