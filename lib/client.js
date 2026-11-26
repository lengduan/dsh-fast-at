/**
 * dsh-fast-at —— 浏览器半。
 *
 * 问题：键入 `@` 后菜单骨架 45–58ms 就出现，内容行却要 1.9–2.7 秒。成因不是接口慢，而是
 * 原生 `reference` 源的 `candidates` 会调 `sessionReferenceResolver.candidates` → 宿主
 * `listCandidates()` → `sessionQuery.listSessions()`；这一步在宿主侧把事件循环占满，同窗口
 * 内完全无关的请求（`settings.get` / `session.phase`）也被一起卡住。
 *
 * 做法：原位包装 `ctx.inputTriggers` 下**所有** `trigger === '@'` 的源的 `candidates`，换成
 * 「读客户端已有快照」的本地查询，原实现不再被调用（用户明确要求不保留回落）。会话行来自
 * `sessions.list.getSnapshot().byId`，零请求；文件行只能由插件自己重取——替换整个
 * `candidates` 会让原生那段 `fileReferences.list` 整段不执行，文件候选会跟着消失，那属于
 * 功能回退。
 *
 * 不碰源的其它成员（name / trigger / order / header / lexicon / warm / codec / onPick /
 * openReference）：header 面包屑仍由原生产生，聊天记录里已发引用的渲染也不受影响，所以
 * 只接管候选发现这一条链路。所有改写都经 `ctx.effect` 登记还原 disposer，卸载后完全回到
 * 原生行为。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fast-at',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 源上「已由本插件包装」的标记位。用 Symbol.for，同一页面重复加载也不会认错。 */
    const WRAP_MARK = Symbol.for('dsh-fast-at.wrapped')

    /**
     * 会话候选行数上限。用户明确要求「每次最多返回 20 条会话」，
     * 所以这里固定 20，不跟宿主的 DEFAULT_CANDIDATE_LIMIT 对齐。
     */
    const CANDIDATE_LIMIT = 20

/**
 * 子对话（子智能体会话）的返回上限，须与宿主 `sessions-reader.js` 的 `CHILD_LIMIT` 一致。
 *
 * 比对话上限（20）小：子对话数量通常不多，给 20 条太浪费屏幕。
 * 这里是**快照回退路径**的上限，主路径由宿主按 `CHILD_LIMIT` 截断。
 */
