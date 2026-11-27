/**
 * host 侧会话索引读取层的集成测试。
 *
 * 验证四件在浏览器里不容易单独测的事：
 * 1. 索引能建起来，且带标题（可搜）
 * 2. query 过滤覆盖 id / cwd / 标题三种方式
 * 3. 返回结构与 SessionReferenceCandidate 契约逐字段吻合
 * 4. 坏文件 / 坏帧 / 缺目录时**不抛错**，返回 ok:false（让 client 回退快照）
 *
 * 跑法：node tests/integration-reader.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  sessionsRoot, ensureIndex, query, clearIndex, collectTargets, readHeader, readTitle,
  frameEnd, sessionFileGen, loadProjcacheTitles, cachePath, loadFromCache,
} from '../lib/sessions-reader.js'

/** 测试用缓存文件路径（与插件实际使用的同一份）。 */
const CACHE_PATH_FOR_TEST = cachePath()
let cacheBackup
let cacheBackedUp = false

/** 备份真实缓存，供需要改写缓存的用例使用。 */
function backupCache() {
  try {
    cacheBackup = fs.readFileSync(CACHE_PATH_FOR_TEST)
  } catch {
    cacheBackup = undefined
  }
  cacheBackedUp = true
}

/**
 * 还原真实缓存，避免用例之间互相污染。
 *
 * 还原后必须重建索引：只 clearIndex 会让后续用例看到 `index-warming`。
 * @returns {Promise<void>} 重建完成。
 */
async function restoreCache() {
  if (!cacheBackedUp) return
  try {
    if (cacheBackup === undefined) fs.rmSync(CACHE_PATH_FOR_TEST, { force: true })
    else fs.writeFileSync(CACHE_PATH_FOR_TEST, cacheBackup)
  } finally {
    cacheBackedUp = false
    clearIndex()
    await ensureIndex()
  }
}

let pass = 0
let fail = 0
const failures = []

/**
 * 跑一个用例。
 * @param {string} name - 用例名。
 * @param {() => Promise<void>|void} fn - 用例体。
 */
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

console.log('\n# 环境')
await test('会话根目录存在', () => {
  assert.ok(fs.existsSync(sessionsRoot()), sessionsRoot() + ' 不存在')
})
await test('collectTargets 扫到会话文件（纯 JS 目录遍历）', async () => {
  const targets = await collectTargets(sessionsRoot())
  assert.ok(targets.length > 100, '只扫到 ' + targets.length + ' 个会话文件')
  for (const t of targets) {
    assert.equal(typeof t.path, 'string')
    assert.equal(typeof t.mtimeMs, 'number')
    assert.equal(typeof t.gen, 'number')
  }
})
await test('collectTargets 按 mtime 降序', async () => {
  const targets = await collectTargets(sessionsRoot())
  for (let i = 1; i < targets.length; i += 1) {
    assert.ok(targets[i - 1].mtimeMs >= targets[i].mtimeMs,
      '第 ' + i + ' 条 mtime 比前一条大，遍历顺序不对')
  }
})

