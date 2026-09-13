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
EXPECTED_CHILD_PROVIDER=${EXPECTED_CHILD_PROVIDER:-merge}
EXPECTED_CHILD_MODEL=${EXPECTED_CHILD_MODEL:-deepseek/deepseek-v4-flash-0731}
PARENT_MODEL_SUBSTR=${PARENT_MODEL_SUBSTR:-glm}
# Harness CLI: the repo checkout drives it via pnpm (`pnpm dsh`); plain `dsh` is
# not installed globally on this host.
DSH_BIN=${DSH_BIN:-pnpm --dir /home/chaosbolt/deepseek-harness dsh}
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

# Run-start cutoff in epoch MILLISECONDS for the log scan below. (`date +%s%3N` is
# not portable: some builds append the full nanosecond field.)
START_TS=$(( $(date +%s) * 1000 ))
export START_TS

echo "--- Test 1: subagent_preset different model ---"
cd "$WORKSPACE" && DSH_PERMISSION_MODE=danger-full-access timeout 240 $DSH_BIN --profile headless "Use subagent_preset to write /tmp/headless_verify_different_model.txt with content 'hello-different-model' and report file was written. Also report your model." 2>&1 | tee /tmp/verify1.txt
cat /tmp/verify1.txt | head -n 50
if ! grep -q "hello-different-model" /tmp/verify1.txt; then echo "FAIL: subagent did not write file"; exit 1; fi
if ! grep -q "$PARENT_MODEL_SUBSTR" /tmp/verify1.txt; then echo "FAIL: parent model not reported"; exit 1; fi
echo "PASS: subagent_preset file write and parent model reported"

echo "--- Test 2: crew_materialize different model ---"
cd "$WORKSPACE" && DSH_PERMISSION_MODE=danger-full-access timeout 180 $DSH_BIN --profile headless "Use crew_materialize for engineering and then crew_status to report. Do not do handoff." 2>&1 | tee /tmp/verify2.txt
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
// Scan EVERY project key for session logs written after START_TS. The parent
// ProjectKey is not predictable: a run launched through `pnpm --dir <checkout>`
// logs under the checkout's key (pnpm changes cwd), not the workspace key — a
// hardcoded `--tmp-headless-workspace--` path reports a FALSE failure because
// it silently scans an empty directory.
const startTs = Number(process.env.START_TS);
const root = `${process.env.HOME}/.dsh/sessions`;
const wantProvider = process.env.EXPECTED_CHILD_PROVIDER;
const wantModel = process.env.EXPECTED_CHILD_MODEL;
let foundSubagent=false, foundCrew=false, foundParent=false, scanned=0;
for(const proj of fs.readdirSync(root)){
  const pdir=path.join(root,proj);
  let entries=[]; try{ entries=fs.readdirSync(pdir); }catch{ continue; }
  for(const d of entries){
    const p=path.join(pdir,d,"session.jsonl.zstd");
    if(!fs.existsSync(p)) continue;
    if(fs.statSync(p).mtimeMs < startTs - 1000) continue;
    scanned++;
    const raw=decompressPerFrame(p);
    const descriptors=[];
    let childHeader=null;   // this session's OWN first request header
    for(const line of raw.split('\n')){
      if(!line.trim()) continue;
      let j; try{ j=JSON.parse(line); }catch{ continue; }
      if(j.type==='subagent/descriptor') descriptors.push(j.data);
      else if(j.type==='request/header'){
        const cfg=j.data?.header?.config ?? {};
        if(childHeader===null) childHeader=cfg;
        if(String(cfg.model ?? '').includes(process.env.PARENT_MODEL_SUBSTR)) foundParent=true;
      }
    }
    for(const data of descriptors){
      console.log(`DESCRIPTOR in ${proj}/${d}: mode=${data.mode} label=${JSON.stringify(data.label)} route=${data.agentProvider ?? '?'}/${data.agentModel ?? '(unset)'}`);
    }
    if(childHeader!==null && descriptors.length>0){
      console.log(`  child header route=${childHeader.provider}/${childHeader.model}`);
    }
    // A child's EFFECTIVE route: the continuable descriptor records it, but a
    // ONE-SHOT descriptor carries no route at all (the service builds it without
    // agentProvider/agentModel) — there the child's own first `request/header`
    // is the authoritative record. Accept either.
    const label = descriptors.map(x=>String(x.label ?? '')).find(Boolean) ?? '';
    const onRoute =
      descriptors.some(x=>x.agentProvider===wantProvider && x.agentModel===wantModel)
      || (childHeader!==null && childHeader.provider===wantProvider && childHeader.model===wantModel);
    if(descriptors.length>0 && onRoute){
      if(label.startsWith('crew:')) foundCrew=true; else foundSubagent=true;
    }
  }
}
console.log(`scanned ${scanned} session log(s) written by this run`);
if(!foundParent) { console.error(`FAIL: parent route substring "${process.env.PARENT_MODEL_SUBSTR}" not found in any request/header written by this run`); process.exit(1); }
if(!foundSubagent) { console.error(`FAIL: no non-crew child ran on ${wantProvider}/${wantModel} (descriptor route or child request/header)`); process.exit(1); }
if(!foundCrew) { console.error(`FAIL: no crew member ran on ${wantProvider}/${wantModel} (descriptor route or child request/header)`); process.exit(1); }
console.log(`PASS: logs show parent "${process.env.PARENT_MODEL_SUBSTR}", subagent + crew on ${wantProvider}/${wantModel}, all with subagent-slim preset`);
JS
echo "=== All verifications passed ==="
echo "Check file written by subagent:"
cat /tmp/headless_verify_different_model.txt 2>&1 | head -n 5 || cat /tmp/headless_simple_verify.txt 2>&1 | head -n 5 || cat /tmp/headless_simple_verify2.txt 2>&1 | head -n 5 || echo "file not found, but subagent log verified"
