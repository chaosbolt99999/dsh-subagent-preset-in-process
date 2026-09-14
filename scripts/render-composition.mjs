#!/usr/bin/env node
/**
 * Print the EFFECTIVE config of this deployment's composed loader rows.
 *
 * Why this exists: a plugin's bundle patch (`cordis.patch.yml`) is composed at
 * boot, and the composed row config — not settings.yaml, not the agent presets
 * — is what a delegation tool actually passes to a child. On 2026-09-14 a
 * `find_symbol` tool was reported as "registered but never delivered", and every
 * allow/deny list in settings.yaml and in `~/.dsh/.agent-presets/` named it; the
 * one list that did not was the `tool-subagent-preset` row's `toolFilter.allow`
 * in this package's own bundle patch. This script makes that layer readable
 * without a running process.
 *
 * Usage: node scripts/render-composition.mjs [profile] [rowId ...]
 *   profile  defaults to `web`; `headless` reads that profile's bundle set.
 *   rowId    optional ids to print; with none, every row id is listed.
 *
 * Run from the DSH checkout (the script resolves @deepseek-ai/dsh-app-boot from
 * there), e.g.:
 *   cd /home/chaosbolt/deepseek-harness \
 *     && node /path/to/scripts/render-composition.mjs web tool-subagent-preset
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Load the boot helpers from the checkout the caller is standing in.
 *
 * A bare import resolves against THIS file's location, which lives in the
 * plugin package rather than the DSH workspace; fall back to the workspace
 * layout so the script works from either place.
 */
async function loadBoot() {
  try {
    return await import('@deepseek-ai/dsh-app-boot')
  } catch (error) {
    const fallback = pathToFileURL(join(process.cwd(), 'packages/boot/app-boot/lib/index.js')).href
    try {
      return await import(fallback)
    } catch {
      throw error
    }
  }
}

const {
  composeEntries,
  healProfilesModuleFallback,
  loadOptionalPatches,
  loadProfile,
} = await loadBoot()

const [, , profileName = 'web', ...wanted] = process.argv

// The install anchor is the DSH checkout's CLI package: profile discovery is
// relative to it, so running from the checkout is required.
const INSTALL_ANCHOR = join(process.cwd(), 'apps/cli/package.json')
healProfilesModuleFallback(INSTALL_ANCHOR)

const profile = loadProfile('dsh', profileName, INSTALL_ANCHOR, undefined, { userLayer: true })
const bundlePatches = profile.layers.flatMap(layer => layer.patches)
const homePatches = loadOptionalPatches('dsh', join(profile.dir, '..', '..', 'cordis.patch.yml')) ?? []

// Later entries win, exactly as the boot composition orders them:
// bundle patches, then the profile's own patch layer, then the home layer.
const rows = new Map()
for (const row of composeEntries([bundlePatches, profile.patches, homePatches, []])) {
  if (typeof row.id === 'string' && row.id !== '') rows.set(row.id, row)
}

if (wanted.length === 0) {
  console.log(`profile ${profileName}: ${rows.size} row(s)`)
  for (const id of [...rows.keys()].sort()) console.log('  ' + id)
  process.exit(0)
}

for (const id of wanted) {
  const row = rows.get(id)
  console.log(`--- ${id} ---`)
  if (row === undefined) {
    console.log('  (no such row in this composition)')
    continue
  }
  console.log('  name: ' + String(row.name))
  const config = row.config
  if (config === undefined) console.log('  config: (none)')
  else console.log('  config: ' + JSON.stringify(config, null, 2).split('\n').join('\n  '))
}
