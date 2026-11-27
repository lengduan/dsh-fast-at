/**
 * dsh-fast-at 纯函数表驱动单测。
 *
 * 为什么这样测：浏览器半的 \`lib/client.js\` 整体包在 \`window.__ModuleLoader__.load\` 里，
 * 内部函数不外露（也不该为了可测性去改代码结构）。这里按规格的做法，用正则从 client.js
 * 里**原样截取**「常量 + 纯函数」那一段源码，直接求值，测的是仓库里真正在跑的那份实现，
 * 而不是手抄的第二份副本。
 *
 * 运行：node tests/test-pure.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const CLIENT_PATH = 'lib/client.js'
const source = readFileSync(CLIENT_PATH, 'utf8')

// 截取区间：从第一个内部常量到 apply 之前。这段只包含常量声明与函数声明，是合法的独立语句序列。
const START_MARK = 'const WRAP_MARK'
const END_MARK = 'function apply(ctx)'
const start = source.indexOf(START_MARK)
const end = source.indexOf(END_MARK)
if (start < 0 || end < 0 || end <= start) {
  throw new Error('无法从 client.js 定位纯函数区间（实现结构变了？）')
}
const slice = source.slice(start, end)

// 把提取出的声明序列执行一遍，取回里面声明的函数。
const names = [
  'base64url', 'escapeLabel', 'encodeMention', 'formatFileMention', 'withLocationOf',
  'bucketOf', 'relativeTime', 'isWindowsStylePath', 'abbreviateHomePath',
  'makeCopy', 'sessionRow', 'fileRows', 'sessionCandidates', 'fetchFileItems',
  'computeCandidates', 'pruneCache', 'indexPathCandidates', 'indexPathRow', 'sameSessionKey',
]
const factory = new Function(
  slice + '\nreturn {' + names.map(name => name + ': typeof ' + name + ' === "function" ? ' + name + ' : undefined').join(', ') + '}',
)
const lib = factory()
for (const name of names) {
  if (typeof lib[name] !== 'function') throw new Error('提取失败，缺少函数：' + name)
}
// 常量也一并取出（部分断言要用）。
const constants = new Function(slice + '\nreturn { CANDIDATE_LIMIT, CHILD_LIMIT, CACHE_TTL_MS, CACHE_MAX, NON_CANDIDATE_SOURCES }')()

let passed = 0
const failures = []

/**
 * 执行一条断言并记录结果。
 * @param {string} label - 用例名。
 * @param {() => void} run - 断言体。
 */
function test(label, run) {
  try {
    run()
    passed += 1
    console.log('  ok   ' + label)
  } catch (error) {
    failures.push({ label, error })
    console.log('  FAIL ' + label + ' -> ' + error.message)
  }
}

/** 分组标题。 */
function group(title) {
  console.log('\n# ' + title)
}

// ---------------------------------------------------------------------------
group('base64url：与宿主 Buffer base64url 逐字节一致')
// ---------------------------------------------------------------------------
test('JSON.stringify("abc") 的 base64url 是 ImFiYyI（规格给定用例）', () => {
  assert.equal(lib.base64url(JSON.stringify('abc')), 'ImFiYyI')
})
test('与 Node Buffer.toString("base64url") 一致（ASCII）', () => {
  const samples = ['abc', 'session-1', 'hello world', 'a/b+c=', '']
  for (const sample of samples) {
    const text = JSON.stringify(sample)
    assert.equal(lib.base64url(text), Buffer.from(text, 'utf8').toString('base64url'), 'mismatch: ' + sample)
  }
})
test('与 Node Buffer.toString("base64url") 一致（非 ASCII / 中文 / emoji）', () => {
  const samples = ['会话-1', '中文标题🙂', 'a\u0000b']
  for (const sample of samples) {
    const text = JSON.stringify(sample)
    assert.equal(lib.base64url(text), Buffer.from(text, 'utf8').toString('base64url'), 'mismatch: ' + sample)
  }
})
test('输出字符集只有 [A-Za-z0-9_-]，且没有尾部 =', () => {
  for (const sample of ['abc', '会话', '❤️']) {
    const out = lib.base64url(JSON.stringify(sample))
    assert.match(out, /^[A-Za-z0-9_-]+$/, 'bad charset: ' + out)
  }
})

