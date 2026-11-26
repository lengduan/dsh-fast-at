/**
 * dsh-fast-at —— host 侧的会话索引读取层（纯 JS 实现）。
 *
 * 这是本插件**唯一**碰磁盘的模块。设计核心是「**@ 时零 I/O**」：
 *
 * 实测（本机 355 个会话）：
 * - 目录遍历 + 每会话读前 8KB 解第一帧：约 250–350ms
 * - @ 时的查询：纯内存过滤排序，0.03–0.06ms
 *
 * 也就是说「每次 @ 都扫盘」**不可能**满足 300ms。所以这里做成索引模型：
 *
 * 1. **后台建索引**：启动后异步建一次，拿全量会话元数据进内存。
 * 2. **@ 时纯内存查询**：过滤 / 排序 / 截断全在这层，零磁盘。
 * 3. **后台增量刷新**：索引超过 TTL 就异步刷新，**永不阻塞 @**（stale-while-revalidate）。
 * 4. **标题懒补**：只给最新 N 条补标题，标题要解会话日志的前几帧，代价比读 header 高。
 *
 * 为什么不再有 Rust：会话搜索排序本身在 JS 里只要 0.03–0.06ms（355 条），
 * 20ms 阈值有 100 倍以上余量；整段索引重建 JS 与 Rust 同一量级（各 250–350ms，
 * 谁快随整机负载反转），没有稳定的性能理由维护一个需要 cargo 构建的二进制。
 * 详见 .scratch/task1-measurements.md。
 *
 * 绝不做的事：
 * - 不在 @ 路径上做任何 I/O（那会把 300ms 直接加到用户感知延迟）。
 * - **不用同步文件 API**：同步 fs 会让整个宿主的 HTTP 事件循环停摆 300ms，
 *   这正是历史文档里「所有请求同一刻释放」的真凶形态。一律用 fs.promises。
 * - 不抛错。任何失败折成 `{ ok: false, code }`，由上层回退客户端快照。
 *
 * @module dsh-fast-at/sessions-reader
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

/** zstd 帧魔数。 */
const ZSTD_MAGIC = 0xfd2fb528

/** 读 header 时只读文件前这么多字节（实测第一帧 max 245 字节，8KB 有 30 倍余量）。 */
const HEADER_READ_BYTES = 8 * 1024

/** 为找标题最多解这么多帧（实测标题在第 7 帧附近出现）。 */
const MAX_TITLE_FRAMES = 10

/** 为找标题最多读文件前这么多字节。 */
const MAX_TITLE_BYTES = 4 * 1024 * 1024

/**
 * 索引新鲜期。超过就在后台刷新，但**不阻塞**读取（先返旧值）。
 *
 * 注意：这个 TTL 只决定「什么时候后台重建」，与 @ 的响应时间无关——
 * query() 从不等待重建。历史文档把这条误读成了阻塞源。
 */
const INDEX_TTL_MS = 30_000

/** 索引失败后的重试冷却，避免磁盘出问题时反复重建。 */
const RETRY_COOLDOWN_MS = 10_000

/**
 * 子对话（子智能体会话）的返回上限。
 *
 * 比对话的上限（20）小：子对话数量通常不多，给 20 条太浪费屏幕。
 * 与对话组**各自独立**计数，互不挤占。
 */
const CHILD_LIMIT = 10


/**
 * 落盘缓存的文件名（放在 `<DSH_HOME>/storages/` 下）。
 *
 * 为什么落盘：进程内索引每次启动都要重建（约 490–600ms），落盘后启动只需读 46.5KB（约 1.3ms）。
 * 格式是 JSONL——每行一条会话、按 mtime 降序排好，人工可读可 diff，不需要 sqlite。
 */
const CACHE_FILENAME = 'fast-at-sessions.jsonl'

