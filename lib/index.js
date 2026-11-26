/**
 * dsh-fast-at —— host 半。
 *
 * 职责只有两件：
 * 1. 在后台建「会话索引」（异步扫一遍磁盘，约 300ms），之后 @ 的查询就是纯内存。
 * 2. 把索引查询暴露成一个 HTTP 路由 `/fast-at/api/*`，供浏览器半 fetch。
 *
 * 为什么用 HTTP 路由而不是 Typert remote 命名空间：`ctx.remote` 的类型来自编译期生成的
 * `ClientRemote`（`dsh-api-session-controller/src/client/transport.ts`），树外插件拿不到那条
 * 生成管线。而 `ctx.webServer.register` 是公开可用的，`dsh-better-sidebar` 就用它注册
 * `/sidebar/api/*`（`lib/index.js` 里那段），是经过验证的做法。
 *
 * @module dsh-fast-at
 */

import { query, clearIndex, warmStart } from './sessions-reader.js'

/** 插件名（cordis 插件契约）。 */
export const name = 'fast-at'

/**
 * 必需依赖。
 *
 * `webServer` 提供路由注册能力，`connection` 提供请求鉴权（`requestRejection`）。
 * 这两项**必须**写进 inject，否则 `ctx.webServer` 这类属性访问会直接抛
 * `cannot get property "webServer" without inject`——这是 cordis 的硬约束。
 */
export const inject = ['webServer', 'connection']

/**
 * 装配插件。
 * @param {object} ctx - cordis 上下文。
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    console.warn('[dsh-fast-at] webServer.register 不可用，不启用会话索引路由')
    return
  }
  if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
    console.warn('[dsh-fast-at] connection.requestRejection 不可用，不启用会话索引路由')
    return
  }

  // 启动：先读缓存文件（毫秒级，@ 立刻可用），再无条件后台重建一次。
  // 重启期间会话可能变了，所以重建这次不能省；用户看到的是旧索引无缝换成新的。
  void warmStart()

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/fast-at/api',
    handler: (req, res) => handle(req, res, ctx),
  }), 'dsh-fast-at: /fast-at/api 会话索引路由')

  // 卸载时清掉内存索引，不留状态（缓存文件保留，下次启动还要用）。
  ctx.effect(() => () => clearIndex(), 'dsh-fast-at: 会话索引清理')
}

/**
 * 路由处理：只接受 POST，路径末段是方法名。
 * @param {object} req - Node IncomingMessage。
 * @param {object} res - Node ServerResponse。
 * @param {object} ctx - cordis 上下文。
 */
function handle(req, res, ctx) {
  const reject = ctx.get('connection')?.requestRejection(req)
  if (reject !== undefined) {
    writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: { code: 'method', message: 'method not allowed' } })
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  const method = pathname.startsWith('/fast-at/api/') ? pathname.slice('/fast-at/api/'.length) : undefined
  if (method === undefined || method.includes('/')) {
    writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
    return
  }
  // 诊断专用：返回带 launch-token 的 GUI 地址，供外部 playwright 连接做 CPU 归因。
  // 只回 loopback 地址，不落盘、不记日志；拿到就删。
  if (method === 'debug.guiUrl') {
    const connection = ctx.get('connection')
    const host = typeof req.headers?.host === 'string' && /^[\w.\-]+(:\d+)?$/.test(req.headers.host)
      ? req.headers.host
      : '127.0.0.1:56059'
    const raw = typeof connection?.authenticatedUrl === 'function'
      ? connection.authenticatedUrl('http://' + host + '/')
      : undefined
    writeJson(res, 200, { ok: true, url: typeof raw === 'string' ? raw : null })
    return
  }
  if (method !== 'sessions.list') {
    writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
    return
  }
  readJson(req).then(body => {
    try {
      const result = query({
        query: typeof body?.query === 'string' ? body.query : '',
        limit: Number.isSafeInteger(body?.limit) ? body.limit : 20,
        cwd: typeof body?.cwd === 'string' ? body.cwd : undefined,
      })
      writeJson(res, 200, result)
    } catch (error) {
      // 查询层理论上不会抛，但路由绝不能因为一个异常把连接挂住。
      writeJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
    }
  }).catch(() => {
    writeJson(res, 400, { ok: false, error: { code: 'bad-body', message: 'invalid JSON body' } })
  })
}

/**
 * 读请求体并解析 JSON（空体返回 undefined）。
 * @param {object} req - Node IncomingMessage。
 * @returns {Promise<object|undefined>} 解析后的对象。
 */
async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    // 这个接口只收几个小字段，超过 64KB 一律拒绝，避免被灌大包。
    if (total > 64 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (total === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  return JSON.parse(text)
}

/**
 * 写 JSON 响应。
 * @param {object} res - Node ServerResponse。
 * @param {number} status - HTTP 状态码。
 * @param {object} body - 响应体。
 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}