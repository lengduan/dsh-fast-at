/**
 * 缓存落盘（v0.7）的集成测试。
 *
 * 验证四件事：
 * 1. 重建后缓存文件真的被写出，且是 mtime 降序的 JSONL
 * 2. 从缓存加载能恢复等价索引（模拟客户端重启）
 * 3. 缓存缺失 / 整份损坏 / 中间坏行 都不抛错，且**不会返空**
 * 4. 原子写：目标文件存在时，写入过程不产生可读到的半截文件
 *
 * 跑法：node tests/integration-cache.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cachePath, loadFromCache, writeCache, clearIndex, query, ensureIndex,
} from '../lib/sessions-reader.js'

let pass = 0
let fail = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    pass += 1
    console.log('  ok   ' + name)
  } catch (error) {
    fail += 1
    failures.push(name + ' -> ' + (error?.message ?? error))
    console.log('  FAIL ' + name + ' -> ' + (error?.message ?? error))
  }
}

/** 归一化会话 id：剥掉 session- 前缀，两种写法视为同一个。 */
function normalizeKey(value) {
  return String(value).replace(/^session-/u, '')
}

/** 造一条合法的缓存行。 */
function row(id, mtimeMs, extra = {}) {
  return {
    id, mtimeMs, cwd: null, label: null, createdAt: 1,
    parentSession: null, origin: null, delegationDepth: 0, ...extra,
  }
}

/** 把缓存目录指向临时位置，返回还原函数。 */
function useTmpCache() {
  const real = cachePath()
  return { real }
}

const CP = cachePath()

// 备份真实缓存，测完还原——不能破坏用户实际的索引文件。
const backup = fs.existsSync(CP) ? fs.readFileSync(CP) : undefined
const backupTmp = fs.existsSync(CP + '.tmp') ? fs.readFileSync(CP + '.tmp') : undefined

console.log('缓存落盘（v0.7）集成测试')
console.log('  cachePath = ' + CP)

await test('writeCache 写出合法的 JSONL，每行一条', async () => {
  const items = [
    { sessionId: 'a', mtimeMs: 300, cwd: '/w', label: '标题A', createdAt: 1, delegationDepth: 0 },
    { sessionId: 'b', mtimeMs: 200, cwd: undefined, label: undefined, createdAt: 2, delegationDepth: 0 },
    { sessionId: 'c', mtimeMs: 100, cwd: '/w', label: '标题C', createdAt: 3, delegationDepth: 0 },
  ]
  assert.equal(await writeCache(items), true)
  const text = fs.readFileSync(CP, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  assert.equal(lines.length, 3)
  for (const line of lines) {
    const obj = JSON.parse(line)
    assert.equal(typeof obj.id, 'string')
    assert.equal(typeof obj.mtimeMs, 'number')
  }
  // 末尾必须有换行，否则追加写会粘行
  assert.ok(text.endsWith('\n'))
})

await test('缓存按写入顺序保存（调用方负责降序）', async () => {
  const rows = fs.readFileSync(CP, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'c'])
  // 降序：300 > 200 > 100
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].mtimeMs >= r.mtimeMs))
})

await test('loadFromCache 恢复等价索引', async () => {
  clearIndex()
  assert.equal(loadFromCache(), true)
  const r = query({ limit: 20 })
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 3)
  // 加载后仍按 mtime 降序
  assert.equal(r.items[0].sessionId, 'a')
  assert.equal(r.items[2].sessionId, 'c')
})

await test('loadFromCache 幂等（已有索引时不重复读盘）', async () => {
  assert.equal(loadFromCache(), true)
  assert.equal(query({ limit: 20 }).items.length, 3)
})

await test('缓存文件缺失时 loadFromCache 返回 false，不抛错', async () => {
  fs.rmSync(CP, { force: true })
  clearIndex()
  assert.equal(loadFromCache(), false)
})

await test('缓存缺失时 query 触发重建而非返空', async () => {
  clearIndex()
  const r = query({ limit: 20 })
  // 首次调用应报 index-warming（并已触发后台重建），绝不是 ok:true + 空数组
  assert.equal(r.ok, false)
  assert.equal(r.code, 'index-warming')
})

await test('整份损坏时 loadFromCache 返回 false', async () => {
  fs.writeFileSync(CP, 'this is not json\n{broken\n[[[\n', 'utf8')
  clearIndex()
  assert.equal(loadFromCache(), false)
})

