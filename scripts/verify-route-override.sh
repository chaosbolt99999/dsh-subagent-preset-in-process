#!/usr/bin/env bash
# verify-route-override.sh — live headless proof of the REQUEST-LEVEL route override.
#
# Boots a real headless DSH with a `--patch` overlay that adds:
#   1. a second `tool-subagent` row carrying its own `agentOptions.model`
#      (the per-ROW override), and
#   2. an extra crew whose two roles differ ONLY in that one role carries
#      `agentOptions.model` (the per-ROLE override).
#
# It then decodes the per-frame zstd session logs and asserts the EFFECTIVE route
# recorded for each child:
#   - the row child runs on the OVERRIDE model, not the Settings model
#     (this is exactly what the old one-shot path silently discarded), and
#   - inside ONE crew, the pinned role runs on the OVERRIDE model while the
#     plain role still follows Settings.
#
# Usage:  bash scripts/verify-route-override.sh [workspace]
# Env:    DSH_BIN (default `pnpm --dir <checkout> dsh`), DSH_CHECKOUT,
#         OVERRIDE_MODEL (default deepseek/deepseek-v4-flash-0731),
#         SETTINGS_PROVIDER / SETTINGS_MODEL (default: read from ~/.dsh/settings.yaml),
#         TIMEOUT (default 420).

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_CHECKOUT=${DSH_CHECKOUT:-/home/chaosbolt/deepseek-harness}
DSH_BIN=${DSH_BIN:-pnpm --dir "$DSH_CHECKOUT" dsh}
DSH_HOME_REAL=${DSH_HOME:-$HOME/.dsh}
WORKSPACE=${1:-/tmp/route-override-workspace}
OVERRIDE_MODEL=${OVERRIDE_MODEL:-deepseek/deepseek-v4-flash-0731}
TIMEOUT=${TIMEOUT:-420}
CREW=override-check
MARKER=/tmp/route-override-marker.txt

