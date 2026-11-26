# dsh-fast-at

去掉 `@` 引用候选的 2 秒等待。

## 要解决的问题

在输入框键入 `@`，候选菜单骨架 45–58ms 就出现，但**内容行要 1.9–2.7 秒**；`@` 搜索会话同样约 2 秒。

慢的不是接口，是接口被调用时对宿主的抢占：`@` 下唯一会跑会话列举的源是内建
`reference`，它调 `sessionReferenceResolver.candidates` → 宿主 `listCandidates()`
→ `sessionQuery.listSessions()`。这一步在宿主侧把 CPU/事件循环占满，同一窗口内
**完全无关**的请求（`settings.get`、`session.phase`）也被卡到秒级、并在同一毫秒一起
放行；而同一接口裸 fetch 只要 15–139ms。

## 做法

三件事，各管一层：

### 1. 候选查询：原位包装 `@` 源的 `candidates`

包装 `ctx.inputTriggers` 下所有 `trigger === '@'` 的源的 `candidates`，让原生那条
`listSessions` 调用**根本不再发生**。会话候选的来源见下文第 2 节。

文件候选用插件自己取（`remote.fileReferences.list` 只要 15ms，不触发 `listSessions`）。
这一步不能省——替换整个 `candidates` 会让原生那段 `fileReferences.list` 整段不执行，
`@ 文件名` 将没有任何结果，属于功能回退。

文件与目录候选的格式（引号规则、目录尾斜杠、`drill`、`section`、`withLocation`）逐条
对齐原生的 `formatFileMention` / `fileCandidate`，因此装与不装的文件行逐字段一致。

### 2. 会话候选：纯 JS 磁盘索引

客户端快照只包含「侧栏已加载」的会话，而磁盘上有全量数百个。用户要「按会话文件修改时间
取最新 20 条」，只有读磁盘才准确。

`dsh-fast-at/lib/sessions-reader.js`（host 侧唯一碰磁盘的模块，**纯 JS，无子进程**）
扫 `~/.dsh/sessions`：

- **只解第一帧**取 header（实测第一帧 max 245 字节，不必读最大 782KB 的整个文件）
- 按会话文件 `mtime` **倒序**
- 补标题：**对话全量补**（176 个约 663ms）；**子对话只补一次**——补到就落盘，
  之后重建直接沿用缓存里的标题，只剩判断开销（实测稳态 query 0.18–0.73ms）。
  `@` 时若发现当前会话的子对话缺标题，同步补前 10 条、其余异步补。
  取名**优先读 `subagent/descriptor.label`**（子智能体真名，与界面顶部面板一致），
  拿不到才退回 `session/title`（那可能是首条消息截断的 fallback 名）

配套的是**落盘缓存 + 内存索引**：

- 索引落盘为 **JSONL**：`~/.dsh/storages/fast-at-sessions.jsonl`
  （每行一条会话、按 mtime 降序，实测 324 条 = 79KB，人工可读可 diff）
- **启动**：先读缓存文件（实测 **1.3ms**，`@` 立刻可用），再无条件后台重建一次
- `@` 时**纯内存查询**（实测 **0.03–0.08ms**），零磁盘
- **惰性刷新，没有定时器**：只有 `@` 时发现索引超过 **30s** 才 `void` 后台重建。
  重建**从不进入等待路径**——本次查询仍用旧索引秒回，用户继续输入的过程中
  自然消化掉那几百毫秒。CPU 只在真正使用 `@` 时才消耗。
- **原子写**：先写 `.tmp` 再 `rename`，读取方不会看到半截文件
- **降级**：缓存缺失 / 整份损坏 / 中间坏行 → 当作没有缓存并当场重建，**绝不返空**
  （坏行逐行跳过，好行保留）