const CHILD_LIMIT = 10

    /**
     * 文件候选结果的缓存有效期。会话行是纯内存计算（微秒级），不需要缓存；真正要省的是
     * 「同一 query 反复触发」时的重复构造。有效期不能长：文件候选来自真实文件系统，缓存久了
     * 会和原生列表对不上（新建文件看不见）。
     */
    const CACHE_TTL_MS = 3000

    /** 缓存条目上限；按 query 逐键缓存，一次输入过程会快速产生大量键。 */
    const CACHE_MAX = 64

    /**
     * 不包装的 @ 源名单。这些源虽然注册了 trigger: '@'，但它们的候选不是会话 / 文件引用，
     * 本插件的替换实现无法表达它们的语义。
     *
     * 两个实测反例（真机复现过）：
     *
     * 1. betterSidebarQuote（dsh-better-sidebar）：纯回显源，candidates 恒返回 []、
     *    onPick 恒返回 'handled'（不产出 insert），codec 负责把 chip 的 ref 还原成引用文本。
     *    包装它 → @ 菜单多出无效分组，选中后退化成纯文本。
     * 2. 主机（ds-harness-remote，dist/client.js:7920-7939）：候选是在线远程设备，
     *    onPick 返回 { text: '@设备名 (Remote hostId=…)' }。包装它 → 设备分组被换成会话 /
     *    文件行，选中后仍按设备语义拼文本，往草稿里插进 @… (Remote hostId=undefined) 垃圾。
     *
     * 为什么只能靠名单：菜单未打开时无法廉价判断一个源「会不会产出会话 / 文件候选」，
     * 运行期探测需要真的调一次原实现——那正是要绕开的慢路径。
     *
     * 维护约定：装了新的 @ 源插件后要判断它属于哪类——会拉慢会话列举的（保持包装）还是
     * 语义不同的（把 name 加进本名单）。
     */
    const NON_CANDIDATE_SOURCES = ['betterSidebarQuote', '主机']
    /**
     * 会话候选是否走本地会话索引。
     *
     * 置为 false 就完全回到「客户端快照」这一条路（也是索引不可用时的回退路径）。
     * 留这个开关是为了出问题时**不用卸载插件**就能回滚。
     */
    const INDEX_ENABLED = true

    /**
     * 会话候选总开关。
     *
     * 置 false 时**完全不产出会话候选**：既不查会话索引，也不读客户端快照，
     * `@` 菜单里只剩文件与文件夹。用于隔离「连续 @ 卡顿是否由会话候选引起」。
     *
     * 这是诊断开关，不是成品配置：关掉后 `@` 会话能力消失（规格要求的能力）。
     */
    /**
     * 会话候选是否启用（每次调用时读取，可被 `globalThis.__FAST_AT_SESSIONS` 运行时覆盖）。
     *
     * 之所以做成函数而不是常量：要在真实 GUI 里做 A/B（开/关会话候选）对比连续 @ 的流畅度，
     * 不能每切一次就改代码重装插件。常量在装配时求值，覆盖不了。
     *
     * @returns 是否产出会话候选。
     */
    function sessionsEnabled() {
      return globalThis.__FAST_AT_SESSIONS !== false
    }

    /**
     * 插件是否整体停用（每次调用时读取，可被 `globalThis.__FAST_AT_OFF` 运行时覆盖）。
     *
     * 置 true 时包装函数直接转调**原实现**，等价于没装插件。
     * 用于测「原生基线」，对比插件到底带来了多少开销。
     *
     * @returns 是否停用插件。
     */
    /**
     * 短路开关：为 true 时 `@` 的 candidates 立刻返回空数组，不跑任何后续逻辑。
     *
     * 用于测量「完全不做候选计算」时的输入流畅度上限——即这个界面在理想情况下
     * 最快能到什么程度。注意它不会阻止菜单骨架渲染，只跳过候选行。
     */
    function shortCircuit() {
      return globalThis.__FAST_AT_SHORTCIRCUIT === true
    }

    function pluginDisabled() {
      return globalThis.__FAST_AT_OFF === true
    }

    /** 相对时间的分桶边界，逐条照抄 ui-primitives 的 relativeTime（日 / 月 / 年按 30 / 365 天）。 */
    const MINUTE = 60_000
    const HOUR = 3_600_000
    const DAY = 86_400_000
    const MONTH = 30 * DAY
    const YEAR = 365 * DAY

    /**
     * 宿主文案不可用时的中文回落（键与原生 `reference` 命名空间一致）。
     * 正常情况下走 `ctx.get('locale').bind('reference')` 取真实文案；只有 locale 服务缺失或
     * 该命名空间未注册时才用这里兜底，避免整组候选因为没有文案而消失。
     */
    const FALLBACK_COPY = {
      'section.files': '文件与文件夹',
      'section.subagents': '子智能体',
      'section.sessions': '对话',
      'candidate.noCwd': '（无工作目录）',
      'time.now': '刚刚',
      'time.minutes': '{n}分钟',
      'time.hours': '{n}小时',
      'time.days': '{n}天',
      'time.months': '{n}个月',
      'time.years': '{n}年',
    }

    /**
     * 会话引用 URI 的 base64url 编码。
     *
     * 权威实现在 dsh-session-reference/src/uri.ts：明文是 `JSON.stringify(sessionId)`（带双引号
     * 的 UTF-8 串），字符集只有 `[A-Za-z0-9_-]`、没有尾部 `=`，解码端还会做 canonical 校验
     * （重编码必须等于原值）。这里用 TextEncoder + btoa 本地复刻——浏览器半不能 import
     * `@deepseek-ai/*`（profile 的 node_modules 里没有这些包）。
     * @param text - 待编码文本。
     * @returns base64url 字符串。
     */
    function base64url(text) {
      const bytes = new TextEncoder().encode(text)
      let bin = ''
      for (const byte of bytes) bin += String.fromCharCode(byte)
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }

    /**
     * 转义 mention 标签里的反斜杠与 `]`（与 uri.ts 的 `escapeLabel` 同规则）。
     * @param label - 显示标题。
     * @returns 可安全放进 `@[...]` 的标签。
     */
    function escapeLabel(label) {
      return label.replace(/[\\\]]/gu, match => '\\' + match)
    }

    /**
     * 拼一条规范的会话引用 mention。
     * @param sessionId - 目标会话 id。
     * @param label - 显示标题（原生用 displayTitle ?? label）。
     * @returns `@[label](dsh-session:<base64url>)`。
     */
    function encodeMention(sessionId, label) {
      return '@[' + escapeLabel(label) + '](dsh-session:' + base64url(JSON.stringify(sessionId)) + ')'
    }

    /**
     * 把一个文件 / 目录候选格式化成提及文本。复刻 dsh-file-reference/src/grammar.ts 的
     * `formatFileMention`：控制字符与双引号无法在编辑器语法里安全表达，直接丢弃该行；目录先
     * 补尾斜杠；带引号时目录留开引号不闭合，好让补全继续往下走。
     * @param candidate - `{ path, kind }`。
     * @param preserveQuote - 用户已主动打开引号（即 `req.quoted === true`）。
     * @returns 提及文本；无法表达时返回 undefined。
     */
    function formatFileMention(candidate, preserveQuote) {
      const path = candidate.kind === 'directory' ? candidate.path + '/' : candidate.path
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
      const quoted = preserveQuote || /\s/u.test(path)
      if (!quoted) return '@' + path
      if (candidate.kind === 'directory') return '@"' + path
      return '@"' + path + '"'
    }

    /**
     * 行是否需要自己承载「所在目录」。
     *
     * 原生判据等价于 `crumbsFor(...) === undefined`：只有「drill 过且 query 里确实有 `/`」时
     * 菜单头才画出面包屑，这时行再重复父目录就是噪音。插件不接管 `header`，面包屑仍由原生
     * 提供，所以必须用同一条件，两边才自洽。
     * @param query - 当前 query。
     * @param drilled - 菜单是否由 drill 打开或重新定界。
     * @returns true 表示行需要自带父目录。
     */
    function withLocationOf(query, drilled) {
      return !(drilled === true && query.lastIndexOf('/') >= 0)
    }

    /**
     * 以某个时间点（秒级）为「现在」，返回相对时间分桶，逐条照抄 ui-primitives 的 `relativeTime`。
     * @param updatedAt - 会话更新时间（毫秒）。
     * @param now - 当前时间（毫秒）。
     * @returns `{ unit, n }`；`unit === 'now'` 时 n 为 0。
     */
    function bucketOf(updatedAt, now) {
      const age = Math.max(0, now - updatedAt)
      if (age < MINUTE) return { unit: 'now', n: 0 }
      if (age < HOUR) return { unit: 'minutes', n: Math.floor(age / MINUTE) }
      if (age < DAY) return { unit: 'hours', n: Math.floor(age / HOUR) }
      if (age < MONTH) return { unit: 'days', n: Math.floor(age / DAY) }
      if (age < YEAR) return { unit: 'months', n: Math.floor(age / MONTH) }
      return { unit: 'years', n: Math.floor(age / YEAR) }
    }

    /**
     * 相对时间分桶，逐条照抄 ui-primitives 的 `relativeTime`。
     * @param updatedAt - 会话更新时间（毫秒）。
     * @param now - 当前时间（毫秒）。
     * @returns `{ unit, n }`；`unit === 'now'` 时 n 为 0。
     */
    function relativeTime(updatedAt, now) {
      return bucketOf(updatedAt, now)
    }

    /**
     * Windows 风格路径判定（照抄 dsh-util-workspace-path）：这类路径不做 `~` 缩写。
     * @param value - 待判定路径。
     * @returns 是否 Windows 风格。
     */
    function isWindowsStylePath(value) {
      return /^[A-Za-z]:[/\\]/u.test(value) || value.startsWith('\\\\')
    }

    /**
     * 把家目录前缀缩成 `~`（照抄 dsh-util-workspace-path 的 `abbreviateHomePath`）。
     * 宿主没给 home、或路径是 Windows 风格时原样返回，与原生表现一致。
     * @param path - 绝对路径。
     * @param home - 家目录。
     * @returns 可显示的路径。
     */
    function abbreviateHomePath(path, home) {
      if (home === undefined || home === '') return path
      if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path
      const root = home.replace(/\/+$/u, '')
      if (root === '' || root === '/') return path
      if (path.replace(/\/+$/u, '') === root) return '~'
      if (path.startsWith(root + '/')) return '~' + path.slice(root.length)
      return path
    }

    /**
     * 造一个「按原生键取文案」的翻译函数。
     *
     * 文案必须与原生同源：`reference` 命名空间由 ui-reference 注册，这里只是借用它的字典，
     * 不重新注册（重新注册会覆盖原插件的文案，且重启后两处字典会打架）。绑定结果缓存在
     * 闭包里：一次候选要取十几次文案，每次重新 bind 没必要。
     *
     * locale 同样是**可选**依赖：它只影响分组标题与相对时间的措辞，缺席时用 FALLBACK_COPY
     * 兜底即可，所以故意不写进 exports.inject。
     * @param ctx - 客户端 cordis 上下文。
     * @returns `t(key, params)`。
     */
    function makeCopy(ctx) {
      let bound
      let resolved = false
      const resolve = () => {
        if (resolved) return bound
        resolved = true
        try {
          const locale = ctx.get('locale')
          if (locale !== undefined && locale !== null && typeof locale.bind === 'function') {
            const candidate = locale.bind('reference')
            if (typeof candidate === 'function') bound = candidate
          }
        } catch {
          bound = undefined
        }
        return bound
      }
      return (key, params) => {
        const translate = resolve()
        if (translate !== undefined) {
          try {
            const value = translate(key, params)
            if (typeof value === 'string' && value !== '') return value
          } catch {
            /* 字典缺键时静默回落：一条文案不该拖垮整组候选 */
          }
        }
        const template = FALLBACK_COPY[key]
        if (template === undefined) return key
        if (params === undefined || params.n === undefined) return template
        return template.replace('{n}', String(params.n))
      }
    }

    /**
     * 构造一条会话候选行，语义对齐原生 `sessionCandidate`。
     * @param summary - 客户端快照里的会话摘要。
     * @param label - 显示标题。
     * @param section - 分组标题（子智能体 / 对话）。
     * @param now - 当前时间。
     * @param home - 宿主家目录，可能为 undefined。
     * @param sameWorkspace - 是否与当前会话同一工作目录。
     * @param t - 翻译函数。
     * @returns 候选行。
     */
    function sessionRow(summary, label, section, now, home, sameWorkspace, t) {
      // updatedAt 在契约里是 number，但快照是跨进程投影来的，缺字段时按「刚刚」处理而不是抛错。
      const updatedAt = typeof summary.updatedAt === 'number' ? summary.updatedAt : now
      const { unit, n } = relativeTime(updatedAt, now)
      const age = unit === 'now' ? t('time.now') : t('time.' + unit, { n })
      // 位置只在「不是当前工作区」时才提供信息；同工作区的行只说多久以前。
      const location = sameWorkspace
        ? undefined
        : summary.cwd === undefined ? t('candidate.noCwd') : abbreviateHomePath(summary.cwd, home)
      const value = { kind: 'session', label, mention: encodeMention(summary.id, label) }
      return {
        name: label,
        description: location === undefined ? age : location + ' · ' + age,
        icon: 'session',
        section,
        // value 必须是 JSON 字符串而不是对象：原生 onPick 对它做 JSON.parse，给对象会直接抛错。
        value: JSON.stringify(value),
      }
    }

    /**
     * 构造一组文件 / 目录候选行，语义对齐原生 `fileCandidate`。
     * @param items - `{ path, kind }` 列表。
     * @param preserveQuote - 用户已打开引号。
     * @param withLocation - 行是否自带父目录。
     * @param t - 翻译函数。
     * @returns 候选行数组。
     */
    function fileRows(items, preserveQuote, withLocation, t) {
      const rows = []
      for (const candidate of items) {
        if (candidate === undefined || candidate === null || typeof candidate.path !== 'string') continue
        const mention = formatFileMention(candidate, preserveQuote)
        if (mention === undefined) continue
        const slash = candidate.path.lastIndexOf('/')
        const name = candidate.path.slice(slash + 1)
        const parent = slash < 0 ? '' : candidate.path.slice(0, slash)
        const directory = candidate.kind === 'directory'
        const value = { kind: 'file', fileKind: candidate.kind, label: name, mention }
        rows.push({
          name: name + (directory ? '/' : ''),
          // 位置只说父目录：重复行上已有的名字没有信息量，工作区根条目也没有父目录。
          ...(withLocation && parent !== '' ? { description: parent } : {}),
          icon: directory ? 'folder' : 'file',
          section: t('section.files'),
          value: JSON.stringify(value),
          ...(directory ? { drill: true } : {}),
        })
      }
      return rows
    }

    /**
     * 从本地会话索引取会话候选。
     *
     * 为什么值得多这一层：客户端快照只包含「侧栏已加载」的会话，而磁盘上有全量 391 个，
     * 包括归档的、别的 profile 留下的、以及尚未被列表拉取的。用户要「最新 20 条」，
     * 按会话文件的修改时间取才准确。
     *
     * **永不等待**：host 侧是「内存索引 + 后台刷新」，这个 fetch 命中内存直接返回；
     * 索引还没建好时 host 会回 ok:false / index-warming，这里返回 undefined
     * 让调用方回退快照——绝不为了索引去 await 一次磁盘扫描。
     *
     * @param state - 插件运行态。
     * @param session - 当前会话投影。
     * @param query - @ 后的 query 文本。
     * @param signal - 取消信号。
     * @returns 候选 { child, row } 数组；索引不可用时返回 undefined。
     */
    /**
     * 把会话 id 归一化成可比较的键。
     *
     * 磁盘上的 id 有两种合法写法：`<uuid>` 与 `session-<uuid>`，实测各占约一半
     * （195 / 192）。同一组「父—子」关系里两侧写法可能不同——例如子会话的 id 是裸 uuid，
     * 而它的 `parentSession` 带 `session-` 前缀。直接用 `===` 比较会**静默失配**，
     * 表现为「子智能体分组消失」或「排除不掉自己」，且不报错、极难排查。
     *
     * 注意：只用于**比较**，不改写 id 本身——mention 解码依赖原始值。
     *
     * @param value - 原始 id。
     * @returns 归一化后的键；非字符串返回空串。
     */
    function sameSessionKey(value) {
      return typeof value === 'string' ? value.replace(/^session-/u, '') : ''
    }

    async function indexPathCandidates(state, session, query, signal) {
      if (INDEX_ENABLED !== true) return undefined
      if (signal !== undefined && signal.aborted) return undefined
      let payload
      try {
        payload = await fetchSessionsIndex(state, session, query, signal)
      } catch {
        return undefined
      }
      if (payload === undefined || payload === null || payload.ok !== true) return undefined
      const items = Array.isArray(payload.items) ? payload.items : []
      const self = sameSessionKey(session.sessionId)
      return items
        // 必须排除当前会话自身：原生 listCandidates 就排除它，不排会出现「引用我自己」。
        // 索引是全量的，宿主会话必然在其中；这条不能靠「反正列表里看不到」侥幸。
        .filter(item => item !== null && typeof item === 'object' && sameSessionKey(item.sessionId) !== self)
        .map(item => {
          // 分组判定以服务端的 `child` 为准：服务端已按「子智能体 / 对话」两组
          // 各自独立截断，前端必须用同一个判据，否则行会挂到错误的分组标题下。
          // 兜底：老服务端没有 child 字段时按 origin + parentSession 自行判定。
          const child = typeof item.child === 'boolean'
            ? item.child
            : item.origin === 'subagent' && sameSessionKey(item.parentSession) === self
          return {
            child,
            row: indexPathRow(state, item, state.t(child ? 'section.subagents' : 'section.sessions')),
          }
        })
    }

    /**
     * 把一条索引项转成候选行。
     *
     * 直接复用 sessionRow，让索引行与快照行的**字段、文案、value 结构完全一致**——
     * 这是必须的：onPick 对 value 做 JSON.parse 后按 kind 分派，字段不同就会静默退化。
     *
     * @param state - 插件运行态。
     * @param item - 索引返回的一条会话元数据。
     * @param section - 该行所属分组标题。
     * @returns 候选行。
     */
    function indexPathRow(state, item, section) {
      const label = typeof item.label === 'string' && item.label !== '' ? item.label : String(item.sessionId)
      // 把索引的元数据整成 sessionRow 认识的 summary 形状（它只用到 id / cwd / updatedAt）。
      const summary = {
        id: String(item.sessionId),
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        updatedAt: typeof item.mtimeMs === 'number' ? item.mtimeMs : Date.now(),
      }
      return sessionRow(summary, label, section, Date.now(), state.home(), item.sameWorkspace === true, state.t)
    }
    /**
     * 向 host 的 /fast-at/api/sessions.list 发一次查询。
     *
     * @param state - 插件运行态。
     * @param session - 当前会话投影（取 cwd 算 sameWorkspace）。
     * @param query - query 文本。
     * @param signal - 取消信号。
     * @returns 响应 JSON；失败返回 undefined。
     */
    async function fetchSessionsIndex(state, session, query, signal) {
      const snapshot = state.sessions.list.getSnapshot()
      const current = snapshot === undefined || snapshot === null || snapshot.byId === undefined
        ? undefined
        : snapshot.byId[session.sessionId]
      const cwd = current === undefined ? undefined : current.cwd
      const response = await fetch('/fast-at/api/sessions.list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // self 让服务端把「直接子智能体」与「对话」分成两组：对话按 CANDIDATE_LIMIT、
    // 子对话按 CHILD_LIMIT 各自独立截断。
        // 不下发 self 的话服务端无从判定 child，只会返回对话组。
        body: JSON.stringify({ query, limit: CANDIDATE_LIMIT, self: session.sessionId, ...(cwd === undefined ? {} : { cwd }) }),
        ...(signal === undefined ? {} : { signal }),
      })
      if (response.ok !== true) return undefined
      return response.json()
    }

    /**
     * 从客户端快照里挑出会话候选。
     *
     * 这段刻意与宿主 `listCandidates` 对齐：查询大小写不敏感地匹配 id / cwd / 标题；排序按
     * 「同工作区 → 无 cwd → 其它」（对应宿主 `candidateRank`）再按快照顺序；最后按同一上限
     * 截断，并**排除当前会话自身**（原生同样排除）。
     * @param state - 插件运行态。
     * @param session - 当前会话投影，只用 sessionId。
     * @param query - `@` 后的 query 文本。
     * @param snapshot - 会话列表快照。
     * @returns `{ child, row }` 数组。
     */
    function sessionCandidates(state, session, query, snapshot) {
      const byId = snapshot.byId === undefined || snapshot.byId === null ? {} : snapshot.byId
      const current = byId[session.sessionId]
      const currentCwd = current === undefined ? undefined : current.cwd
      const needle = query.toLocaleLowerCase()
      const now = Date.now()
      const home = state.home()
      const t = state.t

      const ranked = []
      let index = 0
      for (const id of Object.keys(byId)) {
        const summary = byId[id]
        if (summary === undefined || summary === null) continue
        // 原生 listCandidates 就排除当前会话自身，否则菜单里会出现「引用我自己」。
        if (summary.id === session.sessionId) continue
        const label = summary.displayTitle ?? summary.label ?? summary.id
        if (needle !== '') {
          const matched = summary.id.toLocaleLowerCase().includes(needle)
            || (summary.cwd !== undefined && summary.cwd.toLocaleLowerCase().includes(needle))
            || label.toLocaleLowerCase().includes(needle)
          if (!matched) continue
        }
        const sameWorkspace = summary.cwd !== undefined && summary.cwd === currentCwd
        const rank = sameWorkspace ? 0 : summary.cwd === undefined ? 1 : 2
        ranked.push({ summary, label, sameWorkspace, rank, index })
        index += 1
      }
      ranked.sort((a, b) => a.rank - b.rank || a.index - b.index)
      // 与索引层同一口径：对话取 CANDIDATE_LIMIT 条、子对话取 CHILD_LIMIT 条，
      // **各自独立**计数互不挤占。旧实现是混合截断，子智能体一多就会把对话整体挤出上限。
      const children = []
      const others = []
      for (const entry of ranked) {
        const summary = entry.summary
        // 与索引层同一口径：「子智能体」只放当前会话的直接子会话；
        // 「对话」只放普通会话，任何子会话都不进去。
        const isSubagent = summary.origin === 'subagent'
        if (isSubagent) {
          if (summary.parentId === session.sessionId && children.length < CHILD_LIMIT) {
            children.push({ ...entry, child: true })
          }
          continue
        }
        if (others.length < CANDIDATE_LIMIT) others.push({ ...entry, child: false })
        if (children.length >= CHILD_LIMIT && others.length >= CANDIDATE_LIMIT) break
      }
      return [...children, ...others].map((item) => ({
        child: item.child,
        row: sessionRow(
          item.summary,
          item.label,
          t(item.child ? 'section.subagents' : 'section.sessions'),
          now,
          home,
          item.sameWorkspace,
          t,
        ),
      }))
    }

    /**
     * 取文件 / 目录候选。`result.ok ? result.value : []`，与原生等价。
     * @param state - 插件运行态。
     * @param session - 当前会话投影。
     * @param query - `@` 后的 query 文本。
     * @param signal - 本轮的取消信号。
     * @returns 候选数组（可能为空）。
     */
    async function fetchFileItems(state, session, query, signal) {
      const result = await state.fileReferences.list(session.sessionId, query, signal)
      if (signal !== undefined && signal.aborted) return []
      if (result === undefined || result === null || result.ok !== true) return []
      return Array.isArray(result.value) ? result.value : []
    }

    /**
     * 计算一整轮候选：文件行 → 当前会话的直接子智能体 → 其它会话。
     * @param state - 插件运行态。
     * @param session - 当前会话投影。
     * @param req - 候选请求（query / quoted / drilled / signal）。
     * @returns 候选行数组。
     */
    async function computeCandidates(state, session, req) {
      const signal = req === undefined ? undefined : req.signal
      // abort 之后不得再提交结果：controller 每次击键都会 abort 上一轮，迟到的旧结果会覆盖
      // 新渲染（表现是候选闪一下就没）。
      if (signal !== undefined && signal.aborted) return []
      const query = req !== undefined && typeof req.query === 'string' ? req.query : ''
      const snapshot = state.sessions.list.getSnapshot()
      // 冷启动：首个列表 pull 还没落地时快照不可信。规格决策是「不等待、不预热」——预热本身
      // 就是一条请求，正好是要绕开的链路。返空让菜单自动收起，不用再等 2 秒。
      if (snapshot === undefined || snapshot === null || snapshot.phase !== 'ready') return []

      const quoted = req !== undefined && req.quoted === true
      const drilled = req !== undefined && req.drilled === true
      // 引号路径里写的是路径而不是会话标题，原生在 quoted 时直接把会话查询短路掉。
      // 会话候选：先试本地会话索引（全量数百个会话，不受客户端已加载列表限制），
      // 拿不到就回退客户端快照。**任何情况都不回落原生**（那会重新引入 2 秒延迟）。
      // 引号路径里写的是路径而不是会话标题，原生在 quoted 时直接短路。
      const sessionItems = quoted === true || sessionsEnabled() !== true
        ? []
        : (await indexPathCandidates(state, session, query, signal)) ?? sessionCandidates(state, session, query, snapshot)
      const withLocation = withLocationOf(query, drilled)

      const key = [session.sessionId, query, quoted ? '1' : '0', drilled ? '1' : '0'].join('\u0000')
      const cached = state.cache.get(key)
      if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows

      let fileItems = []
      try {
        fileItems = await fetchFileItems(state, session, query, signal)
      } catch {
        // 文件侧失败不能把会话行也拖没：原生也只是把这一半当空数组。
        fileItems = []
      }
      if (signal !== undefined && signal.aborted) return []

      const rows = [
        ...fileRows(fileItems, quoted, withLocation, state.t),
        ...sessionItems.filter(item => item.child).map(item => item.row),
        ...sessionItems.filter(item => !item.child).map(item => item.row),
      ]
      // 只缓存「确实有文件行」的结果：空结果缓存久了会让刚新建的文件 3 秒内看不见。
      if (fileItems.length > 0 && (signal === undefined || !signal.aborted)) {
        state.cache.set(key, { at: Date.now(), rows })
        pruneCache(state)
      }
      return rows
    }

    /**
     * 缓存条目超过上限时丢掉最早写入的那些（Map 保持插入顺序）。
     * @param state - 插件运行态。
     */
    function pruneCache(state) {
      while (state.cache.size > CACHE_MAX) {
        const oldest = state.cache.keys().next()
        if (oldest.done === true) return
        state.cache.delete(oldest.value)
      }
    }

    /**
     * 插件装配：探测运行时契约、包住现有的与后注册的 `@` 源，并登记完整还原。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      const sessions = ctx.get('sessions')
      const inputTriggers = ctx.get('inputTriggers')
      // 版本探测：任一项不成立就不包装、只记日志、不抛错。依赖的是 asar 内的私有实现
      // （live.sources 是 TS private），升级后字段改名时不能把输入框搞废。
      if (sessions === undefined || sessions === null
        || sessions.list === undefined || typeof sessions.list.getSnapshot !== 'function') {
        console.warn('[dsh-fast-at] sessions.list.getSnapshot 不可用，不启用 @ 候选提速')
        return
      }
      if (inputTriggers === undefined || inputTriggers === null
        || typeof inputTriggers.registerSource !== 'function') {
        console.warn('[dsh-fast-at] inputTriggers.registerSource 不可用，不启用 @ 候选提速')
        return
      }
      // live 是 TS private（不是 #private 字段），运行时可读；只能靠它枚举已注册的源。
      const live = inputTriggers.live
      if (live === undefined || live === null || !Array.isArray(live.sources)) {
        console.warn('[dsh-fast-at] inputTriggers.live.sources 不可用，不启用 @ 候选提速')
        return
      }

      // remote 是**必需**依赖（与原生 ui-reference 的 inject 声明一致：'remote', 'remote.fileReferences'）。
      //
      // 为什么不能当可选：文件候选由本插件自己重取（原生那段 fileReferences.list 不会执行了），
      // 它靠的就是 remote.fileReferences。一旦拿不到而"优雅降级"成空数组，界面上表现为
      // **文件候选静默消失** —— 菜单能开、会话行也在，但 @ 文件名永远没结果，极难排查。
      // 宁可在装配期就判定不可用、不启用包装（用户回落到原生 2 秒），也不给出半残状态。
      const remote = ctx.get('remote')
      const fileReferences = remote === undefined || remote === null ? undefined : remote.fileReferences
      if (fileReferences === undefined || fileReferences === null || typeof fileReferences.list !== 'function') {
        console.warn('[dsh-fast-at] remote.fileReferences 不可用，不启用 @ 候选提速（文件候选无法重取）')
        return
      }
      const state = {
        ctx,
        sessions,
        /** remote 命名空间：装配期已确认可用，之后是稳定引用。 */
        remote,
        /** 文件候选接口，装配期已确认 list 可用。 */
        fileReferences,
        t: makeCopy(ctx),
        /** query 键 → `{ at, rows }` */
        cache: new Map(),
        /** 源 → 原 candidates，用于还原 */
        restores: new Map(),
        /** 宿主家目录；拿不到就返回 undefined（abbreviateHomePath 会原样返回路径）。 */
        home: () => {
          const host = state.remote.$host
          const value = host === undefined || host === null ? undefined : host.home
          return typeof value === 'string' ? value : undefined
        },
      }

      /**
       * 把一个 `@` 源的 `candidates` 换成快照查询；同一源只包一次。
       * @param source - 待包装的源。
       * @returns 是否发生了包装。
       */
      function wrap(source) {
        if (source === undefined || source === null) return false
        if (source[WRAP_MARK] === true) return false
        // 纯回显源没有候选可提速，包了只会多出无效分组并把选中退化成纯文本（见名单注释）。
        if (NON_CANDIDATE_SOURCES.indexOf(source.name) >= 0) return false
        if (typeof source.candidates !== 'function') return false
        const original = source.candidates
        // 用 function 而不是箭头函数：原契约里的 this 虽然没被用到，但保留普通函数的调用语义。
        source.candidates = function candidates(session, req) {
          // 诊断开关：短路时立刻返回空，不进入 computeCandidates。
          if (shortCircuit()) return Promise.resolve([])
          // 诊断开关：整体停用时转调原实现，等价于没装插件（用于测原生基线）。
          if (pluginDisabled()) return original.call(this, session, req)
          return computeCandidates(state, session, req).catch(() => [])
        }
        source[WRAP_MARK] = true
        state.restores.set(source, original)
        return true
      }

      /**
       * 还原单个源的 `candidates`。
       * @param source - 已包装的源。
       */
      function unwrap(source) {
        const original = state.restores.get(source)
        if (original === undefined) return
        source.candidates = original
        delete source[WRAP_MARK]
        state.restores.delete(source)
      }

      // 1) 已在册的 @ 源。遍历所有 trigger === '@'，不硬编码 name === 'reference'：以后装了
      //    别的「会拉慢候选」的 @ 源插件时，硬编码会漏包它。纯回显源由 wrap 内的名单排除，
      //    两条路径（这里与 registerSource 劫持）共用同一个 wrap，因此豁免自动生效。
      for (const source of live.sources.slice()) {
        if (source !== undefined && source !== null && source.trigger === '@') wrap(source)
      }

      // 2) 劫持 registerSource，兜住晚注册的 @ 源——装配先后顺序不保证，注册表才是唯一权威。
      const previousRegister = inputTriggers.registerSource
      inputTriggers.registerSource = function registerSource(source) {
        const applied = source !== undefined && source !== null && source.trigger === '@' ? wrap(source) : false
        try {
          return previousRegister.call(this, source)
        } catch (error) {
          // 注册被拒（(trigger, name) 重复会直接 throw）时把包装撤回，不留一个永不调用的改写。
          if (applied) unwrap(source)
          throw error
        }
      }

      // 3) 登记还原：卸载时把 registerSource 与每个源的 candidates 都改回去，并清空记账。
      //    用 effect 的返回 disposer 而不是自己监听生命周期，插件被禁用 / 重载后不留残留。
      ctx.effect(() => () => {
        inputTriggers.registerSource = previousRegister
        for (const source of [...state.restores.keys()]) unwrap(source)
        state.cache.clear()
      }, 'dsh-fast-at: @ 源 candidates 包装')
    }

    exports.apply = apply
    /**
     * 必需依赖：缺任意一项插件都无法工作，cordis 会在服务缺席时不加载本插件。
     *
     * - `sessions`：会话快照，候选行的唯一数据源。
     * - `inputTriggers`：要包装的源注册表。
     * - `remote` + `remote.fileReferences`：文件候选由本插件自己重取（原生那段不再执行），
     *   与原生 ui-reference 的声明完全一致（`src/client/index.ts:46-49`）。
     *   **不能当可选**：拿不到就会让文件候选静默消失（见 apply 里的说明）。
     *
     * `locale` 仍然是可选依赖，故意不列：它只提供分组标题文案，缺席时走 FALLBACK_COPY 中文兜底，
     * 其余功能不受影响——列进 inject 反而会让本插件在 locale 缺席时整个不加载。
     */
    exports.inject = ['sessions', 'inputTriggers', 'remote', 'remote.fileReferences']
    return module.exports
  },
})