// ---------------------------------------------------------------------------
group('encodeMention：结构 + 可逆（解码端 canonical 校验）')
// ---------------------------------------------------------------------------
test('mention 形如 @[label](dsh-session:<base64url>)', () => {
  const mention = lib.encodeMention('sess-1', '标题')
  assert.match(mention, /^@\[标题\]\(dsh-session:[A-Za-z0-9_-]+\)$/)
})
test('payload 解码后精确等于 JSON.stringify(sessionId)', () => {
  for (const id of ['sess-1', '会话-1', 'a b']) {
    const mention = lib.encodeMention(id, 'L')
    const payload = mention.slice(mention.indexOf('dsh-session:') + 'dsh-session:'.length, -1)
    assert.equal(Buffer.from(payload, 'base64url').toString('utf8'), JSON.stringify(id))
  }
})
test('label 里的反斜杠与右方括号被转义', () => {
  assert.equal(lib.escapeLabel('a]b'), 'a\\]b')
  assert.equal(lib.escapeLabel('a\\b'), 'a\\\\b')
  assert.equal(lib.escapeLabel('a]\\b'), 'a\\]\\\\b')
  const mention = lib.encodeMention('s', 'x]y')
  assert.ok(mention.startsWith('@[x\\]y]('), mention)
})

// ---------------------------------------------------------------------------
group('formatFileMention：照抄 grammar.ts 的分支')
// ---------------------------------------------------------------------------
const fileMentionCases = [
  // [候选, preserveQuote, 期望, 说明]
  [{ path: 'a b.txt', kind: 'file' }, false, '@"a b.txt"', '含空白的文件：加引号并闭合'],
  [{ path: 'dir', kind: 'directory' }, false, '@dir/', '目录无条件补尾斜杠'],
  [{ path: 'dir', kind: 'directory' }, true, '@"dir/', '目录 + 保留引号：开引号不闭合'],
  [{ path: 'a.txt', kind: 'file' }, false, '@a.txt', '普通文件：不加引号'],
  [{ path: 'a.txt', kind: 'file' }, true, '@"a.txt"', '文件 + 保留引号：加引号并闭合'],
  [{ path: 'a"b', kind: 'file' }, false, undefined, '路径含双引号：丢弃该行'],
  [{ path: 'a\u007fb', kind: 'file' }, false, undefined, '路径含 DEL(0x7f)：丢弃该行'],
  [{ path: 'a\u009fb', kind: 'file' }, false, undefined, '路径含 0x9f：丢弃该行'],
  [{ path: 'a\u001fb', kind: 'file' }, false, undefined, '路径含 0x1f：丢弃该行'],
  [{ path: 'a\nb', kind: 'file' }, false, undefined, '路径含换行：丢弃该行'],
  [{ path: 'dir/sub', kind: 'directory' }, false, '@dir/sub/', '嵌套目录：补尾斜杠'],
  [{ path: 'a"b', kind: 'directory' }, true, undefined, '目录含引号：即使 preserveQuote 也丢弃'],
]
for (const [candidate, preserve, expected, note] of fileMentionCases) {
  test('formatFileMention(' + JSON.stringify(candidate) + ', ' + preserve + ') -> ' + String(expected) + '  [' + note + ']', () => {
    assert.equal(lib.formatFileMention(candidate, preserve), expected)
  })
}

// ---------------------------------------------------------------------------
group('withLocationOf：只在「drill 且 query 有 /」时为 false')
// ---------------------------------------------------------------------------
const withLocationCases = [
  ['', false, true, '未 drill：行自带位置'],
  ['', true, true, 'drilled 但 query 无斜杠：仍需位置'],
  ['dir/', false, true, '未 drill（不会有面包屑）：仍带位置'],
  ['dir/', true, false, 'drilled 且 query 有斜杠：面包屑已承载位置'],
  ['a/b', true, false, 'drilled 嵌套路径：面包屑已承载位置'],
  ['a/b', false, true, '未 drill 嵌套路径：无面包屑，行自带位置'],
]
for (const [query, drilled, expected, note] of withLocationCases) {
  test('withLocationOf(' + JSON.stringify(query) + ', ' + drilled + ') -> ' + expected + '  [' + note + ']', () => {
    assert.equal(lib.withLocationOf(query, drilled), expected)
  })
}