# ── resolve the live Settings route (what an un-overridden child must use) ────
if [ -z "${SETTINGS_MODEL:-}" ] || [ -z "${SETTINGS_PROVIDER:-}" ]; then
  # NB: the trailing newline matters — `read` returns non-zero at EOF without
  # one, and `set -e` would abort the script before it does anything.
  read -r LIVE_PROVIDER LIVE_MODEL < <(node --input-type=module -e "
    import fs from 'node:fs';
    const YAML = (await import('$DSH_CHECKOUT/node_modules/js-yaml/index.js')).default;
    const s = YAML.load(fs.readFileSync('$DSH_HOME_REAL/settings.yaml', 'utf8'))?.['subagent-preset-in-process'] ?? {};
    process.stdout.write(String(s.provider ?? 'deepseek-official') + ' ' + String(s.model ?? 'deepseek-v4-flash') + '\n');
  ")
  SETTINGS_PROVIDER=${SETTINGS_PROVIDER:-$LIVE_PROVIDER}
  SETTINGS_MODEL=${SETTINGS_MODEL:-$LIVE_MODEL}
fi
echo "resolved Settings route: ${SETTINGS_PROVIDER} / ${SETTINGS_MODEL}"

echo "=== verify-route-override ==="
echo "checkout          : $DSH_CHECKOUT"
echo "plugin            : $PLUGIN_DIR"
echo "workspace         : $WORKSPACE"
echo "Settings route    : $SETTINGS_PROVIDER / $SETTINGS_MODEL   (un-overridden children)"
echo "Override route    : $SETTINGS_PROVIDER / $OVERRIDE_MODEL   (agentOptions.model on a row / role)"

if [ "$OVERRIDE_MODEL" = "$SETTINGS_MODEL" ]; then
  echo "FAIL: OVERRIDE_MODEL and SETTINGS_MODEL are identical — the test cannot distinguish them" >&2
  exit 2
fi

mkdir -p "$WORKSPACE"
PATCH="$WORKSPACE/route-override.patch.yml"
rm -f "$MARKER"

cat > "$PATCH" <<YAML
# Verification overlay (applied after the profile layer): the per-row and
# per-role request-level route overrides under test.
- insert:
    # 1. per-ROW override: every child of this tool pins its own model.
    - id: tool-subagent-pinned
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: preset
        toolName: subagent_pinned
        agentOptions:
          model: $OVERRIDE_MODEL

# 2. per-ROLE override inside one crew: only the "pinned" role pins a model.
- id: subagent-preset-in-process
  config:
    providerName: preset
    presetId: subagent-slim
    provider: $SETTINGS_PROVIDER
    model: $SETTINGS_MODEL
    crews:
      $CREW:
        mode: routed
        roles:
          - name: pinned
            presetId: subagent-slim
            roleTask: Reply with the single word ACK.
            agentOptions:
              model: $OVERRIDE_MODEL
          - name: plain
            presetId: subagent-slim
            roleTask: Reply with the single word ACK.
YAML

echo "--- overlay ---"
cat "$PATCH"

# Run-start cutoff in epoch MILLISECONDS. NB: `date +%s%3N` is unreliable here —
# this host appends the full nanosecond field (19 digits), which silently skips
# every session file in the mtime filter below.
START_TS=$(( $(date +%s) * 1000 ))
echo "--- headless run (timeout ${TIMEOUT}s) ---"
cd "$WORKSPACE"
set +e
DSH_PERMISSION_MODE=danger-full-access timeout "$TIMEOUT" $DSH_BIN --profile headless --patch "$PATCH" \
  "Do exactly these four tool calls, then stop. (1) Call subagent_pinned once with a prompt asking it to write the file $MARKER containing exactly override-ok and report the tool result. (2) Call crew_materialize for crew $CREW. (3) Call crew_status. (4) Call crew_wait for crew $CREW. Then report what each returned." \
  > "$WORKSPACE/run.log" 2>&1
RUN_STATUS=$?
set -e
tail -30 "$WORKSPACE/run.log" || true
echo "--- headless exit status: $RUN_STATUS (0 expected; a model-side outage can still leave the durable logs assertable) ---"

echo "--- asserting the durable session logs ---"
START_TS="$START_TS" OVERRIDE_MODEL="$OVERRIDE_MODEL" SETTINGS_MODEL="$SETTINGS_MODEL" \
SETTINGS_PROVIDER="$SETTINGS_PROVIDER" CREW="$CREW" DSH_HOME_REAL="$DSH_HOME_REAL" \
node --input-type=module <<'JS'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** Concatenated zstd frames: decompress each frame separately and join. */
function decompressPerFrame(p) {
  const buf = fs.readFileSync(p)
  const offs = []
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i)
  }
  let tot = Buffer.alloc(0)
  for (let i = 0; i < offs.length; i++) {
    const s = offs[i]
    const e = i + 1 < offs.length ? offs[i + 1] : buf.length
    try { tot = Buffer.concat([tot, zlib.zstdDecompressSync(buf.slice(s, e))]) } catch {}
  }
  return tot.toString('utf-8')
}

const startTs = Number(process.env.START_TS)
const override = process.env.OVERRIDE_MODEL
const settings = process.env.SETTINGS_MODEL
const settingsProvider = process.env.SETTINGS_PROVIDER
const crew = process.env.CREW

const sessions = []
const skipped = []
const root = path.join(process.env.DSH_HOME_REAL, 'sessions')
for (const proj of fs.readdirSync(root)) {
  const pdir = path.join(root, proj)
  let entries = []
  try { entries = fs.readdirSync(pdir) } catch { continue }
  for (const d of entries) {
    const p = path.join(pdir, d, 'session.jsonl.zstd')
    if (!fs.existsSync(p)) continue
    const st = fs.statSync(p)
    if (st.mtimeMs < startTs - 1000) { skipped.push([p, st.mtimeMs]); continue }
    let raw
    try { raw = decompressPerFrame(p) } catch { continue }
    const descriptors = []
    const headers = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.type === 'subagent/descriptor') descriptors.push(e.data)
      else if (e.type === 'request/header') headers.push(e.data?.header?.config ?? {})
    }
    sessions.push({ p, descriptors, headers, bytes: raw.length })
  }
}