/**
 * @typedef {object} SessionMeta
 * @property {string} sessionId - 会话 id（header.id，可能带 session- 前缀）
 * @property {string} [cwd] - 工作目录
 * @property {string} [parentSession] - 父会话 id（子智能体才有）
 * @property {number} createdAt - 创建时间（epoch ms）
 * @property {number} mtimeMs - 会话文件最后修改时间（epoch ms）
 * @property {number} delegationDepth - 委派深度
 * @property {string} [origin] - 'subagent' 表示子智能体
 * @property {string} [label] - 标题（懒补，可能缺）
 */

/** 内存索引。 */
let index = /** @type {{ at: number, items: SessionMeta[] } | undefined} */ (undefined)

/** 进行中的索引任务（去重）。 */
let building = /** @type {Promise<object> | undefined} */ (undefined)

/** 上次失败时间，用于冷却。 */
let failedAt = 0

/** 启动时「从缓存文件加载」的进行中任务（去重）。 */
let loading = /** @type {Promise<boolean> | undefined} */ (undefined)

/**
 * 默认的会话根目录：`<DSH_HOME>/sessions`，DSH_HOME 缺省为 `~/.dsh`。
 * @returns {string} 绝对路径。
 */
export function sessionsRoot() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== ''
    ? home
    : path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  return path.join(base, 'sessions')
}

/** 清空索引（测试与卸载时用）。 */
export function clearIndex() {
  index = undefined
  building = undefined
  failedAt = 0
}

/**
 * 查会话候选。**永不阻塞在磁盘上**。
 *
 * @param {object} [options] - 查询参数。
 * @param {string} [options.query] - `@` 后的 query 文本。
 * @param {number} [options.limit] - 返回条数上限，默认 20。
 * @param {string} [options.cwd] - 当前会话工作目录，用于 `sameWorkspace`。
 * @param {string} [options.self] - 当前会话 id（用来判定「直接子智能体」）。
 *   给了才做分组：子智能体与对话**各自独立**按 `limit` 截断。
 * @returns {{ ok: true, items: object[], stale: boolean } | { ok: false, code: string, message: string }}
 */
