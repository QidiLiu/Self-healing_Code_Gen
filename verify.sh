#!/usr/bin/env bash
#
# End-to-end verification against the real opencode host.
#
# Default mode is cheap: it exercises the failure paths and argument handling
# without calling a model. --full also runs the loop, which costs a few cents.
#
# Usage:
#   ./verify.sh              # fast checks only (no model calls)
#   ./verify.sh --full       # also run the loop end to end
#   KEEP=1 ./verify.sh       # keep the temp directory for inspection

set -uo pipefail

cd "$(dirname "$0")"

FULL=0
[ "${1:-}" = "--full" ] && FULL=1

PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }

section() { printf '\n=== %s ===\n' "$1"; }

# ---------------------------------------------------------------- prerequisites
section "prerequisites"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "node $(node -v)"
[ "$NODE_MAJOR" -ge 24 ] && ok "node >= 24" || bad "node $NODE_MAJOR is too old (SDK 2.x needs >= 24)"

if ! command -v opencode >/dev/null 2>&1; then
  echo "opencode CLI not found on PATH." >&2
  exit 1
fi
echo "opencode $(opencode --version 2>&1)"
opencode --version 2>&1 | grep -q " v2\." \
  && ok "opencode CLI is 2.x" \
  || bad "opencode CLI is not 2.x (SDK 2.x requires it)"

if opencode auth list 2>/dev/null | grep -q "stored"; then
  ok "a provider credential is stored"
else
  bad "no stored credential (run: opencode auth login)"
fi

[ -f dist/main.js ] && ok "dist/ is built" || bad "dist/main.js missing (run: npm run build)"

# ------------------------------------------------------------------- fixtures
D="$(mktemp -d)"
trap 'if [ "${KEEP:-0}" != "1" ]; then rm -rf "$D"; fi' EXIT

cat > "$D/good.md" <<'EOF'
A single-file HTML page that displays the sum of the first N natural numbers.

Input: an integer N between 1 and 1000.
Output: the sum, or an out-of-range message.
EOF
printf 'too short' > "$D/short.md"

read_checkpoint() {
  python3 -c "
import json,sys
try:
    d = json.load(open('$1'))
    print('%s %s %s %s %s' % (d['phase'], d['iterations'], d['retries'], d['replanCount'], d['infraErrors']))
except Exception:
    print('ERR ERR ERR ERR ERR')
" 2>/dev/null
}

run_agent() { # name, extra args...
  local name="$1"; shift
  timeout 900 node dist/main.js --once --serve-port 0 \
    --requirements "$D/$name.md" \
    --state-dir "$D/s-$name" --workspace "$D/w-$name" --output-dir "$D/o-$name" \
    "$@" > "$D/$name.log" 2>&1
  return $?
}

# Same as run_agent but always uses the valid requirements fixture, for the
# checks that are about something other than the requirements file.
run_with_good_reqs() { # name, extra args...
  local name="$1"; shift
  timeout 900 node dist/main.js --once --serve-port 0 \
    --requirements "$D/good.md" \
    --state-dir "$D/s-$name" --workspace "$D/w-$name" --output-dir "$D/o-$name" \
    "$@" > "$D/$name.log" 2>&1
  return $?
}

# ------------------------------------------------------------------- arg checks
section "CLI argument handling"

node dist/main.js --max-retry 10 >/dev/null 2>&1
[ $? -eq 1 ] && ok "unknown flag exits 1" || bad "unknown flag did not exit 1"

node dist/main.js --model >/dev/null 2>&1
[ $? -eq 1 ] && ok "flag without a value exits 1" || bad "missing value did not exit 1"

node dist/main.js --help >/dev/null 2>&1
[ $? -eq 0 ] && ok "--help exits 0" || bad "--help did not exit 0"

node dist/main.js --model notaslash >/dev/null 2>&1
[ $? -eq 1 ] && ok "malformed model exits 1" || bad "malformed model did not exit 1"

# ------------------------------------------------------------- preflight checks
section "provider preflight (no model calls)"