// ---------------------------------------------------------------------------
group('relativeTime / bucketOf：与 ui-primitives 的分桶边界一致')
// ---------------------------------------------------------------------------
const NOW = 1_700_000_000_000
const timeCases = [
  [0, { unit: 'now', n: 0 }, '刚刚'],
  [59_999, { unit: 'now', n: 0 }, '差 1ms 到 1 分钟仍是 now'],
  [60_000, { unit: 'minutes', n: 1 }, '整 1 分钟'],
  [3_599_999, { unit: 'minutes', n: 59 }, '差 1ms 到 1 小时'],
  [3_600_000, { unit: 'hours', n: 1 }, '整 1 小时'],
  [86_399_999, { unit: 'hours', n: 23 }, '差 1ms 到 1 天'],
  [86_400_000, { unit: 'days', n: 1 }, '整 1 天'],
  [30 * 86_400_000 - 1, { unit: 'days', n: 29 }, '差 1ms 到 30 天'],
  [30 * 86_400_000, { unit: 'months', n: 1 }, '整 30 天 = 1 个月'],
  [365 * 86_400_000 - 1, { unit: 'months', n: 12 }, '差 1ms 到 365 天'],
  [365 * 86_400_000, { unit: 'years', n: 1 }, '整 365 天 = 1 年'],
]
for (const [age, expected, note] of timeCases) {
  test('age=' + age + 'ms -> ' + JSON.stringify(expected) + '  [' + note + ']', () => {
    assert.deepEqual(lib.relativeTime(NOW - age, NOW), expected)
    assert.deepEqual(lib.bucketOf(NOW - age, NOW), expected)
  })
}
test('未来时间（负 age）按 0 处理，落在 now', () => {
  assert.deepEqual(lib.relativeTime(NOW + 5_000, NOW), { unit: 'now', n: 0 })
})

// ---------------------------------------------------------------------------
group('abbreviateHomePath：照抄 util-workspace-path')
// ---------------------------------------------------------------------------
test('POSIX 家目录缩成 ~', () => {
  assert.equal(lib.abbreviateHomePath('/home/u/proj', '/home/u'), '~/proj')
  assert.equal(lib.abbreviateHomePath('/home/u', '/home/u'), '~')
  assert.equal(lib.abbreviateHomePath('/other/x', '/home/u'), '/other/x')
})
test('Windows 风格路径不做缩写（与原生一致）', () => {
  assert.equal(lib.abbreviateHomePath('C:\\Users\\u\\proj', 'C:\\Users\\u'), 'C:\\Users\\u\\proj')
})
test('home 缺失时原样返回', () => {
  assert.equal(lib.abbreviateHomePath('/a/b', undefined), '/a/b')
})

// ---------------------------------------------------------------------------
group('fileRows：行结构与原生 fileCandidate 同构')
// ---------------------------------------------------------------------------
// 模拟翻译函数：带 params 时把 n 附在末尾，便于断言参数确实传下去了。
const t = (key, params) => (params === undefined || params.n === undefined ? 'T:' + key : 'T:' + key + '{n=' + params.n + '}')
test('文件行：name / icon / section / value，无 drill', () => {
  const rows = lib.fileRows([{ path: 'src/a.txt', kind: 'file' }], false, true, t)
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.name, 'a.txt')
  assert.equal(row.icon, 'file')
  assert.equal(row.section, 'T:section.files')
  assert.equal(row.drill, undefined)
  assert.equal(row.description, 'src')
  assert.equal(typeof row.value, 'string', 'value 必须是 JSON 字符串')
  assert.deepEqual(JSON.parse(row.value), { kind: 'file', fileKind: 'file', label: 'a.txt', mention: '@src/a.txt' })
  assert.equal(row.label, undefined, '文件行不设 label')
})
test('目录行：name 带尾斜杠、icon=folder、drill=true、mention 开引号', () => {
  const rows = lib.fileRows([{ path: 'a b', kind: 'directory' }], false, true, t)
  assert.equal(rows[0].name, 'a b/')
  assert.equal(rows[0].icon, 'folder')
  assert.equal(rows[0].drill, true)
  assert.equal(JSON.parse(rows[0].value).mention, '@"a b/')
})
test('withLocation 为 false 时不填 description', () => {
  const rows = lib.fileRows([{ path: 'src/a.txt', kind: 'file' }], false, false, t)
  assert.equal(rows[0].description, undefined)
})
test('工作区根条目（无父目录）不填 description', () => {
  const rows = lib.fileRows([{ path: 'a.txt', kind: 'file' }], false, true, t)
  assert.equal(rows[0].description, undefined)
})
test('无法表达的路径被整行丢弃', () => {
  const rows = lib.fileRows([{ path: 'a"b', kind: 'file' }, { path: 'ok.txt', kind: 'file' }], false, true, t)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'ok.txt')
})