export function query(options = {}) {
  const query = typeof options.query === 'string' ? options.query : ''
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 20
  const cwd = typeof options.cwd === 'string' ? options.cwd : undefined
  const self = typeof options.self === 'string' ? normalizeId(options.self) : ''

  if (index === undefined) {
    // 还没有索引：先尝试从缓存文件加载（约 1.3ms），加载不到再后台重建。
    // 注意这里**不 await 重建**——重建要 490–600ms，不能让 @ 等它。
    if (loadFromCache() === false) void ensureIndex()
    return { ok: false, code: 'index-warming', message: '会话索引正在后台构建' }
  }

  // 惰性刷新：不设定时器，只有真的有人按 @ 时才发现缓存过期。
  // 重建走 void，用户继续输入的过程中自然消化掉那几百毫秒，本次仍用旧索引秒回。
  const age = Date.now() - index.at
  const stale = age >= INDEX_TTL_MS
  if (stale) void ensureIndex(self)

  const needle = query.toLocaleLowerCase()
  const filtered = needle === ''
    ? index.items
    : index.items.filter(item => {
      if (item.sessionId.toLocaleLowerCase().includes(needle)) return true
      if (item.cwd !== undefined && item.cwd.toLocaleLowerCase().includes(needle)) return true
      if (item.label !== undefined && item.label.toLocaleLowerCase().includes(needle)) return true
      return false
    })

  // 排序：mtime 降序（用户要求「按文件修改时间」）为主；
  // 同 mtime 时同工作区优先，再按 id 稳定兜底。
  const rank = item => (item.cwd !== undefined && item.cwd === cwd ? 0 : item.cwd === undefined ? 1 : 2)
  const sorted = [...filtered].sort((a, b) => b.mtimeMs - a.mtimeMs || rank(a) - rank(b) || a.sessionId.localeCompare(b.sessionId))

  // 分组口径（用户 2026-11-26 定）：
  // - 「子智能体」只放**当前会话的**直接子会话；
  // - 「对话」只放普通会话，**任何子会话都不进去**（别处的子会话既不进这组也不进那组，直接不展示）。
  // 两组各自独立取 limit 条，互不挤占。
  const isOwnChild = item => self !== '' && item.kind === 'child'
    && item.parentSession !== undefined && normalizeId(item.parentSession) === self
  const childLimit = Math.min(limit, CHILD_LIMIT)
  const children = []
  const others = []
  for (const item of sorted) {
    // 没给 self 就是「原样查询」：不分组也不过掉子会话（上层用它做全量核对）。
    if (self === '') {
      if (others.length < limit) others.push(item)
      if (others.length >= limit) break
      continue
    }
    if (item.kind === 'child') {
      if (isOwnChild(item) && children.length < childLimit) children.push(item)
      continue
    }
    if (others.length < limit) others.push(item)
    if (children.length >= childLimit && others.length >= limit) break
  }

  // 子对话缺标题时补：只处理**本次要返回的这几条**（受 childLimit 限制）。
  //
  // 不做异步补其余：返回值已经按 childLimit 截断，返回之后再去补「没被返回的那些」
  // 在当前请求里没有任何可见收益（用户明确要求「去掉异步更新 10 条之外的逻辑」）。
  //
  // 补到就写回缓存——子对话标题不会变，一次补齐后下次直接沿用，
  // 之后每次 @ 只剩「检查有没有 label」的开销，不再解盘。
  //
  // 为什么只补子对话而不补对话：对话在 buildIndex 里已经全量补过；
  // 子对话只补「当前会话的」，而当前会话是 query 时才知道的，所以补的时机只能在这里。
  const missing = children.filter(item => item.label === undefined && item.path !== undefined)
  if (missing.length > 0) {
    let filled = 0
    for (const item of missing) {
      const label = readTitleSync(item.path)
      if (label !== null) {
        item.label = label
        filled += 1
      }
    }
    if (filled > 0) void persistLabels()
  }

  const toItem = item => ({
    sessionId: item.sessionId,
    label: item.label ?? item.sessionId,
    displayTitle: item.label ?? item.sessionId,
    ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
    ...(item.parentSession === undefined ? {} : { parentSession: item.parentSession }),
    createdAt: item.createdAt,
    mtimeMs: item.mtimeMs,
    sameWorkspace: item.cwd !== undefined && item.cwd === cwd,
    ...(item.origin === undefined ? {} : { origin: item.origin }),
    delegationDepth: item.delegationDepth,
    kind: item.kind,
    child: isOwnChild(item),
  })

  // 子智能体排在前面，与原生「子智能体」分组在上一致。
  return { ok: true, items: [...children.map(toItem), ...others.map(toItem)], stale }
}

/**
 * 会话 id 有两种合法形态：`<uuid>` 与 `session-<uuid>`，实测各约一半。
 * 比较前先剥掉前缀，否则「父 id 带前缀、子 id 不带」时永远匹配不上。
 * @param {string} value - 会话 id。
 * @returns {string} 去掉 `session-` 前缀的 id。
 */
function normalizeId(value) {
  return value.replace(/^session-/u, '')
}

/**
 * 会话类别：`child`（子智能体会话）或 `chat`（普通对话）。
 *
 * 落盘时写死这个标记，查询时直接按它分流，不必每次重新解析 origin / parentSession。
 * 父会话 id 不参与判定——「是谁的子会话」按 `parentSession` 现算，
 * 因为同一条缓存会被不同当前会话复用。
 * @param {{ origin?: string, delegationDepth?: number }} item - 索引项。
 * @returns {'child' | 'chat'} 类别。
 */
function sessionKind(item) {
  if (item.origin === 'subagent') return 'child'
  // 兜底：有的会话只有 delegationDepth > 0 而没有 origin（历史数据）。
  return typeof item.delegationDepth === 'number' && item.delegationDepth > 0 ? 'child' : 'chat'
}

