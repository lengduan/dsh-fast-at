/**
 * 包元数据与配置文件的解析校验。
 *
 * package.json 用 JSON.parse；cordis.patch.yml 没有可用依赖，因此用一个覆盖本仓 patch 文件
 * 所用 YAML 子集（注释 / 块序列 / 键值对 / 嵌套缩进）的最小解析器，解析失败会明确报错。
 * 对 lib/client.js 的结构断言一律先剥掉注释，避免把说明文字当成代码。
 *
 * 运行：node tests/test-packaging.mjs
 */
import { readFileSync, statSync } from 'node:fs'
import assert from 'node:assert/strict'

let passed = 0
const failures = []

/**
 * 跑一条断言并记录结果。
 * @param {string} label - 用例名。
 * @param {() => void} run - 断言体。
 */
function test(label, run) {
  try {
    run()
    passed += 1
    console.log('  ok   ' + label)
  } catch (error) {
    const message = String(error && error.message ? error.message : error).split('\n')[0]
    failures.push({ label, message })
    console.log('  FAIL ' + label + ' -> ' + message)
  }
}

/**
 * 断言源码里出现某模式。
 * @param {string} source - 源码。
 * @param {RegExp} pattern - 期望出现的模式。
 * @param {string} note - 说明。
 */
function assertHas(source, pattern, note) {
  if (!pattern.test(source)) throw new Error('缺少' + note + '，模式 ' + String(pattern))
}

/**
 * 断言源码里不出现某模式。
 * @param {string} source - 源码。
 * @param {RegExp} pattern - 不应出现的模式。
 * @param {string} note - 说明。
 */
function assertLacks(source, pattern, note) {
  if (pattern.test(source)) throw new Error('出现了不该有的' + note + '，模式 ' + String(pattern))
}

/**
 * 剥掉 JS 源码里的块注释与行注释。
 * @param {string} source - 源码。
 * @returns {string} 只剩代码的文本。
 */