// ---------------------------------------------------------------------------
group('sessionRow / sessionCandidates：会话行语义')
// ---------------------------------------------------------------------------
const NOW2 = 1_700_000_000_000
test('sessionRow：同工作区时 description 只有相对时间', () => {
  const row = lib.sessionRow({ id: 's2', cwd: '/w/a', updatedAt: NOW2 - 5 * 60_000 }, '标题', 'S', NOW2, undefined, true, t)
  assert.equal(row.name, '标题')
  assert.equal(row.icon, 'session')
  assert.equal(row.section, 'S')
  assert.equal(row.description, 'T:time.minutes{n=5}')
  assert.equal(typeof row.value, 'string')
  const value = JSON.parse(row.value)
  assert.equal(value.kind, 'session')
  assert.equal(value.label, '标题')
  assert.match(value.mention, /^@\[标题\]\(dsh-session:[A-Za-z0-9_-]+\)$/)
})
test('sessionRow：非同一工作区时 description 是「位置 · 相对时间」', () => {
  const row = lib.sessionRow({ id: 's2', cwd: '/w/b', updatedAt: NOW2 - 2 * 3_600_000 }, 'X', 'S', NOW2, undefined, false, t)
  assert.equal(row.description, '/w/b · T:time.hours{n=2}')
})
test('sessionRow：无 cwd 时用 noCwd 文案', () => {
  const row = lib.sessionRow({ id: 's2', updatedAt: NOW2 - 1000 }, 'X', 'S', NOW2, undefined, false, t)
  assert.equal(row.description, 'T:candidate.noCwd · T:time.now')
})

/**
 * 造一个最小的插件运行态（只覆盖 sessionCandidates 用到的部分）。
 * @param {{ byId: object, fileItems?: object[], fileOk?: boolean }} options - 快照与文件侧行为。
 * @returns {object} state
 */
function makeState(options) {
  // fileReferences 自 v0.4.1 起是 state 上的扁平字段（装配期已探测可用），
  // remote 只保留 $host 给 home() 用。
  const fileReferences = {
    list: async () => (options.fileOk === false ? { ok: false } : { ok: true, value: options.fileItems ?? [] }),
  }
  return {
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', ids: Object.keys(options.byId), byId: options.byId }) } },
    remote: { fileReferences, $host: { home: undefined } },
    fileReferences,
    t: key => key,
    cache: new Map(),
    home: () => undefined,
  }
}

const BY_ID = {
  self: { id: 'self', displayTitle: '我自己', cwd: '/w/a', updatedAt: NOW2, running: false, blank: false },
  other: { id: 'other', displayTitle: '别的会话', cwd: '/w/b', updatedAt: NOW2 - 1000, running: false, blank: false },
  same: { id: 'same', displayTitle: '同工作区', cwd: '/w/a', updatedAt: NOW2 - 2000, running: false, blank: false },
  child: { id: 'child', displayTitle: '子智能体一号', cwd: '/w/a', updatedAt: NOW2 - 3000, origin: 'subagent', parentId: 'self', running: false, blank: false },
  alice: { id: 'alice', displayTitle: 'Alice 搜索', cwd: '/w/c', updatedAt: NOW2 - 4000, running: false, blank: false },
}