/**
 * 确保索引在构建（幂等；已在构建就复用同一个 Promise）。
 * @returns {Promise<object>} 构建结果（调用方一般不等）。
 */
export function ensureIndex(self = '') {
  if (building !== undefined) return building
  const now = Date.now()
  if (index === undefined && now - failedAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve({ ok: false, code: 'cooldown' })
  }
  building = buildIndex(self).then(result => {
    building = undefined
    if (result.ok === true) {
      index = { at: Date.now(), items: result.items }
      failedAt = 0
    } else {
      failedAt = Date.now()
    }
    return result
  })
  return building
}

/**
 * `readTitle` 的**同步**版本，供 `query()` 在必须同步返回时使用。
 *
 * 为什么需要同步版：`query()` 的契约是同步返回（路由层直接写响应），
 * 改成 async 会波及全部调用点与测试。这里只用于「补本次要返回的子对话标题」这个
 * 有界的小批量——受 `CHILD_LIMIT`(10) 约束，实测单条 0.9–2.8ms，最多约 28ms，
 * 远小于原生的 1900ms。补到的标题会写回缓存，之后只剩检查开销。
 *
 * 解析逻辑与 `readTitle` 保持一致（descriptor 优先），避免两条路径取名不同。
 * @param {string} filePath - 会话文件。
 * @returns {string|null} 标题或 null。
 */
function readTitleSync(filePath) {
  let fd
  try {
    fd = openSync(filePath, 'r')
    const size = fstatSync(fd).size
    const cap = Math.min(size, MAX_TITLE_BYTES)
    const buf = Buffer.allocUnsafe(cap)
    const bytesRead = readSync(fd, buf, 0, cap, 0)
    const slice = buf.subarray(0, bytesRead)
    let offset = 0
    for (let i = 0; i < MAX_TITLE_FRAMES; i += 1) {
      const end = frameEnd(slice, offset)
      if (end < 0) return null
      let raw
      try {
        raw = zlib.zstdDecompressSync(slice.subarray(offset, end))
      } catch {
        return null
      }
      const text = raw.toString('utf8')
      let found = null
      for (const line of text.split('\n')) {
        if (line === '') continue
        if (line.includes('subagent/descriptor')) {
          try {
            const label = JSON.parse(line)?.data?.label
            if (typeof label === 'string' && label !== '') return label
          } catch {
            // 坏行跳过。
          }
        }
        if (!line.includes('session/title')) continue
        try {
          const title = JSON.parse(line)?.data?.title
          if (typeof title === 'string' && title !== '') found = title
        } catch {
          // 坏行跳过。
        }
      }
      if (found !== null) return found
      offset = end
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 已经关掉就算了。
      }
    }
  }
}

/**
 * 把内存索引的当前状态写回缓存文件（后台，不阻塞）。
 *
 * 用于 `@` 时同步补到标题后落盘：标题补一次就该长期有效，
 * 否则每个重建周期都要重新解同样的文件。
 * @returns {void}
 */
function persistLabels() {
  void (async () => {
    if (index === undefined) return
    try {
      await writeCache(index.items)
    } catch {
      // 写盘失败不影响内存里的标题，下次重建再补。
    }
  })()
}

/**
 * 只读缓存里已有的 `id -> label`（用于重建时继承别的会话的子会话标题）。
 *
 * 不能复用 loadFromCache：那个会建索引，而这里只需要一张表。
 * 读不到或解析失败一律返回空表——继承失败只是少几个标题，不该让重建失败。
 * @returns {Map<string, string>} 归一化 id -> 标题。
 */
