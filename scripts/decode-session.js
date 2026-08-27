#!/usr/bin/env node
// Decode a DSH session log (.jsonl.zstd with concatenated zstd frames) to
// stdout as plain JSONL. Usage: node decode-session.js <session.jsonl.zstd> [grepRegex]
import fs from 'node:fs'
import zlib from 'node:zlib'

function decompressAll(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offs = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (
      buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]
    ) {
      offs.push(i)
      i += 3
    }
  }
  if (offs.length === 0) return buf // already plain?
  let out = Buffer.alloc(0)
  for (let k = 0; k < offs.length; k++) {
    const chunk = buf.slice(offs[k], offs[k + 1] ?? buf.length)
    try {
      out = Buffer.concat([out, zlib.zstdDecompressSync(chunk)])
    } catch (e) {
      // tolerate a torn final frame
      process.stderr.write(`frame ${k} failed: ${e.message}\n`)
    }
  }
  return out
}

const p = process.argv[2]
const filter = process.argv[3]
const raw = decompressAll(fs.readFileSync(p)).toString('utf-8')
const lines = raw.split('\n').filter((l) => l.trim() !== '')
for (const line of lines) {
  if (!filter || new RegExp(filter).test(line)) console.log(line)
}