console.log('\n# 索引构建')
// 索引构建是全量扫描 + 补标题，实测 5-6s；这里给足时间。
const buildResult = await ensureIndex()
await test('ensureIndex 返回 ok:true', () => {
  assert.equal(buildResult.ok, true, JSON.stringify(buildResult).slice(0, 300))
})
await test('刚建好的索引 stale === false', () => {
  const r = query({ limit: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.stale, false, '刚建好的索引不应是 stale')
})
await test('索引覆盖全量会话（远多于展示上限）', () => {
  // 索引装的是全量 header，不是「最新 20 条」——否则搜不到老会话。
  // 用 limit=999999 探一次真实规模，断言它明显超过展示上限 20/50。
  const r = query({ limit: 999_999 })
  assert.equal(r.ok, true)
  assert.ok(r.items.length > 100, '索引只装了 ' + r.items.length + ' 条，没有覆盖全量')
})

console.log('\n# 契约：返回结构与 SessionReferenceCandidate 吻合')
const sample = query({ query: '', limit: 20, cwd: 'C:\\\\lengduan\\\\githubs\\\\my-dsh-plugins' })
await test('query 返回 ok:true', () => {
  assert.equal(sample.ok, true, JSON.stringify(sample).slice(0, 300))
})
await test('items 是数组且条数 <= limit', () => {
  assert.ok(Array.isArray(sample.items))
  assert.ok(sample.items.length <= 20, 'got ' + sample.items.length)
})
await test('每条都有必填字段 sessionId / label / createdAt / sameWorkspace', () => {
  for (const item of sample.items) {
    assert.equal(typeof item.sessionId, 'string', 'sessionId 类型错')
    assert.ok(item.sessionId !== '', 'sessionId 为空')
    assert.equal(typeof item.label, 'string', 'label 类型错')
    assert.equal(typeof item.createdAt, 'number', 'createdAt 类型错')
    assert.equal(typeof item.sameWorkspace, 'boolean', 'sameWorkspace 类型错')
  }
})
await test('按 mtime 降序（用户要求的「按文件修改时间排序」）', () => {
  const mtimes = sample.items.map(x => x.mtimeMs)
  const sorted = [...mtimes].sort((a, b) => b - a)
  assert.deepEqual(mtimes, sorted, 'mtime 不是降序: ' + JSON.stringify(mtimes))
})
await test('最新的对话大多有标题（对话全量补，子对话按需补）', () => {
  // 策略（用户 2026-11-26 定）：**对话全量补标题**，子对话只补「当前会话的」。
  // 所以不传 self 的这次查询里，子对话没有标题是**设计如此**，不能算失败；
  // 判据只对对话行成立。子对话的补标题在 query 传 self 时才发生（见下方专门用例）。
  const chats = sample.items.filter(x => x.kind !== 'child')
  assert.ok(chats.length > 0, '最新 20 条里没有对话行，无法验证')
  const titled = chats.filter(x => x.label !== x.sessionId).length
  assert.ok(titled >= chats.length * 0.7,
    '最新 20 条里的对话只有 ' + titled + '/' + chats.length + ' 条有标题（对话应当全量补）')
})
await test('sameWorkspace 与传入 cwd 一致', () => {
  const target = 'C:\\\\lengduan\\\\githubs\\\\my-dsh-plugins'
  for (const item of sample.items) {
    const expect = item.cwd === target
    assert.equal(item.sameWorkspace, expect, item.sessionId + ' sameWorkspace 不一致')
  }
})

console.log('\n# query 过滤：id / cwd / 标题')
await test('按标题能搜到（标题覆盖区内的会话可被标题检索）', () => {
  // 注意这是**有范围**的保证：只有补过标题的那些会话能按标题搜到，
  // 预算外的会话只能按 id / cwd 搜到。这是「标题只补最新 30 条」这个取舍的直接后果，
  // 测试要把边界钉住，而不是假装全量可搜。
  const first = sample.items.find(x => x.label !== x.sessionId)
  assert.ok(first !== undefined, '样本里没有带标题的条目')
  const needle = first.label.slice(0, Math.min(6, first.label.length))
  const hit = query({ query: needle, limit: 50, cwd: undefined })
  assert.equal(hit.ok, true)
  assert.ok(hit.items.some(x => x.sessionId === first.sessionId),
    '用标题片段「' + needle + '」搜不到 ' + first.sessionId)
})
await test('标题预算边界：预算外的会话可搜 id 但搜不到标题（明确取舍）', () => {
  const all = query({ limit: 999999 }).items
  const untitled = all.filter(x => x.label === x.sessionId)
  if (untitled.length === 0) {
    // 全都补到标题了，这条边界不存在，跳过即可。
    return
  }
  const target = untitled[0]
  // 按 id 片段必须能搜到
  const byId = query({ query: target.sessionId.slice(0, 8), limit: 200, cwd: undefined })
  assert.ok(byId.items.some(x => x.sessionId === target.sessionId),
    '预算外的会话连 id 都搜不到，索引覆盖有缺口')
})
await test('按 cwd 能搜到', () => {
  const withCwd = sample.items.find(x => typeof x.cwd === 'string' && x.cwd !== '')
  assert.ok(withCwd !== undefined, '样本里没有带 cwd 的条目')
  const hit = query({ query: withCwd.cwd.slice(0, 12), limit: 50, cwd: undefined })
  assert.equal(hit.ok, true)
  assert.ok(hit.items.length > 0, '按 cwd 片段搜不到任何条目')
})
await test('按 sessionId 片段能搜到', () => {
  const first = sample.items[0]
  const hit = query({ query: first.sessionId.slice(0, 8), limit: 50, cwd: undefined })
  assert.equal(hit.ok, true)
  assert.ok(hit.items.some(x => x.sessionId === first.sessionId))
})
await test('无匹配时返回空数组而不是报错', () => {
  const hit = query({ query: 'zzz-绝不可能匹配的字符串-zzz', limit: 50, cwd: undefined })
  assert.equal(hit.ok, true)
  assert.deepEqual(hit.items, [])
})


console.log('\n# T1 路径：候选行形状与分组判据（此前零覆盖）')
// 为什么不直接测 indexPathCandidates：它在 client.js 的工厂闭包里，依赖浏览器宿主
// （ctx / remote / inputTriggers）。这里改用「等价契约测试」：把会话索引经 reader.query()
// 取出来，逐条核对 client 侧构造候选行所依赖的全部数据前提。
const t1 = query({ limit: 20, cwd: 'C:\\\\lengduan\\\\githubs\\\\my-dsh-plugins' })

await test('T1 每条都能构造出合法候选行（sessionId + label 非空）', () => {
  assert.equal(t1.ok, true)
  for (const item of t1.items) {
    assert.equal(typeof item.sessionId, 'string')
    assert.ok(item.sessionId !== '', 'sessionId 为空，无法编码 mention')
    assert.equal(typeof item.label, 'string')
    assert.ok(item.label !== '', 'label 为空，候选行 name 会为空')
  }
})

await test('T1 subagent 条目带 parentSession（child 判据的前提）', () => {
  const all = query({ limit: 999999 }).items
  const subs = all.filter(x => x.origin === 'subagent')
  assert.ok(subs.length > 0, '索引里没有 subagent 条目，无法验证 D1')
  const withParent = subs.filter(x => typeof x.parentSession === 'string' && x.parentSession !== '')
  assert.ok(withParent.length > 0,
    'subagent 条目都没有 parentSession：child 判据只能退化看 origin，即 D1 缺陷')
})

await test('T1 parentSession 归一化后能对上已知 sessionId（前缀差异守卫）', () => {
  const all = query({ limit: 999999 }).items
  const ids = new Set(all.map(x => x.sessionId.replace(/^session-/u, '')))
  const subs = all.filter(x => x.origin === 'subagent' && typeof x.parentSession === 'string')
  const matched = subs.filter(x => ids.has(x.parentSession.replace(/^session-/u, '')))
  assert.ok(matched.length > 0,
    'parentSession 归一化后一个都对不上（' + subs.length + ' 个候选）——前缀差异会让 child 判据静默失配')
})

await test('T1 磁盘 id 前缀确实混合（sameSessionKey 存在的理由）', () => {
  const all = query({ limit: 999999 }).items
  const prefixed = all.filter(x => x.sessionId.startsWith('session-')).length
  const bare = all.length - prefixed
  assert.ok(bare > 0 && prefixed > 0,
    '前缀不再混合（prefixed=' + prefixed + ', bare=' + bare + '）：可简化 sameSessionKey')
})

await test('T1 索引包含大量会话（所以 client 必须自己排除当前会话）', () => {
  const all = query({ limit: 999999 }).items
  assert.ok(all.length > 100, '索引只有 ' + all.length + ' 条，无法证明「含自身」')
})

console.log('\n# 回退链')
await test('索引可用 → 返回非空 items', () => {
  const r = query({ limit: 5 })
  assert.equal(r.ok, true)
  assert.ok(r.items.length > 0)
})
await test('索引未就绪 → ok:false + index-warming（client 据此回退快照）', () => {
  clearIndex()
  const r = query({ limit: 5 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'index-warming')
})
await test('clearIndex 后重建索引仍能工作', async () => {
  const r = await ensureIndex()
  assert.equal(r.ok, true)
  const q = query({ limit: 3 })
  assert.equal(q.ok, true)
  assert.ok(q.items.length > 0)
})

console.log('\n# 阴性对照：失败路径不抛错、返回 ok:false')
await test('N1 collectTargets 对不存在的根返回空数组而不抛', async () => {
  const r = await collectTargets('C:\\definitely\\not\\here')
  assert.ok(Array.isArray(r))
  assert.deepEqual(r, [])
})
await test('N2 readHeader 对不存在的文件返回 null 而不抛', async () => {
  const r = await readHeader('C:\\definitely\\not\\here\\session.v1.jsonl.zstd')
  assert.equal(r, null)
})
await test('readTitle 对子智能体返回 subagent/descriptor 的 label（不是 fallback 标题）', async () => {
  // 子会话文件里同时有：
  //   frame 1: {"type":"subagent/descriptor","data":{"label":"真正的名字"}}
  //   frame 3: {"type":"session/title","data":{"title":"首条消息截断的备用名","source":{"kind":"fallback"}}}
  // 必须取前者，否则 @ 里的名字与界面顶部子智能体面板显示的不一致。
  const all = query({ limit: 999999 }).items
  const subs = all.filter(x => x.origin === 'subagent')
  assert.ok(subs.length > 0, '索引里没有 subagent，无法验证')
  const targets = await collectTargets(sessionsRoot())
  let checked = 0
  for (const sub of subs) {
    const bare = String(sub.sessionId).replace(/^session-/u, '')
    const tg = targets.find(t => t.path.includes(bare))
    if (tg === undefined) continue
    const title = await readTitle(tg.path)
    assert.equal(typeof title, 'string', sub.sessionId + ' 的标题应为字符串')
    assert.notEqual(title, '', sub.sessionId + ' 的标题为空')
    // 关键断言：不能是 fallback 那种「你是独立复核者。任务：复核」式的首句截断。
    // 真名不含这种「。任务：」句式；出现即说明又读回了 session/title。
    assert.ok(!title.includes('。任务：'),
      sub.sessionId + ' 取到了 fallback 标题（' + title + '），说明没优先读 subagent/descriptor.label')
    checked += 1
    if (checked >= 5) break
  }
  assert.ok(checked > 0, '没能真正校验任何子会话')
})

await test('子对话返回上限是 10，与对话的 20 各自独立', async () => {
  // 用户要求：「将子对话的返回数量限制为10条」——子对话数量通常不多，20 条太浪费。
  // 用合成数据走 loadFromCache + query，避免依赖磁盘上真实有几个子对话。
  const parent = 'session-limitprobe'
  const rows = []
  for (let i = 0; i < 15; i += 1) {
    rows.push({ id: 'kid' + i, mtimeMs: 1000 - i, kind: 'child', cwd: null, label: '子' + i, createdAt: 1, parentSession: parent, origin: 'subagent', delegationDepth: 1, path: null })
  }
  for (let i = 0; i < 15; i += 1) {
    rows.push({ id: 'chat' + i, mtimeMs: 900 - i, kind: 'chat', cwd: null, label: '对话' + i, createdAt: 1, parentSession: null, origin: null, delegationDepth: 0, path: null })
  }
  backupCache()
  try {
    fs.writeFileSync(CACHE_PATH_FOR_TEST, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    clearIndex()
    assert.equal(loadFromCache(), true)
    const r = query({ limit: 20, self: parent })
    assert.equal(r.ok, true)
    assert.equal(r.items.filter(x => x.child).length, 10, '子对话应被截断到 10 条')
    assert.equal(r.items.filter(x => !x.child).length, 15, '对话的上限是 20，15 条不该被截断')
  } finally {
    await restoreCache()
  }
})

await test('N3 readTitle 对不存在的文件返回 null 而不抛', async () => {
  const r = await readTitle('C:\\definitely\\not\\here\\session.v1.jsonl.zstd')
  assert.equal(r, null)
})
await test('N3b readHeader 对非 zstd 垃圾文件返回 null 而不抛', async () => {
  const os = await import('node:os')
  const tmp = path.join(os.tmpdir(), 'dsh-fast-at-junk-' + process.pid + '.jsonl.zstd')
  fs.writeFileSync(tmp, Buffer.from('this is not a zstd frame at all'))
  try {
    assert.equal(await readHeader(tmp), null)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
})
await test('N3c loadProjcacheTitles 对不存在的目录返回空 Map', async () => {
  const r = await loadProjcacheTitles('C:\\definitely\\not\\here')
  assert.ok(r instanceof Map)
  assert.equal(r.size, 0)
})
await test('N3d frameEnd 对垃圾数据返回 -1', () => {
  assert.equal(frameEnd(Buffer.from([0, 0, 0, 0]), 0), -1)
  assert.equal(frameEnd(Buffer.from([]), 0), -1)
  assert.equal(frameEnd(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 0), -1)
})
await test('N3e sessionFileGen 只认会话文件名', () => {
  assert.equal(sessionFileGen('session.jsonl.zstd'), 0)
  assert.equal(sessionFileGen('session.v7.jsonl.zstd'), 7)
  assert.equal(sessionFileGen('session.v.jsonl.zstd'), null)
  assert.equal(sessionFileGen('session.vX.jsonl.zstd'), null)
  assert.equal(sessionFileGen('other.v1.jsonl.zstd'), null)
  assert.equal(sessionFileGen('session.v1.jsonl'), null)
})
await test('N4 非法 limit 时 query 不抛错（回退默认值）', () => {
  const r = query({ limit: -1 })
  assert.equal(r.ok, true)
  assert.ok(r.items.length <= 20, '非法 limit 应回退为默认 20')
})
await test('N5 clearIndex 后 query 返回 index-warming 而不是抛错', () => {
  clearIndex()
  const r = query({ limit: 5 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'index-warming', '应提示索引正在构建，got ' + r.code)
})

console.log('\n' + '-'.repeat(60))
console.log('通过 ' + pass + ' / ' + (pass + fail))
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')