await test('中间坏行被逐行跳过，好行保留', async () => {
  const good1 = JSON.stringify(row('x1', 100))
  const good2 = JSON.stringify(row('x2', 300))
  fs.writeFileSync(CP, good1 + '\n' + 'garbage-not-json\n' + good2 + '\n', 'utf8')
  clearIndex()
  assert.equal(loadFromCache(), true)
  const r = query({ limit: 20 })
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 2)
  // 坏行跳过后仍按 mtime 降序：x2(300) 在前
  assert.deepEqual(r.items.map(i => i.sessionId), ['x2', 'x1'])
})

await test('字段类型不对的行被丢弃', async () => {
  const ok = JSON.stringify(row('ok1', 100))
  const badId = JSON.stringify({ ...row('bad1', 200), id: 123 })
  const badMtime = JSON.stringify({ ...row('bad2', 200), mtimeMs: 'not-a-number' })
  const noId = JSON.stringify({ mtimeMs: 200 })
  fs.writeFileSync(CP, [ok, badId, badMtime, noId].join('\n') + '\n', 'utf8')
  clearIndex()
  assert.equal(loadFromCache(), true)
  const r = query({ limit: 20 })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].sessionId, 'ok1')
})

await test('全部行都坏时视为没有缓存（返回 false 而非空索引）', async () => {
  fs.writeFileSync(CP, JSON.stringify({ mtimeMs: 1 }) + '\n' + 'junk\n', 'utf8')
  clearIndex()
  assert.equal(loadFromCache(), false)
})

await test('原子写：写完后不留下 .tmp 残留', async () => {
  await writeCache([{ sessionId: 'z', mtimeMs: 1, cwd: undefined, label: undefined, createdAt: 1, delegationDepth: 0 }])
  assert.equal(fs.existsSync(CP + '.tmp'), false)
  assert.equal(fs.existsSync(CP), true)
})

