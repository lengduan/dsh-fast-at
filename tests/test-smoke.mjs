/**
 * 加载冒烟测试：在不带浏览器的环境里真正执行 lib/client.js，验证装配与还原。
 *
 * 用一个最小的 window.__ModuleLoader__ mock 把 factory 跑起来，然后检查：
 * 包装是否生效、是否只包 @ 源、晚注册是否兜住、失败是否返空不回落、卸载是否完全还原、
 * 版本探测不成立时是否只 warn 不抛错。这些都是不需要真实浏览器就能证伪的行为。
 *
 * 运行：node tests/test-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const SOURCE = readFileSync('lib/client.js', 'utf8')
// 注意：vm 上下文里造出的数组/对象属于另一个 realm，assert.deepEqual 会因原型不同判不等，
// 因此所有跨 realm 的结构比较统一先 JSON.stringify 归一化。

let passed = 0
const failures = []

/**
 * 跑一条断言并记录结果。
 * @param {string} label - 用例名。
 * @param {() => (void | Promise<void>)} run - 断言体。
 */
async function test(label, run) {
  try {
    await run()
    passed += 1
    console.log('  ok   ' + label)
  } catch (error) {
    const message = String(error && error.message ? error.message : error).split('\n')[0]
    failures.push({ label, message })
    console.log('  FAIL ' + label + ' -> ' + message)
  }
}

/**
 * 在隔离的 vm 上下文里加载插件，返回模块导出与观察到的副作用。
 * @param {object} options - ctx 服务与日志收集配置。
 * @returns {Promise<object>} 加载结果。
 */
async function load(options) {
  const warnings = []
  const infos = []
  let factoryResult
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          assert.equal(spec.id, 'dsh-fast-at')
          factoryResult = spec.factory()
        },
      },
    },
    console: {
      warn: (...args) => warnings.push(args.join(' ')),
      info: (...args) => infos.push(args.join(' ')),
      error: (...args) => warnings.push(args.join(' ')),
    },
    TextEncoder,
    btoa,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Map,
    Promise,
    Symbol,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    WeakMap,
    Set,
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'lib/client.js' })
  assert.ok(factoryResult !== undefined, 'factory 必须返回值（否则拿到 undefined）')
  assert.equal(typeof factoryResult.apply, 'function', 'factory 返回值要有 apply')
  const ctx = options.ctx
  const disposers = []
  ctx.effect = (fn, label) => {
    const dispose = fn()
    disposers.push({ dispose, label })
  }
  await factoryResult.apply(ctx)
  return { exports: factoryResult, ctx, warnings, infos, disposers, sandbox }
}

/**
 * 造一套最小的 ctx 依赖。
 * @param {object} options - 会话快照与文件候选配置。
 * @returns {object} ctx
 */
function makeCtx(options = {}) {
  const sources = options.sources ?? []
  const snapshot = options.snapshot ?? { phase: 'ready', ids: [], byId: {} }
  const fileValue = options.fileItems ?? []
  const sessions = {
    list: { getSnapshot: () => snapshot },
  }
  const inputTriggers = {
    live: { sources },
    registerSource(source) {
      sources.push(source)
      return () => {
        const at = sources.indexOf(source)
        if (at >= 0) sources.splice(at, 1)
      }
    },
  }
  const services = {
    sessions,
    inputTriggers,
    remote: {
      fileReferences: { list: async () => ({ ok: true, value: fileValue }) },
      $host: { home: undefined },
    },
    locale: { bind: () => key => 'L:' + key },
  }
  return {
    _services: services,
    _sources: sources,
    get(name) {
      return services[name]
    },
  }
}

/**
 * 造一个 @ 源。
 * @param {string} name - 源名。
 * @param {string} trigger - 触发字符。
 * @returns {object} 源
 */
function makeSource(name, trigger) {
  const original = async () => [{ name: 'ORIGINAL-' + name }]
  return { name, trigger, candidates: original, __original: original }
}

/**
 * 造一个「纯回显源」：candidates 恒空、onPick 恒 handled，只为渲染已插入的 chip。
 * 形态照抄 dsh-better-sidebar 的 createQuoteSource。
 * @param {string} name - 源名。
 * @returns {object} 源
 */
function makeEchoSource(name) {
  const original = () => Promise.resolve([])
  return {
    name,
    trigger: '@',
    showGroupTitle: false,
    candidates: original,
    onPick: () => 'handled',
    codec: { clipboardText: ref => ref, serialize: async ref => ref },
    __original: original,
  }
}

// ---------------------------------------------------------------------------
console.log('# 装配与包装')
// ---------------------------------------------------------------------------
await test('包装已注册的 @ 源，不调用原实现', async () => {
  const source = makeSource('reference', '@')
  const ctx = makeCtx({ sources: [source] })
  await load({ ctx })
  const rows = await source.candidates({ sessionId: 'self' }, { query: '', quoted: false, drilled: false, signal: undefined })
  assert.ok(Array.isArray(rows), 'candidates 必须返回数组')
  assert.equal(rows.some(row => row.name === 'ORIGINAL-reference'), false, '不应调用原实现')
})