run_with_good_reqs noprov --model noprov/nothing
[ $? -eq 1 ] && grep -q "not available to opencode" "$D/noprov.log" \
  && ok "unknown provider fails fast with a provider list" \
  || bad "unknown provider did not fail as expected"

run_with_good_reqs badmodel --model deepseek/no-such-model-xyz
[ $? -eq 1 ] && grep -q "does not exist on provider" "$D/badmodel.log" \
  && ok "unknown model fails fast with the available models" \
  || bad "unknown model did not fail as expected"

run_agent short
[ $? -eq 1 ] && grep -q "too vague" "$D/short.log" \
  && ok "short requirements rejected" \
  || bad "short requirements not rejected"

[ ! -f "$D/s-short/usage.json" ] \
  && ok "rejection happens before any model call" \
  || bad "a model call was made despite invalid requirements"

# --------------------------------------------------------------- agent config
section "agent configuration"

if [ -f "$D/w-noprov/opencode.json" ]; then
  read -r agents sysok model perm <<< "$(python3 -c "
import json
c = json.load(open('$D/w-noprov/opencode.json'))
ids = sorted(c.get('agents', {}))
sysok = all(len(c['agents'][i].get('system','')) > 200 for i in ids)
print('%s %s %s %s' % (','.join(ids), sysok, c.get('model',''), c.get('permission',{}).get('edit','')))
")"
  [ "$agents" = "evaluator,generator,planner" ] \
    && ok "all three role agents declared ($agents)" \
    || bad "agent roles wrong: $agents"
  [ "$sysok" = "True" ] && ok "each role has a system prompt" || bad "a role has no system prompt"
  [ "$perm" = "allow" ] && ok "edit permission is allow" || bad "edit permission is $perm"
else
  bad "opencode.json was not written"
fi

# -------------------------------------------------------------------- dashboard
section "dashboard"

mkdir -p "$D/dash-ws"
echo "<h1>ok</h1>" > "$D/dash-ws/page.html"
echo "SECRET" > "$D/outside.txt"
mkdir -p "$D/dash-state"

cat > "$D/serve.mjs" <<EOF
import { startDashboard } from "$(pwd)/dist/dashboard.js"
startDashboard({
  rootDir: "$(pwd)",
  stateDir: "$D/dash-state",
  workspacePath: "$D/dash-ws",
  requirementsPath: "$D/good.md",
  model: "deepseek/deepseek-flash",
  maxRetries: 4, maxReplans: 2, maxInfraErrors: 3, maxTotalIterations: 17,
}, 4188)
setTimeout(() => process.exit(0), 20000)
EOF

node "$D/serve.mjs" > "$D/dash.log" 2>&1 &
DASH_PID=$!
sleep 3

trav=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' "http://127.0.0.1:4188/api/workspace/../outside.txt" 2>/dev/null)
enc=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' "http://127.0.0.1:4188/api/workspace/..%2f..%2fetc%2fpasswd" 2>/dev/null)
legit=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:4188/api/workspace/page.html" 2>/dev/null)

[ "$trav" = "403" ] && [ "$enc" = "403" ] \
  && ok "path traversal refused ($trav / $enc)" \
  || bad "path traversal not refused (trav=$trav enc=$enc)"
[ "$legit" = "200" ] && ok "legitimate workspace read works" || bad "legitimate read returned $legit"

if command -v ss >/dev/null 2>&1; then
  bound=$(ss -ltn 2>/dev/null | grep -c '127.0.0.1:4188')
  lan=$(ss -ltn 2>/dev/null | grep -c '0.0.0.0:4188')
  [ "$bound" -ge 1 ] && [ "$lan" -eq 0 ] \
    && ok "bound to 127.0.0.1 only" \
    || bad "bind check: loopback=$bound any=$lan"
fi
kill $DASH_PID 2>/dev/null

# ------------------------------------------------------------------ reply edits
section "reply instruction editing"

cat > "$D/blocks.md" <<'EOF'
First requirement paragraph that is definitely long enough.

---

Second paragraph mentioning CSV export as a required feature.

---

Third paragraph with more distinct content here.
EOF
cp "$D/blocks.md" "$D/blocks-work.md"