> **为什么不能每次 `@` 都扫盘**：Windows 下数百个目录 ×（三次 `readdir` + 一次 `stat`）
> 的固有成本就近 130ms，加上解压 90–130ms。物理上无法稳定满足 300ms 判据。
> 索引模型让**用户感知延迟与索引构建耗时解耦**。
>
> **为什么全部用 `fs/promises` 而不是同步 API**：同步 fs 会把整个宿主的事件循环
> 钉住整段索引构建时间（实测旧 Rust 子进程方案就是这种形态：无关请求一起卡 1534ms）。
> 现在 785ms 的重建期间，事件循环最大只停顿 30.8ms。
>
> **为什么落盘**：进程内索引每次启动都要重建（实测 **419ms**），而读缓存文件只要 **1.3ms**，
> 省掉 99.7%。不用 sqlite——纯文本 JSONL 就够，还省一个依赖。
>
> **为什么查询不流式读文件**：文件只有 79KB。实测流式读 20 条 **1.362ms**，
> 比一次读完再取前 20（**0.936ms**）还慢 45%，比内存索引（0.03–0.08ms）慢 40 倍。
>
> **为什么不再有 Rust**：会话搜索排序本身 JS 只要 0.014–0.057ms（数百条），
> 20ms 判据有 100 倍以上余量——要到 3.5 万条才触及 20ms。整段索引重建 JS 与 Rust
> 同一量级（各 250–365ms，谁快随整机负载反转），没有稳定的性能理由维护一个需要
> cargo 构建的二进制。实测数据见 `.scratch/task1-measurements.md`。

host 半通过 `ctx.webServer.register` 把索引查询暴露成 `/fast-at/api/sessions.list`，
浏览器半 `fetch` 它。鉴权用 `ctx.connection.requestRejection`。

### 3. 三级降级：任何情况都不回原生

```
T1 本地会话索引  →  T2 客户端快照  →  T3 空数组
```

索引带来几类新失败面（目录不可读、zstd 帧损坏、header JSON 非法、磁盘异常）。
返空会让用户**彻底失去 `@` 会话能力**，比原生慢 2 秒更糟；而快照回落是零请求的现有代码。
所以失败一律回退快照，**任何情况都不调原生 `candidates`**。

不做的事：不新注册 `@` 源、不禁用内建 `dsh-client-ui-reference`、不碰 `header` /
`lexicon` / `warm` / `codec` / `onPick` / `openReference`。

### 包装哪些 `@` 源（维护约定）

`@` 下的源不都提供候选。包装前用 `NON_CANDIDATE_SOURCES` 名单跳过**语义不同的源**：

| 源 | 来源 | 为什么不包 |
|---|---|---|
| `betterSidebarQuote` | dsh-better-sidebar | 纯回显源，`candidates` 恒 `[]`、`onPick` 恒 `'handled'`。包了会多出无效分组，选中退化成纯文本 |
| `主机` | ds-harness-remote | 候选是**在线远程设备**，`onPick` 返回 `{ text: '@设备名 (Remote hostId=…)' }`。包了会把设备分组换成会话行，选中插入 `@… (Remote hostId=undefined)` 垃圾 |

**新增 `@` 源插件时按下表处理**：

| 新装的 `@` 源属于 | 要做什么 |
|---|---|
| 会产出会话/文件候选、要跑宿主列举（会拉慢） | 不用改代码，`wrap` 会自动包装它 |
| 纯回显（`candidates` 恒空 / `onPick` 恒 `handled`） | **把 `name` 加进 `NON_CANDIDATE_SOURCES`** |
| 语义不同（候选不是会话/文件引用） | 同上 |

## 边界与已知限制

| 项 | 说明 |
|---|---|
| 依赖私有实现 | `inputTriggers.live.sources` 是 TS private 字段（运行时可读）。探测不成立时**不启用包装**、只 `console.warn`，不抛错。 |
| 索引新鲜度 | 索引 TTL 30s；**新建会话最迟约 30 秒后**（下次按 `@` 时触发重建）出现在 `@` 候选里。 |
| 标题覆盖 | **对话全量补**（176 个约 663ms）；**子会话只补当前会话的**，且 `@` 时若发现缺标题会同步补前 10 条、其余异步补。预算外的回落显示 sessionId。 |
| 标题匹配 | 原生还按子智能体标签匹配，该值不在磁盘索引里；插件按 `label` 匹配。 |
| 排序 | **mtime 倒序为主**（用户要求），`candidateRank` 作次级键。 |
| 展示上限 | 展示 **20** 条（用户明确要求），但**搜索范围是全量索引**（过滤在内存里对全量做）。 |
| 冷启动 | `phase` 不是 `ready` 时返空数组：不等待、不预热。 |
| 失败行为 | 一律回退客户端快照，不抛错、不回落原生。 |