await test('不硬编码源名：多个 @ 源都被包装', async () => {
  const a = makeSource('reference', '@')
  const b = makeSource('another-at', '@')
  const ctx = makeCtx({ sources: [a, b] })
  await load({ ctx })
  for (const source of [a, b]) {
    const rows = await source.candidates({ sessionId: 'self' }, { query: '', quoted: false, drilled: false, signal: undefined })
    assert.equal(rows.some(row => row.name === 'ORIGINAL-' + source.name), false, source.name + ' 未被包装')
  }
})

await test('不碰非 @ 源（/ 源保持原样）', async () => {
  const slash = makeSource('goal', '/')
  const ctx = makeCtx({ sources: [slash] })
  await load({ ctx })
  assert.equal(slash.candidates, slash.__original, '/ 源的 candidates 不应被替换')
})

await test('不碰源的其它成员（name / trigger / 其它回调）', async () => {
  const source = makeSource('reference', '@')
  source.order = 7
  source.header = () => [{ label: 'crumb' }]
  source.onPick = () => undefined
  const ctx = makeCtx({ sources: [source] })
  await load({ ctx })
  assert.equal(source.name, 'reference')
  assert.equal(source.trigger, '@')
  assert.equal(source.order, 7)
  assert.equal(typeof source.header, 'function')
  assert.equal(typeof source.onPick, 'function')
})

// ---------------------------------------------------------------------------
console.log('\n# 纯回显源豁免（NON_CANDIDATE_SOURCES）')
// ---------------------------------------------------------------------------
await test('betterSidebarQuote 不被包装（candidates 引用不变）', async () => {
  const echo = makeEchoSource('betterSidebarQuote')
  const ctx = makeCtx({ sources: [echo] })
  await load({ ctx })
  assert.equal(echo.candidates, echo.__original, '纯回显源不应被包装')
})

await test('晚注册的 betterSidebarQuote 同样不被包装', async () => {
  const ctx = makeCtx({ sources: [] })
  await load({ ctx })
  const echo = makeEchoSource('betterSidebarQuote')
  ctx._services.inputTriggers.registerSource(echo)
  assert.equal(echo.candidates, echo.__original, '晚注册的纯回显源也不应被包装')
  assert.equal(ctx._sources.includes(echo), true, '但仍应正常登记进注册表')
})

await test('同时注册 reference 与 betterSidebarQuote：只包 reference', async () => {
  const reference = makeSource('reference', '@')
  const echo = makeEchoSource('betterSidebarQuote')
  const ctx = makeCtx({ sources: [reference, echo] })
  await load({ ctx })
  assert.notEqual(reference.candidates, reference.__original, 'reference 应被包装')
  assert.equal(echo.candidates, echo.__original, 'betterSidebarQuote 不应被包装')
})

await test('纯回显源仍返回它自己的空数组（@ 菜单不会多出分组）', async () => {
  const echo = makeEchoSource('betterSidebarQuote')
  const ctx = makeCtx({ sources: [echo] })
  await load({ ctx })
  assert.equal(JSON.stringify(await echo.candidates()), '[]')
})

// ---------------------------------------------------------------------------
console.log('\n# 晚注册与还原')
// ---------------------------------------------------------------------------
await test('劫持 registerSource 兜住晚注册的 @ 源', async () => {
  const ctx = makeCtx({ sources: [] })
  await load({ ctx })
  const late = makeSource('late-at', '@')
  ctx._services.inputTriggers.registerSource(late)
  const rows = await late.candidates({ sessionId: 'self' }, { query: '', quoted: false, drilled: false, signal: undefined })
  assert.equal(rows.some(row => row.name === 'ORIGINAL-late-at'), false, '晚注册的源也应被包装')
})

await test('registerSource 仍把源登记进表（原行为保留）', async () => {
  const ctx = makeCtx({ sources: [] })
  await load({ ctx })
  const late = makeSource('late2', '@')
  const dispose = ctx._services.inputTriggers.registerSource(late)
  assert.equal(ctx._sources.includes(late), true, '源应被登记')
  assert.equal(typeof dispose, 'function', '应返回 disposer')
})

await test('注册被拒时撤回包装并重新抛错', async () => {
  const ctx = makeCtx({ sources: [] })
  ctx._services.inputTriggers.registerSource = function throwing(source) {
    throw new Error('duplicate')
  }
  await load({ ctx })
  const dup = makeSource('dup', '@')
  assert.throws(() => ctx._services.inputTriggers.registerSource(dup), /duplicate/u)
  assert.equal(dup.candidates, dup.__original, '被拒的源应还原成原实现')
})