test('sessionCandidates 排除当前会话自身', () => {
  const state = makeState({ byId: BY_ID })
  const items = lib.sessionCandidates(state, { sessionId: 'self' }, '', { byId: BY_ID })
  assert.equal(items.some(item => item.row.name === '我自己'), false)
})
test('sessionCandidates 排序：同工作区 → 无 cwd → 其它', () => {
  const byId = {
    self: BY_ID.self,
    far: { id: 'far', displayTitle: '远', cwd: '/w/z', updatedAt: NOW2 },
    none: { id: 'none', displayTitle: '无 cwd', updatedAt: NOW2 },
    near: { id: 'near', displayTitle: '近', cwd: '/w/a', updatedAt: NOW2 },
  }
  const state = makeState({ byId })
  const names = lib.sessionCandidates(state, { sessionId: 'self' }, '', { byId }).map(item => item.row.name)
  assert.deepEqual(names, ['近', '无 cwd', '远'])
})
test('sessionCandidates 子智能体标记：parentId 指向当前会话才算 child', () => {
  const state = makeState({ byId: BY_ID })
  const items = lib.sessionCandidates(state, { sessionId: 'self' }, '', { byId: BY_ID })
  const child = items.find(item => item.row.name === '子智能体一号')
  assert.equal(child.child, true)
  assert.equal(child.row.section, 'section.subagents')
  const other = items.find(item => item.row.name === '别的会话')
  assert.equal(other.child, false)
  assert.equal(other.row.section, 'section.sessions')
})
test('indexPathCandidates 按服务端 child 决定分组标题（子智能体 / 对话）', async () => {
  // 服务端已分好组并给出 child 字段；前端必须照它挂分组标题，
  // 旧实现把索引行一律标成 "对话"，「子智能体」分组凭空消失。
  const payload = {
    ok: true,
    items: [
      { sessionId: 'a', label: '子A', origin: 'subagent', parentSession: 'session-self', child: true, createdAt: 1, mtimeMs: 3, delegationDepth: 1 },
      { sessionId: 'b', label: '别的会话', origin: 'subagent', parentSession: 'session-other', child: false, createdAt: 1, mtimeMs: 2, delegationDepth: 1 },
      { sessionId: 'c', label: '对话C', createdAt: 1, mtimeMs: 1, delegationDepth: 0 },
    ],
  }
  const state = makeState({ byId: BY_ID })
  state.sessions.list.getSnapshot = () => ({ phase: 'ready', byId: BY_ID })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => payload })
  try {
    const items = await lib.indexPathCandidates(state, { sessionId: 'session-self' }, '', undefined)
    assert.equal(items.length, 3)
    const childRow = items.find(item => item.row.name === '子A')
    assert.equal(childRow.child, true)
    assert.equal(childRow.row.section, 'section.subagents')
    const otherRow = items.find(item => item.row.name === '别的会话')
    assert.equal(otherRow.child, false)
    assert.equal(otherRow.row.section, 'section.sessions')
  } finally {
    globalThis.fetch = originalFetch
  }
})
test('sessionCandidates 查询大小写不敏感，匹配标题 / id / cwd', () => {
  const state = makeState({ byId: BY_ID })
  const byTitle = lib.sessionCandidates(state, { sessionId: 'self' }, 'alice', { byId: BY_ID }).map(i => i.row.name)
  assert.deepEqual(byTitle, ['Alice 搜索'])
  const byCwd = lib.sessionCandidates(state, { sessionId: 'self' }, '/w/c', { byId: BY_ID }).map(i => i.row.name)
  assert.deepEqual(byCwd, ['Alice 搜索'])
  const byId = lib.sessionCandidates(state, { sessionId: 'self' }, 'other', { byId: BY_ID }).map(i => i.row.name)
  assert.deepEqual(byId, ['别的会话'])
})
test('sessionCandidates 按 CANDIDATE_LIMIT 截断', () => {
  const byId = { self: BY_ID.self }
  for (let i = 0; i < 80; i += 1) byId['s' + i] = { id: 's' + i, displayTitle: 't' + i, cwd: '/w/a', updatedAt: NOW2 }
  const state = makeState({ byId })
  const items = lib.sessionCandidates(state, { sessionId: 'self' }, '', { byId })
  assert.equal(items.length, constants.CANDIDATE_LIMIT)
  // 用户明确要求「每次最多返回 20 条会话」，不再与宿主 DEFAULT_CANDIDATE_LIMIT(50) 对齐。
  assert.equal(constants.CANDIDATE_LIMIT, 20)
})
test('sessionCandidates 子对话取 10 条、对话取 CANDIDATE_LIMIT 条，各自独立', () => {
  const byId = { self: BY_ID.self }
  // 30 个直接子对话 + 30 个普通会话，两组都超过各自上限
  for (let i = 0; i < 30; i += 1) {
    byId['c' + i] = { id: 'c' + i, displayTitle: 'child' + i, cwd: '/w/a', updatedAt: NOW2, origin: 'subagent', parentId: 'self' }
    byId['o' + i] = { id: 'o' + i, displayTitle: 'other' + i, cwd: '/w/a', updatedAt: NOW2 }
  }
  const state = makeState({ byId })
  const items = lib.sessionCandidates(state, { sessionId: 'self' }, '', { byId })
  const children = items.filter(item => item.child)
  const others = items.filter(item => !item.child)
  // 子对话上限 10（用户要求），对话上限 CANDIDATE_LIMIT(20)，两组互不挤占。
  // 旧实现是混合截断，子智能体会把对话挤出上限。
  assert.equal(children.length, constants.CHILD_LIMIT)
  assert.equal(others.length, constants.CANDIDATE_LIMIT)
  assert.equal(items.length, constants.CHILD_LIMIT + constants.CANDIDATE_LIMIT)
  // 子对话排在前面，且分组标题正确
  assert.ok(items.slice(0, constants.CHILD_LIMIT).every(item => item.child))
  assert.ok(children.every(item => item.row.section === 'section.subagents'))
  assert.ok(others.every(item => item.row.section === 'section.sessions'))
})