console.log(`scanned ${sessions.length} session log(s) written by this run (cutoff ${new Date(startTs).toISOString()})`)
if (sessions.length === 0) {
  skipped.sort((a, b) => b[1] - a[1])
  for (const [p, m] of skipped.slice(0, 3)) console.log(`  (newest skipped: ${p} @ ${new Date(m).toISOString()})`)
}
for (const s of sessions) {
  for (const d of s.descriptors) {
    console.log(`  descriptor mode=${d.mode} provider=${d.provider} label=${JSON.stringify(d.label)} route=${d.agentProvider ?? '?'}/${d.agentModel ?? '(unset)'} preset=${d.presetId ?? '-'}`)
  }
  for (const h of s.headers.slice(0, 1)) console.log(`  first request header route=${h.provider}/${h.model}`)
}

const failures = []

// ── assertion 1: the per-ROLE override inside one crew ──────────────────────
const pinnedDesc = sessions.flatMap((s) => s.descriptors).find((d) => d.label === `crew:${crew}:pinned`)
const plainDesc = sessions.flatMap((s) => s.descriptors).find((d) => d.label === `crew:${crew}:plain`)
if (pinnedDesc === undefined) failures.push(`no descriptor for crew role "${crew}:pinned" (crew not materialized?)`)
else if (pinnedDesc.agentModel !== override) {
  failures.push(`crew role "pinned" ran on ${pinnedDesc.agentModel ?? '(unset)'}, expected the role override ${override}`)
}
if (plainDesc === undefined) failures.push(`no descriptor for crew role "${crew}:plain"`)
else if (plainDesc.agentModel !== settings) {
  failures.push(`crew role "plain" ran on ${plainDesc.agentModel ?? '(unset)'}, expected the Settings route ${settings}`)
}

// ── assertion 2: the per-ROW override on a one-shot child ───────────────────
// A one-shot child's descriptor carries no route (the service builds it), so the
// authoritative record is the child's own first `request/header`. The old bug
// showed up here as the Settings model even though the row pinned another one.
const oneShot = sessions.filter((s) => s.descriptors.some((d) => d.mode === 'one-shot'))
if (oneShot.length === 0) failures.push('no one-shot child session found (subagent_pinned was not used?)')
else {
  const overridden = oneShot.find((s) => s.headers.some((h) => h.model === override))
  if (overridden === undefined) {
    const seen = oneShot.flatMap((s) => s.headers.map((h) => `${h.provider}/${h.model}`)).join(', ') || '(no request header)'
    failures.push(`the one-shot child of the pinned tool row never ran on ${override} (saw: ${seen}) — the row-level override was discarded`)
  } else {
    const cfg = overridden.headers.find((h) => h.model === override)
    if (settingsProvider !== '' && cfg.provider !== settingsProvider) {
      failures.push(`one-shot child used provider ${cfg.provider}, expected the untouched Settings provider ${settingsProvider}`)
    }
  }
}

// ── assertion 3: the pinned row child kept the untouched Settings provider ──
// (covered inside assertion 2: the row pinned only `model`, so `provider` must
// still come from Settings — that is what makes it a field-by-field override.)

if (failures.length > 0) {
  console.error('\nFAIL:')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log(`\nPASS: row-level override → ${override}; crew role override → ${override} while the un-pinned role stayed on ${settings}`)
JS

echo "--- marker file (written by the pinned row child, when the run reached a turn) ---"
if [ -f "$MARKER" ]; then cat "$MARKER"; echo; else echo "(not written — the child's turn may have been cut short by the run timeout)"; fi
echo "=== verify-route-override finished ==="