await test('卸载后 candidates 与 registerSource 完全还原', async () => {
  const source = makeSource('reference', '@')
  const ctx = makeCtx({ sources: [source] })
  const originalRegister = ctx._services.inputTriggers.registerSource
  const loaded = await load({ ctx })
  assert.notEqual(source.candidates, source.__original, '装载后应被包装')
  assert.equal(loaded.disposers.length, 1, '应登记 1 个还原 disposer')
  loaded.disposers[0].dispose()
  assert.equal(source.candidates, source.__original, '卸载后应还原 candidates')
  assert.equal(ctx._services.inputTriggers.registerSource, originalRegister, '卸载后应还原 registerSource')
})

// ---------------------------------------------------------------------------
console.log('\n# 行为：数据源与失败策略')
// ---------------------------------------------------------------------------
await test('会话行来自客户端快照，零请求', async () => {
  const source = makeSource('reference', '@')
  let fileCalls = 0
  const snapshot = {
    phase: 'ready',
    ids: ['self', 'other'],
    byId: {
      self: { id: 'self', displayTitle: '我', cwd: '/w/a', updatedAt: Date.now() },
      other: { id: 'other', displayTitle: '别人', cwd: '/w/b', updatedAt: Date.now() },
    },
  }
  const ctx = makeCtx({ sources: [source], snapshot })
  ctx._services.remote.fileReferences.list = async () => { fileCalls += 1; return { ok: true, value: [] } }
  await load({ ctx })
  const rows = await source.candidates({ sessionId: 'self' }, { query: '', quoted: false, drilled: false, signal: undefined })
  assert.equal(JSON.stringify(rows.map(row => row.name)), JSON.stringify(['别人']), '只应出现其它会话')
  assert.equal(fileCalls, 1, '文件侧只调一次')
})

await test('phase 非 ready 时返空数组', async () => {
  const source = makeSource('reference', '@')
  const ctx = makeCtx({ sources: [source], snapshot: { phase: 'pending', ids: [], byId: {} } })
  await load({ ctx })
  assert.equal(JSON.stringify(await source.candidates({ sessionId: 'self' }, { query: '', quoted: false, drilled: false, signal: undefined })), '[]')
})

await test('文件侧 ok=false 时不回落原生，会话行照给', async () => {
  const source = makeSource('reference', '@')
  const ctx = makeCtx({
    sources: [source],
    snapshot: {
      phase: 'ready',
      ids: ['self', 'other'],
      byId: {
        self: { id: 'self', displayTitle: '我', cwd: '/w/a', updatedAt: Date.now() },
        other: { id: 'other', displayTitle: '别人', cwd: '/w/a', updatedAt: Date.now() },
      },
    },
  })
  ctx._services.remote.fileReferences.list = async () => ({ ok: false })
  await load({ ctx })
  const rows = await source.candidates({ sessionId: 'self' }, { query: '', quoted: false, drilled: false, signal: undefined })
  assert.equal(rows.some(row => row.name === 'ORIGINAL-reference'), false, '绝不回落原生')
  assert.equal(JSON.stringify(rows.map(row => row.name)), JSON.stringify(['别人']))
})

// ---------------------------------------------------------------------------
console.log('\n# 版本探测：失败只 warn 不抛错')
// ---------------------------------------------------------------------------
await test('缺少 sessions 服务时不抛错、不包装、记 warn', async () => {
  const source = makeSource('reference', '@')
  const ctx = makeCtx({ sources: [source] })
  delete ctx._services.sessions
  const loaded = await load({ ctx })
  assert.equal(source.candidates, source.__original, '不应包装')
  assert.ok(loaded.warnings.some(text => text.includes('dsh-fast-at')), '应记 warn')
})

await test('live.sources 不可用时不抛错、不包装、记 warn', async () => {
  const source = makeSource('reference', '@')
  const ctx = makeCtx({ sources: [source] })
  ctx._services.inputTriggers.live = undefined
  const loaded = await load({ ctx })
  assert.equal(source.candidates, source.__original, '不应包装')
  assert.ok(loaded.warnings.length > 0, '应记 warn')
})

await test('registerSource 不是函数时不抛错、不包装', async () => {
  const source = makeSource('reference', '@')
  const ctx = makeCtx({ sources: [source] })
  ctx._services.inputTriggers.registerSource = 'nope'
  const loaded = await load({ ctx })
  assert.equal(source.candidates, source.__original, '不应包装')
  assert.ok(loaded.warnings.length > 0, '应记 warn')
})

// ---------------------------------------------------------------------------
console.log('\n' + '-'.repeat(60))
console.log('通过 ' + passed + ' / ' + (passed + failures.length))
if (failures.length > 0) {
  for (const failure of failures) console.log('  - ' + failure.label + ' -> ' + failure.message)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
