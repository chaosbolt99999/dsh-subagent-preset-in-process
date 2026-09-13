/**
 * Build the browser client half into `lib/client.js`.
 *
 * The DSH web app loads a client plugin through `window.__ModuleLoader__`, so
 * the bundle is the esbuild CJS output of `src/client.tsx` wrapped in that
 * envelope. Two details are load-bearing and easy to lose when regenerating:
 *
 *   - `"use strict"` must sit inside the factory body (the wrapped module runs
 *     in sloppy mode otherwise);
 *   - React is an EXTERNAL, resolved by the loader as a CJS module, so the
 *     interop helper needs `isNodeMode` (`__toESM(require("react"), 1)`) or
 *     `import_react.default` is undefined at runtime.
 *
 * Usage: node scripts/build-client.mjs
 */
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ID = 'dsh-subagent-preset-in-process'

const result = await build({
  entryPoints: [path.join(root, 'src/client.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2022',
  external: ['react'],
  write: false,
  logLevel: 'warning',
  absWorkingDir: root,
})

const raw = result.outputFiles[0].text
  .replace('__toESM(require("react"))', '__toESM(require("react"), 1)')

const wrapped = 'window.__ModuleLoader__.load({ id: "' + PLUGIN_ID + '", factory: (require) => {\n'
  + '  var module = { exports: {} };\n'
  + '  var exports = module.exports;\n'
  + '"use strict";\n'
  + raw
  + '  return module.exports;\n'
  + '}});\n'

await fs.mkdir(path.join(root, 'lib'), { recursive: true })
await fs.writeFile(path.join(root, 'lib/client.js'), wrapped)
console.log(`wrote lib/client.js (${wrapped.length} bytes)`)