read -r delok kept dropped <<< "$(node --input-type=module -e "
import { applyReplyInstructions, parseReplyInstructions } from '$(pwd)/dist/reply.js'
import { readFileSync } from 'node:fs'
const p = '$D/blocks-work.md'
const r = applyReplyInstructions(parseReplyInstructions('删除需求: CSV'), p)
const after = readFileSync(p, 'utf-8')
console.log(r.ok, after.includes('First requirement') && after.includes('Third paragraph'), !after.includes('CSV'))
" 2>/dev/null)"

[ "$delok" = "true" ] && [ "$kept" = "true" ] && [ "$dropped" = "true" ] \
  && ok "删除需求 removes only the matching block" \
  || bad "block delete wrong (ok=$delok kept=$kept dropped=$dropped)"

read -r rej same <<< "$(node --input-type=module -e "
import { applyReplyInstructions, parseReplyInstructions } from '$(pwd)/dist/reply.js'
import { readFileSync } from 'node:fs'
const p = '$D/blocks-work.md'
const before = readFileSync(p, 'utf-8')
const r = applyReplyInstructions(parseReplyInstructions('删除需求: NOT_A_KEYWORD'), p)
console.log(r.ok === false, readFileSync(p, 'utf-8') === before)
" 2>/dev/null)"

[ "$rej" = "true" ] && [ "$same" = "true" ] \
  && ok "unknown keyword is rejected and the file is untouched" \
  || bad "unknown keyword handling wrong (rej=$rej same=$same)"

# ------------------------------------------------------------------- full run
if [ "$FULL" -eq 1 ]; then
  section "full loop ($D)"

  echo "  running with a 1-iteration budget (expects stuck, exit 1)..."
  run_with_good_reqs good --max-total-iterations 1
  code=$?
  read -r phase iters retries replans infra <<< "$(read_checkpoint "$D/s-good/checkpoint.json")"
  echo "  phase=$phase iterations=$iters retries=$retries replans=$replans infraErrors=$infra"

  [ "$phase" = "stuck" ] && [ "$iters" = "1" ] && [ "$code" = "1" ] \
    && ok "iteration budget is a hard cap (stuck at exactly 1)" \
    || bad "budget not enforced (phase=$phase iterations=$iters exit=$code)"

  [ -f "$D/o-good/report.md" ] && ok "report.md written" || bad "report.md missing"
  [ -f "$D/o-good/report.json" ] && ok "report.json written" || bad "report.json missing"
  [ -f "$D/s-good/usage.json" ] && ok "usage.json written" || bad "usage.json missing"

  requests=$(python3 -c "import json;print(json.load(open('$D/s-good/usage.json'))['requests'])" 2>/dev/null || echo 0)
  cost=$(python3 -c "import json;print(round(json.load(open('$D/s-good/usage.json'))['cost'],4))" 2>/dev/null || echo 0)
  echo "  requests=$requests cost=\$$cost"
  [ "$requests" -gt 0 ] && ok "at least one model call recorded" || bad "no model calls recorded"
  [ "$infra" = "0" ] && ok "no infrastructure failures" || bad "infraErrors=$infra"

  echo "  running with a 4-iteration budget (expects done)..."
  run_with_good_reqs good2 --max-total-iterations 4
  code=$?
  read -r phase2 iters2 retries2 replans2 infra2 <<< "$(read_checkpoint "$D/s-good2/checkpoint.json")"
  echo "  phase=$phase2 iterations=$iters2 infraErrors=$infra2"

  if [ "$infra2" != "0" ]; then
    bad "provider failed $infra2 times (phase=$phase2)"
  elif [ "$phase2" = "done" ] && [ "$code" = "0" ]; then
    ok "loop reached done with exit 0"
    [ -f "$D/w-good2/index.html" ] && ok "implementation file generated in the workspace" || bad "no implementation file"
  else
    bad "loop ended phase=$phase2 exit=$code (not a provider problem)"
  fi
else
  section "full loop"
  echo "  skipped (pass --full to run it; costs a few cents)"
fi

# ---------------------------------------------------------------------- result
section "result"
echo "pass=$PASS fail=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "verify: PASS"
else
  echo "verify: FAIL"
fi
exit "$FAIL"