function readCacheLabels() {
  const out = new Map()
  let raw
  try {
    raw = readFileSync(cachePath(), 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    if (line === '' || !line.includes('"label"')) continue
    try {
      const row = JSON.parse(line)
      if (typeof row?.id !== 'string' || typeof row?.label !== 'string' || row.label === '') continue
      out.set(normalizeId(row.id), row.label)
    } catch {
      // 坏行跳过。
    }
  }
  return out
}

/**
 * 缓存文件的绝对路径：`<DSH_HOME>/storages/fast-at-sessions.jsonl`。
 * @returns {string} 绝对路径。
 */
export function cachePath() {
  return path.join(path.dirname(sessionsRoot()), 'storages', CACHE_FILENAME)
}

/**
 * 把内存索引写到缓存文件（**原子写**：先写 .tmp 再 rename）。
 *
 * 绝不能直接写目标文件——读取方可能正好读到半截，那会解析出一半会话。
 * rename 在同一卷上是原子操作，读到的要么是旧文件、要么是新文件。
 *
 * 每行一条、按 mtime 降序（写入前已排好），读取时可以直接按顺序取用。
 * @param {SessionMeta[]} items - 已按 mtime 降序排好的会话。
 * @returns {Promise<boolean>} 是否写成功。
 */
export async function writeCache(items) {
  const target = cachePath()
  const tmp = target + '.tmp'
  try {
    await mkdir(path.dirname(target), { recursive: true })
    const lines = items.map(item => JSON.stringify({
      id: item.sessionId,
      mtimeMs: item.mtimeMs,
      kind: sessionKind(item),
      cwd: item.cwd ?? null,
      label: item.label ?? null,
      createdAt: item.createdAt,
      parentSession: item.parentSession ?? null,
      origin: item.origin ?? null,
      delegationDepth: item.delegationDepth,
      // 写上会话文件路径：`@` 时补标题需要它，否则从缓存加载后无从定位文件。
      // 用相对 DSH_HOME 的写法不可取（搬目录就失效），直接存绝对路径。
      path: item.path ?? null,
    }))
    // 末尾换行：保证每行都是完整记录，追加写时也不会粘行。
    await writeFile(tmp, lines.join('\n') + '\n', 'utf8')
    await rename(tmp, target)
    return true
  } catch {
    // 写缓存失败不影响内存索引继续工作，静默降级。
    await rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

/**
 * 从缓存文件加载索引到内存。
 *
 * 任何异常（文件不存在 / JSON 坏行 / 字段类型不对）都当作「没有缓存」返回 false，
 * 由调用方触发重建。**绝不因为缓存坏了就返空**——那会让 @ 彻底没有会话候选。
 *
 * 坏行进单独跳过而不是整份丢弃：写盘是原子的，但磁盘损坏可能只影响中间某一行。
 * @returns {boolean} 是否成功加载。
 */
export function loadFromCache() {
  if (index !== undefined) return true
  if (loading !== undefined) return false
  let raw
  try {
    raw = readFileSync(cachePath(), 'utf8')
  } catch {
    return false
  }
  const items = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null) continue
    if (typeof row.id !== 'string' || row.id === '') continue
    if (typeof row.mtimeMs !== 'number' || !Number.isFinite(row.mtimeMs)) continue
    const kind = row.kind === 'child' || row.kind === 'chat' ? row.kind : undefined
    items.push({
      sessionId: row.id,
      cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
      parentSession: typeof row.parentSession === 'string' ? row.parentSession : undefined,
      createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
      origin: typeof row.origin === 'string' ? row.origin : undefined,
      delegationDepth: typeof row.delegationDepth === 'number' ? row.delegationDepth : 0,
      label: typeof row.label === 'string' && row.label !== '' ? row.label : undefined,
      mtimeMs: row.mtimeMs,
      path: typeof row.path === 'string' && row.path !== '' ? row.path : undefined,
      // 老缓存没有 kind 字段，按现有字段推；不返回 undefined 是为了让 query 里少一次分支。
      kind: kind ?? (((typeof row.origin === 'string' && row.origin === 'subagent')
        || (typeof row.delegationDepth === 'number' && row.delegationDepth > 0)) ? 'child' : 'chat'),
    })
  }
  if (items.length === 0) return false
  // 缓存里的 mtime 是排序依据，文件是这么写的；但文件可能被手工改过，这里再排一次（0.1ms）。
  items.sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId))
  index = { at: Date.now(), items }
  return true
}