// ---------------------------------------------------------------------------
group('computeCandidates：整轮编排')
// ---------------------------------------------------------------------------
test('phase 非 ready 时返空数组（不等待、不预热）', async () => {
  const state = makeState({ byId: BY_ID })
  state.sessions.list.getSnapshot = () => ({ phase: 'pending', ids: [], byId: {} })
  assert.deepEqual(await lib.computeCandidates(state, { sessionId: 'self' }, { query: '', signal: undefined }), [])
})
test('quoted === true 时会话候选为空', async () => {
  const state = makeState({ byId: BY_ID, fileItems: [{ path: 'a b', kind: 'file' }] })
  const rows = await lib.computeCandidates(state, { sessionId: 'self' }, { query: 'a b', quoted: true, drilled: false, signal: undefined })
  assert.equal(rows.every(row => row.icon !== 'session'), true)
  assert.equal(rows.length, 1)
})
test('文件侧失败（ok=false）不影响会话行', async () => {
  const state = makeState({ byId: BY_ID, fileOk: false })
  const rows = await lib.computeCandidates(state, { sessionId: 'self' }, { query: '', quoted: false, drilled: false, signal: undefined })
  assert.ok(rows.length > 0)
  assert.equal(rows.every(row => row.icon === 'session'), true)
})
test('文件侧抛错也不影响会话行', async () => {
  const state = makeState({ byId: BY_ID })
  state.fileReferences.list = async () => { throw new Error('boom') }
  const rows = await lib.computeCandidates(state, { sessionId: 'self' }, { query: '', quoted: false, drilled: false, signal: undefined })
  assert.ok(rows.length > 0)
})
test('顺序：文件行 → 子智能体会话 → 其它会话', async () => {
  const state = makeState({
    byId: BY_ID,
    fileItems: [{ path: 'f.txt', kind: 'file' }, { path: 'd', kind: 'directory' }],
  })
  const rows = await lib.computeCandidates(state, { sessionId: 'self' }, { query: '', quoted: false, drilled: false, signal: undefined })
  const icons = rows.map(row => row.icon)
  assert.deepEqual(icons.slice(0, 2), ['file', 'folder'], '文件行在最前')
  const sections = rows.slice(2).map(row => row.section)
  const firstSessions = sections.indexOf('section.sessions')
  const lastSubagent = sections.lastIndexOf('section.subagents')
  assert.ok(lastSubagent < firstSessions, '子智能体段排在对话段之前：' + sections.join(','))
})
test('abort 之后不再提交结果', async () => {
  const controller = new AbortController()
  controller.abort()
  const state = makeState({ byId: BY_ID })
  assert.deepEqual(await lib.computeCandidates(state, { sessionId: 'self' }, { query: '', quoted: false, drilled: false, signal: controller.signal }), [])
})
test('同样的 query 命中缓存，不重复调文件接口', async () => {
  let calls = 0
  const state = makeState({ byId: BY_ID, fileItems: [{ path: 'f.txt', kind: 'file' }] })
  const original = state.fileReferences.list
  state.fileReferences.list = async (...args) => { calls += 1; return original(...args) }
  const req = { query: 'f', quoted: false, drilled: false, signal: undefined }
  await lib.computeCandidates(state, { sessionId: 'self' }, req)
  await lib.computeCandidates(state, { sessionId: 'self' }, req)
  assert.equal(calls, 1, '第二次应命中缓存')
})

// ---------------------------------------------------------------------------
group('NON_CANDIDATE_SOURCES：纯回显源豁免名单')
// ---------------------------------------------------------------------------
test('名单包含 betterSidebarQuote', () => {
  assert.ok(Array.isArray(constants.NON_CANDIDATE_SOURCES), '必须是数组')
  assert.ok(constants.NON_CANDIDATE_SOURCES.includes('betterSidebarQuote'), '缺少 betterSidebarQuote')
})
test('名单不含 reference（真正的候选源必须被包装）', () => {
  assert.equal(constants.NON_CANDIDATE_SOURCES.includes('reference'), false)
})

// ---------------------------------------------------------------------------
console.log('\n' + '-'.repeat(60))
console.log('通过 ' + passed + ' / ' + (passed + failures.length))
if (failures.length > 0) {
  console.log('失败用例：')
  for (const failure of failures) console.log('  - ' + failure.label)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