## 安装

本插件是纯 JS，**不需要编译任何二进制**，也没有 `cargo` / Rust 工具链依赖。

从 GitHub 子目录安装（`<sha>` 取本仓当前 HEAD；pwsh / bash 下 `#` 与 `&` 是保留字符，
spec 必须整体加引号）：

```sh
dsh plugin --profile desktop add 'github:lengduan/my-dsh-plugins#path:dsh-fast-at&<sha>'
```

本地联调也可以用 link：

```sh
dsh plugin --profile desktop add 'dsh-fast-at@link:C:\lengduan\githubs\my-dsh-plugins\dsh-fast-at'
```

> **装完必须重启 DSH 桌面客户端。** 浏览器半的改动可以热加载，
> 但 host 半的路由注册（`ctx.webServer.register`）只在启动时装配。

## 卸载

用插件管理器（推荐，会同时取消选中并热重载）：

```
plugin_manager action=remove_bundle target=dsh-fast-at
```

或手工：

```sh
dsh plugin --profile desktop remove dsh-fast-at
```

所有改写都经 `ctx.effect` 登记还原 disposer：卸载后 `registerSource`、每个源的
`candidates`、`/fast-at/api` 路由、内存索引都会回到原值。

> 注意：`pnpm remove` 会留下 `node_modules/dsh-fast-at` 的 **junction 残留**，
> 需 `cmd /c rmdir` 手工清理（删前确认 `LinkType=Junction`，别删到仓库源）。

## 测试

```sh
node tests/all.mjs
```

六个套件共 **188 项断言**：纯函数 64、打包契约 42、冒烟 18、client T1 回归 11、host 读取层集成 35、缓存落盘 17。

单独跑：

```sh
node tests/test-pure.mjs          # 纯函数
node tests/test-packaging.mjs     # 打包契约
node tests/test-smoke.mjs         # 包装/还原
node tests/client-t1.mjs          # client T1 回归（D1/D2，可用变异验证）
node tests/integration-reader.mjs # host 读取层集成（索引/契约/过滤/失败路径）
node tests/integration-cache.mjs  # 缓存落盘（JSONL/原子写/损坏降级）
node tests/check-live.mjs         # 重启 DSH 后验证 /fast-at/api 路由
```

> `tests/client-t1.mjs` 是**真回归测试**：把 `client.js` 的 `sameSessionKey` /
> `indexPathCandidates` 提取出来直接调用并配合 fetch 桩，不启浏览器。
> 已验证「把 D1 缺陷退回 origin-only 判据」时它会变红（`tests/all.mjs` exit 1）。

## 验收

以 `specs/@引用候选提速插件.md` 的「校验与验收」为准，要点：

1. `@` 后**内容行**（不是骨架）首次出现 < 300ms（基线 1962–2680ms）。
2. `@` 期间 `settings.get` / `session.phase` 全部 < 200ms。
3. `@` 下不再出现 `/api/sessionReferenceResolver/candidates` 请求。
4. 选中会话候选后草稿里的 mention 能被宿主解析并作为引用发出，聊天记录里可点击。
5. 卸载后 `@` 恢复基线耗时；`cordis.patch.yml`、`package.json`、`node_modules` 三处无残留。
6. 装/卸两态的文件候选逐字段等价（`name` / `description` / `section` / `drill` / `value`）。

## 回滚

不用卸载，改一个常量：

```js
// dsh-fast-at/lib/client.js
const INDEX_ENABLED = false   // 完全回到客户端快照实现
```