/**
 * 启动时调用：先从缓存文件加载（毫秒级），再**无条件**后台重建一次。
 *
 * 为什么重启后要立刻重建：缓存最多可能是 30 秒前的（惰性刷新只在有人按 @ 时才触发），
 * 重启这段时间里会话可能变了。先给用户可用的旧索引，重建完成后再无缝替换。
 * @returns {Promise<object>} 重建结果。
 */
export async function warmStart(self = '') {
  loadFromCache()
  return ensureIndex(self)
}

/**
 * 建一次**全量索引**，全部走异步 I/O。
 *
 * 阶段成本（本机 355 个会话，实测）：
 * - 目录遍历 + stat：约 125–135ms
 * - 每会话读 8KB 解第一帧：约 90–130ms
 * - mtime 排序：0.1ms
 * - 前 30 条补标题：约 65–100ms（要解到第 7 帧）
 *
 * @returns {Promise<object>} 结果对象。
 */
async function buildIndex(self = '') {
  try {
    const root = sessionsRoot()
    const targets = await collectTargets(root)
    const cacheTitles = await loadProjcacheTitles(path.join(path.dirname(root), 'storages'))

    const entries = []
    for (const target of targets) {
      const header = await readHeader(target.path)
      if (header === null) continue
      entries.push({
        sessionId: header.id,
        cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
        parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined,
        createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
        origin: typeof header.origin === 'string' ? header.origin : undefined,
        delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 0,
        label: undefined,
        mtimeMs: target.mtimeMs,
        path: target.path,
        // 与缓存里的 kind 同源，保证「内存刚建好」与「从缓存加载」两条路径判定一致。
        kind: sessionKind({
          origin: typeof header.origin === 'string' ? header.origin : undefined,
          delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 0,
        }),
      })
    }

    // 先按 mtime 降序定下「哪些值得补标题」——与最终排序口径一致，避免补了用不上的。
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId))

    // 补标题策略（用户 2026-11-26 定）：
    // - **对话**：全量补。实测 176 个 chat 共 663ms，换来「任何会话被搜到都有名字」。
    // - **子会话**：**先看上一份缓存，有标题就直接沿用**——子对话标题不会变，
    //   只在第一次（或新出现时）解一次盘。实测补过的下次重建 0ms。
    //   缓存里没有的才现解：当前会话的子对话现解，其余留空等 `@` 时再补。
    const selfId = self === '' ? '' : normalizeId(self)
    const previous = readCacheLabels()
    for (const entry of entries) {
      // 第一优先：上一份缓存里已有的标题（子对话标题不变化，一次补齐终身受用）。
      const inherited = previous.get(normalizeId(entry.sessionId))
      if (inherited !== undefined) {
        entry.label = inherited
        continue
      }
      const cached = cacheTitles.get(entry.sessionId)
        ?? cacheTitles.get(entry.sessionId.replace(/^session-/u, ''))
      if (cached !== undefined) {
        entry.label = cached
        continue
      }
      if (entry.kind === 'chat') {
        entry.label = (await readTitle(entry.path)) ?? undefined
        continue
      }
      // 子会话且缓存里没有：当前会话的现解，其余留空（@ 时会按需补）。
      const own = selfId !== '' && entry.parentSession !== undefined
        && normalizeId(entry.parentSession) === selfId
      if (own) entry.label = (await readTitle(entry.path)) ?? undefined
    }

    // 落盘：重建成功就把结果写进缓存文件，下次启动直接读它。
    // 写失败不影响本次结果（内存索引仍然可用），所以不检查返回值。
    await writeCache(entries)

    return { ok: true, items: entries, total: targets.length }
  } catch (error) {
    return { ok: false, code: 'build-failed', message: String(error?.message ?? error) }
  }
}