function stripComments(source) {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//gu, ' ')
  return noBlock.split(/\r?\n/u).map(line => line.replace(/(^|[^:'"\\])\/\/.*$/u, '$1')).join('\n')
}

const PKG_PATH = 'package.json'
const PATCH_PATH = 'cordis.patch.yml'

// ---------------------------------------------------------------------------
console.log('# package.json')
// ---------------------------------------------------------------------------
let pkg
test('是合法 JSON', () => {
  pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
})
if (pkg === undefined) {
  console.log('package.json 解析失败，后续断言跳过')
  process.exit(1)
}
test('name = dsh-fast-at', () => assert.equal(pkg.name, 'dsh-fast-at'))
test('version 是 >= 0.2.0 的语义化版本', () => {
  // v0.2.0 起加入会话索引器（后改为纯 JS），故下限提到 0.2.0，而不是钉死具体版本。
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/u, '不是语义化版本: ' + pkg.version)
  const [maj, min] = pkg.version.split('.').map(Number)
  assert.ok(maj > 0 || min >= 2, '版本应 >= 0.2.0（会话索引），got ' + pkg.version)
})
test('type = module', () => assert.equal(pkg.type, 'module'))
test('main = lib/index.js', () => assert.equal(pkg.main, 'lib/index.js'))
test('dsh.bundle.patch = ./cordis.patch.yml', () => assert.equal(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, './cordis.patch.yml'))
test('dsh.client.platform = web', () => assert.equal(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform, 'web'))
test('dsh.client.inject 含 @deepseek-ai/dsh-api-remotes', () => {
  const inject = pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject
  assert.ok(Array.isArray(inject), 'inject 必须是数组')
  assert.ok(inject.includes('@deepseek-ai/dsh-api-remotes'), '缺少 api-remotes')
})
test('exports 含四个必需入口', () => {
  for (const key of ['.', './client', './cordis.patch.yml', './package.json']) {
    assert.equal(typeof pkg.exports[key], 'string', '缺少 exports[' + key + ']')
  }
})
test('exports["./client"] 指向 lib/client.js', () => assert.equal(pkg.exports['./client'], './lib/client.js'))
test('files 含 lib / cordis.patch.yml / README.md', () => {
  // 不再有 bin：会话索引已改为纯 JS 实现，不需要随包分发的 Rust 二进制。
  assert.deepEqual([...pkg.files].sort(), ['README.md', 'cordis.patch.yml', 'lib'])
})
test('exports 里声明的每个文件都真实存在', () => {
  for (const key of Object.keys(pkg.exports)) {
    const path = pkg.exports[key].replace(/^\.\//, '')
    assert.ok(statSync(path).isFile(), 'exports[' + key + '] -> ' + path + ' 不存在')
  }
})
test('files 里声明的每个条目都真实存在', () => {
  for (const entry of pkg.files) {
    assert.ok(statSync(entry), 'files 条目不存在：' + entry)
  }
})

// ---------------------------------------------------------------------------
console.log('\n# cordis.patch.yml')
// ---------------------------------------------------------------------------
/**
 * 去掉行内引号。
 * @param {string} raw - 原始值文本。
 * @returns {string} 去引号后的值。
 */
function unquote(raw) {
  const trimmed = raw.trim()
  const single = trimmed.startsWith("'") && trimmed.endsWith("'")
  const double = trimmed.startsWith('"') && trimmed.endsWith('"')
  return single || double ? trimmed.slice(1, -1) : trimmed
}

const PAIR = /^([A-Za-z_][\w.-]*):\s*(.*)$/u

/**
 * 递归解析一块同缩进的 YAML。
 * @param {Array<{indent: number, body: string}>} rows - 去注释后的行。
 * @param {number} start - 起始行号。
 * @param {number} indent - 本块缩进。
 * @returns {any[]} [解析结果, 下一行行号]
 */
function parseBlock(rows, start, indent) {
  if (rows[start].body.startsWith('- ')) {
    const items = []
    let cursor = start
    while (cursor < rows.length && rows[cursor].indent === indent && rows[cursor].body.startsWith('- ')) {
      const rest = rows[cursor].body.slice(2).trim()
      const pair = PAIR.exec(rest)
      if (pair === null) {
        items.push(unquote(rest))
        cursor += 1
        continue
      }
      const entry = {}
      const key = pair[1]
      if (pair[2] === '') {
        if (cursor + 1 < rows.length && rows[cursor + 1].indent > indent) {
          const parsed = parseBlock(rows, cursor + 1, rows[cursor + 1].indent)
          entry[key] = parsed[0]
          cursor = parsed[1]
        } else {
          entry[key] = null
          cursor += 1
        }
        items.push(entry)
        continue
      }
      entry[key] = unquote(pair[2])
      cursor += 1
      while (cursor < rows.length && rows[cursor].indent > indent && !rows[cursor].body.startsWith('- ')) {
        const more = PAIR.exec(rows[cursor].body)
        if (more === null) throw new Error('无法解析的映射行：' + rows[cursor].body)
        entry[more[1]] = unquote(more[2])
        cursor += 1
      }
      items.push(entry)
    }
    return [items, cursor]
  }
  const map = {}
  let cursor = start
  while (cursor < rows.length && rows[cursor].indent === indent && !rows[cursor].body.startsWith('- ')) {
    const pair = PAIR.exec(rows[cursor].body)
    if (pair === null) throw new Error('无法解析的映射行：' + rows[cursor].body)
    if (pair[2] === '' && cursor + 1 < rows.length && rows[cursor + 1].indent > indent) {
      const parsed = parseBlock(rows, cursor + 1, rows[cursor + 1].indent)
      map[pair[1]] = parsed[0]
      cursor = parsed[1]
      continue
    }
    map[pair[1]] = pair[2] === '' ? null : unquote(pair[2])
    cursor += 1
  }
  return [map, cursor]
}

/**
 * 解析整份 patch 文件。
 * @param {string} text - 文件内容。
 * @returns {any} 解析结果。
 */
function parsePatchYaml(text) {
  const rows = text.split(/\r?\n/u)
    .map(raw => raw.replace(/(^|\s)#.*$/u, '$1'))
    .filter(raw => raw.trim() !== '')
    .map((raw) => {
      const indent = raw.length - raw.trimStart().length
      if (raw.slice(0, indent).indexOf('\t') >= 0) throw new Error('缩进里出现制表符：' + raw)
      return { indent, body: raw.trim() }
    })
  if (rows.length === 0) throw new Error('文件为空')
  const parsed = parseBlock(rows, 0, rows[0].indent)
  if (parsed[1] !== rows.length) throw new Error('解析在第 ' + (parsed[1] + 1) + ' 行中断，剩余内容未消费')
  return parsed[0]
}

let patch
test('可被最小 YAML 解析器解析', () => {
  patch = parsePatchYaml(readFileSync(PATCH_PATH, 'utf8'))
})
if (patch !== undefined) {
  test('顶层是 [{ insert: [...] }]', () => {
    assert.ok(Array.isArray(patch), '顶层必须是序列')
    assert.equal(patch.length, 1, '顶层应只有一项')
    assert.ok(Array.isArray(patch[0].insert), 'insert 必须是数组')
  })
  test('insert 恰好一项', () => assert.equal(patch[0].insert.length, 1))
  test('该项 id = fast-at', () => assert.equal(patch[0].insert[0].id, 'fast-at'))
  test("该项 name = 'dsh-fast-at'", () => assert.equal(patch[0].insert[0].name, 'dsh-fast-at'))
  test('name 与 package.json 的 name 一致', () => assert.equal(patch[0].insert[0].name, pkg.name))
  test('不含第一版不需要的 config 段', () => assert.equal(patch[0].insert[0].config, undefined))
}
test('文件里有说明用途的中文注释', () => {
  const text = readFileSync(PATCH_PATH, 'utf8')
  assert.match(text, /#.*dsh bundle patch/u)
  assert.ok(/[\u4e00-\u9fa5]/u.test(text), '缺少中文注释')
})

// ---------------------------------------------------------------------------
console.log('\n# lib/index.js（host 半：会话索引路由）')
// ---------------------------------------------------------------------------
// 说明（v0.5 变更）：host 半从「空壳」改为「注册 /fast-at/api 路由」。
// 断言同步改为验证新契约，**不放宽**：仍然禁止 @deepseek-ai import，
// 并新增 inject 声明与路由注册的硬断言。
const indexSource = readFileSync('lib/index.js', 'utf8')
test('导出 name', () => assertHas(indexSource, /export const name = 'fast-at'/u, ' export const name'))
test('导出 apply(ctx) 并在装配期做能力探测', () => {
  assertHas(indexSource, /export function apply\(ctx\)/u, ' apply(ctx)')
  assertHas(indexSource, /typeof webServer\.register !== 'function'/u, ' webServer 探测')
})
test('inject 声明 webServer 与 connection', () => {
  assertHas(indexSource, /export const inject = \['webServer', 'connection'\]/u, ' inject 数组')
})
test('用 ctx.effect 包裹路由注册（卸载可还原）', () => {
  assertHas(indexSource, /ctx\.effect\(\(\) => webServer\.register\(/u, ' effect 包裹 register')
})
test('路由做鉴权与方法校验', () => {
  assertHas(indexSource, /requestRejection/u, ' connection.requestRejection 鉴权')
  assertHas(indexSource, /req\.method !== 'POST'/u, ' POST 校验')
})
test('不 import 任何 @deepseek-ai/*', () => assertLacks(indexSource, /from '@deepseek-ai\//u, ' @deepseek-ai import'))

// ---------------------------------------------------------------------------
console.log('\n# lib/client.js（浏览器半硬约束，断言前先剥注释）')
// ---------------------------------------------------------------------------
const rawClient = readFileSync('lib/client.js', 'utf8')
const code = stripComments(rawClient)
test('用 window.__ModuleLoader__.load 包裹', () => assertHas(code, /window\.__ModuleLoader__\.load\(\{/u, ' ModuleLoader 包裹'))
test('id 为 dsh-fast-at', () => assertHas(code, /id: 'dsh-fast-at'/u, ' 模块 id'))
test('factory 返回 module.exports（否则拿到 undefined）', () => assertHas(code, /return module\.exports/u, ' factory 返回值'))
test('不出现 ESM import', () => assertLacks(code, /^\s*import\s/mu, ' ESM import'))
test('不 import 任何 @deepseek-ai/*（profile 里没有这些包）', () => assertLacks(code, /from '@deepseek-ai\//u, ' @deepseek-ai import'))
test('代码里不硬编码 name === reference', () => assertLacks(code, /name === 'reference'/u, ' 硬编码源名'))
test('遍历所有 trigger === @ 的源', () => assertHas(code, /source\.trigger === '@'/u, ' trigger 判定'))
test('失败不回落原生：包装里 catch 成空数组', () => assertHas(code, /\.catch\(\(\) => \[\]\)/u, ' catch 空数组'))
test('所有包装经 ctx.effect 登记还原', () => assertHas(code, /ctx\.effect\(\(\) => \(\) => \{/u, ' ctx.effect 还原'))
test('劫持 registerSource 兜住晚注册', () => assertHas(code, /inputTriggers\.registerSource = function registerSource/u, ' registerSource 劫持'))
test('尊重 req.signal（abort 后返空）', () => assertHas(code, /signal\.aborted/u, ' signal.aborted 检查'))
test('代码里有不包装源名单，且含两个实测反例', () => {
  assertHas(code, /const NON_CANDIDATE_SOURCES = \[/u, ' 豁免名单常量')
  assertHas(code, /const NON_CANDIDATE_SOURCES = \[[^\]]*'betterSidebarQuote'/u, ' 名单含 betterSidebarQuote（纯回显源）')
  assertHas(code, /const NON_CANDIDATE_SOURCES = \[[^\]]*'主机'/u, ' 名单含 主机（远程设备源）')
})
test('wrap 里真的用了豁免名单', () => {
  assertHas(code, /NON_CANDIDATE_SOURCES\.indexOf\(source\.name\)/u, ' wrap 豁免判断')
})
test('没有禁用 dsh-client-ui-reference', () => {
  assertLacks(code, /disable[\s\S]{0,40}ui-reference/u, ' 禁用 ui-reference')
  assertLacks(code, /ui-reference[\s\S]{0,40}disable/u, ' 禁用 ui-reference')
})
test('不新注册源（registerSource 只被劫持，没有被调用）', () => {
  assertLacks(code, /\.registerSource\(\{/u, ' 新注册源调用')
  assertLacks(code, /\.registerSource\(source\)/u, ' 新注册源调用')
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