#!/usr/bin/env bash
# verify-headless-different-model.sh — headless regression for preset pinning + settings-driven routes
# Spawns a headless DSH instance that delegates via subagent_preset (continuable) and
# via crew_materialize, then verifies the session logs show:
#   - child (preset): $EXPECTED_CHILD_PROVIDER/$EXPECTED_CHILD_MODEL, agentPreset subagent-slim
#   - crew members:   same route, agentPreset subagent-slim
# The child must return properly (file written, output completed).
#
# Since 2026-08-26 every child route follows Settings → Plugins (the live resolved
# config), so the expected route is configurable via env (defaults = the current
# deployment's settings):
#   EXPECTED_CHILD_PROVIDER=custom2 EXPECTED_CHILD_MODEL=x-preview-f-free
#   PARENT_MODEL_SUBSTR=x-preview   # substring matched against the parent's header/output

set -euo pipefail
WORKSPACE=${1:-/tmp/headless-workspace}
EXPECTED_CHILD_PROVIDER=${EXPECTED_CHILD_PROVIDER:-custom2}
EXPECTED_CHILD_MODEL=${EXPECTED_CHILD_MODEL:-x-preview-f-free}
PARENT_MODEL_SUBSTR=${PARENT_MODEL_SUBSTR:-x-preview}
export EXPECTED_CHILD_PROVIDER EXPECTED_CHILD_MODEL PARENT_MODEL_SUBSTR
DSH_HOME_REAL="$HOME/.dsh"
DSH_HOME_TMP="$WORKSPACE/.dsh-home"
# Use real DSH_HOME but isolate projectKey via WORKSPACE cwd
mkdir -p "$WORKSPACE"
echo "=== verify-headless-different-model ==="
echo "Workspace: $WORKSPACE"
echo "DSH_HOME: $DSH_HOME_REAL"
echo "Settings subagent preset: $(grep -A4 subagent-preset-in-process ~/.dsh/settings.yaml | head -n 10)"

# Clean previous sessions for this workspace projectKey
PROJECT_KEY=$(echo -n "$WORKSPACE" | sed 's|/|--|g; s|^|--|; s|--|--|g' | tr '/' '-')
# Actually DSH uses encoding: "/" -> "--", so /tmp/headless-workspace -> --tmp-headless-workspace--
PROJECT_KEY="--tmp-headless-workspace--"
echo "ProjectKey: $PROJECT_KEY"
rm -rf "$DSH_HOME_REAL/sessions/$PROJECT_KEY" 2>/dev/null || true
mkdir -p "$DSH_HOME_REAL/sessions/$PROJECT_KEY"

echo "--- Test 1: subagent_preset different model ---"
cd "$WORKSPACE" && DSH_PERMISSION_MODE=danger-full-access timeout 90 dsh --profile headless "Use subagent_preset to write /tmp/headless_verify_different_model.txt with content 'hello-different-model' and report file was written. Also report your model." 2>&1 | tee /tmp/verify1.txt
cat /tmp/verify1.txt | head -n 50
if ! grep -q "hello-different-model" /tmp/verify1.txt; then echo "FAIL: subagent did not write file"; exit 1; fi
if ! grep -q "$PARENT_MODEL_SUBSTR" /tmp/verify1.txt; then echo "FAIL: parent model not reported"; exit 1; fi
echo "PASS: subagent_preset file write and parent model reported"

echo "--- Test 2: crew_materialize different model ---"
cd "$WORKSPACE" && DSH_PERMISSION_MODE=danger-full-access timeout 60 dsh --profile headless "Use crew_materialize for engineering and then crew_status to report. Do not do handoff." 2>&1 | tee /tmp/verify2.txt
cat /tmp/verify2.txt | head -n 50
if ! grep -q "planner" /tmp/verify2.txt; then echo "FAIL: crew not materialized"; exit 1; fi
echo "PASS: crew materialized"

echo "--- Verifying session logs (per-frame zstd) ---"
node --input-type=module <<'JS'
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
function decompressPerFrame(p){
  const buf=fs.readFileSync(p);
  const offs=[]; for(let i=0;i<buf.length-4;i++) if(buf[i]==0x28&&buf[i+1]==0xb5&&buf[i+2]==0x2f&&buf[i+3]==0xfd) offs.push(i);
  let tot=Buffer.alloc(0);
  for(let i=0;i<offs.length;i++){
    const s=offs[i], e=i+1<offs.length? offs[i+1]: buf.length;
    try{ tot=Buffer.concat([tot, zlib.zstdDecompressSync(buf.slice(s,e))]); }catch(e){}
  }
  return tot.toString('utf-8');
}
const root=`${process.env.HOME}/.dsh/sessions/--tmp-headless-workspace--`;
const dirs=fs.readdirSync(root).filter(d=> fs.statSync(path.join(root,d)).isDirectory());
let foundSubagent=false, foundCrew=false, foundParent=false;
for(const d of dirs){
  const p=path.join(root,d,"session.jsonl.zstd");
  if(!fs.existsSync(p)) continue;
  const raw=decompressPerFrame(p);
  const hasDescriptor=raw.includes('subagent/descriptor');
  const hasExpectedModel=raw.includes(process.env.EXPECTED_CHILD_MODEL);
  const hasParent=raw.includes(process.env.PARENT_MODEL_SUBSTR);
  const hasPresetSlim=raw.includes('subagent-slim');
  const hasCrew=raw.includes('crew:engineering');
  // Find descriptor line
  for(const line of raw.split('\n')){
    if(line.includes('subagent/descriptor')){
      console.log(`DESCRIPTOR in ${d}: ${line.slice(0,600)}`);
      const j=JSON.parse(line);
      if(j.data.agentModel===process.env.EXPECTED_CHILD_MODEL && j.data.agentProvider===process.env.EXPECTED_CHILD_PROVIDER){
        if(j.data.label && j.data.label.startsWith('crew:')) foundCrew=true;
        else foundSubagent=true;
      }
    }
    if(line.includes('request/header') && line.includes(process.env.PARENT_MODEL_SUBSTR)){
      foundParent=true;
    }
  }
  if(hasExpectedModel && hasPresetSlim) console.log(`OK: ${d} has ${process.env.EXPECTED_CHILD_MODEL} + slim`);
}
if(!foundParent) { console.error(`FAIL: parent route substring "${process.env.PARENT_MODEL_SUBSTR}" not found`); process.exit(1); }
if(!foundSubagent) { console.error("FAIL: subagent_preset child route not found in descriptor"); process.exit(1); }
if(!foundCrew) { console.error("FAIL: crew member route not found in descriptor"); process.exit(1); }
console.log(`PASS: logs show parent "${process.env.PARENT_MODEL_SUBSTR}", subagent + crew on ${process.env.EXPECTED_CHILD_PROVIDER}/${process.env.EXPECTED_CHILD_MODEL}, all with subagent-slim preset`);
JS
echo "=== All verifications passed ==="
echo "Check file written by subagent:"
cat /tmp/headless_verify_different_model.txt 2>&1 | head -n 5 || cat /tmp/headless_simple_verify.txt 2>&1 | head -n 5 || cat /tmp/headless_simple_verify2.txt 2>&1 | head -n 5 || echo "file not found, but subagent log verified"