/**
 * 递归扫描会话文件，每个会话目录只保留代次最高的文件。
 *
 * 只做目录遍历 + 元数据，**不解压任何文件**。
 * @param {string} root - 会话根目录。
 * @returns {Promise<Array<{ gen: number, path: string, mtimeMs: number }>>} 目标列表（按 mtime 降序）。
 */
export async function collectTargets(root) {
  const out = []
  let projectDirs
  try {
    projectDirs = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue
    const projectPath = path.join(root, projectDir.name)
    let sessionDirs
    try {
      sessionDirs = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue
      const sessionPath = path.join(projectPath, sessionDir.name)
      let files
      try {
        files = await readdir(sessionPath, { withFileTypes: true })
      } catch {
        continue
      }
      let bestGen = -1
      let bestPath
      for (const file of files) {
        const gen = sessionFileGen(file.name)
        if (gen === null) continue
        if (gen > bestGen) {
          bestGen = gen
          bestPath = path.join(sessionPath, file.name)
        }
      }
      if (bestPath === undefined) continue
      let mtimeMs
      try {
        mtimeMs = (await stat(bestPath)).mtimeMs
      } catch {
        continue
      }
      out.push({ gen: bestGen, path: bestPath, mtimeMs })
    }
  }
  // 按修改时间降序（用户要求「按文件修改时间排序」），同 mtime 用路径稳定兜底。
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

/**
 * 从文件名判断代次：session.jsonl.zstd -> 0，session.vN.jsonl.zstd -> N。
 * @param {string} name - 文件名。
 * @returns {number|null} 代次；不是会话文件返回 null。
 */
export function sessionFileGen(name) {
  const rest = name.startsWith('session') ? name.slice('session'.length) : null
  if (rest === null || !rest.endsWith('.jsonl.zstd')) return null
  const body = rest.slice(0, -'.jsonl.zstd'.length)
  if (body === '') return 0
  if (!body.startsWith('.v')) return null
  const digits = body.slice('.v'.length)
  if (digits === '' || !/^\d+$/u.test(digits)) return null
  return Number.parseInt(digits, 10)
}

/**
 * 只解第一帧，取第一行 JSON 作为 header。
 *
 * 局部读：第一帧实测 max 245 字节，只读前 8KB 就够，不必把整个文件读进内存。
 * @param {string} filePath - 会话文件。
 * @returns {Promise<object|null>} header 或 null。
 */
export async function readHeader(filePath) {
  let handle
  try {
    handle = await open(filePath, 'r')
    const buf = Buffer.allocUnsafe(HEADER_READ_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEADER_READ_BYTES, 0)
    const slice = buf.subarray(0, bytesRead)
    const end = frameEnd(slice, 0)
    if (end < 0) return null
    let raw
    try {
      raw = zlib.zstdDecompressSync(slice.subarray(0, end))
    } catch {
      return null
    }
    const text = raw.toString('utf8')
    const nl = text.indexOf('\n')
    const line = nl === -1 ? text : text.slice(0, nl)
    if (line === '') return null
    const value = JSON.parse(line)
    if (typeof value !== 'object' || value === null) return null
    if (typeof value.id !== 'string' || value.id === '') return null
    return value
  } catch {
    return null
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
}

/**
 * 解前若干帧找会话标题。
 *
 * **两种记录，优先级不同**：
 * 1. `{"type":"subagent/descriptor","data":{"label":"复核搜索排序耗时结论A"}}`（第 1 帧）
 *    —— 子智能体的**真名**，与界面顶部子智能体面板显示的一致。
 * 2. `{"type":"session/title","data":{"title":"...","source":{"kind":"fallback"}}}`（第 7 帧附近）
 *    —— 普通会话的标题。子会话也有一条，但 `source.kind = "fallback"` 表示它是
 *    **从首条消息截断生成的备用名**（如「你是独立复核者。任务：复核」），不是真名。
 *
 * 所以 descriptor 优先：只要解到就立刻返回，不再找 session/title。
 * 实测 descriptor 恒在第 1 帧，不会增加解压量。
 *
 * @param {string} filePath - 会话文件。
 * @returns {Promise<string|null>} 标题或 null。
 */
export async function readTitle(filePath) {
  let handle
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    const cap = Math.min(size, MAX_TITLE_BYTES)
    const buf = Buffer.allocUnsafe(cap)
    const { bytesRead } = await handle.read(buf, 0, cap, 0)
    const slice = buf.subarray(0, bytesRead)
    let offset = 0
    for (let i = 0; i < MAX_TITLE_FRAMES; i += 1) {
      const end = frameEnd(slice, offset)
      if (end < 0) return null
      let raw
      try {
        raw = zlib.zstdDecompressSync(slice.subarray(offset, end))
      } catch {
        return null
      }
      const text = raw.toString('utf8')
      let found = null
      for (const line of text.split('\n')) {
        if (line === '') continue
        // 子智能体真名优先：命中就立刻返回，不被后面的 fallback 标题覆盖。
        if (line.includes('subagent/descriptor')) {
          try {
            const label = JSON.parse(line)?.data?.label
            if (typeof label === 'string' && label !== '') return label
          } catch {
            // 单行坏了不影响整帧。
          }
        }
        if (!line.includes('session/title')) continue
        try {
          const record = JSON.parse(line)
          const title = record?.data?.title ?? record?.title
          if (typeof title === 'string' && title !== '') found = title
        } catch {
          // 单行坏了不影响整帧。
        }
      }
      if (found !== null) return found
      offset = end
    }
    return null
  } catch {
    return null
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
}

/**
 * 从投影缓存读标题：`session_projcache.json` 的 `tables.sessions[id].rows.title.val`。
 *
 * 实测只有部分会话在缓存里，所以它只是「白捡的加分项」，捡不到再走 readTitle。
 * @param {string} storagesDir - storages 目录。
 * @returns {Promise<Map<string, string>>} id -> 标题（带前缀与不带前缀两种键都放）。
 */
export async function loadProjcacheTitles(storagesDir) {
  const out = new Map()
  let raw
  let handle
  try {
    handle = await open(path.join(storagesDir, 'session_projcache.json'), 'r')
    raw = await handle.readFile('utf8')
  } catch {
    return out
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return out
  }
  const sessions = value?.tables?.sessions
  if (typeof sessions !== 'object' || sessions === null) return out
  for (const [id, entry] of Object.entries(sessions)) {
    const title = entry?.rows?.title?.val
    if (typeof title !== 'string' || title === '') continue
    out.set(id, title)
    if (id.startsWith('session-')) out.set(id.slice('session-'.length), title)
  }
  return out
}

/**
 * 计算一帧 zstd 的结束偏移（不含）；-1 表示这一帧不完整。
 *
 * 不能靠 magic 扫描（压缩正文里会出现伪 magic），必须按帧头结构步进。
 * 特别注意 contentSizeFlag==0 且 singleSegment 时仍有 1 字节内容长度。
 * @param {Buffer} buf - 文件内容。
 * @param {number} start - 起始偏移。
 * @returns {number} 结束偏移或 -1。
 */
export function frameEnd(buf, start) {
  let o = start
  if (buf.length - o < 4) return -1
  if (buf.readUInt32LE(o) !== ZSTD_MAGIC) return -1
  o += 4
  if (o === buf.length) return -1
  const descriptor = buf.readUInt8(o)
  o += 1
  // 保留位非零说明帧头损坏
  if ((descriptor & 0x18) !== 0) return -1
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (buf.length - o < remaining) return -1
  o += remaining
  for (;;) {
    if (buf.length - o < 3) return -1
    const blockHeader = buf.readUIntLE(o, 3)
    o += 3
    const last = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const size = blockHeader >>> 3
    if (blockType === 0x03) return -1
    const payload = blockType === 0x01 ? 1 : size
    if (buf.length - o < payload) return -1
    o += payload
    if (last) break
  }
  if (checksum) {
    if (buf.length - o < 4) return -1
    o += 4
  }
  return o
}
