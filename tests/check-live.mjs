/**
 * 重启后的一键验收脚本。
 *
 * 为什么单独做这个：host 半的路由只在 DSH 启动时装配，所以「重启后是否真的生效」
 * 是本次交付唯一无法在开发期验证的环节。这个脚本把它变成一条命令。
 *
 * 用法（重启 DSH 之后）：
 *   1. 把下面的 PORT 改成当前 GUI 端口（或设 DSH_GUI_PORT 环境变量）
 *   2. node tests/check-live.mjs
 *
 * 它检查四件事：
 *   1. POST /fast-at/api/sessions.list 返回 ok:true 且 items 非空
 *   2. items 结构与 SessionReferenceCandidate 契约吻合
 *   3. 按 mtime 降序（用户要求的排序口径）
 *   4. 三条阴性对照：GET 应 405、未知方法应 404、非法 body 应 400
 */

const PORT = process.env.DSH_GUI_PORT ?? '51012'
const BASE = 'http://127.0.0.1:' + PORT

let pass = 0
let fail = 0
const failures = []

/**
 * 断言。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 详情。
 */
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log('  ok   ' + name)
  } else {
    fail += 1
    failures.push(name + (detail ? ' -> ' + detail : ''))
    console.log('  FAIL ' + name + (detail ? ' -> ' + detail : ''))
  }
}

/**
 * 发一次 POST。
 * @param {string} method - 方法名。
 * @param {object|string} body - 请求体。
 * @returns {Promise<{status: number, json: any, text: string}>} 响应。
 */
async function post(method, body) {
  const res = await fetch(BASE + '/fast-at/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json, text }
}

console.log('\n# 目标: ' + BASE)

console.log('\n# 1. 路由是否生效')
let first
try {
  first = await post('sessions.list', { limit: 5 })
} catch (error) {
  console.log('  FAIL 连不上 ' + BASE + ' -> ' + String(error?.message ?? error))
  console.log('\n提示：确认 DSH 桌面客户端已重启，且端口正确（设 DSH_GUI_PORT 覆盖）。')
  process.exit(1)
}
check('POST 返回 200', first.status === 200, 'status=' + first.status)
if (first.json === undefined) {
  console.log('  响应不是 JSON（可能路由未注册）。原始响应前 200 字：')
  console.log('  ' + first.text.slice(0, 200))
  console.log('\n提示：若 status=405 且 allow=GET,HEAD，说明请求落到了宿主静态服务 —— 路由没注册，host 半没重启。')
  process.exit(1)
}
check('响应 ok === true', first.json.ok === true, JSON.stringify(first.json).slice(0, 200))
check('items 非空', Array.isArray(first.json.items) && first.json.items.length > 0,
  'items=' + JSON.stringify(first.json.items)?.slice(0, 120))
check('items 条数 <= limit', Array.isArray(first.json.items) && first.json.items.length <= 5)

console.log('\n# 2. 契约字段')
const items = first.json.items ?? []
check('每条都有 sessionId / label / createdAt / sameWorkspace', items.every(x =>
  typeof x.sessionId === 'string' && x.sessionId !== ''
  && typeof x.label === 'string'
  && typeof x.createdAt === 'number'
  && typeof x.sameWorkspace === 'boolean'))
check('大多数条目有标题（证明索引带了标题）',
  items.filter(x => x.label !== x.sessionId).length > items.length / 2,
  items.filter(x => x.label !== x.sessionId).length + '/' + items.length + ' 有标题')

console.log('\n# 3. 排序（按文件修改时间倒序）')
const big = await post('sessions.list', { limit: 20 })
const mtimes = (big.json?.items ?? []).map(x => x.mtimeMs)
const sorted = [...mtimes].sort((a, b) => b - a)
check('mtime 降序', JSON.stringify(mtimes) === JSON.stringify(sorted), JSON.stringify(mtimes))

console.log('\n# 4. 阴性对照')
const getRes = await fetch(BASE + '/fast-at/api/sessions.list')
check('N1 GET 被拒（405）', getRes.status === 405, 'status=' + getRes.status)
const unknown = await post('__nope__', {})
check('N2 未知方法返回 404', unknown.status === 404, 'status=' + unknown.status)
const badBody = await post('sessions.list', '{not json')
check('N3 非法 body 返回 4xx 而不是 500', badBody.status >= 400 && badBody.status < 500,
  'status=' + badBody.status)

console.log('\n' + '-'.repeat(60))
console.log('通过 ' + pass + ' / ' + (pass + fail))
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('\n路由已生效，会话索引工作正常。')
console.log('采样（前 3 条）：')
for (const x of items.slice(0, 3)) {
  console.log('  ' + x.sessionId.slice(0, 24) + '...  mtime=' + x.mtimeMs + '  ' + x.label)
}