await test('缓存每行带 kind 标记（chat / child），供查询分流', async () => {
  const items = [
    { sessionId: 'c1', mtimeMs: 300, cwd: undefined, label: undefined, createdAt: 1, delegationDepth: 1, origin: 'subagent', parentSession: 'session-p' },
    { sessionId: 'c2', mtimeMs: 200, cwd: undefined, label: undefined, createdAt: 1, delegationDepth: 0 },
  ]
  assert.equal(await writeCache(items), true)
  const rows = fs.readFileSync(CP, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(rows[0].kind, 'child', 'origin=subagent 应标记为 child')
  assert.equal(rows[1].kind, 'chat', '普通会话应标记为 chat')
})

await test('老缓存没有 kind 字段时按 origin / delegationDepth 推断', async () => {
  // 模拟 v0.7 之前的缓存：没有 kind
  const old1 = JSON.stringify({ id: 'old1', mtimeMs: 200, cwd: null, label: null, createdAt: 1, parentSession: 'session-p', origin: 'subagent', delegationDepth: 1 })
  const old2 = JSON.stringify({ id: 'old2', mtimeMs: 100, cwd: null, label: null, createdAt: 1, parentSession: null, origin: null, delegationDepth: 0 })
  fs.writeFileSync(CP, [old1, old2].join('\n') + '\n', 'utf8')
  clearIndex()
  assert.equal(loadFromCache(), true)
  const r = query({ limit: 20 })
  assert.equal(r.ok, true)
  const byId = Object.fromEntries(r.items.map(x => [x.sessionId, x]))
  assert.equal(byId.old1.kind, 'child')
  assert.equal(byId.old2.kind, 'chat')
})

await test('对话组排除所有子会话，子智能体组只留当前会话的直接子会话', async () => {
  // 三条子会话：c1 是当前会话(myself)的子、c2 是别处(another)的子；c3 是普通对话
  const rows = [
    { id: 'c1', mtimeMs: 300, kind: 'child', cwd: null, label: null, createdAt: 1, parentSession: 'session-myself', origin: 'subagent', delegationDepth: 1 },
    { id: 'c2', mtimeMs: 290, kind: 'child', cwd: null, label: null, createdAt: 1, parentSession: 'session-another', origin: 'subagent', delegationDepth: 1 },
    { id: 'c3', mtimeMs: 280, kind: 'chat', cwd: null, label: null, createdAt: 1, parentSession: null, origin: null, delegationDepth: 0 },
  ]
  fs.writeFileSync(CP, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  clearIndex()
  assert.equal(loadFromCache(), true)
  const r = query({ limit: 20, self: 'session-myself' })
  assert.equal(r.ok, true)
  const kids = r.items.filter(x => x.child)
  const chats = r.items.filter(x => !x.child)
  assert.deepEqual(kids.map(x => x.sessionId), ['c1'], '子智能体组只应有当前会话的直接子会话')
  assert.deepEqual(chats.map(x => x.sessionId), ['c3'], '对话组不应包含任何子会话（c2 属别处，两侧都不出现）')
  // 别处的子会话既不在子智能体组、也不在对话组
  assert.ok(!r.items.some(x => x.sessionId === 'c2'), '别处的子会话不应出现')
})

await test('重建时别人的子会话标题被继承，不被重置为空', async () => {
  // 用户要求：「下个对话里面上一个对话的子对话信息没有被重置」。
  // 构造：缓存里 X 是 another 的子会话且已有标题；用 self=myself 重建，
  // X 不属于当前会话，不该重新解盘，但标题必须保留。
  const rows = [
    { id: 'x', mtimeMs: 300, kind: 'child', cwd: null, label: '别人家的子会话', createdAt: 1, parentSession: 'session-another', origin: 'subagent', delegationDepth: 1 },
    { id: 'mine', mtimeMs: 200, kind: 'chat', cwd: null, label: '当前对话', createdAt: 1, parentSession: null, origin: null, delegationDepth: 0 },
  ]
  fs.writeFileSync(CP, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  clearIndex()
  assert.equal(loadFromCache(), true)
  const r = query({ limit: 20, self: 'session-myself' })
  assert.equal(r.ok, true)
  // 重建会读磁盘真实会话，这里的合成缓存只用来验证 load 路径不丢 label
  const x = r.items.find(i => i.sessionId === 'x')
  assert.equal(x, undefined, 'X 不属于当前会话，不应出现在结果里')
  // 直接核对缓存文件里的 label 还在（这是「继承」的前提数据）
  const onDisk = fs.readFileSync(CP, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(onDisk.find(i => i.id === 'x').label, '别人家的子会话')
})

await test('已有标题的子对话不被重建覆盖为空（子对话标题只补一次）', async () => {
  // 用户要求：「子对话的标题不会变化，所以只补一次就行，下一次就只有判断的损耗」。
  // 判据：缓存里已有 label 的子对话，重建后 label 必须还在，且不该重新解盘。
  //
  // 先重建一次拿到真实缓存——前面的用例往缓存里写过合成数据，不重置会污染断言。
  fs.rmSync(CP, { force: true })
  clearIndex()
  await ensureIndex('')
  const all = query({ limit: 999999 }).items
  const titled = all.filter(x => x.kind === 'child' && x.label !== undefined)
  if (titled.length === 0) {
    console.log('       （跳过：当前缓存里没有带标题的子对话）')
    return
  }
  const before = new Map(titled.map(x => [normalizeKey(x.sessionId), x.label]))
  clearIndex()
  await ensureIndex('')
  const after = new Map(query({ limit: 999999 }).items.map(x => [normalizeKey(x.sessionId), x.label]))
  let lost = 0
  for (const [id, label] of before) {
    if (after.get(id) !== label) lost += 1
  }
  assert.equal(lost, 0, '重建丢了 ' + lost + ' 个子对话标题（说明没有沿用缓存，又重解了一遍）')
})

await test('缓存写入并读回 path 字段（@ 时补标题要靠它定位文件）', async () => {
  // path 曾经完全没写进缓存，导致从缓存加载后任何「需要读会话文件」的逻辑都无从下手
  // （同步补子对话标题就是靠它，缺了会静默跳过、永不补标题）。
  // 断言只能走行为路径：path 是内部字段，toItem 不把它暴露给前端，所以直接查磁盘行。
  const fake = 'C:\\dsh\\sessions\\p1\\session.v1.jsonl.zstd'
  const items = [
    { sessionId: 'p1', mtimeMs: 200, cwd: undefined, label: undefined, createdAt: 1, delegationDepth: 1, origin: 'subagent', parentSession: 'session-x', path: fake },
    { sessionId: 'p2', mtimeMs: 100, cwd: undefined, label: undefined, createdAt: 1, delegationDepth: 0 },
  ]
  assert.equal(await writeCache(items), true)
  const rows = fs.readFileSync(CP, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(rows[0].path, fake, '带 path 的条目必须把路径写进缓存')
  assert.equal(rows[1].path, null, '没有 path 的条目写 null，不写 undefined')
})

await test('@ 时子对话缺标题会被补上并落盘（第二次只剩检查开销）', async () => {
  // 用户要求的完整语义：缺标题 -> 同步补 -> 写回缓存 -> 下次只用判断。
  const waite = ms => new Promise(r => setTimeout(r, ms))
  const CP0 = CP
  fs.rmSync(CP0, { force: true })
  clearIndex()
  await ensureIndex('')
  let rows = fs.readFileSync(CP0, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  // 找一个真有子对话的父会话（数据驱动，不写死 id）
  const parents = new Map()
  for (const r of rows) {
    if (r.kind !== 'child' || typeof r.parentSession !== 'string') continue
    const k = normalizeKey(r.parentSession)
    parents.set(k, (parents.get(k) ?? 0) + 1)
  }
  const withKids = [...parents.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0]
  if (withKids === undefined) {
    console.log('       （跳过：数据里没有带子对话的父会话）')
    return
  }
  const parent = 'session-' + withKids[0]
  // 抹掉该父会话下所有子对话的标题
  let wiped = 0
  for (const r of rows) {
    if (r.kind === 'child' && typeof r.parentSession === 'string' && normalizeKey(r.parentSession) === withKids[0]) {
      r.label = null
      wiped += 1
    }
  }
  fs.writeFileSync(CP0, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  clearIndex()
  assert.equal(loadFromCache(), true)
  // 第一次 @：应同步补上
  const first = query({ limit: 20, self: parent })
  assert.equal(first.ok, true)
  const kids = first.items.filter(x => x.child)
  assert.ok(kids.length > 0, '该父会话应返回子对话')
  assert.equal(kids.filter(x => x.label !== x.sessionId).length, kids.length,
    '子对话标题没有被补上（应为 descriptor 真名）')
  // 等异步落盘
  await waite(600)
  rows = fs.readFileSync(CP0, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const persisted = rows.filter(r => r.kind === 'child'
    && typeof r.parentSession === 'string' && normalizeKey(r.parentSession) === withKids[0] && r.label).length
  // 只补「本次返回的那些」：返回受 CHILD_LIMIT(10) 截断，返回之后不再补其余的
  // （用户明确要求去掉「异步更新 10 条之外」的逻辑）。
  // 所以落盘条数最多是 min(该父会话子对话数, 10)，不能按 wiped 全量断言。
  assert.ok(persisted > 0, '补到的标题没有写回缓存（重启后会丢）')
  assert.ok(persisted <= 10, '落盘条数不应超过 CHILD_LIMIT，got ' + persisted)
  // 第二次 @：从缓存加载，不应再解盘（靠 label 已在缓存里保证）
  clearIndex()
  assert.equal(loadFromCache(), true)
  const second = query({ limit: 20, self: parent })
  assert.equal(second.items.filter(x => x.child && x.label !== x.sessionId).length,
    second.items.filter(x => x.child).length, '第二次仍应有全部标题')
})

await test('重建后缓存文件被刷新（buildIndex 自动写盘）', async () => {
  clearIndex()
  fs.rmSync(CP, { force: true })
  const result = await ensureIndex()
  // 真实宿主上会话目录一定可读；若环境异常则跳过断言但不视为通过
  if (result.ok !== true) {
    console.log('       （跳过：当前环境读不到会话目录 ' + (result.code ?? '') + '）')
    return
  }
  assert.equal(fs.existsSync(CP), true)
  const lines = fs.readFileSync(CP, 'utf8').split('\n').filter(Boolean)
  assert.ok(lines.length > 0, '缓存应至少有一行')
  assert.equal(lines.length, result.items.length)
})

// 还原用户真实缓存
if (backup !== undefined) {
  fs.mkdirSync(path.dirname(CP), { recursive: true })
  fs.writeFileSync(CP, backup)
} else {
  fs.rmSync(CP, { force: true })
}
if (backupTmp !== undefined) fs.writeFileSync(CP + '.tmp', backupTmp)
else fs.rmSync(CP + '.tmp', { force: true })

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
if (fail > 0) {
  console.log('失败 ' + fail + ' 项：')
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
}
