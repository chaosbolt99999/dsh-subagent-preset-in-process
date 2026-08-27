#!/usr/bin/env node
// Summarize a DSH session log for debugging: per-event-type counts,
// tool calls with args/results (truncated), error-ish events, and
// assistant text. Usage: node summarize-session.js <session.jsonl.zstd> [--full]
import fs from 'node:fs'
import zlib from 'node:zlib'

function decompressAll(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offs = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) {
      offs.push(i)
      i += 3
    }
  }
  if (offs.length === 0) return buf
  let out = Buffer.alloc(0)
  for (let k = 0; k < offs.length; k++) {
    const chunk = buf.slice(offs[k], offs[k + 1] ?? buf.length)
    try {
      out = Buffer.concat([out, zlib.zstdDecompressSync(chunk)])
    } catch (e) {
      process.stderr.write(`frame ${k} failed: ${e.message}\n`)
    }
  }
  return out
}

const p = process.argv[2]
const full = process.argv.includes('--full')
const raw = decompressAll(fs.readFileSync(p)).toString('utf-8')
const events = raw.split('\n').filter((l) => l.trim() !== '').map((l) => {
  try { return JSON.parse(l) } catch { return { type: 'PARSE_ERROR', line: l.slice(0, 200) } }
})

const clip = (s, n = 300) => (typeof s === 'string' ? (s.length > n && !full ? s.slice(0, n) + `…(+${s.length - n})` : s) : s)
const j = (v, n) => clip(typeof v === 'string' ? v : JSON.stringify(v), n)

const counts = {}
for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1
console.log('== event counts:', JSON.stringify(counts))

for (const e of events) {
  const t = e.type ?? ''
  const d = e.data ?? {}
  if (t === 'tool/call') {
    console.log(`\n[tool/call] ${d.name ?? d.toolName} id=${d.id ?? ''}`)
    console.log('  args:', j(d.arguments ?? d.args ?? d.input))
  } else if (t === 'tool/result') {
    console.log(`[tool/result] id=${d.id ?? ''} isError=${d.isError ?? d.error !== undefined ? JSON.stringify(d).slice(0, 100) : false}`)
    console.log('  out:', j(d.content ?? d.result ?? d.output ?? d))
  } else if (/error|fail|abort|refus|denied|invalid/i.test(t)) {
    console.log(`\n[${t}]`, j(d))
  } else if (t === 'assistant/message') {
    const txt = (d.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    const tools = (d.content ?? []).filter((b) => b.type === 'tool-call').map((b) => `${b.name ?? ''}(${j(b.input ?? b.arguments, 120)})`)
    console.log(`\n[assistant] text: ${clip(txt, full ? 100000 : 500)}`)
    if (tools.length) console.log('[assistant] tool-calls:', tools.join(' | '))
  } else if (t === 'user/message') {
    console.log(`\n[user/message] ${j(d.content ?? d)}`)
  } else if (t === 'subagent/descriptor') {
    console.log(`\n[subagent/descriptor] ${j(d)}`)
  } else if (t === 'turn/end') {
    console.log(`[turn/end] ${j(d)}`)
  }
}
