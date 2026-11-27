/**
 * 解析性能基准（JS 侧）：与 Rust 侧吃同一份 `parse-corpus.json`。
 *
 * 关键：跑在 **worker_threads** 里，不占主线程——这正是用户要求的
 * 「使用线程或者异步操作不要影响主线程」。
 *
 * 跑法：node tests/parse-bench-js.mjs [repeat]
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/**
 * 一帧的结束偏移；-1 表示不完整。
 * @param {Buffer} buf - 数据。
 * @param {number} start - 起始偏移。
 * @returns {number} 结束偏移或 -1。
 */
function frameEnd(buf, start) {
  let o = start
  if (buf.length - o < 4) return -1
  if (buf.readUInt32LE(o) !== ZSTD_MAGIC) return -1
  o += 4
  if (o === buf.length) return -1
  const d = buf.readUInt8(o); o += 1
  if ((d & 0x18) !== 0) return -1
  const fcsFlag = d >>> 6
  const single = (d & 0x20) !== 0
  const cks = (d & 0x04) !== 0
  const dict = d & 3
  const dictBytes = dict === 3 ? 4 : dict
  const fcsBytes = fcsFlag === 0 ? (single ? 1 : 0) : 1 << fcsFlag
  const rem = (single ? 0 : 1) + dictBytes + fcsBytes
  if (buf.length - o < rem) return -1
  o += rem
  for (;;) {
    if (buf.length - o < 3) return -1
    const bh = buf.readUIntLE(o, 3); o += 3
    const last = (bh & 1) !== 0
    const type = (bh >>> 1) & 3
    const size = bh >>> 3
    if (type === 3) return -1
    const payload = type === 1 ? 1 : size
    if (buf.length - o < payload) return -1
    o += payload
    if (last) break
  }
  if (cks) {
    if (buf.length - o < 4) return -1
    o += 4
  }
  return o
}

/**
 * worker 主体：解析语料并回报耗时。
 */
function runWorker() {
  const { corpusPath } = workerData
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'))
  const t0 = performance.now()
  let frames = 0
  let headerHits = 0
  let titleHits = 0
  for (const session of corpus) {
    for (const b64 of session.frames) {
      const buf = Buffer.from(b64, 'base64')
      const end = frameEnd(buf, 0)
      const slice = end > 0 ? buf.subarray(0, end) : buf
      let text
      try {
        text = zlib.zstdDecompressSync(slice).toString('utf8')
      } catch {
        continue
      }
      frames += 1
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        if (line.includes('"id"')) headerHits += 1
        if (line.includes('session/title') && line.includes('"title"')) titleHits += 1
      }
    }
  }
  const elapsedMs = performance.now() - t0
  parentPort.postMessage({ sessions: corpus.length, frames, headerHits, titleHits, elapsedMs })
}

if (isMainThread) {
  const corpusPath = path.resolve('.scratch/parse-corpus.json')
  if (!fs.existsSync(corpusPath)) {
    console.error('缺少语料：先跑 node .scratch/_gen-corpus.mjs')
    process.exit(1)
  }
  const repeat = Number(process.argv[2] ?? 5)

  /** 跑一次 worker，返回它的结果。 */
  const once = () => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { corpusPath } })
    w.once('message', resolve)
    w.once('error', reject)
    w.once('exit', code => { if (code !== 0) reject(new Error('worker exit ' + code)) })
  })

  const runs = []
  for (let i = 0; i < repeat; i += 1) {
    const r = await once()
    runs.push({ ...r, totalMs: Math.round(r.elapsedMs * 100) / 100 })
  }
  const sorted = [...runs].map(r => r.totalMs).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  console.log(JSON.stringify({
    sessions: runs[0].sessions,
    frames: runs[0].frames,
    headerHits: runs[0].headerHits,
    titleHits: runs[0].titleHits,
    medianMs: Math.round(median * 100) / 100,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    runs: runs.map(r => r.totalMs),
  }))
} else {
  runWorker()
}
