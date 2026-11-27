/**
 * client 半 T1 路径的**回归测试**。
 *
 * 为什么单独建这个文件（而不是并进 integration-reader.mjs）：
 * 那边通篇只 import sessions-reader.js，断言的是「索引里有 subagent、有 parentSession 字段」
 * 这类**数据前提**；而 D1/D2 这两个缺陷在 client.js 的 `child:` 表达式与 `.filter()` 里
 * ——**测试从没执行过那一行**。把两处修复同时退回缺陷版，integration-reader 依然全绿。
 *
 * 这里用「截取 + new Function」把 client.js 里那几个纯函数提出来直接调用，
 * 不启动浏览器、不依赖宿主，因此**退回缺陷版必然变红**（见文件末尾的变异自检）。
 *
 * 跑法：node tests/client-t1.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

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

const source = fs.readFileSync('lib/client.js', 'utf8')

/**
 * 从 client.js 里截出纯函数区并求值。
 *
 * 截取范围：`const WRAP_MARK` 到 `function apply(ctx)`。
 * 这一段是模块内部的纯逻辑层，不碰 window / DOM / ctx，所以可以脱离浏览器直接跑。
 *
 * @param {string} text - client.js 源码。
 * @returns {object} 提出来的函数集合。
 */
function loadLib(text) {
  const start = text.indexOf('const WRAP_MARK')
  const end = text.indexOf('function apply(ctx)')
  assert.ok(start > 0 && end > start, '找不到可截取的纯函数区（client.js 结构变了？）')
  const slice = text.slice(start, end)
  const names = ['sameSessionKey', 'indexPathCandidates', 'indexPathRow', 'sessionCandidates']
  const body = slice + '\nreturn {' + names.map(n =>
    n + ': typeof ' + n + ' === "function" ? ' + n + ' : undefined').join(', ') + '}'
  // eslint-disable-next-line no-new-func -- 这一步就是「提取纯函数直接测」的手段本身
  return new Function(body)()
}

const lib = loadLib(source)

/**
 * 造一个最小的 state 桩。
 * @returns {object} state。
 */
function makeState() {
  return {
    t: k => k,
    home: () => undefined,
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } },
  }
}

/** 固定的索引返回：覆盖「自身 / 本会话的子 / 别人的子 / 普通会话」四种。 */
const ITEMS = [
  { sessionId: 'self-uuid', label: '我自己' },
  { sessionId: 'child-1', label: '子会话', origin: 'subagent', parentSession: 'session-self-uuid' },
  { sessionId: 'other-1', label: '别人的子会话', origin: 'subagent', parentSession: 'someone-else' },
  { sessionId: 'other-2', label: '普通会话' },
]

/**
 * 把 fetch 桩成返回固定 items 的 /fast-at/api 响应。
 * @param {Array<object>} items - 要返回的条目。
 */
function stubFetch(items) {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, items }) })
}

console.log('\n# 纯函数提取')
await test('能从 client.js 提取到 4 个纯函数', () => {
  assert.equal(typeof lib.sameSessionKey, 'function', 'sameSessionKey 提取失败')
  assert.equal(typeof lib.indexPathCandidates, 'function', 'indexPathCandidates 提取失败')
  assert.equal(typeof lib.indexPathRow, 'function', 'indexPathRow 提取失败')
  assert.equal(typeof lib.sessionCandidates, 'function', 'sessionCandidates 提取失败')
})

console.log('\n# D2：必须排除当前会话自身')
stubFetch(ITEMS)
for (const selfId of ['self-uuid', 'session-self-uuid']) {
  await test('当前会话写作 ' + selfId + ' 时，「我自己」不出现在候选里', async () => {
    const out = await lib.indexPathCandidates(makeState(), { sessionId: selfId }, '', undefined)
    const names = out.map(o => o.row.name)
    assert.ok(!names.includes('我自己'), '出现了「引用我自己」：' + JSON.stringify(names))
    assert.ok(names.includes('普通会话'), '其它会话被误伤了：' + JSON.stringify(names))
  })
}

console.log('\n# D1：child 判据必须「既是 subagent，且父会话是当前会话」')
stubFetch(ITEMS)
for (const selfId of ['self-uuid', 'session-self-uuid']) {
  await test('当前会话写作 ' + selfId + ' 时，只有本会话的子进 child 组', async () => {
    const out = await lib.indexPathCandidates(makeState(), { sessionId: selfId }, '', undefined)
    const childNames = out.filter(o => o.child).map(o => o.row.name)
    assert.deepEqual(childNames, ['子会话'],
      'child 组应是且仅应是本会话的子，实际：' + JSON.stringify(childNames))
    const otherChild = out.find(o => o.row.name === '别人的子会话')
    assert.ok(otherChild !== undefined, '「别人的子会话」被整条丢掉了（应该保留但不进 child 组）')
    assert.equal(otherChild.child, false,
      '「别人的子会话」被误判为 child —— 这正是 D1 缺陷：只看 origin 不看 parentSession')
  })
}

console.log('\n# D1 变异守卫：模拟旧判据，必然失败')
await test('若把 child 判据退回 origin-only，本测试会变红（自证有效）', async () => {
  // 这段不是测产品代码，而是**证明本测试有效**：用旧判据跑一遍，必须得到错误结果。
  // 如果哪天有人把判据改回 origin-only 而测试没红，说明测试失效了。
  const oldJudge = item => item.origin === 'subagent'
  const wrong = ITEMS.filter(oldJudge).map(i => i.label)
  assert.ok(wrong.length > 1,
    '旧判据只选中 ' + wrong.length + ' 条，样本构造失效（应能暴露「别人的子会话」也被误选）')
  assert.ok(wrong.includes('别人的子会话'),
    '样本里没有「别人的子会话」，测不出 D1')
  // 新判据的正确结果里必须**不含**它
  const out = await lib.indexPathCandidates(makeState(), { sessionId: 'self-uuid' }, '', undefined)
  assert.ok(![...out.filter(o => o.child)].some(o => o.row.name === '别人的子会话'),
    '新判据仍然把别人的子会话算进 child 组')
})

console.log('\n# sameSessionKey 归一化')
await test('两种写法归一化后相等', () => {
  assert.equal(lib.sameSessionKey('session-abc'), lib.sameSessionKey('abc'))
})
await test('非字符串返回空串而不是抛错', () => {
  assert.equal(lib.sameSessionKey(undefined), '')
  assert.equal(lib.sameSessionKey(null), '')
  assert.equal(lib.sameSessionKey(123), '')
})
await test('只剥一次前缀（session-session-x → session-x，不误删）', () => {
  assert.equal(lib.sameSessionKey('session-session-x'), 'session-x')
})

console.log('\n# 回退链：索引不可用时走快照')
await test('fetch 失败 → indexPathCandidates 返回 undefined（交给 ?? 回退）', async () => {
  globalThis.fetch = async () => { throw new Error('network down') }
  const out = await lib.indexPathCandidates(makeState(), { sessionId: 'self-uuid' }, '', undefined)
  assert.equal(out, undefined)
})
await test('host 返回 ok:false → 同样返回 undefined', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, code: 'index-warming' }) })
  const out = await lib.indexPathCandidates(makeState(), { sessionId: 'self-uuid' }, '', undefined)
  assert.equal(out, undefined)
})

console.log('\n' + '-'.repeat(60))
console.log('通过 ' + pass + ' / ' + (pass + fail))
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')