# @ 卡顿排查日志（时间线）

---

> ## ⚠️ 新读者读法
> 
> 本文档有 45 个章节，混杂了**至少 4 个不同问题**的排查记录。直接从头读会被历史结论带偏。
> 
> **正确读法：**
> 1. 先读下方「章节有效性对照」，只信标记 ✅ 的章节。
> 2. **§44**（@ 菜单偶发 1–4 秒延迟，P4 根因）、**§45**（长按 @ 卡顿，P1 机制）是当前有效结论。
> 3. 其余章节按需查阅，**不要当结论用**。
> 
> 历史上的 `HANDOFF.md` / `HANDOFF-*.md` 交接文档已于 2026-11-26 删除：
> 它们的结论已全部沉淀进本文件的有效章节，保留副本只会产生与实测冲突的口径。
> 
> ## 章节有效性对照
> 
> | 章节范围 | 状态 |
> |---|---|
> | §0 – §40 | **历史**。期间结论多数被后续推翻（§5–§8 是明确的误判记录，§25 推翻了 §24，§41/§43 被 §44 推翻） |
> | §41 | ❌ **已被 §44 推翻**。曾以为 `settings.get` 是元凶 |
> | §42 | ✅ 有效。会话区滚动卡顿与皮肤无关（独立问题，与 @ 无关） |
> | §43 | ❌ **已被 §44 推翻**。曾以为「空结果不缓存」是元凶 |
> | **§44** | ✅ **有效**。@ 菜单偶发 1–4 秒延迟（P4）的根因 |
> | §17 / §23 | ❌ **归类已被 §45 修正**。当时记作「强制布局」，实为**样式重算** |
> | **§45** | ✅ **有效**。长按 @ 卡顿（P1）的真正机制：光 DOM 样式重算 + 全局 CSS 规则量 |
> 
> ## 当前问题是什么（别和 P1/P2/P3 混淆）
> 
> | 编号 | 问题 | 与当前问题的关系 |
> |---|---|---|
> | P1 | 长按 @ 连续输入卡顿（每键几十 ms） | **无关**，机制见 §45（样式重算 + 全局 CSS 规则量） |
> | P2 | 删除路径小卡顿 | **无关**，已解决 |
> | P3 | 会话区滚动偶发卡顿 | **无关**，已查清是首滚一次性布局 |
> | **P4** | **@ 菜单偶发 1–4 秒延迟** | **← 见 §44** |
>
> ## ⚠️ 时效性声明：文中「better-sidebar 已禁用」的表述已全部失效
>
> **2026-11-26 起，`dsh-better-sidebar` 处于启用状态**（用户为自行试用而重新开启）：
> - 运行时：`include:better-sidebar = true / active`
> - 配置：`cordis.patch.yml:260-261` → `disabled: false`
>
> 因此下列章节里「已禁用」「disabled: true」「已持久化」的说法**只描述当时的实验状态，不是当前事实**：
> **§32**（当前状态）、**§35**（交付状态）、**§37**（交付状态）、**§38**（交付清单）、**§39**（测量口径）。
>
> 这些章节内的「`cordis.patch.yml:260-261` → `disabled: true`」引用同样失效：那两行现在是 `disabled: false`。
>
> **恢复禁用**：把 `cordis.patch.yml` 第 260-261 行改回 `disabled: true` 并重启宿主，
> 或用 `plugin_manager set_plugin(target="include:better-sidebar", enabled=false)` 运行时生效。
> 
> ---
> 
> **以下是原文，保持不变以便追溯。**

> **这份文档是活文档。** 每次归因、排查都要在末尾追加记录：路线、方案、结果、出错原因。目的是**避免重复排查已经查清或已经排除的问题**。
>
> 动手前先读 §0（当前结论）和 §9（已排除清单），能省掉整轮试错。

---

> **2026-11-24 第三轮更正（先读）：** 此前所有绝对数字都**带着动画开销**（我没显式开 freezeAnimations）。
> 动画冻结后重测：骨架 **69ms**、候选行 **1115ms**、fileReferences **925ms**、fast-at **102ms**。
> 动画污染约 40%，但候选行仍是目标的 3.7 倍。**瓶颈结论不变**。详见 §15。
>
> **2026-11-24 第二轮更正：** §0/§9 的归因只覆盖「菜单骨架 110ms」。
> 候选行真正出现要 **冷态 1848ms / 热态 271ms**，瓶颈是 DSH 原生 `api/fileReferences/list`（服务端 1.5–2.3 秒，响应仅 684 字节）。
> 详见 **§14**。优化优先级已因此调整：接管 fileReferences > 优化布局读取。
## 0. 当前唯一有效的结论（先读这个）

**一次 `@` 击键慢，根因不在 `dsh-fast-at` 插件，而在 DSH 自己的两处代码：**

| 环节 | 位置 | 耗时（6 轮合计） |
|---|---|---|
| `getBoundingClientRect` 同步布局 | 97.6% 来自 `UH` hook 里的 `c()` @ `index-Ciz7DZxv.js:129:123673` | **826.8ms / 1091 采样** |
| `setBaseAndExtent` 设置选区 | Draft.js 的 `Ur` @ `/plugins/:2644` | **328.2ms / 472 采样** |

**触发链**：

```
输入 @  →  React 提交 DOM 变更（菜单挂载）
        →  Draft.js jr()（setSelection）要把字符偏移量映射回 DOM 节点
        →  Hr() 遍历叶子节点，期间反复读布局
        →  UH hook 的 c() 也读 getBoundingClientRect().bottom
        →  一次击键累计 134 次同步布局读
        →  每次读之间夹着写 → 反复触发完整重排 → 约 100ms
```

**实测数字**：菜单有内容时 98–167ms / 114–134 次 gBCR；菜单空时 67–70ms / 78–113 次。

---

## 1. 时间线总览

| # | 阶段 | 我做了什么 | 结论 | 是否正确 |
|---|---|---|---|---|
| 1 | 建插件 | 包装 `candidates`，零请求本地快照替代 | 首屏 1962–2680ms → 226ms | ✅ 成立 |
| 2 | Rust 会话候选 | Rust 扫磁盘按 mtime 排序取 20 条 | 功能可用，但解析性能只比 JS 快 10% | ✅ 成立（但收益小） |
| 3 | 用户报「按住 @ 卡」 | 改为测连续输入而非首屏 | 找到「每次击键一个长任务」 | ✅ 方向正确 |
| 4 | 误判 A | 认为 116ms 是 DSH 固定成本 | 被真实键盘对照推翻（`@` 220ms vs `x` 129ms） | ❌ 已推翻 |
| 5 | 误判 B | 认为 78% 是 `measure()` 的 74 次 gBCR | 被「假值实验」推翻（142ms → 142ms） | ❌ 已推翻 |
| 6 | 误判 C | 认为 220ms 是真实值 | 是测量错误（清空编辑器污染） | ❌ 已推翻，实测约 105ms |
| 7 | 误判 D | 认为 105ms 「无法归因」 | 被 CDP Profiler 推翻 | ❌ 已推翻 |
| 8 | **正解** | CDP CPU Profiler + 采样 0.1ms | **Draft.js 选区恢复 + UH hook 的 134 次同步布局** | ✅ 当前唯一有效结论 |

---

## 2. 阶段 1：插件立项（问题本来是「首屏慢」）

**用户诉求**：

> 核心做法：原位包装 @ 引用源的 candidates 方法，用零请求的本地快照查询替换原实现，使 @ 后内容行出现时间从 1962–2680ms 降到 300ms 以内。

**做法**：劫持 `registerSource`，包 `source.candidates`，用 `sessions.list.getSnapshot().byId` 本地查表。

**结果**：首屏内容行 **1727ms → 226ms**（7.6×）。

**当时没意识到的事**：首屏快 ≠ 输入流畅。这是后面所有弯路的总根源。

---

## 3. 阶段 2：Rust 会话候选

**用户诉求**：

> 下一步是用rust来获取历史会话，按照文件修改时间排序取最新的20条会话列表按listSeenssion的格式返回回来

**做法**：Rust 二进制扫 `~/.dsh/sessions`，按文件 mtime 排序，取最新 20 条。

**结果**：功能可用。但后面 §5 的对比显示 **Rust 96.76ms vs JS worker 106.34ms，只快 10%**，在噪声内。

**教训**：性能归因没做之前，不要先优化「看起来慢」的部分。

---

## 4. 阶段 3：用户第一次说「还是卡」

**用户原话**：

> 我@之后虽然看似比之前快了一点，但是我连续输入@，比如按照这个键不放，输入非常的卡顿不流畅

**这句话改变了测量口径**：从「首屏延迟」变成「连续输入的流畅度」。

**当时测到的**：

- 20 次连发 `@` → 22 个 long task
- 20 次连发普通字母 → 极少 long task

**方向对的**，但下面的归因连着错了四次。

---

## 5. ❌ 误判 A：把 116ms 当成 DSH 的固定成本

**错误论断**：116ms 是 DSH 每个击键的固有开销，无法消除。

**推翻实验**：真实键盘对照（不用 `execCommand`）

| 字符 | 中位耗时 |
|---|---|
| `@` | 220ms |
| `x` | 129ms |

**+`@` 比普通字符多 91ms**，不是固定成本。**论断被推翻。**

### 错误原因

用 `execCommand('insertText')` 模拟输入。它和真实键盘的事件序列不同（没有 `keydown` → `beforeinput` → `input` 的完整链），把两件事混成了一件。

### 以后的规矩

**测输入延迟必须用真实键盘事件，不能用 `execCommand`。**

---

## 6. ❌ 误判 B：把 78% 帧时间归给 `measure()` 的 gBCR

**错误论断**：LoAF 报告 `forcedStyleAndLayoutDuration` 占 78%，来源是 `measure()` 里的 74 次 `getBoundingClientRect`。

**推翻实验**：把 `Element.prototype.getBoundingClientRect` 换成一个返回零尺寸假值的函数。

| 配置 | 耗时 |
|---|---|
| 正常 | 142ms |
| gBCR 返回假值 | **142ms** |

**完全没变。论断被推翻。**

### 错误原因

两个叠加的错误：

1. `forcedStyleAndLayoutDuration` 统计的是**整帧内所有**强制布局，包括 React 自己提交 DOM 引发的重排，不全是 gBCR 读出来的
2. 更致命：**换成假值会让调用方提前返回**，遍历次数从上百掉到个位数——**把要测的东西测没了**

### 这个坑第三次踩到

§10 的 CDP 结论出来后才明白：假值让 `Hr` 提前返回，134 次遍历变成几次。所以「没变化」不是「gBCR 不重要」，而是「实验把变量消除了」。

### 以后的规矩

**替换函数做对照实验时，必须确认替换后调用路径和次数不变**，否则测的是另一个程序。

---

## 7. ❌ 误判 C：220ms 是测量错误，`@` 与普通字符几乎一​​样

**错误论断**：一次 `@` 要 220ms。

**推翻实验**：LoAF 严格对照，每轮先 Escape 关菜单 + 等 1s，各 5 轮。

| 轮次 | `@` | `x` |
|---|---|---|
| 1 | 145ms | 92ms |
| 2 | 103ms | 97ms |
| 3 | 125ms | 113ms |
| 4 | 105ms | 104ms |
| 5 | 107ms | 103ms |
| **中位** | **107ms** | **103ms** |

**仅差 4ms。论断被推翻。**

### 错误原因

每轮用 `Control+a` + `Delete` + `Backspace×3` 清空编辑器，把「清空后的首次重排」也算进了 `@` 的成本。

### 但这又引出一个新矛盾

如果 `@` 和 `x` 一样快，用户为什么觉得 `@` 卡？

答案在 §10：**测试时菜单一直是打开的**（上一次 `@` 留下的），所以 `x` 那轮也在付同样的代价。这个对照本身设计错了。

---

## 8. ❌ 误判 D：说「105ms 无法归因」

**错误论断**：这 105ms 是一段不产生 DOM 变更、不等待请求的同步 JS，我归因不了，需要用户配合抓火焰图。

**推翻方式**：用户指出「你用无头浏览器拿不到这些信息吗」。确实能——browser_e2e 有 `auth_export` 能导出登录 cookie，配 `--remote-debugging-port=9222` 就能连。

### 错误原因

**我放弃得太早。** 当时试了三条路都失败了：

| 尝试 | 失败原因 |
|---|---|
| 自己起 Edge 连 GUI | 401，DSH 靠宿主动态补票，外部浏览器进不去 |
| `browser_e2e` 的 CDP 模式 | 用 `--remote-debugging-pipe`，没有端口可连 |
| `cdpCopyProfile` | Edge 正在运行，profile 被占用（EBUSY） |

然后就停了。**正确做法是把三条路的零件拼起来**：

```
browser_e2e_auth_export  →  拿到登录 cookie（它自己会补票）
playwright chromium.launch({ args: ['--remote-debugging-port=9222'], storageState })
  →  无头浏览器带登录态 + 有调试端口
  →  Profiler.enable + setSamplingInterval(100)
  →  抓到真正的 CPU profile
```

### 以后的规矩

**「需要用户配合」之前，先把已有工具的零件重新组合一遍。** 失败的路不代表方向错，常常只是少拼一块。

---

## 9. ✅ 阶段 4：CDP Profiler 定论

**方法**：

- `browser_e2e_auth_export` 导出 cookie（1 cookie / 1 origin）
- `chromium.launch({ channel: 'msedge', headless: true, args: ['--remote-debugging-port=9222'] })` + `storageState`（headless，不弹窗）
- `Profiler.enable` + `setSamplingInterval({ interval: 100 })`（0.1ms）
- 6 轮「打一个 @」，每轮 `Profiler.start` / `Profiler.stop`

**Top 热点（6 轮合计）**：

| 耗时 | 采样 | 函数 |
|---|---|---|
| **847.6ms** | **1114** | `getBoundingClientRect` |
| **328.2ms** | **472** | `setBaseAndExtent` |
| 79.0ms | 94 | 垃圾回收 |
| 44.1ms | 63 | `elementsFromPoint` |
| 25.1ms | 37 | `get` @ index-Ciz7DZxv.js:13 |
| 24.6ms | 39 | `fetch` |

**gBCR 的调用者归属**：

| 耗时 | 采样 | 调用者 |
|---|---|---|
| **826.8ms** | **1091** | **`c` @ index-Ciz7DZxv.js:129:123673** |
| 10.7ms | 7 | `isVisible`（右侧面板状态） |
| 5.6ms | 8 | `measure` |
| 3.9ms | 7 | `slotOccupied` |
| 0.6ms | 1 | `jr` |

**`c` 一个函数占了 97.6%。**

### `c` 的身份

`index-Ciz7DZxv.js:129` 的 `UH` hook：

```js
function UH(e, t, r, i = RH) {
  const [n, o] = x.useState(t)
  return x.useLayoutEffect(() => {
    const l = e.current
    if (l === null) return
    const c = () => {
      o(Math.min(t, Math.max(0, l.getBoundingClientRect().bottom - B2(i))))
    }
    return c(),
      window.addEventListener('resize', c),
      window.addEventListener('scroll', c, true),
      () => { /* 卸载时移除 */ }
  }, [e, t, r, i]), n
}

function B2(e, t, r = 0) {
  const i = document.documentElement
  const n = Number.parseFloat(getComputedStyle(i).getPropertyValue('--dsh-frame-top-clearance'))
  ...
}
```

### 一次击键到底调了多少次

| 观测 | 数值 |
|---|---|
| 一次 `@` 击键 gBCR 总调用 | **134 次** |
| 单次 gBCR（静息） | 0.1ms |
| 单次 gBCR（击键后立刻） | 0–0.4ms |
| 击键到下一个宏任务 | 97ms |

**前几个调用栈全部是：**

```
getBoundingClientRect
  <- (anon) @ /plugins/:2644
  <- jr      @ /plugins/:2644      ← Draft.js 的 setSelection
  <- (anon) @ /plugins/:2646
```

### `jr` 的身份：Draft.js `setSelection`

```js
function jr(t, e, n, o, r, s) {        // t=prevSelection, e=nextSelection, n=inputState
  ...
  const [, p] = Hr(n, h, f.offset)       // 把 Draft 偏移量映射到 DOM 节点+offset
  const [, m] = Hr(n, g, d.offset)
  ...
  if (Ur(o, v, p, T, m), ...)             // Ur 里调 setBaseAndExtent
}
```

**所以是 O(叶子节点数) × 同步布局读。** 菜单打开后 DOM 里多了几十个候选行，`Hr` 要遍历的节点暴涨。

---

## 10. 已排除清单（不要重复试）

| 假设 | 实验 | 结果 |
|---|---|---|
| 网络请求慢 | 打点 `fetch` 发起/完成时刻 | 请求 13–14ms 发起，**643ms 内 0 个完成**，菜单 144ms 已挂载。排除 |
| CSS 动画 | 注入 `animation:none!important` | 115→95ms，只省 20ms。不是主因 |
| 首帧渲染（画） | LoAF `duration - renderStart` | 2–6ms/帧。排除 |
| 候选行数 | `@`（有内容）vs `@zzzzzz`（空） | 98–167ms vs 67–70ms，约 30% 差异，非数量级 |
| GC | 6 轮堆增量 vs 耗时 | `-0.7MB/154ms`、`+0.4MB/185ms`… 无相关。排除 |
| `measure()` 的 slotOccupied | 短路其 gBCR | 129/187ms vs 171/152ms，无显著差异。排除 |
| 我们的插件 | `__FAST_AT_OFF` / `__FAST_AT_SESSIONS` 三态对照 | 无系统性差异。**插件事不关己** |
| 用户截图里的悬浮按钮 | 对比 `measure()` 的目标元素 | 那个按钮是 `button.nArs4W_bottomClose`，纯 CSS 定位，不参与 measure() |

---

## 11. 测量方法纪律（每次都要遵守）

1. **真实键盘，不用 `execCommand`** —— 两者事件序列不同
2. **每轮重置到干净状态** —— 关菜单（Escape）+ 等 1s，否则上一轮的菜单状态污染下一轮
3. **中位 ≥ 5 轮**，不报单次值
4. **交叉交替配置** —— A/B/A/B 而不是 AAAA/BBBB，抵消机器漂移
5. **替换函数做对照时，确认调用次数没变**（见 §6 的坑）
6. **同时用两种口径** —— LoAF 看帧，CDP Profiler 看函数栈。只有一种时容易归错
7. **机器空闲时测** —— 实测 CPU 在 38%–100% 之间波动，负载下数字翻倍
8. **「首帧」≠「内容可见」** —— 涉及列表/异步数据的界面，必须分别测「骨架」「首个数据项」「全量数据项」三个时刻
9. **测性能前先确认工具自身的优化开关状态** —— `freezeAnimations` 默认 true，但自己拉 playwright 就绕过了；先取证开关生效再测（§15 的教训）
10. **「某功能慢」要分清是功能逻辑慢还是触发管线慢** —— 用短路对照一次分开，不做会把管线成本错记在功能账上（§16）
11. **验证布局修复时不能替换返回值** —— 假 rect 会让下游逻辑走偏、反而更慢；要改调用时机或调用次数（§6、§17 两次踩到）
12. **CDP 的 self time 大 ≠ 是瓶颈** —— 只说明采样时正好在这个函数里；必须做「消掉它再测」的对照（§18 的教训）
13. **用 LoAF 的 `scripts[].sourceCharPosition` 反查源码** —— 比 CDP 逐层追栈快，且 `styleAndLayout` 能区分 JS 慢还是布局慢
14. **「重置到干净状态」本身可能是最大干扰源** —— 每轮测量前的准备动作（全选、删除、切焦点）必须单独测它的影响（§19）
15. **连续输入的测量必须在同一页面会话内不中断地做** —— 不能每键重置；重置只用于「首次打开」类测量
16. **任何「某字符特别慢」的结论，必须先做「换普通字符」的同样测量** —— 若普通字符同样慢，问题在通道或通用路径
17. **`execCommand('insertText')` 是验证应用侧真实输入成本的可信通道** —— 走完整 beforeinput → Lexical 路径，无工具按键开销
18. **在这个 Lexical 编辑器上清空必须用真实按键（Ctrl+A + Delete），`execCommand('delete')` 无效且不报错** —— 测量前必须断言 `innerText.length === 0`，否则残留的 `@` 会让菜单常开，数字整体偏移 20ms
19. **条目数 / 成本曲线实验必须在「每次全新页面」下做** —— 同页面连续削减会被累积状态污染，实测同页面降到 0 条目仍有 74ms，而新页面清空只要 41ms
20. **要保持菜单 62 行，必须用「按键+Backspace 交替」而非 execCommand** —— execCommand 的 insertText 会让查询变成 @zzz 而候选归零，delete 又删不掉。用 recipe 发真实按键 `z` + `Backspace`，文本长度恒定、菜单全程 62 行

---

## 12. 下一步（未做，等用户决定）

| 优化 | 改哪里 | 预期 | 风险 |
|---|---|---|---|
| 候选行虚拟化 | `@` 菜单只渲染可见行 | 节点数降 8 倍 | 中，改菜单组件 |
| 菜单打开时不重设选区 | `controller.ts` 的 `@` 分支跳过 selection 恢复 | 省掉整条 `jr` 链 | 高，可能破坏光标位置 |
| `UH` 的 `c()` 改用 Observer | `ResizeObserver` / `IntersectionObserver` 替代主动读 | 消除同步布局 | 低，但属于改 DSH 核心 |
| 插件侧限制候选数 | 我们插件控制返回行数 | **约 20–30%，非线性** | 低，可立刻做 |

---

## 13. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-24 | 初版：补齐阶段 1–4 全部尝试，4 次误判及推翻原因，已排除清单，测量纪律 |
| 2026-11-24 第二轮 | 画流程图时发现「骨架 ≠ 候选行」：候选行冷态 1848ms，瓶颈是 DSH 原生 fileReferences/list（1.5–2.3s）。**§9 结论只覆盖 110ms 骨架**。产出 FLOW.html |
| 2026-11-24 第三轮 | 发现此前测量全都没开 freezeAnimations。重测：骨架 69ms、候选行 1115ms、fileReferences 925ms。动画污染约 40%，瓶颈结论不变。新发现 slotOccupied 属于 dsh-better-sidebar 插件（可改） |
| 2026-11-24 第四轮 | 短路对照：候选计算只占 @ 击键成本 13%，其余 87% 是触发管线。@ 与普通字母差距（735ms vs 0ms）短路后仍在 |
| 2026-11-24 第五轮 | 挖到根因：useAnchoredMaxHeight 在 useLayoutEffect 里同步读 gBCR，一次击键 4 次、每次约 46ms，全因强制同步布局（写入后 43.59ms vs 缓存 0.06ms，726 倍） |
| 2026-11-24 第六轮 | 方案C真实验证：改动生效（c 消失、gBCR 只剩 12ms）但 longtask 仅降 7%。LoAF 定位真凶是 Lexical 编辑循环（onkeydown/beforeinput/input，styleAndLayout=0）。推翻「Draft.js」与「布局是瓶颈」两条结论。已回滚 asar |
| 2026-11-24 第七轮 | **测量方法本身是元凶**：不做重置时连续输入 @ 与字母都是 0.1–0.3ms，完全流畅。之前 50–80ms 全部来自我每轮做的 Ctrl+A+Delete。推翻 §16/§18 的每键结论 |
| 2026-11-25 第八轮 | 用户指定长按为唯一基准。实测长按 @ = 40 次/39795ms、间隔 1030ms；长按字母 = 40 次/401ms、间隔 1ms。**短路后仍 1000ms**，根因不在候选计算 |
| 2026-11-25 第九轮 | 用 fill:keystrokes 通道：@ 891ms/字符 vs 字母 33ms/字符。拦截全部请求后 @ 降到 476ms。真凶 = 每个 @ 都发一整套宿主请求。已排除工具伪影（press/repeat 都被 ~950ms 工具开销污染） |
| 2026-11-25 第十轮 | **推翻 §20/§21**：菜单开着时连打字母 z 也要 1 秒/键；execCommand 实测 @ 0.54ms/键、z 0.70ms/键无差异。真实长按（33ms/键）下 z 1928ms vs @ 1971ms 一致。真因是 useLayoutEffect 里的强制同步布局（pc3rQa_menu），每键 ~60ms |
| 2026-11-25 第十一轮 | 整体禁用 dsh-better-sidebar：强制布局 1218ms→1ms、longtask 21→1、每键 75→42ms。推翻旧记录「sidebar 已排除」（那次只短路了 measure，没真正消除）。但局部消融全无效，且数字在 40–42ms 与 64–79ms 两组间摆动，存在未识别开关变量 |
| 2026-11-25 第十二轮 | **归因闭环**。§23 的数字摆动真因：编辑器残留 @（execCommand 删不掉）。干净三组：无@44ms/50ms、菜单0行65ms/1035ms、菜单62行95ms/1560ms。312 次布局读取中 245 次(79%)来自 dsh-better-sidebar 的 slotOccupied，宿主 MenuView 的 updateOverflowHint 占 12% |
| 2026-11-25 第十三轮 | **真凶确定**：菜单开 96ms/键 vs 关 43ms/键（三轮稳定）。gBCR 49 次吃 1272ms(74%)，其中 40 次/1008ms 全部来自宿主 `c@index:130`（useAnchoredMaxHeight）读 `.pc3rQa_menu`，单次 30–36ms。**推翻 §24 的 better-sidebar 结论**（禁用插件只是副作用关了菜单） |
| 2026-11-25 第十四轮 | **三次补丁全部无效**：sidebar 优化无效、UAMH 去同步 c() 无效（gBCR 40→0 但耗时转移给 scrollTop）、useLayoutEffect→useEffect 更差。关键洞察：**瓶颈不是布局次数，是每次布局本身的成本**（菜单开时单次 ~30ms vs 关时 ~2ms，15 倍）。全部改动已回滚并校验哈希 |
| 2026-11-25 第十五轮 | 严格基线：无菜单 42ms / 菜单62行 96–102ms / 菜单0条目 41ms。**证伪「单次布局 30ms」**（实测 0.3–0.5ms）。CSS contain/content-visibility/去shadow 全无效；短路 slotOccupied 全无效。execCommand 单键仅 1–2ms 但每键产生 ~58ms 独立 longtask。推论：58ms 在「条目存在时才跑的 JS」，不在布局读取 |
| 2026-11-25 第十六轮 | **决定性排除**：同一按键序列下，无菜单 67ms / 菜单62行 800ms / 菜单条目 display:none 777ms / visibility:hidden 875ms / 移出屏幕 931ms / opacity:0 863ms。**成本与渲染、布局、合成全部无关**，来自「菜单 open 时运行的 JS」。同时纠正测量错误：execCommand 会因无候选把菜单行数变 0 |
| 2026-11-25 第十七轮 | **根因确认**：每键 8758 次 DOM 调用（507 setAttribute / 223 closest / 186 appendChild / 99 createElement）。全部来自 React commit。菜单 state/groups/generation 每次按键都换新引用（generation 2→4）而内容不变 → MenuView 全量重渲染。这是 design issue 不是布局问题 |

---


---

## 14. 2026-11-24 第二轮：流程图取证推翻「候选行 = 首屏」的假设

### 触发

用户要求画流程图 + 截图。为了画图必须知道「每个阶段在什么时刻、屏幕上是什么样」，于是做了逐阶段截图。

### 关键发现（本轮实测，5 轮）

| 轮次 | 骨架出现 | 候选行出现 | `fileReferences/list` 耗时 | `fast-at/sessions.list` |
|---|---|---|---|---|
| 1 | 93ms | **1848ms** | 1564ms | 157ms |
| 2 | 125ms | 271ms | 未触发（缓存） | 118ms |
| 3 | 110ms | **1754ms** | 1487ms | 127ms |
| 4 | 101ms | 267ms | 未触发（缓存） | 121ms |
| 5 | 144ms | **2675ms** | 2340ms | 161ms |
| **中位** | **110ms** | **冷 1848 / 热 271** | **1564ms** | **127ms** |

### 这推翻了什么

**推翻：§9 把「骨架出现」当成「内容出现」。**

§9 的所有结论（Draft.js `jr()`、`UH` 的 `c()`、137 次 gBCR）**只解释了骨架那 110ms**。候选行要等到 1.8 秒，之前的分析完全没覆盖这一段。

而且我上一轮`02-menu-open.png`第一次截出来是空的（只有「主机」标题），当时我以为是截图裁切问题——**其实是菜单真的还没渲染出行**。

### 新发现的真瓶颈

`POST /api/fileReferences/list` 的请求体：

```json
{"type":"client-request","method":"fileReferences/list","payload":{"args":{"agentId":"session-...","query":""}}}
```

| 观测 | 值 |
|---|---|
| 响应体大小 | **684 字节** |
| 耗时（两次独立测量） | **1556ms / 1603ms** |
| 慢在哪 | 服务端固定开销，与返回数据量无关 |

**空 query 都要 1.5 秒，响应只有 684 字节。**

### 为什么之前没发现

1. 我用 `execCommand` 测的是「到首帧」，不是「到候选行出现」——骨架出现就算首帧了
2. 上一轮的 LoAF/CDP 分析窗口是 1.1–1.2 秒，**候选行在 1.8 秒才出现，正好在窗口外**
3. 我以为 A4 的「连续输入流畅度」口径已经覆盖，实际上它测的是「按住 @ 时的每击键成本」，不是「首次打开要等多久」

### 教训（已加入 §11 纪律）

**8. 「首帧」≠「内容可见」。** 涉及列表/异步数据的界面，必须分别测量「骨架」「首个数据项」「全量数据项」三个时刻。

### 对优化优先级的影响

| 项 | 之前判断 | 现在判断 |
|---|---|---|
| 接管 fileReferences | 没考虑过 | **P0：冷态 1848ms → 预计 < 300ms** |
| 优化 `c()` 的布局读取 | P0 | P2：只覆盖 110ms 骨架 |

### 产出

- `FLOW.html` —— 带 4 张阶段截图与实测数字的流程图
- `assets/stage-a~d.png` —— 阶段截图原图


---

## 15. 2026-11-24 第三轮：动画冻结下重测（推翻此前全部数字）

### 触发

用户指出：**此前所有测量都没开 `freezeAnimations`。**

> 之前我们的浏览器插件禁用动画的参数默认是关闭的，我发现你好像启动浏览器的时候没有把它开启

### 我的错误

`browser_e2e_start` 的 `freezeAnimations` **默认就是 true**，但我前几轮调用时从未显式传。更糟的是在 m6618 之后的测量里，我甚至用了自己起的独立浏览器（playwright 直连），**完全绕过了插件的动画冻结**。

所以 §14 及之前的所有绝对数字（骨架 110ms / 候选行 1848ms / fileReferences 1564ms）**都带着动画开销**。

### 重测条件

- `browser_e2e_start({ headless: true, freezeAnimations: true })`
- 验证生效：`animDisabled: true`、`document.getAnimations().length === 0`
- GUI 端口 52209（DSH 重启过，端口每轮会变）

### 新数字（冷态 5 轮，每轮刷新页面）

| 轮次 | 骨架 | 候选行 | `fileReferences` | `fast-at` | `settings.get` |
|---|---|---|---|---|---|
| 1 | 79ms | 888ms | 18ms（命中缓存） | 735ms | 1902ms |
| 2 | 69ms | 1115ms | 902ms | 123ms | 1020ms |
| 3 | 52ms | 1172ms | 1010ms | 77ms | 1080ms |
| 4 | 81ms | 1386ms | 1189ms | 102ms | 1266ms |
| 5 | 59ms | 1088ms | 925ms | 83ms | 1002ms |
| **中位** | **69ms** | **1115ms** | **925ms** | **102ms** | **1080ms** |

### 变化对比

| 指标 | 动画未冻结（旧） | 动画冻结（新） | 变化 |
|---|---|---|---|
| 骨架 | 110ms | **69ms** | −41ms（−37%） |
| 候选行 | 1848ms | **1115ms** | −733ms（−40%） |
| `fileReferences/list` | 1564ms | **925ms** | −639ms（−41%） |
| `fast-at/sessions.list` | 127ms | **102ms** | −25ms |

**动画确实污染了约 40%。** 但即使扣除，候选行仍是 1115ms，**离 300ms 目标还差 3.7 倍**。

### 这推翻了什么 / 没推翻什么

| 结论 | 状态 |
|---|---|
| 瓶颈是 `api/fileReferences/list` | **仍然成立**（925ms，占候选行 1115ms 的 83%） |
| `fast-at/sessions.list` 不是瓶颈 | **仍然成立**（102ms） |
| 骨架 ~110ms | **数字下调到 69ms**，但量级不变 |
| Draft.js `jr()` + `UH` 的 `c()` 归因 | **仍然成立**（真实键盘下 gBCR 322–470 次，`some` 占绝大头） |
| `measure()` 的 slotOccupied 走查 | **新发现：这是 `dsh-better-sidebar` 插件，不是 DSH 核心** |

### 新发现：`slotOccupied` 属于 `dsh-better-sidebar`

路径：`~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/lib/client.js:32319`

```js
function slotFree(left, top) {
  const cy = top + BUTTON_SIZE / 2;
  for (const dx of [2, 8, BUTTON_SIZE/2, 20, 26])      // 每格采 5 个点
    if (slotOccupied(left + dx, cy)) return false;
  return true;
}

function slotOccupied(cx, cy) {
  return document.elementsFromPoint(cx, cy).some((element) => {
    ...
    if (element.getBoundingClientRect().width > MAX_OCCUPANT_W) return false;   // gBCR
    const background = getComputedStyle(element).backgroundColor;              // gCS
    ...
  });
}

function measure() {
  for (let step = 0; step < MAX_RETREAT_STEPS && left >= minLeft; step++) {  // 最多 100 步
    if (slotFree(left, top)) return { top, left };
    left -= STEP_PX;   // 4px
  }
}
```

**实测**：一次 `@` 击键 `elementsFromPoint` 55 次、gBCR 385 次、`slotOccupiedByRect` 0 次（未走回退分支）。55 × 7 元素 ≈ 385，对得上。

**这是可以换掉的**——`dsh-better-sidebar` 是我们自己能改/能关的插件，不是 DSH 核心。

### 教训（已加入 §11 纪律）

**9. 测性能前先确认测量工具本身的优化开关状态。** `freezeAnimations` 默认 true，但自己拉 playwright 就绕过了；先取证「开关确实生效」再开始测。

### 修正后的优先级

| 优先级 | 做什么 | 预期 | 风险 |
|---|---|---|---|
| **P0** | 接管 `fileReferences/list` | 1115ms → 预计 < 300ms | 中 |
| **P1** | 修 `dsh-better-sidebar` 的 `measure()` 走查（加缓存 / 降步数 / 改 Observer） | 去掉约 385 次 gBCR | **低（自己插件）** |
| P2 | 骨架 69ms 已可接受，暂不动 | — | — |


---

## 16. 2026-11-24 第四轮：`@` 全流程短路对照（决定性）

### 做法

在 `lib/client.js:676` 的 `candidates` 包装最前面加一个诊断开关 `globalThis.__FAST_AT_SHORTCIRCUIT`：

```js
source.candidates = function candidates(session, req) {
  if (shortCircuit()) return Promise.resolve([])   // 立刻返回，不进 computeCandidates
  if (pluginDisabled()) return original.call(this, session, req)
  return computeCandidates(state, session, req).catch(() => [])
}
```

开关默认 `undefined`，不影响正常运行；只用于测量。

### 短路确实生效（取证）

| | 发出的请求 | 候选行 | 菜单 |
|---|---|---|---|
| 短路开 | `settings.get` / `session.phase` ×4 / `devices` | **0** | **不弹出** |
| 短路关 | 上述 + **`fileReferences/list`** + **`fast-at/sessions.list`** | 62 | 弹出 |

短路后菜单根本不出现（`candidates` 返空 → 菜单自动空）。

### 三组对照（每组 3 轮，每轮连击 10 次，真实键盘，180ms 间隔，动画冻结）

| 组 | longtask 数 | longtask 累计 | 最长单次 | raf p90 |
|---|---|---|---|---|
| A：`@` 不短路 | 10 / 11 / 10 | 735 / 763 / 716 ms | 102 / 98 / 87 ms | 17ms |
| B：`@` 短路 | 10 / 10 / 10 | 653 / 640 / 623 ms | 83 / 81 / 80 ms | 17ms |
| **C：普通字母 `x`** | **0 / 0 / 0** | **0 / 0 / 0 ms** | **0 / 0 / 0 ms** | 17ms |

### 结论（决定性）

**短路只省掉 12–16%（735ms → 640ms），`@` 与普通字母的差距（735ms → 0ms）完全没被消除。**

| 问题 | 答案 |
|---|---|
| 短路后是否恢复到「正常输入」水平？ | **没有。** 仍有 10 个 longtask / 累计 640ms，普通字母是 0 |
| 瓶颈是不是候选计算？ | **不是主要部分。** 候选计算只占约 13% |
| 那剩下 87% 在哪？ | **`@` 触发管线本身**：token 识别 → controller → 菜单状态机 → `dsh-better-sidebar` 的 `measure()` |

### 这推翻了什么

**推翻：之前把「候选行慢」等同于「`@` 慢」。**

- A1 的「候选行首次出现」口径只衡量了**一次打开**的延迟
- A4 的「连续输入流畅度」口径暴露的是**另一个成本**：每次击键的固定管线开销
- 两者不是同一件事，之前的优化方向（接管 fileReferences）只解决前者

### 新的成本拆分

```
一次 @ 击键的总成本 ≈ 73ms（735ms / 10 次）
  ├─ 候选计算（fileReferences + sessions.list）  ≈ 10ms  13%   ← 短路能省掉
  └─ 触发管线固定开销                          ≈ 63ms  87%   ← 短路省不掉
        ├─ token 识别 + controller.refreshHeaders
        ├─ Draft.js setSelection / setBaseAndExtent
        └─ dsh-better-sidebar measure() 的 elementsFromPoint 走查
```

### 教训

**10. 「某功能慢」要分清是「功能逻辑慢」还是「触发它的管线慢」。** 用短路对照一次就能分开，不做这个对照会把管线成本错记在功能账上。

### 下一步（已被下方追加排除）

87% 里最大的嫌疑曾是 `dsh-better-sidebar` 的 `measure()`（每次击键 385 次 gBCR）；它是我们自己的插件，**可以直接关掉验证**——关掉后若 longtask 消失，就是它。
### 追加：`dsh-better-sidebar` 的 `measure()` 已排除

把 `elementsFromPoint` 短路成只返回 `body`（走查第一步就判空、立刻返回），对照 2 轮：

| 组 | longtask 累计 | 最长 |
|---|---|---|
| `measure()` 正常 | 718 / 724 ms | 93 / 94 ms |
| `measure()` 短路 | 768 / 750 ms | 116 / 98 ms |

**没有改善，甚至略高。** 所以 `measure()` 的 385 次 gBCR **不是**这 87% 的主因，§15 里对它的怀疑到此排除。

（注：本次 `efp` 计数有问题——只在开关打开时计数，所以「正常」组显示 0。但 longtask 的对比不受影响。）

### 87% 的候选嫌疑（下一步，未验证）

1. **Draft.js 的选区操作** —— `jr()` / `setBaseAndExtent`，每次击键 22 次 `jr` 调用
2. **`input-trigger` controller 的 token 识别与 header 刷新** —— `controller.ts:126 track()` / `:618 refreshHeaders`
3. **菜单状态机的每次重建** —— 每个 `@` 都可能重建整个候选列表



---

## 17. 2026-11-24 第五轮：挖到最核心 —— 强制同步布局

### 定位路径（全部靠 CDP Profiler 逐层收敛）

```
10 次 @ 击键 = 每次 544ms（含 idle）
  └─ getBoundingClientRect  self 653ms / 12%   ← 仅有的 JS 大户
       └─ 唯一调用者：c @index-Ciz7DZxv.js:129  (655ms total)
            └─ 祖先链：c ← (anon)@129 ← Rc ← Cm ← xm ← Px ← Vx ← Si ← jm ← Wr ← (anon)@59
                 └─ 顶端是 (root)：非事件处理器，是 React 提交阶段
```

### 源码（`dsh-web-frontend/dist/assets/index-Ciz7DZxv.js:129`）

```js
function B2(e, t, r = 0) {
  const i = document.documentElement,
        n = Number.parseFloat(getComputedStyle(i).getPropertyValue("--dsh-frame-top-clearance"))
  if (Number.isNaN(n)) return e
  const o = t !== void 0 && t.top >= 0 ? t.bottom + r : Number.POSITIVE_INFINITY
  return Math.max(e, Math.min((i.hasAttribute("data-fullscreen") ? 0 : n) + 20, o))
}

const RH = 12
function UH(e, t, r, i = RH) {            // 真名：useAnchoredMaxHeight
  const [n, o] = x.useState(t)
  return x.useLayoutEffect(() => {
    const l = e.current
    if (l === null) return
    const c = () => {
      o(Math.min(t, Math.max(0, l.getBoundingClientRect().bottom - B2(i))))   // ← 强制同步布局
    }
    return c(),                                                            // ← 立即执行
      window.addEventListener("resize", c),
      window.addEventListener("scroll", c, !0),
      () => { ... }
  }, [e, t, r, i]),                  // ← r 是 state，每次菜单状态变化都换引用
  n
}
```

### 调用点（`dsh-client-ui-input-trigger/lib/client.js`）

```js
const maxHeight = useAnchoredMaxHeight(listRef, MAX_HEIGHT, state, TOP_MARGIN)
//                                  ref     400        ↑菜单快照  84
```

`state` 来自 `useSyncExternalStore(menu.subscribe, menu.getSnapshot)`。

### 机制（这才是最核心的地方）

1. 一次 `@` 击键，`track()` → `seedGroups` / `reduce({type:'hit'})` / `refreshHeaders` / `fetchCandidates` 会多次 `menu.set()`
2. 每次 `menu.set()` → 新的 `state` 快照 → `useLayoutEffect` 依赖 `r` 变化 → **同步**重跑 `c()`
3. `c()` 里的 `getBoundingClientRect()` 在 React 刚提交完 DOM 后立即读 → **强制浏览器同步重排整页**
4. 实测：一次击键 `c()` 跑 **4 次**，单次最长 **35–68ms**，合计 **130–160ms**

### 决定性证据：强制同步布局的代价

| 场景 | 单次 gBCR |
|---|---|
| DOM 写入后首次读 | **43.59ms** |
| 紧接着再读（布局已缓存） | **0.06ms** |
| **比值** | **726 倍** |

**读一次布局本身是 0.06ms。43.59ms 全是「让浏览器把脏掉的整页重新算一遍」的代价。**

### 每次击键的 c() 实测（10 次独立击键）

| 击键 | c() 次数 | 合计 | 单次最长 |
|---|---|---|---|
| 1 | 3 | 104ms | 38.0ms |
| 2–10 | 4 | 129–162ms | 35.8–68.2ms |
| **中位** | **4** | **~138ms** | **~46ms** |

### 为什么它本不该这么慢（A5）

**它只需要一个数字：菜单卡片底部到视口顶部的距离。**

有三处不合理：

1. **在 `useLayoutEffect` 里同步读布局** —— 这是 React 明确警告的反模式。`useLayoutEffect` 跑在 DOM 提交后、浏览器绘制前，此刻读布局必然触发强制重排。
2. **依赖 `state`** —— 菜单内容变了不代表**位置**变了。一次击键内 `state` 变 4 次，就要重排 4 次。位置只跟容器几何有关，`ResizeObserver` 才是正确工具。
3. **每次读都走完整 `getBoundingClientRect`** —— 它读的是 `listRef.current`（菜单卡片），而菜单高度变化其实已经由 `MAX_HEIGHT` 约束，绝大多数情况下这个值根本不变。

### 修复方向（按风险排序）

| 方案 | 改哪 | 预期 | 风险 |
|---|---|---|---|
| **A. 去掉 `state` 依赖** | `useLayoutEffect` 的 deps 里删掉 `r` | 4 次 → 1 次，省约 100ms | 低，但要确认位置真的不依赖 state |
| **B. 换成 `ResizeObserver`** | 把 `c()` 改成 observer 回调 | 只在尺寸真变时测 | 低，语义更正确 |
| **C. 把测量延到 `requestAnimationFrame`** | `c()` 内部推迟一帧 | 避开提交期 | 中，可能闪一下 |
| **D. 缓存 + 脏标记** | 记录上次读到的 rect，只在写入后失效 | 省掉重复读 | 中 |


### 修复方案已验证（同步读 vs 下一帧读）

用真实会弄脏布局的操作（改 `paddingBottom`）对照 10 轮：

| 读法 | 平均 | 最大 | 明细 |
|---|---|---|---|
| **提交后同步读** | **3.78ms** | 4.80ms | 4.8 / 4.8 / 4.5 / 4.5 / 3.4 / 2.9 / 2.9 / 2.8 / 3.3 / 3.9 |
| **延后到下一帧读** | **0.09ms** | 0.20ms | 0.1 / 0.1 / 0.1 / 0 / 0.2 / 0.1 / 0 / 0.1 / 0.1 / 0.1 |
| **倍数** | **42 倍** | — | — |

注意这里测的是「单个元素的小范围改动」；真实场景是整页（1600×1000、62 行菜单、终端/侧栏都在）重排，所以实测 `c()` 单次 35–68ms，量级比这个微基准大得多，但**方向一致**。

### 最终结论（可直接落地）

**要改的就一行：`useAnchoredMaxHeight` 的 `useLayoutEffect` 依赖数组里的 `r`（即 `state`）。**

```diff
  }, [e, t, r, i]),
  }, [e, t, i]),
```

菜单内容变化（`state`）不影响菜单卡片的**位置**，位置只由容器几何决定。删掉这个依赖：

- 一次击键的 `c()` 从 4 次降到 1 次
- 省掉约 100ms / 次击键（130–160ms → 30–50ms）
- 加上方案 C（延后一帧读），可再降到接近 0

**这是目前找到的最大单点收益，且改动面极小。**

### 失败的修复尝试（记录，避免重走）

我试过拦截 `gBCR` 返回假 rect：**longtask 仍是 776ms，没有改善**。

原因和 §6 误判 B 完全一样：**返回假值会让组件拿到错误高度 → 下游逻辑走偏 → 触发更多渲染**。

**规矩：验证布局修复时，不能替换返回值，要改调用时机或调用次数。**


---

## 18. 2026-11-24 第六轮：方案 C 真实验证（结果：收益微小，且挖出两个颠覆性事实）

### 做了真实验证

直接改 `app.asar` 内的 `index-Ciz7DZxv.js`，把 `useAnchoredMaxHeight` 的 deps 从 `[e,t,r,i]` 改成 `[e,t,i,0]`（同字节长度替换，备份在 `.scratch/app.asar.backup`），重启 DSH 实测。

**integrity 校验没有拦截**，DSH 正常启动。

### 补丁确实生效

| | 补丁前 | 补丁后 |
|---|---|---|
| `c()` 在 gBCR 调用者中出现 | **653ms（12%）** | **完全消失** |
| 每次击键 `c()` 调用次数 | 4 次 | **0 次** |
| 每次击键 `c()` 耗时 | ~138ms | **0ms** |

### 但 longtask 几乎没降

| 组 | 3 轮累计 | 中位 |
|---|---|---|
| `@` 补丁后 | 710 / 669 / 682 ms | **682ms** |
| `@` 补丁前 | 735 / 763 / 716 ms | **735ms** |
| 普通字母 | 60 / 0 / 58 ms | **58ms** |

**只降了 7%（735 → 682ms）。** 而且补丁后 5 次 @ 的 541 次 gBCR 合计只花 **12ms**——布局读取彻底不是瓶颈了。

### ❌ 颠覆性事实一：`c()` 不是主因，我之前把「self time 大」错当成「是瓶颈」

CDP 里 `getBoundingClientRect` self 653ms 是真的，但那是**采样归因**：它被调用时恰好在做重排，所以采样落在它身上。

**但消掉它之后 longtask 没少**——说明那 653ms 是「本来就要做的重排」被记在了它账上，不是它额外制造的。

这推翻了 §17 的结论「改一行省 100ms」。

### ✅ 颠覆性事实二：LoAF 直接给出了真凶

用 `long-animation-frame` 的 `scripts[]` 归因，每次 `@` 的 longtask 全部指向同一个脚本：

| invoker | 时长 | charPos | styleAndLayout |
|---|---|---|---|
| `DIV.onkeydown` | 33ms | 2810449 | 0 |
| `DIV.onbeforeinput` | 86ms | 2810449 | 0 |
| `DIV.oninput` | 65–73ms | 2810449 | **0** |

**`styleAndLayout` 全是 0** —— 根本不是布局问题，是纯 JS 执行。

`charPos 2810449` 反查到 `client.js&rev=290e1f014731`（5.4MB），落在 Lexical 编辑器的事件注册区。

### ❌ 颠覆性事实三：编辑器是 Lexical，不是 Draft.js

| 检查 | 结果 |
|---|---|
| `data-lexical-editor` 属性 | **true** |
| 编辑器 DOM | `<span data-lexical-text="true">@@@@</span>` |
| `window.Draft` | **undefined** |

**§9 / §17 里关于 `jr()` = Draft.js `setSelection`、`setBaseAndExtent` 的归因全部作废。**

（`setBaseAndExtent` 实测只有 25.6ms/次击键，本来就不是大头；现在知道它属于 Lexical 的选区同步，不是 Draft.js。）

### 现在的结论（唯一有效）

```
一次 @ 击键 ≈ 68ms
  ├─ 布局读取（gBCR / useAnchoredMaxHeight）  ≈ 0ms     0%   ← 已排除（补丁后 12ms/5次）
  ├─ 候选计算（fileReferences + sessions.list）≈ 10ms   15%   ← 短路可省
  └─ Lexical 编辑循环（onkeydown/beforeinput/input）≈ 58ms 85%  ← 真凶
        styleAndLayout = 0，纯 JS
        候选：Lexical 的 composition/reconcile + DSH 的 input-trigger controller
```

### 教训

**12. CDP 的 self time 大 ≠ 是瓶颈。** 它只说明「采样时正好在这个函数里」。必须做「消掉它再测」的对照，否则会把被动承担的成本当主动制造的成本。

**13. 用 LoAF 的 `scripts[].sourceCharPosition` 直接反查源码位置**，比 CDP 逐层追调用链快得多，而且能拿到 `styleAndLayout` 这种区分「JS 慢」还是「布局慢」的关键字段。

### 已回滚

`app.asar` 已恢复原始状态，SHA256 校验一致（199.4MB）。备份保留在 `.scratch/app.asar.backup`。


---

## 19. 2026-11-24 第七轮：测量方法本身是元凶（本轮最重要的发现）

### 决定性的对照

在**同一个页面会话**里连续输入，不做任何重置：

| 按键序列 | beforeinput 耗时 |
|---|---|
| `a` `@` `b` `c` `@` `d` | **0.3 / 0.3 / 0.1 / 0.2 / 0.1 / 0.1 ms** |

**`@` 与其他字母完全没有差异，都是亚毫秒级。**

### 那 50–80ms 是哪来的

逐个隔离我每次测量前做的「重置动作」：

| 重置动作 | 下一次输入的 beforeinput 耗时 |
|---|---|
| 只按 `Escape` | **0.2ms** |
| 只点击编辑器 | **0.1ms** |
| **`Ctrl+A` + `Delete`（全选删除）** | **47.1ms** |

**元凶是「全选删除」。**

### 进一步确认：只有删除后的第一键慢

| 场景 | 逐键耗时 |
|---|---|
| 全选删除后连输 `1` `2` `3` | **48.6** / 0.1 / 0.2 ms |
| 不删除，直接连输 `4` `5` `6` | 0.2 / 0.1 / 0.1 ms |
| 全选删除后打 `@` | **73.5ms** |
| 全选删除后再打第二个 `@` | 0.1–0.2ms（见上） |

### 这推翻了什么

**推翻 §16 / §18 的全部「每次击键 60–80ms」「@ 比字母慢 30ms」结论。**

那些数字全部是在「先全选删除、再输入」的流程里测的，**测的是「全选删除后的首次输入」，不是「连续输入的流畅度」**。

这恰恰违反了 A4 的口径要求（「连续输入/按住 @ 的流畅度」），也违反了 §11 纪律第 2 条（每轮重置到干净状态）——我为了「干净」而引入的删除动作，本身就是最大的干扰源。

### 那 47ms 是什么（次要问题）

全选删除后第一次输入，Lexical 需要从「空文档」重建整棵节点树 + 重算 selection + 重新注册引用芯片。这是**一次性**成本，不是每键成本。

真实用户场景里，「全选删除后立刻输入」并不常见；**真正影响手感的是连续输入，而连续输入已经是 0.1–0.2ms，非常流畅**。

### 教训

**14. 「重置到干净状态」这个动作本身可能是最大的干扰源。** 每轮测量前的准备动作（全选、删除、切焦点）必须单独测一次它的影响；否则会把准备成本记在被测对象账上。

**15. 连续输入的测量必须在同一个页面会话内不中断地做**，不能每键重置。重置只能用于「首次打开」类的测量。

### 剩余待查

| 问题 | 状态 |
|---|---|
| 连续输入 `@` 是否流畅 | **已答：0.1–0.3ms，非常流畅** |
| 首次打开 `@` 菜单的候选行延迟 | 1115ms（§15），这是真实待优化项 |
| 全选删除后首键 47ms | 一次性成本，优先级低 |


---

## 20. 2026-11-25 第八轮：长按 @ 的真实基线（用户指定的唯一基准）

### 用户校正了我的口径

> 一定要做 @ 的连续输入测试，我长时间按着这个 @ 键的时候，它的输入就是非常卡顿的。把这个作为基准去测试其他所有的你找到的可能性

§19 里我用「单次击键」得出「连续输入 0.1–0.3ms 很流畅」是**错的**：那种测法是「打完一个字、等 350ms、再打下一个」，不是长按。

### 长按的真实数据（`browser_e2e_press({ key, repeat: 40 })`，真实按键事件连发）

| 指标 | 长按 `a` | 长按 `@` | 倍数 |
|---|---|---|---|
| 40 次输入总耗时 | **401ms** | **39795ms** | **99 倍** |
| 输入间隔（中位） | ~1ms | **~1030ms** | **1000 倍** |
| longtask 个数 | 1 | **40** | 40 倍 |
| longtask 累计 | 61ms | **2771ms** | 45 倍 |
| 最长单次 longtask | 61ms | **98ms** | — |
| 帧间隔 p50 | 17ms | 17ms | — |
| 帧间隔 p99 | 17ms | **50ms** | 3 倍 |

### 决定性对照：短路后仍然 1000ms

打开 `__FAST_AT_SHORTCIRCUIT`（`candidates` 立刻返回 `[]`，不发任何请求、不渲染任何候选行）：

| | 输入间隔 | longtask | 候选行 |
|---|---|---|---|
| 短路前 | ~1030ms | 40 个 / 2771ms | 62 |
| **短路后** | **~1000ms** | **20 个** | **0** |

**根因既不是我们的插件，也不是候选计算，更不是菜单渲染（候选行为 0）。**

### 每个 @ 触发的请求（6 次长按实测）

| 请求 | 触发次数 | 实测耗时 |
|---|---|---|
| `ds-harness-remote/settings.get` | 6/6 | **1844–2655ms** |
| `fast-at/api/sessions.list` | 6/6 | 100–1090ms |
| **`api/fileReferences/list`** | 6/6 | **5 次未返回（超时/挂起）** |
| `/sidebar/api/session.phase` | 10 | 1–1252ms |
| `ds-harness-remote/devices` | 6/6 | 900ms+ |

### 当前唯一结论

**每个 `@` 都被一个约 1000ms 的节流/阻塞挡住，与候选计算无关。**

这个 1000ms 精确到 ±30ms（1007 / 1001 / 996 / 985 / 1005 / 998 / 976），**强烈提示代码里有 `1000` 或 `1e3` 的常量**（防抖、节流、或请求超时的重试间隔）。

### 下一步

在 `dsh-client-ui-input-trigger` / `dsh-client-ui-composer` 源码里搜 `1e3` / `1000` 常量，定位这个节流点。


---

## 21. 2026-11-25 第九轮：长按 @ 的真凶 = 每次输入都发一整套请求

### 换用第三条独立输入通道，排除工具伪影

`browser_e2e_fill({ mode: 'keystrokes' })` 走的是 playwright 的 `pressSequentially`，与 `press` / `press:repeat` 完全不同的代码路径。用墙钟计时：

| 输入 | 耗时 | 每字符 |
|---|---|---|
| `6×z` | **196ms** | 33ms |
| `6×@` | **5344ms** | **891ms** |
| `2×@` | 1979ms | 990ms |

**同一路径、同一条件，`@` 比字母慢 27 倍。** 这条数据可信。

### 先排除工具伪影（重要）

| 通道 | `@` 间隔 | `z` 间隔 | 判定 |
|---|---|---|---|
| `press` 独立调用 ×6 | 925–1216ms | **918–988ms** | **工具固定开销，不可用** |
| `press` + `repeat:6` | 950–1063ms | **941–1058ms** | **工具固定节流，不可用** |
| `fill mode=keystrokes` | **891ms/字符** | **33ms/字符** | **可用** |

**`press` 与 `repeat` 都被工具自身的 ~950ms 往返/节流污染，只有 `fill:keystrokes` 能反映真实差异。**

### 真凶：每次 `@` 都会发一整套请求

拦截（不真正发出，直接返回空 200）所有 `fileReferences/list` / `sessions.list` / `devices` / `settings.get` / `session.phase`：

| | 6×@ 耗时 | 6×z 耗时 |
|---|---|---|
| 不拦截 | **5344 / 5711ms** | 196ms |
| 拦截 | **476 / 440ms** | 174ms |

**`@` 从 5344ms 降到 476ms（快 11 倍），`z` 几乎不变（196 → 174ms）。**

### 单个 `@` 的完整时间线（实测）

```
29ms   keydown / keypress / beforeinput   ← JS 链路极快
57ms   fetch settings.get 开始
58ms   fetch fast-at/sessions.list 开始
89ms   menu:open（行数 0）
136ms  longtask 93ms
150ms  fetch session.phase 开始
990ms  settings.get 返回          ← 等了 933ms
996ms  sessions.list 返回
1012ms fileReferences/list 开始
1039ms fileReferences/list 返回
```

**JS 处理只用了不到 100ms。剩下的 900ms 全在等请求。**

而 `fill` 的 `pressSequentially` 是「每个字符输入后等页面稳定」再发下一个，所以它准确地把「每次 `@` 等 900ms」暴露了出来。

### 为什么单拦某一个请求没效果

逐个只拦一个：fileReferences=6326ms、settings=5896ms、phase=6843ms、devices=5815ms（基线 5688ms）——**全部无效**。

因为它们**并行叠加**，`fill` 要等**最慢的那个**；只有全拦才降到 476ms。

### 一个重要的负面结果

拦截实验出现过 440ms 与 7070ms 的巨大抖动（同一配置两次），说明「页面内 monkey-patch fetch」这条路本身不稳定（可能与 React StrictMode 双挂载、或 HMR 重建 fetch 引用有关）。**这个方法只能定性，不能定量。**

### 当前结论（唯一有效）

```
长按 @ 慢 27 倍的真凶：
  每输入一个 @ → 触发一整套宿主请求（settings.get / sessions.list /
  fileReferences/list / devices / session.phase）
  → 最慢的一个 ~900ms → 输入被拖到 891ms/字符

与以下无关（已排除）：
  ✗ dsh-fast-at 插件（关闭 / 短路后完全一样：5612 / 5542 / 5460ms）
  ✗ 候选计算（短路不发请求，照样慢）
  ✗ 主线程阻塞（rAF 全程 17ms，定时器零延迟）
  ✗ 布局（LoAF styleAndLayout 全为 0）
  ✗ Draft.js（编辑器是 Lexical）
```

### 下一步

1. 找出「每输入一个 `@` 就发一整套请求」的代码位置（在 `input-trigger` controller 的 `track()` 里）
2. 确认 `settings.get` 为什么要 900ms（它每个 `@` 都重发一次，其实完全可以缓存）


---

## 22. 2026-11-25 第十轮：长按 @ 的卡顿与 @ 无关（本轮推翻 §20/§21）

### 推翻 §20 / §21

§20 说「长按 @ 慢 99 倍」、§21 说「真凶是每次 @ 都发一整套请求」——**这两个结论都建立在 `browser_e2e` 的按键通道上，而那个通道本身有 ~950ms 固定开销。**

### 决定性反证：菜单开着时，打普通字母也一样慢

| 场景 | 工具墙钟 | 键间隔 |
|---|---|---|
| `z ×6`，菜单**未开** | **122ms** | 8–66ms |
| `z ×6`，菜单**已开**（62 行） | **7556ms** | **964–985ms** |
| `@ ×6`，菜单未开 | 6280ms | 978–1064ms |

**菜单开着时连打普通字母 `z` 也是 1 秒/字符。** 所以「@ 慢」是假象，真实变量是「菜单是否打开 + 走哪个按键通道」。

### 决定性反证 2：给所有 fetch 加 1 秒延迟，字母输入毫发无损

把 `window.fetch` 全部延迟 1000ms 后：`z ×6` 墙钟 **173ms**、间隔 10–71ms，**完全不受影响**。

如果是「等网络」，字母也该被拖慢。**所以「等请求」不是机制。**

### 决定性反证 3：页面内直接输入，@ 与字母毫无差异

用 `execCommand('insertText')`（走真实 `beforeinput` → Lexical 路径，但不经工具按键）：

| 输入 | 每键耗时 |
|---|---|
| `z ×100`（菜单关） | **0.70ms** |
| `@ ×100`（菜单关） | **0.54ms** |
| `z ×100`（菜单开） | **0.72ms** |

**应用侧纯输入成本 0.5–0.7ms/键，@ 与字母无差异，菜单开不开也无差异。**

### 真正的成本：以真实长按速率（33ms/键）持续输入时暴露

OS 按键重复速率约 33ms/键。以该速率连打 30 键：

| | 总耗时 | 每键 | longtask | rAF p99 |
|---|---|---|---|---|
| `z ×30` | **1928ms** | 64ms | 27 个 / 1651ms | 337ms |
| `@ ×30` | **1971ms** | 66ms | 27 个 / 1710ms | 476ms |
| 理论值（30×33） | 990ms | 33ms | — | — |

**`z` 和 `@` 完全一样（1928 vs 1971ms）。** 长按任何字符都会积压约 2 倍。

### 这 27 个 longtask 的来源（LoAF 归因）

```
invoker: TimerHandler:setTimeout   合计 1698ms  ← 全部
每帧自报 forcedStyleAndLayoutDuration = 50–66ms  ← 几乎全部
帧自报 styleAndLayoutStart 区间仅 25ms         ← 说明是「强制」而非「自然」布局
```

**全部来自 `setTimeout` 回调里的强制同步布局。**

### 强制布局的具体调用栈（hook getBoundingClientRect 抓到）

```
c@index-Ciz7DZxv.js:130
  (anon)@index-Ciz7DZxv.js:130      ← useLayoutEffect 回调
    Rc@index-Ciz7DZxv.js:60         ← React commit
      Cm@index-Ciz7DZxv.js:60
        xm@index-Ciz7DZxv.js:60
          Px@index-Ciz7DZxv.js:60
DOM 元素: ._surface_1w4el_1.pc3rQa_menu
```

即 §18 记录的 `useAnchoredMaxHeight` → 内部闭包 `c` → `motionMenu.getBoundingClientRect()`，在 **React `useLayoutEffect`** 里同步读布局。

### 但这仍然不是「@ 专属」

对照测量（20 键，33ms 间隔）：

| | 总耗时 | gBCR 次数 | getComputedStyle 次数 |
|---|---|---|---|
| 菜单关闭 | 1258ms | **188** | 46 |
| 菜单开启 | 1289ms | **188** | 46 |

**完全相同。** 与 §18 一致：把 `c` 的依赖数组补丁打掉后，长任务只降 7%。

### 本轮唯一有效结论

```
1. 长按 @ 与长按字母一样快/一样慢——不存在 @ 专属卡顿。
2. 真实长按（33ms/键）下，DSH 编辑器每键实际成本 64–66ms，
   约为按键速率的 2 倍，会产生积压。这对所有字符一致。
3. 积压来自 React useLayoutEffect 里的强制同步布局
   （pc3rQa_menu 的 useAnchoredMaxHeight），每键 ~60ms。
4. browser_e2e 的按键通道有 ~950ms 固定开销，
   §20/§21 的「@ 慢 99 倍 / 27 倍」是该开销放大的假象。
```

### 测量教训（第 16、17 条）

**16. 任何「某字符特别慢」的结论，必须先做「换成普通字符」的同样测量。** 若普通字符同样慢，问题就在通道或通用路径，不在那个字符。

**17. `execCommand('insertText')` 是验证「应用侧真实输入成本」的可信通道**——它走完整 `beforeinput` → Lexical 路径，且不引入工具按键开销。应作为长按测量的基准而非 `press`/`fill`。


---

## 23. 2026-11-25 第十一轮：真正的强制布局来源（插件消融）

### 关键实验：整体禁用 dsh-better-sidebar

用 `plugin_manager set_plugin(include:better-sidebar, enabled:false)` 真正禁用插件（不是短路函数，是整体不加载），重载页面后重测（20 键，33ms 间隔，execCommand 通道）：

| | 总耗时 | 每键 | longtask | forcedStyleAndLayout |
|---|---|---|---|---|
| better-sidebar **启用** | 1496ms | **75ms** | 21 个 | **1218ms** |
| better-sidebar **禁用** | 841ms | **42ms** | **1 个** | **1ms** |

**强制布局 1218ms → 1ms，longtask 21 个 → 1 个。**

这推翻了本文档旧记录里「dsh-better-sidebar 的 measure() 已排除」——那条结论来自「只短路 `measure()`」的局部消融，而不是整体禁用。**局部短路不等于消除：插件里还有别的路径在读布局。**

### 布局强制读取的完整清单（hook 全部 API，5 次按键）

| API | 次数 | 调用栈 | 目标元素 | 归属 |
|---|---|---|---|---|
| `getBoundingClientRect` | 10 | `c@index:130 < useLayoutEffect < Rc@React` | `.pc3rQa_menu` | `useAnchoredMaxHeight`（宿主 ui） |
| `scrollTop` | 10 | `client.js:2745 < useLayoutEffect` | `.pc3rQa_viewport` | 宿主 input-trigger `MenuView` |
| `clientHeight` | 10 | 同上 | `.pc3rQa_viewport` | 同上 |
| `scrollHeight` | 10 | 同上 | `.pc3rQa_viewport` | 同上 |
| `getBoundingClientRect` | 35 | `slotOccupied < slotFree < measure` | `.an3WzG_*` `.mP3x-q_*` | **dsh-better-sidebar** |
| `getBoundingClientRect` | 2 | `measure < ?` | `._button_1ulci_2` | dsh-better-sidebar |
| `getBoundingClientRect` + `gCS` | 2+1 | `isVisible < readRightPanelOpen < publish` | `._button_1ulci_2` | dsh-better-sidebar |

### 宿主侧的确切代码（可优化点）

`@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js` 的 `MenuView`：

```js
const updateOverflowHint = useCallback(() => {
  const viewport = viewportRef.current;
  setHasOverflowBelow(
    viewport !== null &&
    viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1
  );
}, []);
useLayoutEffect(() => {
  updateOverflowHint()
}, [state, maxHeight, updateOverflowHint]);   // ← state 每次输入都变
```

**每次输入 → `state` 变 → `useLayoutEffect` 同步读 `scrollTop`/`clientHeight`/`scrollHeight` → 强制布局。**

同一渲染里还有 `useAnchoredMaxHeight(listRef, MAX_HEIGHT, state, TOP_MARGIN)`，也在 `useLayoutEffect` 里读 `getBoundingClientRect()`。

### dsh-better-sidebar 侧的确切代码

`dsh-better-sidebar/lib/client.js` 的 `DockFallback`：

```js
useEffect(() => {
  if (!rendered) return;
  onResize();                                  // 立即测一次
  const timer = setInterval(onResize, REALIGN_MS);   // REALIGN_MS = 500
  ...
}, [rendered, onResize]);
```

`onResize` → `measure()` → 最多 `MAX_RETREAT_STEPS=100` 步 × `slotFree` 采样 5 点 × `slotOccupied` 用 `elementsFromPoint` 取出整摞元素、每个都读 `getBoundingClientRect()` + `getComputedStyle()`。

### 但局部消融全部无效（重要负面结果）

| 消融方式 | 每键 | 强制布局 |
|---|---|---|
| 基线 | 64–69ms | 1007–1089ms |
| `elementsFromPoint` 返空（dock 区域） | 63–64ms | 1016–1033ms |
| 移除右侧栏锚点按钮 | 62ms | 1016ms |
| 移除 `[data-dsh-dock-fallback]` 元素 | 63ms | 1023ms |
| CSS 隐藏 `dockFallback` | 59ms | 965ms |
| 输入后主动 flush 布局 | 63ms | 1023ms |

**全部无效。** 只有「整体禁用插件」或「移除 `.pc3rQa_menu` DOM」能降下来。

### 一个尚未解释的矛盾（必须记录）

同一份代码、同一页面，测得两组差异很大的数字，且不可稳定复现：

| 轮次 | 每键 | longtask | 强制布局 |
|---|---|---|---|
| 第一组（多次） | 64–79ms | 16–21 个 | 1007–1255ms |
| 第二组（连续 6 轮交替） | **40–42ms** | **0 个** | **0ms** |

第二组是在「连续多轮测量后」出现的，菜单与侧栏是否存在都不影响（40/41/40/41/42/40ms）。

**这个矛盾说明还有未识别的开关变量。** 在解决它之前，任何「优化到 X ms」的结论都不可信。

### 当前可执行结论

```
1. dsh-better-sidebar 是强制布局的主要来源（禁用后 1218ms → 1ms）。
2. 宿主 input-trigger 的 MenuView 也有两处 useLayoutEffect 强制布局
   （updateOverflowHint 读 scrollTop/clientHeight/scrollHeight；
     useAnchoredMaxHeight 读 getBoundingClientRect）。
3. 局部消融无效、整体禁用有效、且数字在两组之间摆动 —— 说明存在
   未识别的共同开关变量，下一步必须先稳定测量条件。
```


---

## 24. 2026-11-25 第十二轮：归因闭环（干净对照 + 逐 API 归因）

### 此前矛盾的原因：编辑器里残留了 `@`

§23 记录的数字摆动（40–42ms vs 64–79ms）不是随机，而是**编辑器文本里是否含有 `@`**。

`execCommand('delete')` 在这个 Lexical 编辑器上**清不掉内容**，必须用真实按键 `Ctrl+A` + `Delete`。此前多次「清空」其实没清掉，残留的 `@` 让菜单一直开着，于是每键 64–79ms。

**教训（第 18 条）：在这个编辑器上清空必须用真实按键，`execCommand('delete')` 无效且不报错。测量前必须断言 `innerText.length === 0`。**

### 干净三组对照（严格断言清空、真实按键开菜单）

| 状态 | 每键 | longtask | forcedStyleAndLayout |
|---|---|---|---|
| **无 `@`、菜单关闭** | **44ms** | **2 个** | **50ms** |
| 有 `@`、菜单开（0 行） | 64–66ms | 15–20 个 | 1035ms |
| **菜单开、真渲染 62 行** | **95ms** | **19 个** | **1560ms** |

OS 按键重复速率约 33ms/键。

```
44ms/键  → 轻微积压（1.3 倍）
95ms/键  → 严重积压（2.9 倍）  ← 这就是用户感受到的「非常卡」
```

### 逐 API 归因（菜单开、5 次按键，共 312 次布局读取）

| 次数 | 占比 | API | 调用栈 | 归属 |
|---|---|---|---|---|
| **245** | **79%** | `getBoundingClientRect` | `slotOccupied@client.js:56425 < some` | **dsh-better-sidebar** |
| 13 | 4% | `getBoundingClientRect` | `c@index:130 < useLayoutEffect` | 宿主 `useAnchoredMaxHeight` |
| 13 | 4% | `scrollTop` | `client.js:2745 < useLayoutEffect` | 宿主 `MenuView.updateOverflowHint` |
| 13 | 4% | `clientHeight` | 同上 | 同上 |
| 13 | 4% | `scrollHeight` | 同上 | 同上 |
| 8 | 3% | `getBoundingClientRect` | `isVisible < readRightPanelOpen < publish` | dsh-better-sidebar |
| 7 | 2% | `getBoundingClientRect` | `measure < ?` | dsh-better-sidebar |

**每次按键约 49 次 `slotOccupied` 内的 `getBoundingClientRect`。**

### 为什么菜单打开会让它从 50ms 涨到 1560ms

`slotOccupied(cx, cy)` 的实现：

```js
function slotOccupied(cx, cy) {
  return document.elementsFromPoint(cx, cy).some((element) => {
    if (element.closest("[data-dsh-dock-fallback]") !== null) return false;
    if (element === document.body || element === document.documentElement) return false;
    if (element.matches("button, a, input, select, textarea, [role=...]")) return true;
    if (element.getBoundingClientRect().width > MAX_OCCUPANT_W) return false;   // ← 强制布局 × 每个元素
    const background = getComputedStyle(element).backgroundColor;              // ← 强制样式重算 × 每个元素
    return background !== "" && background !== "transparent" && background !== "rgba(0, 0, 0, 0)";
  });
}
```

`elementsFromPoint` 返回该点**整摞**元素。菜单（`.pc3rQa_menu` + 62 个 `.pc3rQa_item` + 各种包裹层）在场时，命中栈显著变深，于是**每个采样点的迭代次数成倍增加**，每次迭代都强制一次布局读取。

再乘上 `slotFree` 的 5 个采样点、`measure()` 最多 100 步的让位走查（`STEP_PX=4`），一次 `measure()` 就是**数百次强制布局**。

而 `DockFallback` 的 effect 里挂着 `setInterval(onResize, REALIGN_MS=500)`，且 `onResize` 里 `setPos`/`setHeaderEntry` 会触发 React 更新——**输入引起的任何重渲染都可能再次触发它**。

### 可执行优化点（按收益排序）

**优化点 1（收益最大，79%）：`dsh-better-sidebar` 的 `slotOccupied` 缓存/降频**

位置：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-better-sidebar\lib\client.js`，函数 `slotOccupied` / `slotFree` / `measure`。

三个改法，任选其一即可大幅下降：

1. **`measure()` 结果缓存 + 只在真正需要时重算**：目前 `setInterval(500ms)` 无条件重算。改成「只有 `resize` / 可见性变化 / 宿主角落控件出现」时才重算，500ms 轮询改为只做轻量签名比对（例如比对右侧栏按钮的 `data-*` 属性），签没变就直接复用上次结果——不碰布局 API。
2. **`slotOccupied` 里把 `getBoundingClientRect().width` 换成 `offsetWidth`**：`offsetWidth` 是布局属性，但只在必要时才 flush；更重要的是**先做 `getComputedStyle` 判断再取几何**，或直接用 `element.checkVisibility()` / `offsetParent === null` 做初筛，避免对整摞元素逐个读 rect。
3. **缩短让位走查**：`MAX_RETREAT_STEPS=100` × `STEP_PX=4` 意味着最多 400px、100 次 `slotFree` × 5 点 = **500 次命中测试**。实测右侧栏角落控件只有 3–4 个按钮（约 100px 宽），把上限改成 30 步（120px）对功能无影响，成本降到 3 成。

**优化点 2（收益次之，8%）：宿主 `MenuView` 的 `useLayoutEffect` 依赖**

位置：`@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js` 的 `MenuView`。

```js
useLayoutEffect(() => { updateOverflowHint() }, [state, maxHeight, updateOverflowHint]);
//                                              ^^^^^ 每次输入 state 都换新对象
```

改成 `[maxHeight, updateOverflowHint]`，并在真正需要时（例如行数变化、滚动）才重算 overflow hint。同理 `useAnchoredMaxHeight(listRef, MAX_HEIGHT, state, TOP_MARGIN)` 的 `state` 依赖也应改为「只在打开/关闭或行数变化时更新」。

### 与用户症状的对应

用户描述「长时间按着 @ 键，输入非常卡顿」：

```
按住 @ → 菜单打开 → 每个 @ 都让菜单 state 变化
  → useLayoutEffect 强制布局（宿主侧 13×3 次）
  + DockFallback 的 measure 走查（sidebar 侧 245 次）
  → 每键 95ms > 按键速率 33ms
  → 按键排队、字符一个个往外蹦  ← 用户的体感
```

### 为什么它本不该这么慢（回答 K2）

前端开发的直觉是对的：**输入一个字符不应该触发任何布局读取。**

- 输入只改变文本内容，菜单的 overflow 提示和「停靠按钮该放哪」都不会因多打一个字符而改变。
- 但当前实现把这两件事都挂在「每次输入都变的 `state`」上，且用 `useLayoutEffect`（同步、渲染前）执行。
- 更糟的是 `slotOccupied` 用「对整摞元素逐个读几何 + 算样式」的方式做命中测试，复杂度与页面元素密度成正比，而菜单一开，命中栈就变深。

正常实现应该是：菜单的 overflow 提示只在「行数变化」或「滚动」时算；停靠按钮位置只在 resize / 侧栏开合 / 宿主控件变化时算。两者都可以完全脱离「每键」这条路径。


---

## 25. 2026-11-25 第十三轮：真凶确定（推翻 §24 的 better-sidebar 结论）

### 稳定可复现的对照（交替 3 轮，严格清空 + 真实按键）

| 状态 | 每键 | longtask | forcedStyleAndLayout |
|---|---|---|---|
| 菜单关闭 | **43 / 44 / 42 ms** | 1–2 个 | 39 / 43 / 36 ms |
| **菜单打开（62 行）** | **96 / 96 / 95 ms** | 15–19 个 | **1618 / 1618 / 1585 ms** |

**差 53ms/键，强制布局 40 倍。** 三轮完全一致，可稳定复现。

### 推翻 §24：不是 dsh-better-sidebar

给 `dsh-better-sidebar` 插观测计数器后：

| 期间 | `measure()` | `slotOccupied()` |
|---|---|---|
| 空转 1000ms | +2 | +6 |
| **打字 20 键（1300ms）** | **+3** | **+9** |
| 空转同样 1300ms | +3 | +9 |

**打字与空转的调用次数完全相同**（都是 500ms 轮询驱动）。

§24 里「禁用 better-sidebar 后强制布局 1218ms→1ms」之所以成立，是因为**禁用插件会触发整页重新渲染，副作用地把菜单关掉了**——菜单一关，成本自然消失。这是混淆变量，不是因果。

### 也对 better-sidebar 打了补丁，实测无效

改动（已应用并热重载生效）：
1. `slotOccupied` 里 `element.getBoundingClientRect().width` → `element.offsetWidth`
2. `MAX_RETREAT_STEPS` 100 → 20
3. `slotFree` 采样点 5 → 3（去掉 8、20）

结果：**95ms → 99–100ms，无改善。**（符合「它本来就不是元凶」的判断）

### 逐 API 计时归因（20 键，菜单开着，共 1710ms / 86ms per key）

| API | 次数 | 自报耗时 | 占比 |
|---|---|---|---|
| **`getBoundingClientRect`** | **49** | **1272.7ms** | **74%** |
| `clientHeight` | 42 | 6.9ms | 0.4% |
| `scrollTop` | 41 | 0.8ms | 0.05% |
| `scrollHeight` | 41 | 0.3ms | 0.02% |
| `getComputedStyle` | 48 | 0ms | 0% |

**`getBoundingClientRect` 的 49 次吃掉 1272.7ms，平均每次 26ms。**

### 按调用栈聚合 gBCR 耗时（47 次）

| 次数 | 耗时 | 调用栈 | 目标元素 |
|---|---|---|---|
| **40** | **1008ms** | **`c@index-Ciz7DZxv.js:130 < useLayoutEffect < Rc@React`** | **`.pc3rQa_menu`** |
| 3 | 0ms | `measure < ?`（better-sidebar） | — |
| 4 | 0ms | `isVisible < readRightPanelOpen < publish`（better-sidebar） | — |

最贵的 5 次全部是 `c@index-Ciz7DZxv.js:130` 读 `.pc3rQa_menu`，耗时 30.1 / 30.2 / 33.8 / 34.9 / 36.4 ms。

### 唯一结论

```
真凶：宿主 @deepseek-ai/dsh-client-ui-input-trigger 的 MenuView 里
      useAnchoredMaxHeight 的内部闭包 c，在 useLayoutEffect 中
      对 .pc3rQa_menu 调用 getBoundingClientRect()。

      每次输入 → state 变 → useLayoutEffect → c() → gBCR(dfn 容器)
      → 单次 30–36ms 的完整重排
      × 每键 2 次 → 每键 +60ms → 96ms/键（按键速率只有 33ms）
      → 输入严重积压，这就是「长按 @ 非常卡」

与以下无关（已实测排除）：
  ✗ dsh-better-sidebar（打字与空转调用次数相同；打补丁无效）
  ✗ 菜单候选行数（行数 0/62/69 时，去掉菜单后成本都归零）
  ✗ 候选计算 / 请求（短路后仍慢）
  ✗ 主线程（rAF 稳定 17ms）
```

### 与 §18 旧结论的关系

§18 曾尝试给 `useAnchoredMaxHeight` 的依赖数组打补丁（`[e,t,r,i]` → `[e,t,i,0]`），实测只降 7% 就回滚了。

那次的问题在于：**只去掉了 `state` 这一个依赖，但 `maxHeight` 和 `useSyncExternalStore` 的快照仍会每键刷新，`c` 仍被调用**。真正要做的是让 `c()` 本身不再每次同步读布局（见 §26 的缓存方案）。


---

## 26. 2026-11-25 第十四轮：三次补丁全部无效（重要负面结果）

### 补丁 1：better-sidebar 的 slotOccupied 优化 —— 无效

改了 3 处并热重载生效：
1. `element.getBoundingClientRect().width` → `element.offsetWidth`
2. `MAX_RETREAT_STEPS` 100 → 20
3. `slotFree` 采样点 5 → 3

结果：**95ms → 99–100ms，无改善。**

### 补丁 2：useAnchoredMaxHeight 去掉同步 c() —— 也无效

改 `index-Ciz7DZxv.js` 的 `UH` 函数：

```js
// 原：
return c(),window.addEventListener("resize",c),...
// 改为：
return window.addEventListener("resize",c),...
```

**补丁确认生效**（`gBCR` 的调用栈里 `c@index:130` 这一项彻底消失，从 40 次降到 0 次）。

但：

| 指标 | 补丁前 | 补丁后 |
|---|---|---|
| 每键 | 96ms | **95 / 97 / 96 ms**（三轮） |
| 强制布局 | 1585–1618ms | **1565–1598ms** |

**耗时只是从 `gBCR` 转移到了 `scrollTop`（1045ms），总量没变。**

### 补丁 3：MenuView 的 useLayoutEffect → useEffect —— 反而更差

改 `input-trigger/lib/client.js`：

```js
// 原：(0,react.useLayoutEffect)(()=>{updateOverflowHint()},[state,maxHeight,updateOverflowHint]);
// 改：(0,react.useEffect)(()=>{updateOverflowHint()},[...]);
```

结果：**96ms → 98ms，无改善**（且让补丁 2 那次偶发的 68ms 消失）。

### 这说明了什么（关键洞察）

**强制同步布局的「次数」不是瓶颈，「每次布局本身有多贵」才是。**

证据链：

1. 把 `gBCR` 从 40 次降到 0 次 → 总耗时不变（转嫁给 `scrollTop`）。
2. 把 `slotOccupied` 的采样点从 5 降到 3、步数从 100 降到 20 → 总耗时不变。
3. 把 `useLayoutEffect` 换成 `useEffect`（延后到渲染后）→ 总耗时不变甚至更差。

**无论谁去读、读几次、什么时候读，只要菜单（62 个条目）在 DOM 里，一次布局就要 30ms。**

这解释了一个此前所有轮次都没想通的现象：为什么 §18 的补丁只降 7%、为什么这次三个补丁都无效。

### 成本模型（新的、可解释的数据）

```
菜单关闭：43ms/键，强制布局 40ms/次（20 键共 ~40ms）
菜单打开：96ms/键，强制布局 1585ms/次（20 键共 ~1585ms）

→ 菜单打开时，每次强制布局的成本从 ~2ms 涨到 ~30ms（15 倍）
→ 这个 15 倍来自菜单 DOM 本身的布局复杂度
```

### 还没定位的（下一轮方向）

**为什么菜单的布局这么贵？** 62 个 `.pc3rQa_item` 不应该值 30ms。可疑：

1. 菜单用了 `backdrop-filter` / `filter` / `box-shadow` 等昂贵合成属性
2. 菜单在 `position: fixed` 的 portal 里，每次布局要重算整个层
3. 菜单的容器有 `contain` 缺失，导致布局范围蔓延到整页
4. 每个 item 内部有 flex/grid 嵌套过深
5. 字体加载 / 文本测量（62 个条目 × 多段文本）

**下一轮应该直接测量「菜单容器的布局耗时 vs 条目数」的关系，以及尝试 `contain: layout style paint` / `content-visibility` 等 CSS 隔离手段。**

### 所有修改已回滚

```
asar:           已从备份还原，SHA256 校验一致（5ec8acd9...）
better-sidebar: 已从备份还原，1803069 bytes
```


---

## 27. 2026-11-25 第十五轮：又一批消融失败，但拿到关键的「结构性数据」

### 严格基线（每组独立 navigate + 严格清空，三轮一致）

| 状态 | 每键 | longtask | forcedStyleAndLayout |
|---|---|---|---|
| **无菜单** | **42 / 41 ms** | 1 个 | 39 / 36 ms |
| **菜单 62 行** | **102 / 95 / 96 ms** | 18–19 个 | 1659 / 1540 / 1571 ms |
| **菜单存在但 0 条目** | **41 ms** | 1 个 | **26 ms** |

第三行是关键：**菜单容器在、但条目清空后，成本降到无菜单水平（41ms）。**

所以成本确实来自 62 个条目，不是菜单容器、不是 portal、不是 position。

### 但「单次布局很贵」这个假设被证伪

直接测「弄脏布局 → 读一次 gBCR」的循环（30 次）：

| 条件 | p50 | max | 30 次合计 |
|---|---|---|---|
| 菜单 62 行 | **0.5ms** | 0.9ms | 15.6ms |
| 条目隐藏 | 0.3ms | 2.2ms | 13.7ms |
| 菜单隐藏 | 0.3ms | 2.2ms | 13.7ms |

**单次强制布局只要 0.3–0.5ms，绝不是 30ms。**

§26 里「单次布局 30ms」的推断是错的——那个 30ms 是 `forcedStyleAndLayoutDuration` 聚合值除以调用次数的平均值，不是真实单次成本。

### CSS 隔离手段全部无效

| 手段 | 每键 |
|---|---|
| 基线 | 99ms |
| `.pc3rQa_menu{contain:layout style paint}` | 95ms |
| `.pc3rQa_viewport{contain:layout style paint}` | 95ms |
| `.pc3rQa_viewport{content-visibility:auto}` | 93ms |
| 去掉所有 `box-shadow` | 94ms |
| `.pc3rQa_item{contain:layout style}` | 94ms |

### 条目数与成本的关系（同一页面内，display 控制）

| 条目数 | 每键 |
|---|---|
| 62 | 94ms |
| 32 | 85ms |
| 16 | 80ms |
| 8 | 76ms |
| 4 | 75ms |
| 1 | 73ms |
| 0 | 74ms |

**降到 0 条目仍有 74ms** —— 与上一节的「清空后 41ms」矛盾。差别在**是否在同一页面连续测量**（累积效应）。

**教训（第 19 条）：条目数实验必须在「每次全新页面」下做，同页面连续削减会被累积状态污染。**

### 输入间隔实验（重要）

`execCommand` 单次耗时 vs 实际每键：

| 间隔 | 实际每键 | execCommand 单次 | longtask |
|---|---|---|---|
| 250ms | 264ms | 1.5–1.9ms | 10 个 / 587ms |
| 100ms | 109ms | 1.4–1.8ms | 8 个 / 465ms |
| 33ms | 64ms | 1.2–2.3ms | 10 个 / 597ms |
| 16ms | 61ms | 1.2–1.5ms | 10 个 / 579ms |
| 0ms | 61ms | 1.1–1.6ms | 8 个 / 479ms |

**`execCommand` 单次永远 1–2ms，但每键都伴随一个 ~58ms 的独立 longtask。**

`execCommand` 返回后再等 250ms 时，longtask 仍然发生（10 键 10 个），说明它是**输入触发的异步任务，不是积压导致**。

### API 调用分布（3 键，菜单 62 行，265ms longtask）

| API | 3 键总次数 | 每键 |
|---|---|---|
| `Element.closest` | **84** | 28 |
| `Element.matches` | **53** | 18 |
| `getBoundingClientRect` | **43** | 14 |
| `scrollTop/Height/clientHeight` | 6 each | 2 |
| `elementsFromPoint` | 5 | 1.7 |

`closest` 的 62 次来自 `slotOccupied` 里的 `element.closest("[data-dsh-dock-fallback]")`。

`elementsFromPoint` 在视口右下角返回 **9 个元素**（`an3WzG_scrollBody < an3WzG_body < an3WzG_root < mP3x-q_mainPanel < mP3x-q_centerCol < mP3x-q_frame < ...`）。

### 但短路 slotOccupied 仍然无效

把 `elementsFromPoint` 改成只返 1 个元素、或返空：

| 消融 | 每键 | longtask |
|---|---|---|
| 基线 | 94ms | 10 个 / 888ms |
| `elementsFromPoint` 只返 1 个 | **94ms** | 10 个 / 886ms |
| `elementsFromPoint` 返空 | **95ms** | 10 个 / 889ms |
| 恢复 | 94ms | 10 个 / 882ms |

**完全无变化。** 又一次无效消融。

### 目前的完整无效消融清单（累计）

```
✗ better-sidebar 整体禁用（副作用关菜单，非因果）
✗ better-sidebar slotOccupied 三处优化（offsetWidth/步数/采样点）
✗ elementsFromPoint 返空 / 只返 1 个
✗ 移除右侧栏锚点按钮
✗ 移除 / CSS 隐藏 dockFallback
✗ useAnchoredMaxHeight 去掉同步 c()（gBCR 40→0 但耗时转移）
✗ MenuView useLayoutEffect → useEffect
✗ 各类 CSS contain / content-visibility / 去 box-shadow
✗ 输入后主动 flush 布局
✗ 移除菜单 DOM（有效，但那等于关掉功能）
✗ 清空 viewport 子元素（有效，但那等于清空候选）
```

**唯一有效的是「让 62 个条目消失」，但那等于砍掉功能。**

### 下一步方向（需要换思路）

已知：
1. 62 个条目在 → 每键一个 ~58ms longtask
2. 62 个条目不在 → 每键 ~0ms longtask
3. 单次强制布局只要 0.3–0.5ms
4. 所有「减少布局读取次数」的改动都无效

**推论：那 58ms 不在布局读取里，而在「条目存在时才会跑的某段 JS」。**

下一轮应该：
1. 用 `console.profile` / CDP `Profiler` 抓真实 CPU profile（需要让 browser_e2e 暴露端口，或改用桌面端 CDP）
2. 或者二分 React 组件树：逐个移除 62 个条目的子元素（icon / label / shortcut），看哪个真正贵
3. 检查是否有 `IntersectionObserver` / `ResizeObserver` 在 62 个条目上逐个观察


---

## 28. 2026-11-25 第十六轮：决定性排除（成本与渲染无关）

### 先纠正一个系统性测量错误

`document.execCommand('insertText')` 在查询变成 `@zzz...` 时会**没有候选**，菜单行数变 0。

而 `document.execCommand('delete')` **删不掉内容**（本编辑器已知问题，§24 已记录）。

所以此前很多「菜单 62 行」实验，实际跑的是「菜单 0 行」。**这才是之前大量消融无效的真正原因**。

**纠正办法**：用 `recipe` 执行「按 `z` 键 + 按 `Backspace` 键」交替，文本长度恒定在 1（只有一个 `@`），菜单全程 62 行。实测有效：

```
recipe z+Backspace ×10 → 结束态 菜单=true 行=62 文本长度=1  ✓
```

### 同一按键序列，唯一变量是菜单状态

统一用 `z+Backspace ×5`（10 次按键），只有菜单状态不同：

| 场景 | 菜单 | 墙钟 | longtask |
|---|---|---|---|
| **无菜单**（先 Escape） | false | **570ms** | **1 个 / 67ms** |
| **菜单 62 行** | true | **8330ms** | **11 个 / 800ms** |
| **菜单 62 行但条目 `display:none`** | true | **9157ms** | **10 个 / 777ms** |

第三行是突破：**把 62 个条目全部 `display:none`，成本几乎没变（777 vs 800ms）。**

### 决定性实验：菜单视觉隐藏

| 场景 | 墙钟 | longtask |
|---|---|---|
| 菜单 62 行（基准） | 9109ms | 11 个 / 826ms |
| **`visibility: hidden`** | 9098ms | 10 个 / **875ms** |
| **`transform: translate(-9999px,-9999px)`** | 9425ms | 13 个 / **931ms** |
| **`opacity: 0`** | 9155ms | 11 个 / **863ms** |

**全部无变化。**

### 这排除了什么（重要）

```
✗ 不是布局（布局不跑也慢）
✗ 不是绘制（opacity:0 / visibility:hidden 关掉了绘制）
✗ 不是合成（移出屏幕关掉了合成层）
✗ 不是条目数量（display:none 关掉了条目布局）
✗ 不是 CSS contain / content-visibility / box-shadow / 动画
✗ 不是 IntersectionObserver / ResizeObserver（视觉不可见时它们不触发）
```

### 唯一结论

```
成本来自「菜单 state.open === true」时运行的 JS 逻辑，
与菜单的视觉/布局/合成完全无关。

每按一个键（z 或 Backspace 都算）：
  菜单关闭 → 0 个 longtask
  菜单打开 → 1 个 longtask，约 70–90ms
```

### 为什么之前所有「减少布局读取」的消融都无效

因为那些读取**不是成本来源**，只是碰巧发生在同一段 JS 里。真正的成本是这段 JS 的其余部分。

§27 记的「单次强制布局只有 0.3–0.5ms」与此完全吻合：布局很便宜，贵的是别的。

### 下一轮唯一正确方向

**直接抓「菜单打开时每次按键执行的那段 JS 的调用栈」。**

已知它：
1. 由按键触发（不是定时器，因为空转 0 longtask）
2. 与菜单视觉无关
3. 约 70–90ms
4. 在 `input` 事件之后异步执行（`execCommand` 只花 1–2ms）

方法：用 `Error.prepareStackTrace` 在高频函数上采样，或者包装 `MessageChannel` / `queueMicrotask` / `Promise.then` 抓异步链。

另一个更直接的思路：**用 `profile()` / CDP Profiler**。之前失败是因为 browser_e2e 的浏览器没暴露 CDP 端口。可以考虑：
- 用桌面客户端（CDP 9230）——但那是 `dsh://host`，无法执行 JS
- 让 browser_e2e 启动时带 `--remote-debugging-port`（需查它的启动参数）


---

## 29. 2026-11-25 第十七轮：根因完全确认（React 全量重渲染）

### 用 DOM API 计数器抓到真实工作量

包装 30+ 个高频 DOM API，测「6 次按键」（z+Backspace 交替，菜单全程 62 行）：

| API | 6 次按键总调用 | 每次按键 |
|---|---|---|
| **`setAttribute`** | **3039** | **507** |
| **`Element.closest`** | **1338** | **223** |
| **`appendChild`** | **1116** | **186** |
| **`Element.matches`** | **980** | **163** |
| `document.createElement` | **592** | **99** |
| `element.querySelector` | 560 | 93 |
| `getBoundingClientRect` | 528 | 88 |
| `element.querySelectorAll` | 156 | 26 |
| `getComputedStyle` | 41 | 7 |
| **合计** | **8758** | **1460** |

**每次按键：创建 99 个元素、调用 507 次 `setAttribute`、186 次 `appendChild`。**

这就是那 70–90ms 的真实内容——不是布局，是**大量的 DOM 重建**。

### setAttribute 的调用栈（全部来自 React commit）

```
93×  class          O@index-Ciz7DZxv.js:53 < Mx@:60 < Mm@:60 < Nm@:60
55×  aria-hidden    同上
26×  role          同上
25×  d             同上   ← SVG path
24×  stroke        同上   ← SVG
23×  width/height  同上   ← SVG
23×  fill          同上   ← SVG
13×  viewBox       同上   ← SVG
15×  aria-label    同上
```

`O` / `Mx` / `Mm` / `Nm` 是 React 的 commit 阶段函数。**属性全是图标（SVG）与 class/aria 属性。**

### DOM 节点身份：复用头部，重建尾部

按键前后对比 `__reactFiber# @ 卡顿排查日志（时间线）

> **这份文档是活文档。** 每次归因、排查都要在末尾追加记录：路线、方案、结果、出错原因。目的是**避免重复排查已经查清或已经排除的问题**。
>
> 动手前先读 §0（当前结论）和 §9（已排除清单），能省掉整轮试错。

---

> **2026-11-24 第三轮更正（先读）：** 此前所有绝对数字都**带着动画开销**（我没显式开 freezeAnimations）。
> 动画冻结后重测：骨架 **69ms**、候选行 **1115ms**、fileReferences **925ms**、fast-at **102ms**。
> 动画污染约 40%，但候选行仍是目标的 3.7 倍。**瓶颈结论不变**。详见 §15。
>
> **2026-11-24 第二轮更正：** §0/§9 的归因只覆盖「菜单骨架 110ms」。
> 候选行真正出现要 **冷态 1848ms / 热态 271ms**，瓶颈是 DSH 原生 `api/fileReferences/list`（服务端 1.5–2.3 秒，响应仅 684 字节）。
> 详见 **§14**。优化优先级已因此调整：接管 fileReferences > 优化布局读取。
### 新发现：第三个 @ 源

菜单分组实测为 3 个：

| 源 | 候选数 |
|---|---|
| `主机` | 0 |
| `reference` | **62** |
| `betterSidebarQuote` | 0 |

`betterSidebarQuote` 来自 `dsh-better-sidebar` 插件，是第三个注册到 `@` 的源。


---

## 30. 2026-11-25 第十八轮：双向归因完成（增删不对称）

### 可靠的测量指标：`input` → 首帧延迟

`recipe` 的 `press` 有约 900ms 工具开销，不能用来算每键成本。改用页面内指标：

```js
document.addEventListener('input', () => {
  const s = performance.now();
  requestAnimationFrame(() => record(performance.now() - s));
}, true);
```

**同一文本状态（`len=1`）下的对照**：

| 菜单状态 | 延迟 | 中位 |
|---|---|---|
| **关闭** | 5 / 10 / 11 ms | **10ms** |
| **关闭（复测）** | 6 / 12 / 13 ms | **12ms** |
| **打开 62 行** | 105 / 95 / 94 ms | **95ms** |

**菜单打开时慢 9 倍（10ms → 95ms）。这是无工具开销的可靠数字。**

### DOM 调用量差异（6 次按键，唯一变量是菜单状态）

| API | 菜单关闭 | 菜单打开 | 差值 |
|---|---|---|---|
| **`setAttribute`** | **0** | **4375** | **+4375** |
| `closest` | 75 | 1664 | +1589 |
| `appendChild` | 0 | 1597 | +1597 |
| `matches` | 35 | 1304 | +1269 |
| `element.querySelector` | 0 | 884 | +884 |
| **`createElement`** | **0** | **819** | **+819** |
| `getBoundingClientRect` | 103 | 529 | +426 |
| `element.querySelectorAll` | 0 | 268 | +268 |
| `removeChild` | 0 | 221 | +221 |

**菜单关闭时 `setAttribute` / `createElement` / `appendChild` 全部为 0。**

### 单次按键的精确开销（增删极不对称）

菜单 62 行、542 个元素的状态下：

| 按键 | 效果 | createElement | setAttribute | appendChild | removeChild |
|---|---|---|---|---|---|
| **`z`** | 62 行 → 1 行（删 61 个） | **12** | **36** | 14 | **67** |
| **`Backspace`** | 1 行 → 62 行（建 62 个） | **288** | **1489** | 545 | 5 |

**删便宜（12 个元素）、建很贵（288 个元素）。**

创建的标签分布：`span` 359 / `button` 101 / `kbd` 22 / `div` 18（4 次按键合计 500 个）。

全部来自 `Mx@index-Ciz7DZxv.js:60 < Mm@:60 < Nm@:60` —— React 的 commit 阶段。

### 这与用户症状的精确对应

```
长按 @（从空开始）：
  第 1 个 @ → 菜单从无到有，建 62 个 item      ← 最贵（~95ms）
  第 2 个 @ → 查询变 @，候选 62 → 9            ← 删，便宜
  第 3 个及以上 → 候选 1 行，删到底             ← 最便宜
  ...
  所以「长按 @」本身的成本主要在第一次，后续每个 @ 仍有 ~65ms 的固定开销（见下）

长按 @ 后按 Backspace（删回）：
  候选 1 → 62，每次重建 288 个元素              ← 每键 ~95ms，最卡
```

但用户说的是「长按 @ 时非常卡」。实测数据：

| 场景 | 每键 |
|---|---|
| 空页面长按 `@` × 10 | 62–97ms（10 个 longtask） |
| 候选 1 行时按键 | 62ms |
| 候选 62 行时按键 | 95ms |
| 无菜单按键 | 10ms |

**即使候选只有 1 行，每键仍要 62ms** —— 这部分固定开销与 item 数量无关，是第三块成本。

### 三块成本拆解（当前最完整模型）

```
① 无菜单基线         : 10ms  ← Lexical + React 正常输入
② 菜单 open 的固定开销: +52ms ← 候选 1 行时达到 62ms，与 item 数无关
③ 62 个 item 的增量  : +33ms ← 达到 95ms
```

② 是此前一直没分离出来的部分：**只要菜单开着（哪怕 0-1 行），每键就多 52ms**。

### 已排除（累计，本轮新增）

```
✗ 布局 / 绘制 / 合成（opacity:0 / visibility:hidden / translate 全部无变化）
✗ 条目数量作为主因（1 行也要 62ms）
✗ CSS contain / content-visibility / box-shadow / 动画 / will-change
✗ IntersectionObserver / ResizeObserver
✗ 异步调度（MessageChannel / queueMicrotask / setTimeout / rAF / requestIdleCallback 全未捕获）
✗ better-sidebar 的任何改动
✗ useAnchoredMaxHeight 的同步读取
```

### 下一轮方向

**分离 ②：菜单 open 但 0 行时的 52ms 固定开销。**

做法：让菜单 open 但 `groups` 全空（例如打 `@zzzz` 让候选归零，菜单保持 open），测 input→帧延迟。若仍是 62ms，则 52ms 来自「input-trigger 的 track() 链路本身」，与渲染无关。


---

## 31. 2026-11-25 第十九轮：按调用点计时抓到唯一真凶（scrollTop @ input-trigger:2745）

### 突破：按调用点累计耗时的计时代理

之前所有消融都失败，是因为只看「调用次数」不看「每次调用多贵」。本轮改成每个 API 调用都计时，并按调用栈聚合：

```js
const wrapG = (obj, prop, label) => {
  const d = Object.getOwnPropertyDescriptor(obj, prop)
  const g = d.get
  Object.defineProperty(obj, prop, { ...d, get() {
    const k = label + ' | ' + caller()      // caller 用 prepareStackTrace 抓 2 层
    const s = performance.now()
    const r = g.call(this)
    rec(k, performance.now() - s)           // 按调用点累计
    return r
  } })
}
```

### 结果（菜单 1 行，6 次按键）

| 调用点 | 累计耗时 | 次数 | 每次 |
|---|---|---|---|
| **`scrollTop` @ `290e1f:2745`** | **488.8ms** | 19 | **25.7ms** |
| `elementsFromPoint` @ `slotFree` | 18.1ms | 65 | 0.28ms |
| `gBCR` @ `slotOccupied` | 1.3ms | 455 | 0.003ms |
| `gBCR` @ `readRightPanelOpen` | 0.5ms | 13 | 0.04ms |
| 其余全部 | < 1ms | | |

**`scrollTop` 一项占 96%，其余全部加起来只有 20ms。**

### 同一方法换 API 再验，结论稳定

包装 `gBCR` 时，最贵的是 `c()` @ `index:130`（490.3ms / 19 次 / 25.8ms）；
包装 `scrollTop` 时，最贵的是 `2745`（488.8ms / 19 次 / 25.7ms）。

**两者是同一处：`MenuView` 里 `updateOverflowHint` 读 `viewport.scrollTop`。**

`c()` 那次是 `useAnchoredMaxHeight` 的 `getBoundingClientRect`，两者都在同一个渲染帧内、都把 62 项菜单的布局撑满。

### 源码位置（asar 内，字符偏移 35915）

文件：`/dsh/node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js`（44769 字节，5 行的压缩 bundle）

```js
const maxHeight = useAnchoredMaxHeight(listRef, MAX_HEIGHT, state, TOP_MARGIN)
const updateOverflowHint = useCallback(() => {
  const viewport = viewportRef.current
  setHasOverflowBelow(
    viewport !== null &&
    viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1   // ← 25.7ms
  )
}, [])
useLayoutEffect(() => { updateOverflowHint() }, [state, maxHeight, updateOverflowHint]);  // ← state 每键都变
```

**为什么这么慢**：`scrollTop` 是布局属性读取。菜单里 62 个 `<button>` + 359 个 `<span>` + 175 个 SVG `<path>`（共 542 个元素），每次按键 React 更新 state → `useLayoutEffect` 同步读 `scrollTop` → 浏览器必须先把整棵 542 元素子树重新布局才能回答 → **单次 25.7ms**。

### 三个补丁全部「生效但无效」，原因终于清楚

| 补丁 | 是否写进 asar | `c()` / `scrollTop` 是否消失 | longtask 变化 |
|---|---|---|---|
| `useAnchoredMaxHeight` 去掉同步 `c()` | 是（已验证字符串替换成功） | `c()` 的 gBCR 调用 490ms → **0** | 493ms → **451ms**（几乎不变） |
| `updateOverflowHint` 依赖 `state` → `state.open` | 是 | `scrollTop` 仍 19 次 / 488ms | 不变 |
| `updateOverflowHint` 内部表达式改常量 `false` | 是 | `scrollTop` 仍 19 次 / 488ms | 不变 |

### 关键发现：asar 补丁对运行中的进程无效

**这是本轮最重要的方法论结论。**

证据链：
1. asar 内确认补丁存在：`contains('viewport!==null&&false') === true`，原表达式已不存在
2. 但页面运行时的调用栈仍指向 `290e1f:2745` 的原始 `scrollTop` 读取
3. 页面内 `fetch` 拉取实际加载的合并包（5.4MB），内容为**原始版**（`viewport.scrollTop+viewport.clientHeight` 仍在）
4. 全盘搜索 `C:/lengduan/softwares/DeepSeekHarness/resources` 与 profile `node_modules`，**磁盘上无任何其他副本**

**结论：宿主进程（PID 15220，即监听 50470 的 `DeepSeek Harness.exe`）在启动时把插件包读进内存，之后改 asar 不再生效。必须重启客户端才能让 asar 补丁生效。**

之前 §26 记的「补丁生效」是误判——那次只是字符串替换成功，从未验证运行时是否真的用上了新代码。

### 纪律新增（第 21 条）

**验证 asar 补丁是否生效，不能只看「asar 内字符串已替换」，必须看运行时证据**：
- 调用栈里旧代码路径是否消失
- 或页面内 `fetch` 拉取该插件包，确认返回的是补丁版

### 当前状态

```
asar:      已从备份完整还原，SHA256 = 5ec8acd9e72b93b6680c953c1be44a72（与备份一致）
插件:      dsh-better-sidebar 未被修改
结论:      scrollTop @ input-trigger:2745 是唯一主要成本（96%）
待办:      需重启客户端让补丁生效，再验证是否真的解决卡顿
```

### 下一步

1. 重启 DSH 客户端（PID 15220）
2. 重新打补丁（`updateOverflowHint` 内部改常量 / 依赖改 `state.open`），或更彻底：让 `MenuView` 在 `state` 变化时完全不读布局
3. 重启后**先验证补丁运行时生效**（调用栈中 `290e1f:2745` 的 scrollTop 消失），再测卡顿


---

## 32. 2026-11-25 第二十轮：补丁终于运行时生效（首次拿到真实改善）

### 前提：重启客户端

§31 的结论得到验证：**asar 补丁必须重启客户端才生效**。

重启后 GUI 端口从 50470 变为 **60472**。

### 运行时验证（这一步此前从未做过）

用页面内 `fetch` 拉取实际加载的插件包，逐项核对：

| 补丁 | 验证项 | 结果 |
|---|---|---|
| B（input-trigger） | 含 `state.open,maxHeight,updateOverflowHint` | **true** |
| B | 仍含 `[state,maxHeight,updateOverflowHint]` | **false** |
| A（useAnchoredMaxHeight） | 仍含 `return c(),window.addEventListener("resize",c)` | **false** |

**两个补丁都确认在运行时生效。** 这是此前所有「补丁无效」结论的真正原因。

### 补丁内容

**补丁 A** — `dsh-web-frontend/dist/assets/index-Ciz7DZxv.js`（1093870 字节）

```js
// 原
return c(),window.addEventListener("resize",c),window.addEventListener("scroll",c,!0),...
// 改（去掉 useLayoutEffect 里的同步布局读取）
return     window.addEventListener("resize",c),window.addEventListener("scroll",c,!0),...
```

**补丁 B** — `dsh-client-ui-input-trigger/lib/client.js`（44769 字节）

```js
// 原
(0,react.useLayoutEffect)(()=>{updateOverflowHint()},[state,maxHeight,updateOverflowHint]);
// 改（依赖从整个 state 收窄到 state.open）
(0,react.useEffect)(()=>{updateOverflowHint()},[state.open,maxHeight,updateOverflowHint]);
```

两处均等长替换，asar 结构与 integrity 均未破坏。

### 效果（实测）

**按调用点计时（5 次按键 × 2）**：

| 指标 | 补丁前 | 补丁后 | 改善 |
|---|---|---|---|
| **forced 强制布局** | **420ms** | **53ms** | **-87%** |
| 被测 JS API 总耗时 | 509ms | 39.2ms | -92% |
| 最贵调用点 | `scrollTop` 488ms / 19 次 | `eip` 33.5ms / 115 次 | — |

**input→rAF 延迟（各 2 轮）**：

| 场景 | 补丁前 | 补丁后 | 改善 |
|---|---|---|---|
| 菜单关闭 | 6 / 10ms | 9 / 8ms | 不变（基线） |
| **菜单打开 69 行** | **95ms** | **37 / 54ms** | **-43% ~ -61%** |

### 结论

```
✓ 补丁确实有效：forced 降 87%，菜单开时延迟降 43-61%
✗ 但尚未达到「与普通字符一样流畅」（目标 < 15ms）

当前剩余差距：菜单开 37-54ms  vs  菜单关 8-9ms
```

### 仍待解决：剩余的 30-45ms

补丁后最贵的调用点已变成：

| 调用点 | 耗时 | 次数 |
|---|---|---|
| `elementsFromPoint` @ `slotFree`（better-sidebar） | 33.5ms | 115 |
| `gBCR` @ `slotOccupied`（better-sidebar） | 4.1ms | 805 |
| `gBCR` @ `input-trigger` | 0.7ms | 23 |

**better-sidebar 的 `measure()` 现在是最大剩余项（33.5ms + 4.1ms ≈ 38ms）。**

但注意：它走的是 500ms 定时器（`DockFallback` 的 `setInterval(onResize, REALIGN_MS=500)`），不是按键直接触发。§28 的 `visibility:hidden` 实验也证明它与菜单视觉无关。

**下一轮方向**：
1. 移除/短路 better-sidebar 的 `DockFallback` 定时器（它是唯一还剩的 30ms+ 项）
2. 或者查清为什么菜单打开时 `measure()` 变得如此昂贵（菜单在视口内改变了 `elementsFromPoint` 的返回元素数）

### 回滚方式

```
asar 原始备份: C:\lengduan\githubs\my-dsh-plugins\.scratch\app.asar.backup (199.4MB)
SHA256 = 5ec8acd9e72b93b6680c953c1be44a72
回滚后需重启客户端
```


---

## 33. 2026-11-25 第二十一轮：测量方法全面返工 + 真凶收敛到 better-sidebar

### 用户质疑是对的：我此前所有长按测量都无效

用户：«我长按这个@键的时候还是很卡顿 是否是因为我们的插件不支持这种长按输入，导致你无法准确地测量？»

**结论：是。我用的三个通道没有一个能复现长按。**

| 通道 | 缺陷 |
|---|---|
| `browser_e2e_press` 单次 | 每次约 930ms 工具往返，通道本身的时间远大于页面耗时 |
| `browser_e2e_recipe` | 每步约 900ms，同上 |
| `browser_e2e_fill(mode:'keystrokes')` | 菜单浮层出现后 Playwright 的 actionability 检查每次要等约 1000ms |
| `execCommand` 裸测 | Lexical 异步处理插入，`innerText` 立刻读不到，导致「文本长度恒为 1」，数据无效 |
| `input→rAF` 单键 | 只测单键延迟，不反映连续输入下的积压 |

**决定性判别实验（证明 Playwright 通道不可信）**：

| 场景 | 按键间隔 | 字符插入 |
|---|---|---|
| 菜单关闭 + 打 z ×15 | **15ms** | 15/15 |
| 菜单打开 + 打 z ×15 | **1011ms** | 12/15（超时） |

菜单打开时**普通字符 z 也变成 1011ms，但主线程 longtask 为 0**。

**这 1 秒不是页面卡顿，是 Playwright 在等元素稳定。** 所以用它测出的任何「长按」数字都不可信。

### 有效口径（唯一可信）

```js
// execCommand 插入 + 16ms 让出（给 Lexical 处理时间），扣除等待后得每键主线程成本
const t0 = performance.now();
for (let i = 0; i < n; i++) { document.execCommand('insertText', false, ch); await sleep(16) }
const perKey = (performance.now() - t0 - (n - 1) * 16) / n;
// 同时必须断言 innerText.length === n，否则数据无效
```

判定标准：**OS 按键重复速率约 33ms/键**，超过就会积压，用户感知为「卡」。

### 测量污染问题（重要教训）

用 `Error.prepareStackTrace` + `new Error().stack` 包装热点 DOM API 来抓调用栈，会让每次调用多花**数毫秒到数十毫秒**。

实测：同一场景下，带栈探针时测得 144 → 197 → 270 → 330ms/键，数字随探针运行时间单调恶化；
卸掉探针后回到 13–112ms。**带探针的数字只能用于「归因比例」，不能用于「绝对性能」。**

### 真凶：better-sidebar 的右侧面板状态轮询

**A/B 对照（同一页面、同一按键序列、同一口径）**：

| better-sidebar | 菜单打开时每键 | forced 强制布局 |
|---|---|---|
| **启用** | **112.8 / 72.3 ms** | **918 / 490 ms** |
| **禁用** | **13.6 / 14.2 ms** | **0 / 0 ms** |

**禁用后 forced 精确为 0，两轮一致。**

### 根因代码（`dsh-better-sidebar/lib/client.js`）

```js
const POLL_MS = 500;                                  // 轮询间隔

function isVisible(element) {
  const rect = element.getBoundingClientRect();        // ← 菜单打开时单次 57.8ms
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(element);             // ← 紧接着读样式，形成 读布局→读样式→再读布局
  return style.visibility !== "hidden" && style.display !== "none";
}

function readRightPanelOpen() {
  for (const element of doc.querySelectorAll("[data-sidebar-right-expand]")) if (isVisible(element)) return false;
  for (const element of doc.querySelectorAll("[data-sidebar-right-toggle]")) if (isVisible(element)) return true;
  return false;
}

function publish() { const next = readRightPanelOpen(); if (next === open) return; open = next; /* 通知 */ }
function startTimer$1() { timer = setInterval(publish, POLL_MS); }   // ← 每 500ms
```

### 为什么它本不该这么慢（回答 A5 / K2）

**`isVisible` 只是为了判断一个按钮在不在视野里，`getBoundingClientRect()` 理论上应该 < 0.1ms。**

单次实测 57.8ms 的原因：
1. 菜单打开时 DOM 里有 **62 个 button + 359 个 span + 175 个 SVG path（共 542 元素）**
2. `isVisible` 是 `gBCR()` 后**立刻** `getComputedStyle()` —— 这是经典的 layout thrashing 模式
3. 但单看这两句不该 57ms，真正的问题是**它在一次按键内被反复触发**：`selectionchange` / `input` / 500ms 定时器三条路径都会走到 `publish()`
4. 每次按键，浏览器已经因为菜单重渲染把布局弄脏，此时任何一次 `gBCR` 都要先把 542 元素重新布局 —— 而 62 项菜单的重排本身就要几十毫秒

**换句话说：不是 `isVisible` 慢，是它每次都在「菜单刚重渲染完、布局最脏」的时刻去捅布局，从而把整个重排成本记账到自己头上。**

正确的做法：
1. `isVisible` 用 `element.checkVisibility()`（不触发完整布局）或 `offsetParent !== null`
2. 把 `gBCR` 和 `getComputedStyle` 合并 —— 只读 `gBCR` 就够判断 `width/height > 0`，`getComputedStyle` 那句是冗余的
3. 轮询间隔内用 `requestIdleCallback` 包裹，避免在输入帧内执行
4. 或者在菜单打开时暂停这个轮询（右侧面板开合状态在打字期间不会变）

### 当前状态

```
asar 补丁:      A（useAnchoredMaxHeight 去同步 c()）+ B（updateOverflowHint 依赖收窄）均已生效
better-sidebar: 已禁用（临时，用于 A/B 取证）
有效改善:       菜单打开时每键 112.8/72.3ms → 13.6/14.2ms，forced 918/490ms → 0/0ms
```

### 下一步

1. 把 better-sidebar 的 `isVisible` 改成不触发完整布局的实现（`checkVisibility()` 或复用同一次 gBCR 的结果）
2. 重新启用插件，验证既保住功能又拿到 14ms
3. 用有效口径做最终验收：长按 @ 与长按普通字符的每键成本对比


---

## 34. 2026-11-25 第二十二轮：三段代码级修复都无效，但 A/B 事实成立

### 已确认的事实（唯一可信的 A/B）

同一页面、同一按键序列（z ×12）、同一口径（execCommand + 16ms 让出）：

| better-sidebar | 菜单打开时每键 | forced 强制布局 |
|---|---|---|
| **启用（原始代码）** | **112.8 / 72.3 ms** | **918 / 490 ms** |
| **禁用** | **13.6 / 14.2 ms** | **0 / 0 ms** |

两轮一致，差距 5–8 倍。**这是本轮唯一可以站得住的结论。**

### 但三段代码修复都无法复现这个改善

| 尝试 | 改动 | 菜单打开时每键 | 判定 |
|---|---|---|---|
| 修复 1 | `isVisible` 改用 `checkVisibility({visibilityProperty:true})` | 66.9 / 83.7 ms | **无效**（仍远高于 13.6） |
| 修复 2 | `readRightPanelOpen` 直接 `return false` 短路 | 68.3 ms | **无效** |
| 修复 3 | `elementsFromPoint` 强制返空 | 与基线相同 | **无效** |

三段都确认写进了磁盘并在运行时生效（`fetch` 拉取插件包验证 `hasCheckVisibility: true`），但都没能复现禁用时的 13.6ms。

### 进一步排除：与菜单的视觉无关

| 实验 | 菜单打开时每键 |
|---|---|
| 基线（62 行可见） | 63.9 ms |
| **菜单 `visibility:hidden`** | **65.7 ms** |
| 恢复 | 83.9 ms |

**菜单不可见后成本不变。** 与 §28 的结论一致：与渲染/绘制/合成无关。

### 所以成本在哪

三段针对性修复全无效，但整体禁用有效 → **成本不是某个函数，而是 better-sidebar 挂载后让页面 DOM/React 树整体变复杂**，导致任何一次布局重算都更贵。

佐证：
1. 菜单 62 行时页面共 **542 个元素在菜单内**，加上 better-sidebar 自己的组件树
2. `forced` 总量在启用时 918/490ms，禁用时精确为 **0**
3. 单次 `gBCR` 在启用时 57.8ms，禁用时不出现

**即：better-sidebar 让「一次布局」的单价从接近 0 涨到几十毫秒。**

### 已回滚

```
better-sidebar: 已从 npm 重新校验，SHA256 = C5F6A461...2FD，与 dsh-better-sidebar@0.32.1 官方包完全一致
asar:           两个补丁（A + B）保留，已确认运行时生效
```

### 下一轮的真正方向

不再试图「修 better-sidebar 的某个函数」，而是：

1. **测量 better-sidebar 挂载后到底给 DOM 增加了多少元素**（对比启用/禁用的 `document.querySelectorAll('*').length`）
2. **找出它的哪个组件在菜单打开时会参与布局**（React DevTools 式的 fiber 遍历）
3. 或者接受现实：**菜单 62 行本身就是 542 个元素，把候选数从 62 降到 15–20，菜单本身就便宜了** —— 这是最直接、最不依赖第三方插件的路径

**第 3 条是当前最可行的方向**：dsh-fast-at 插件本来就控制候选数量，把 62 条降到 20 条，菜单元素从 542 降到约 175，布局成本按比例下降。


---

## 35. 2026-11-25 第二十三轮：目标达成（31ms 差 → 7ms 差，两者均低于 OS 节拍）

### 测量终于稳定了：清空必须严格

本轮最大的方法论修正：**`document.execCommand('delete')` 清不掉 Lexical 的内容**。

实测：`execCommand('delete')` 后 `innerText.length` 仍是 13，字符不断累积，导致 Lexical 处理越来越慢，**污染了此前所有「菜单开/关」的对照**。

**修正后的清空流程（必须断言）**：

```js
for (let k = 0; k < 4; k++) {
  await press('Control+a');
  await press('Delete');
  if (innerText.length === 0) break;   // ← 必须断言，否则本轮数据作废
}
```

### 严格流程下的稳定基线

| 场景 | input→rAF 中位 |
|---|---|
| 无菜单（清空后 len=0） | **10 / 13 / 6 / 8 ms** |
| 菜单 62 行（len=1） | **77 / 147 ms** |

**6–12 倍差距，这就是用户感知的卡顿。**

### 关键发现：better-sidebar 的开销与菜单无关

同一页面、菜单状态相同（都 0 行）：

| better-sidebar | input→rAF 中位 |
|---|---|
| 启用 | **87 ms**（96/84/92/102/87/74） |
| 禁用 | **18 ms**（9/30/19/18/17/20） |

**4.8 倍。** 这推翻了「better-sidebar 只是让菜单变贵」的假设 —— **它让整个输入路径都变慢了**，`@` 只是更容易被察觉。

### 布局单价实验：排除了「菜单 DOM 复杂」

| 条件 | 单次 gBCR（弄脏后） |
|---|---|
| 菜单 62 行 / 542 元素可见 | **p50 0.4ms** |
| 菜单隐藏 | p50 0.3ms |

**布局本身只要 0.4ms，完全不是瓶颈。** 菜单元素数实验也证实：62/32/20/0 条分别为 71/48/50/57ms，非单调 —— 与元素数无关。

### CSS 隔离全线无效

| 手段 | input→rAF 中位 |
|---|---|
| 基线 | 87ms |
| `item{content-visibility:auto}` | 79ms |
| `item{contain:layout style paint}` | 91ms |
| `menu{contain:layout style paint size}` | 78ms |
| 恢复 | 79ms |

### 最终验收（better-sidebar 禁用）

严格清空 + 15 键，两轮：

| 输入 | 每键成本 | 中位延迟 |
|---|---|---|
| **长按 z** | **14.6 / 26.0 ms** | 7 / 13 ms |
| **长按 @** | **23.2 / 31.5 ms** | 18 / 20 ms |
| 平均差距 | **z 20.3ms vs @ 27.4ms，差 7.1ms（1.3×）** | |

**OS 按键重复速率约 33ms/键：两者都低于节拍，都不积压。**

### 这回答了 A9 / G11

```
问题：短路之后性能是否恢复到「正常输入普通字符」的水平？
答案：是。长按 @ 27.4ms/键 vs 长按 z 20.3ms/键，差距 1.3 倍，
      两者均 < 33ms 的 OS 重复速率，连续输入不再积压。

对比基线（better-sidebar 启用）：长按 @ 77–147ms/键，是节拍的 2.3–4.5 倍，必然积压。
```

### 为什么它本不该这么慢（回答 A5 / K2）

**根因：`dsh-better-sidebar` 让整个输入路径慢了 4.8 倍，与 `@` 无关。**

证据链：
1. 菜单 0 行、无 `@` 参与时，启用 87ms vs 禁用 18ms
2. 布局单价仅 0.4ms —— 不是布局复杂度
3. 三段针对性代码修复（`isVisible` / `readRightPanelOpen` / `elementsFromPoint`）全部无效
4. CSS 隔离（contain / content-visibility）全部无效

**即：成本不在某个函数，而在插件挂载后的整体运行时开销。**

### 可执行的优化点

```
最直接：不安装 / 禁用 dsh-better-sidebar
  代价：失去空白会话的底部工作台开关等增强功能
  收益：长按 @ 从 77-147ms/键 降到 23-31ms/键，不再积压

若必须保留该插件：
  1. 向插件作者报告「启用后每次按键 input→rAF 增加约 70ms」
  2. 排查它的全局事件监听（selectionchange / resize / 500ms 轮询）
  3. 用 Performance 面板录一次按键，看 React commit 阶段耗时
```

### 当前状态

```
better-sidebar: 已禁用（这是达成目标的关键）
asar 补丁:      A + B 保留，运行时已验证生效
实测:           长按 @ 27.4ms/键，长按 z 20.3ms/键，均 < 33ms 节拍
```


---

## 36. 2026-11-25 第二十四轮：反向 A/B 严格确认 + 成本精确定位到「渲染阶段」

### 双向 A/B，各 3 轮（每轮严格清空并断言 len===0）

| better-sidebar | 长按 z（每键） | 长按 @（每键） | @/z |
|---|---|---|---|
| **启用** | 15.2 / 11.5 / 15.5 ms | **75.9 / 94.9 / 62.8 ms** | **4–8×** |
| **禁用** | 21.9 / 18.8 / 13.0 ms | **19.2 / 12.1 / 16.4 ms** | **0.9–1.3×** |

**禁用时 `@` 与 `z` 完全持平（甚至更快），启用时 `@` 是 `z` 的 4–8 倍。** 这完成了因果确认。

### 成本精确切分：`execCommand` 很快，成本在渲染

单次 `execCommand('insertText')` 的**同步**耗时 vs 之后等到 rAF 的时间：

| 场景 | execCommand 同步 | → rAF |
|---|---|---|
| 启用 + 菜单开 | **1.5 ms**（max 3.4） | **62.8 ms**（max 131.4） |
| 禁用 + 菜单开（62 行全开） | — | **17.1 ms**（max 125.3） |

**`execCommand` 本身只要 1.5ms，剩下 61ms 全在之后的 React 渲染/提交阶段。**

注意第二次对照时禁用侧的菜单是 **62 行全开**，而启用侧是 0 行 —— **菜单更全、插件禁用时反而快 3.7 倍**。

### 本轮排除的四个可能（全部证否）

| 假设 | 实验 | 结果 |
|---|---|---|
| DOM 规模 | 注入 372 元素假浮层 | 7ms → 9ms，**无关** |
| 布局复杂度 | 弄脏后单次 gBCR | **0.4ms**，不是瓶颈 |
| 全局事件监听 | 统计 `addEventListener` | 无 `selectionchange`、无 `beforeinput`；`keydown` 只有 IME 守卫与 Escape |
| CSS 隔离 | contain / content-visibility | 78–91ms，**全部无效** |

### 已排除的代码级修复（前几轮）

| 尝试 | 结果 |
|---|---|
| `isVisible` → `checkVisibility()` | 66.9 / 83.7ms，无效 |
| `readRightPanelOpen` 直接短路 | 68.3ms，无效 |
| `elementsFromPoint` 强制返空 | 与基线相同，无效 |

### 结论

**better-sidebar 的成本不在任何单一函数，而在它挂载后让整个 React 渲染/提交流水线变重（每键 +45ms）。**

这解释了为什么三段针对性修复全部无效：改的不是成本所在的位置。

### 当前配置（目标已达成）

```
cordis.patch.yml:260-261
  - id: better-sidebar
    disabled: true
```

实测：长按 @ 19.2 / 12.1 / 16.4 ms，长按 z 21.9 / 18.8 / 13.0 ms，**持平，均 < 33ms 节拍**。

### 下一步（保留该功能时的方向）

1. 用 React DevTools Profiler 录一次按键，看哪个组件的 commit 耗时最长
2. 重点看它在每次 `insertText` 后是否有大范围 context 更新导致整棵树重渲染
3. 若确实如此，可向作者报 issue：启用后每次输入 +45ms，与菜单内容无关


---

## 37. 2026-11-25 收尾：最终数据与交付状态

### 最终验收（better-sidebar 禁用，全新页面，逐轮严格清空 len===0）

| 轮次 | 长按 @ ×15 | 长按 z ×15 |
|---|---|---|
| 1 | 25.9 ms | 21.6 ms |
| 2 | 12.7 ms | 19.2 ms |
| 3 | 13.2 ms | — |
| **中位** | **13.2 ms** | **19.2 ms** |

**长按 @ 比长按 z 还快。** 两者都远低于 OS 按键重复速率（约 33ms/键），不产生积压。

### 交付状态

```
1. asar 补丁 A + B      已应用，运行时已验证（强制布局 420ms → 53ms）
2. better-sidebar       已禁用，持久化于 cordis.patch.yml:260-261
3. 实测                 长按 @ 13.2ms/键，长按 z 19.2ms/键，持平
```

### 代价说明（必须让用户知情）

`dsh-better-sidebar` 提供：文件树、编辑器、变更面板、任务面板、侧聊、
以及给其它插件注册侧栏标签 / 文件查看器的服务。

禁用后这些功能全部下线。

### 若用户希望保留该插件

唯一未走完的路：**React DevTools Profiler 定位 commit 阶段耗时**。

已知事实足够写一份 issue：
```
启用 dsh-better-sidebar 后，每次 insertText 的 render 阶段增加约 45ms；
与触发菜单、DOM 规模、布局复杂度均无关（已逐项排除）；
长按 @ 从 13ms/键 恶化到 63-95ms/键。
```


---

## 38. 2026-11-25 用户决策与最终交付清单

### 用户决策（card answer）

> 如何处理 dsh-better-sidebar？ → **保持禁用，优先流畅**

### 最终交付状态（已逐项核实）

| 项 | 状态 | 证据 |
|---|---|---|
| better-sidebar 禁用 | ✅ 已持久化 | `cordis.patch.yml:260-261` → `- id: better-sidebar` / `disabled: true` |
| better-sidebar 文件完整 | ✅ 未改动 | SHA256 `C5F6A461…696272FD`，与 npm 0.32.1 官方包一致，1803069 B |
| asar 备份可用 | ✅ 存在 | `.scratch\app.asar.backup`，209083008 B，SHA256 `5EC8ACD9…20F69`（pristine） |
| asar 当前状态 | ✅ 含补丁 A+B | SHA256 `087AAFC…97121`，大小与备份相同（原位替换） |

### 回滚方法

```powershell
# 1. 恢复 asar（撤回补丁 A+B）
Copy-Item 'C:\lengduan\githubs\my-dsh-plugins\.scratch\app.asar.backup' `
          'C:\lengduan\softwares\DeepSeekHarness\resources\app.asar' -Force

# 2. 恢复 better-sidebar（撤回禁用）
#    编辑 cordis.patch.yml 第 260-261 行，改为 disabled: false，或直接删除这两行

# 3. 重启客户端使两者生效
```

### 最终性能数据（复述，便于查阅）

```
better-sidebar 禁用：
  长按 @ ×15   25.9 / 12.7 / 13.2 ms/键   中位 13.2 ms
  长按 z ×15   21.6 / 19.2 ms/键         中位 19.2 ms
  → 两者持平，@ 甚至更快；均 < 33ms OS 节拍，不积压

better-sidebar 启用（对照）：
  长按 @ ×15   75.9 / 94.9 / 62.8 ms/键
  长按 z ×15   15.2 / 11.5 / 15.5 ms/键
  → @ 是 z 的 4-8 倍，必然积压
```

### 本轮的完整排除清单（供后人查阅，勿重复）

| 排除项 | 实验方法 | 结论 |
|---|---|---|
| DOM 规模 | 注入 372 元素假浮层 | 7ms → 9ms，无关 |
| 布局复杂度 | 弄脏后单次 gBCR | 0.4ms，不是瓶颈 |
| 菜单条目数 | 62/32/20/0 条对照 | 71/48/50/57ms，非单调，无关 |
| 菜单可见性 | visibility:hidden | 63.9 → 65.7ms，无关 |
| CSS 隔离 | contain / content-visibility | 78–91ms，全部无效 |
| 全局事件监听 | 统计 addEventListener | 无 selectionchange / beforeinput |
| isVisible 代码 | 改用 checkVisibility() | 66.9/83.7ms，无效 |
| readRightPanelOpen | 直接 return false | 68.3ms，无效 |
| elementsFromPoint | 强制返空 | 与基线相同，无效 |
| execCommand 本身 | 测同步耗时 | 仅 1.5ms，成本在之后的渲染 |
| Playwright 通道 | 菜单开时打 z | 1011ms 但 longtask=0，工具侧等待 |
| execCommand 清空 | 测量后查 innerText | 清不掉（len 恒 13），污染了早期数据 |

### 测量方法（唯一可信口径，务必沿用）

```js
// 1. 严格清空并断言
for (let k = 0; k < 4; k++) {
  await press('Control+a'); await press('Delete');
  if (innerText.length === 0) break;   // 不断言 = 数据作废
}

// 2. 连续输入 + 扣除等待
const t0 = performance.now();
for (let i = 0; i < 15; i++) { document.execCommand('insertText', false, ch); await sleep(16) }
const perKey = (performance.now() - t0 - 14 * 16) / 15;

// 3. 判定标准
//    perKey < 33ms  → 不积压（OS 按键重复速率）
//    perKey > 33ms  → 积压，用户感知为卡
```


---

## 39. 2026-11-25 待排查：删除路径的残余卡顿（用户报告，尚未测量）

### 现象（用户原话）

> 全选 删除 或者 长按 删除键删除的时候还有一点点卡顿，这个问题先记录

两条触发路径：
1. **全选后删除**：`Ctrl+A` → `Delete`
2. **长按退格键连续删除**：按住 Backspace 持续删除

程度：「一点点卡顿」，比此前长按 `@` 的问题轻很多，但可感知。

### 状态

**仅记录，未做任何测量。** 本节不含实测数字，不得当作已归因。

### 为什么值得单独记一笔（与 §37 的结论不冲突）

§37 确认的是**插入路径**（`insertText`）在 better-sidebar 禁用后已达标（13.2ms/键）。

删除走的是不同路径，未验证是否同源：

| 路径 | 事件 | 关键差异 |
|---|---|---|
| 插入 | `beforeinput` / `input`，`inputType=insertText` | 已测 |
| 全选删除 | `beforeinput` / `input`，`inputType=deleteContentBackward` 或 `deleteByCut` | **未测** |
| 长按退格 | 同上，但**连续高频**触发 | **未测** |

尤其长按退格：触点不在 `@` 上，`@` 菜单不开，**此前的候选/菜单相关结论全部不适用**。

### 待验证的假设（按可能性排序，均为推测）

1. **同一渲染瓶颈的另一种表现**：若 better-sidebar 让 render 阶段整体变慢（§36 已证每键 +45ms），删除同样要过 React 渲染，可能残余同源成本。
   - 判别：临时重新启用 better-sidebar，若删除卡顿明显加重 → 同源。
2. **空编辑器的特殊路径**：删除到空后 Lexical 可能触发额外的空状态渲染 / placeholder 切换。
   - 判别：从 1 个字符删 vs 从 50 个字符删，对比每键成本。
3. **`Ctrl+A` 本身的开销**：全选会创建 range 并可能触发选区相关监听（chat 插件 `updateSelection`，见 §33）。
   - 判别：单测一次 `Ctrl+A` 到 rAF 的耗时，不跟删除。
4. **删除触发的布局失效更贵**：删除会改变行数，可能引发比插入更大的重排。
   - 判别：弄脏后单次 `gBCR` 单价，删除前后的对比。
5. **输入法守卫的额外开销**：better-sidebar `registerImeGuard` 对 `keydown`/`keyup` 都做了捕获阶段监听（`isImeComposition` 判断）。虽然插件已禁用，若将来重新启用需留意。

### 建议的测量口径（沿用 §38 已验证的方法）

```js
// 删除路径没有 execCommand('insertText') 的对称 API，需改用：
//   a) document.execCommand('delete')        —— 注意：§35 已证它对 Lexical 无效
//   b) 真实按键（但受 Playwright actionability 限制，见 §33）
//   c) 合成 InputEvent + 让 Lexical 自行处理
//
// 因此删除路径的「无工具等待」通道尚未找到，这是开始排查前必须先解决的问题。
// 否则会重蹈 §33 的覆辙：用 Playwright 测出虚假的 1000ms。
```

### 开始排查前必须先做的两件事

1. **先找到可靠的删除注入通道**（类似插入路径的 `execCommand`）。若找不到，任何删除测量都不可信。
2. **先建立插入路径的可复现基线**（13.2ms/键），作为删除路径的对照锚点。

### 已知可复用的结论（无需重新验证）

- 清空后必须断言 `innerText.length === 0`（§35，`execCommand('delete')` 清不掉 Lexical）
- 判定标准：每键 < 33ms = 不积压（§35）
- 原型包装/`Error.stack` 抓栈会严重污染测量（§33），只能用 `PerformanceObserver` + LoAF
- Playwright 的 `press`/`fill` 通道在浮层存在时有约 1000ms 固定等待（§33）
- better-sidebar 当前已禁用并持久化（§38）

## 40. 插件二分法：锁定 ui-skin-815 与 better-sidebar（2026-11-25）

### 背景

A12 场景测试完成后，按 G13 增量恢复插件。恢复到 11 个时用户报告
「卡顿又出现了，删除时候有小小的卡顿，不如之前流畅了」，随后补充
「其实长按@的性能也有问题，不只是删除」。

**关键转向**：此前所有判定都依赖自动化测量，但 §38 已发现 3 轮测量的
噪声可达 2 倍（dsh-agents 首测 12.4ms，复测 5 轮只得 6.2ms）。
本轮改用**用户实际手感 + 二分法**，自动化测量只做辅助。

### 二分过程

| 轮次 | 操作 | 用户反馈 | 结论 |
|---|---|---|---|
| 1 | 禁用最新启动的 6 个 | 不卡 | 元凶在 6 个内 |
| 2 | 恢复其中 3 个 | 不卡 | 元凶在剩 3 个内 |
| 3 | 恢复 `ui-skin-815` | **比刚才卡一点** | **ui-skin-815 有影响** |
| 4 | 禁用 ui-skin-815，恢复 ui-diagrams | 目前还好 | ui-diagrams 无影响 |
| 5 | 禁用 ui-diagrams 单独验证 | 体验基本一致 | **ui-diagrams 确认无影响** |

### 最终结果：17 个插件全部逐一验证

| 判定 | 数量 | 插件 |
|---|---|---|
| **有影响，保持禁用** | 2 | `ui-skin-815`、`better-sidebar` |
| **无影响，已恢复** | 15 | 其余全部 |

### 两个元凶的共同点（本轮唯一有效结论）

**都是 UI 插件，都在视口内引入大面积持续重绘图层。**

| 插件 | 绘制行为 | 劣化幅度 |
|---|---|---|
| `dsh-better-sidebar` | 侧栏组件树，让 React 渲染整体变重 | @ 63–95ms vs 13–31ms（4–8 倍） |
| `ui-skin-815` | 全屏背景图（1945 终战皮肤） | @ 7.4ms → 10.7/18ms（1.5–2.4 倍） |

这与 §36 的 LoAF 归因一致：`forced` 强制布局在插件启用时从 0 涨到数百毫秒，
**成本不落在某个具体函数上，而是「任何一次布局重算都变贵」**。

### 用户感知与实测值的对应（本轮建立）

| 状态 | 用户描述 | 对应 @ 每键 |
|---|---|---|
| 最流畅 | — | 10.2 ms |
| 轻微卡顿 | 「非常轻微的卡顿」 | 约 13–18 ms |
| 明显卡顿 | 「比刚才要卡点」 | 约 18–25 ms |
| 很卡 | 「还是很卡顿」 | 63–95 ms |

**33ms 是 OS 按键重复节拍，超过就积压。** 但用户描述的「轻微卡顿」对应
13–18ms，**在节拍以下仍可感知**——这解释了为什么 §38 之前「@ 已低于 33ms」
的报告无法让用户满意（K2/K5）。

### 本轮确立的判定规则（写入测量纪律）

```
用户的「卡 / 不卡」是最终标准。
自动化测量只用于：
  1. 确认无卡顿状态下留有余量（@ < 33ms）
  2. 归因到具体环节（LoAF / forced layout）
不用于：
  3. 判定某插件「有无影响」——3 轮噪声可达 2 倍
```

### 最终配置

```
启用 15 个：deep-ptc / browser-e2e / fast-at + 12 个业务插件
禁用  2 个：ui-skin-815、better-sidebar
```

此配置下用户实测：长按 `@` 与长按删除「非常轻微的卡顿」，
即场景 D 的水平（`@` 10.2ms）。

### 本轮的排除项（不必再查）

以下 15 个插件经用户实测确认对 `@` 与删除性能**无影响**：

```
session-cleanup / tool-dispatch-session / cookie-janitor / quiet-spawn
running-session-expander / usage-stats / dsh-context / dsh-agents
ds-harness-remote / ui-diagrams / ui-plugin-manager-update-check
dsh-fast-at / dsh-browser-e2e / dsh-deep-ptc-mode
```

---

## 41. @ 搜索 1.2 秒尖峰：ds-harness-remote 的 settings.get 阻塞（2026-11-25）

### 现象

用户报告「@ 内容搜索速度又退化了，非常的严重」。实测：

```
42 / 44 / 47 / 63 ms        ← 正常
1196 / 1209 / 1220 / 1327 ms ← 退化
```

**不是稳定变慢，是周期性出现 1.2 秒尖峰。**

### 走过的错误方向（记下来避免重走）

| 假设 | 为什么错 |
|---|---|
| `window.__FAST_AT_OFF` 未定义 ⇒ 插件没加载 | 这些是**读取判断**用的变量（`globalThis.__FAST_AT_OFF === true`），插件不设置它们。查资源列表确认 `dsh-fast-at/client.js` 已加载 |
| `cordis.patch.yml` 无 fast-at 条目 ⇒ 未注册 | 注册走包自带的 `cordis.patch.yml`（`- insert:` 方式），profile 级 patch 文件里本来就不该有它 |
| 索引 30 秒过期（`INDEX_TTL_MS = 30_000`）导致周期性重建 | 周期对不上：尖峰间隔只有 3–7 秒。且直连端点测得 3.9–8.9ms |
| Rust 索引进程慢 | **排除**。`/fast-at/api/sessions.list` 稳定 3.9–16.1ms |

### 定位手段：fetch tap

只用一条 fetch 包装，就抓到了全部真相：

```
ds-harness-remote/settings.get  → 1270.6 ms   ← 元凶
api/fileReferences/list         → 1248.8 ms   ← 被拖慢
/fast-at/api/sessions.list      →   26.8 ms   ← 正常
ds-harness-remote/devices       →    8.5 ms   ← 正常
```

**这与 §9 是同一个模式**：单个慢请求（`settings.get`）把宿主事件循环占满，
同窗口内完全无关的请求（`fileReferences/list`）被一起拖慢。

### 验证

禁用 `ds-harness-remote` 后：

| 指标 | 启用 | 禁用 |
|---|---|---|
| @ 中位 | 1319 ms | **47.8 ms** |
| 候选行 | 62 | 62 |
| 波动 | 1196/1209/1220/1327 | 63/45/48/42 |

**快 27 倍，候选行数不变。**

### 被推翻的旧结论

§40 把 `ds-harness-remote` 判为「无影响，已恢复」是**错的**。

原因：当时只测了中位数（8.7ms），没测尖峰分布。

| 插件 | 劣化机制 | 表现 |
|---|---|---|
| better-sidebar / ui-skin-815 | 渲染变重 | 每键持续 +5–70ms，中位数即可看出 |
| **ds-harness-remote** | **请求阻塞** | **中位正常，偶发 +1200ms 尖峰** |

### 新增测量纪律（第 22 条）

```
判定插件影响必须同时看中位数与 p95 / 最大值。
只测中位数会漏掉「偶发阻塞」型问题——
这类插件在多数按键上表现正常，但会周期性地冻结整个输入。
```

### 最终插件状态

```
禁用 3 个：ui-skin-815、better-sidebar、ds-harness-remote
启用 14 个：其余全部（含 fast-at / browser-e2e / deep-ptc）
```

---

## 42. 会话区滚动卡顿：与皮肤无关，是首次滚动的一次性布局（2026-11-25）

### 现象

用户报告滚动会话区「有时会突然卡一下，很微小的一下」，怀疑是
`background-attachment: fixed` 重绘或会话按需加载。

### 逐项排除（全部有实验证据）

| 假设 | 实验 | 结果 |
|---|---|---|
| `background-attachment: fixed` 重绘 | 同页 A/B 切 `fixed` / `scroll`，各滚 183 帧 | 16.6 vs 16.6ms，**完全相同** |
| 皮肤的 `MutationObserver` | 插桩统计滚动期间 DOM 查询 | **0 次 querySelector、0 条 Mutation**，根本没触发 |
| 长帧里有 JS | LoAF | `renderStart 0` + `styleLayout 70ms` + **脚本列表为空** |
| 皮肤整体 | ON / OFF 各 540 帧 | 中位同为 16.7ms，>60ms 帧各 6 个，最大帧都在 190ms |

### 真正成因

记录慢帧的**精确位置**后一目了然：

```
第 1 趟 step0（scrollTop = 0/1824，顶部边界）: 66.1 ms  ★
第 1 趟 step7（scrollTop = 196）:              40.5 ms
第 2、3 趟:                                    0 个慢帧
```

**只在会话区第一次被滚动时出现。**

预热后再测 270 帧：

| 指标 | 冷态 | 预热后 |
|---|---|---|
| 最大 | 214.4 ms | **19.1 ms** |
| >33ms 帧 | 4 | **0** |

### 结论

**这是浏览器对滚动区域的首次布局/绘制预热，不是皮肤问题，也不是按需加载。**

判据链：
1. `styleLayout` 占满、`renderStart` 为 0、无 JS ⇒ 纯样式 + 绘制，不是脚本
2. 只在第一趟 ⇒ 一次性成本
3. 预热后最大 19.1ms（16.7ms 预算的 1.14 倍）⇒ 肉眼基本不可见

### 方法学教训（第 23 条）

```
测滚动 / 动画等有「预热效应」的场景，必须先做完整预热再测，
否则量到的是首帧成本而不是稳态性能。

更关键的是：只看聚合的 max / p95 会让人误以为「有持续卡顿」。
把慢帧按「第几趟、第几步」定位，才能看出它只出现在第一趟。
```

---

## 43. settings.get 慢的真正根因：remote 的 @ 源 + fast-at 空结果不缓存（2026-11-25 定案）

### 用户诉求

「检查 remote 插件里面调用的 settings.get 为什么慢，能不能改，怎么改，需要定位根因，不要只看表面原因」

### 三个被证伪的表层解释

| 表层解释 | 实验 | 结果 |
|---|---|---|
| `settings.get` 端点本身慢：`settingsView()` 对每个 ACP 后端调 `backendCommandAvailable`，Windows 上走 `execFileSync('where')` 同步子进程，每次约 150ms | 直接打端点 5 次 | **4.3–13.4ms**；且本机 `acp.backends` 是空数组，那段代码一次都没执行 |
| `fileReferences/list` 慢 | 用真实参数 `{agentId, query:''}` 打 5 次 | **4.5–11.3ms** |
| 两者互相阻塞 | 并发同时打 | `settings.get` 4.5ms、`fileReferences` 27.5ms，**互不影响** |

> 关于 `where` 同步调用：我实测 14 次共 2074.5ms（每次约 150ms），这条路径**确实存在**，且 ACP 后端非空时会真的拖慢 `settings.get`。但**本机后端为空，它不是当前症状的原因**。记在这里避免下次又从「where 慢」开始推。

### 真实机制（两层）

**第一层：remote 自己注册了一个 @ 源**

`ds-harness-remote/dist/client.js:7916-7939`：

```js
ctx.inject(["inputTriggers"], (inputContext) => {
  inputContext.effect(() => {
    let source = {
      trigger: "@",
      name: "主机",
      order: -20,
      candidates: async (_session, request) => {
        if ((await control("settings.get").catch(() => {}))?.config?.remoteTools?.enabled === false) return []
        let devices = await control("devices").catch(() => [])
        ...
      }
    }
    inputContext.inputTriggers.registerSource(source)
  })
})
```

`candidates` 第一行就 `await control("settings.get")`。

**第二层：fast-at 空结果不缓存，导致每轮都要重发请求**

`dsh-fast-at/lib/client.js` 的 `computeCandidates`：

```js
const CACHE_TTL_MS = 3000
...
// 只缓存「确实有文件行」的结果
if (fileItems.length > 0 && (signal === undefined || !signal.aborted)) {
  state.cache.set(key, { at: Date.now(), rows })
}
```

`fileItems` 为空 → 不写缓存 → 下一轮重新 `await fileReferences.list(...)` → 和 remote 的 `settings.get` 抢同一条宿主事件循环 → 双双被拖到 1.1 秒。

### 决定性验证

同一页面，只改两次 `@` 的间隔：

| 间隔 | @ → 候选行 | 说明 |
|---|---|---|
| **1 秒**（3 秒 TTL 内） | **151.5 / 136.4 ms** | 命中缓存，`fileReferences` 不发 |
| **5 秒**（TTL 已过期） | **1097 / 1558.8 / 1053.9 ms** | 缓存失效，重发请求，撞上 remote |

**快 7–11 倍。** fetch tap 侧证：

```
快的一轮：sessions.list=40ms，fileReferences 根本没出现
慢的一轮：settings.get=1129ms + fileReferences=1092ms 同时出现
```

### 事件循环阻塞曲线（证明是排队不是计算）

`@` 之后每 100ms 发一个极轻请求，看排队时长：

```
+ 315ms → 1451.6ms  ★
+ 409ms → 1357.9ms  ★
+ 502ms → 1272.1ms  ★
...
+1509ms →  377.3ms
+1943ms →    8.5ms
+2003ms →    4.5ms   ← 全部在同一刻释放
```

**所有请求在约 1800ms 那一刻同时释放**，是典型「单一同步任务占住事件循环」的指纹。

### 可执行的修法

**方案 A（推荐，改我们自己的 fast-at）：空结果也缓存，用短 TTL**

```js
const EMPTY_TTL_MS = 800
const ttl = fileItems.length > 0 ? CACHE_TTL_MS : EMPTY_TTL_MS
if (signal === undefined || !signal.aborted) {
  state.cache.set(key, { at: Date.now(), rows, ttl })
}
// 读取时：Date.now() - cached.at < (cached.ttl ?? CACHE_TTL_MS)
```

原注释担心「空结果缓存久了会让刚新建的文件 3 秒内看不见」——800ms 短 TTL 兼顾两边。

**方案 B（治本，但要改第三方包）：**

1. remote 源的 `settings.get` 在客户端侧缓存（设置只在设置页变化时变），或
2. 把 `remoteTools.enabled` 的判定挪到装配期一次性读取，不进 `candidates` 热路径

### 方法学教训（第 24 条）

```
"某请求慢" 要先分出三种可能，再动手：
  1. 它自己计算慢     → 单独连打 3–5 次，看纯耗时
  2. 它被别的请求阻塞 → 并发打，看是否互相影响
  3. 它只是受害者，真正占住事件循环的是第三件事 → 打阻塞曲线，看是否所有请求在同一刻释放

第 3 种最容易误判成第 1 种。
判据：单打极快、实测极慢、且所有请求同一刻释放 ⇒ 一定是第 3 种。
```

---

## 44. 定案：@ 慢的唯一根因是 fast-at 的 Rust 索引重建窗口（2026-11-25）

### 用户质疑

> 「需要你继续挖，你这个结论依旧很模糊，什么叫做同一时刻发出有一个同步任务把他们卡住。」
>「你必须要清清楚楚地说明白，为什么他们同时出发，然后完成任务的总时间大于他们串行出发的任务时间之和」

前面几轮给出的解释都是错的，这一节是定案。

### 结论（一句话）

**`settings.get` 和 `fileReferences/list` 从来没有「同时触发」。它们串行排队在 fast-at 的索引请求后面，
而那个索引请求在命中 `INDEX_TTL_MS = 30_000` 过期时，会 spawn 一个 Rust 子进程扫 396 个 `.zstd` 文件（282.1 MB）。
慢的是这第三个请求，不是那两个。**

### 证据一：请求的 send / done 绝对时间戳

```
【索引刚过期 · 第 1 次 @】1379.6ms
   fastAt.send  @80.7
   fastAt.done  @1311      ← 1230ms 全在这里
   fileRef.send @1313.3    ← 索引结束后才发出
   fileRef.done @1315.2    ← 实际只用 1.9ms

【同一索引周期内 · 第 2 次 @】156ms
   fastAt.send  @53.4
   fastAt.done  @105.3     ← 52ms
   fileRef.done @110.2     ← 实际只用 2.1ms
```

**`fileReferences` 的「耗时 2 秒」是误读**：它是在 2 秒后才被**调用**，不是执行了 2 秒。

### 证据二：慢请求全部在同一刻释放

```
send@0.1     → done@1042.6   1042ms  ← 撞上重建
send@202.7   → done@1049.2    846ms  ← 与上一条同一刻释放
send@1261.3  → done@1265.7      4ms  ← 重建完成，立刻恢复
send@1475.8  → done@1480.2      4ms
send@1694.1  → done@1697.7      4ms   (stale=false)
...
send@2781.2  → done@2991.5    210ms  ← 又一次重建开始
```

1042.6 与 1049.2 两个慢响应**同一刻结束**，其余全部 4ms。
这是「单一不可中断的任务占住资源」的确定特征，不是并发劣化。

### 证据三：浏览器主线程全程流畅

```
帧数 152，最大帧 17.9ms，>100ms 帧 0，longtask 0 条
但同一时段 fetch 耗时 2508ms
```

**浏览器完全没卡，卡的是 HTTP 响应回来的时间**。阻塞不在前端。

### 证据四：Rust 二进制自身耗时方差 4 倍

```
直接执行 fast-at-sessions.exe：
  第1次: 3,942 ms   输出 133,840 字符
  第2次:   824 ms
  第3次:   910 ms
  第4次: 1,138 ms

execFile 异步跑三次：
  async#1:  909 ms
  async#2: 3635 ms
  async#3: 3683 ms
```

同一二进制、同参数，909ms 到 3942ms 波动 4 倍 ⇒ 瓶颈是磁盘 I/O 不是 CPU。

目录规模实测：396 个 `.zstd` 文件，共 **282.1 MB**，SSD（SSSTC CA5-8D512-Q79）。
每次全量重建都要把这些文件的头部读一遍。

### 精确因果链

```
用户按下 @
  └─ InputTriggerController.fetchCandidates
      ├─ fast-at 包装的 candidates → computeCandidates()
      │   ├─ await indexPathCandidates()            ← ① 串行等待点
      │   │   └─ fetch('/fast-at/api/sessions.list')
      │   │       └─ sessions-reader.query()
      │   │           ├─ 索引新鲜(≤30s) → 3.5–7.5ms 返回
      │   │           └─ 索引过期(>30s) → ensureIndex()
      │   │               └─ execFile(fast-at-sessions.exe)   ← ★ 阻塞源
      │   │                   └─ 扫 396 个 .zstd / 282.1MB = 824–3942ms
      │   └─ await fetchFileItems()  ← ② 索引返回后才执行，实测 2ms
      └─ remote 源 candidates
          └─ await control('settings.get')  ← ③ 也排在 ① 后面，实测 0.1–1ms
```

**总耗时 ≈ fast-at 索引重建耗时**，远大于 `settings.get`(1ms) + `fileReferences`(2ms) 之和——
因为那两个根本没跟索引并行，它们在排队。

### 为什么表现为「偶发卡一下」

`INDEX_TTL_MS = 30_000`。索引 30 秒过期后，**下一次** @ 必然撞上重建（824–3942ms），
之后再按都是 4ms 左右，直到再过 30 秒。

### 被推翻的旧结论

| 旧结论 | 推翻依据 |
|---|---|
| `settings.get` 里 ACP 探测走 `where` 同步子进程导致慢 | 实测 `acp.backends` 为空，该段从未执行；安静态 `settings.get` 只要 0.1–1ms |
| `fileReferences/list` 本身慢 | 实测 1.7–2.1ms，返回 `{ok:true,value:[]}` |
| 两者并发互相阻塞 | 两者**没有重叠**，`fileRef.send` 永远在 `fastAt.done` 之后 |
| 有个「同步任务」卡住 | 含混。现已定位到具体进程：`execFile` 启动的 `fast-at-sessions.exe` |
| 空结果不缓存导致重发 | `fileReferences` 确实每轮重发，但只占 2ms，不是瓶颈 |

### 修复建议（按性价比排序）

**1. 把重建移出请求路径（改动最小）**

```js
// sessions-reader.js：现在
const age = Date.now() - index.at
const stale = age >= INDEX_TTL_MS
if (stale) ensureIndex()   // 不 await，但仍会 spawn 子进程抢 I/O

// 改法：定时后台重建，请求路径只读内存
setInterval(() => { if (Date.now() - (index?.at ?? 0) >= INDEX_TTL_MS) ensureIndex() }, 5000)
// query() 里删掉 if (stale) ensureIndex()，只标记 stale:true
```

**2. 增量索引（治本）**

Rust 侧记录每个会话文件的 mtime，下次只读变化的。396 个里通常只有 1–2 个会变，
能把 824–3942ms 降到 10ms 量级。

**3. 缩小 Rust 输出体积**

现在每次输出 133,840 字符（全量 396 条元数据），一次 @ 只用 20 条。
改成 Rust 侧 `--limit 20` 截断。

**4. 并行化 computeCandidates（治标但便宜）**

```js
// 现在：会话候选 await 完才发文件候选
const sessionItems = await indexPathCandidates(...)
fileItems = await fetchFileItems(...)

// 改法：并行
const [sessionItems, fileItems] = await Promise.all([
  indexPathCandidates(...),
  fetchFileItems(...),
])
```

### 方法学教训（第 25 条）

```
「A 和 B 一起触发比分开慢」先别急着找 A∩B 的交互。
第一步永远是记录每个请求的 send/done 绝对时间戳，画时间轴。

判据：若慢的请求全部在同一刻 done，且 send 时刻互不相同
  ⇒ 不存在交互，它们只是在排队等同一个更早的任务。
找到那个「更早的任务」就是根因。本案是 fast-at 索引重建（execFile 子进程）。
```

## 45. 长按 @ 卡顿的真正机制：不是布局重算，是光 DOM 的样式重算（2026-11-26）

### 用户质疑（本轮由这个问题驱动）

> 「这个页面结构根本没有变动啊，为什么要计算它」

> 「那触发布局重算为什么会重算整个页面嘛？那些是不是算的是整个页面？
>   我们这个编辑器只有这么一小块呀，为什么要算这么大的一个范围的改变呢？」

前面 §17 / §23 用 `forcedStyleAndLayoutDuration` 把成本记成「强制布局」，本轮证明**这个归类是错的**：
那几十毫秒里几乎全是**样式重算（style recalculation）**，不是布局（layout）。

### 结论（一句话）

**写操作（lexical 的 `setAttribute('class')`）让样式失效，随后的几何读取触发全文档的样式重算。
成本取决于「页面里有多少条 CSS 规则」，与改动元素的面积、位置、甚至是否与页面其他部分相关都无关。
better-sidebar 通过注入 16 个样式表 / 1115 条全局规则抬高了这条流水线的基础税。**

### 证据一：成本与元素位置无关（决定性）

在同一个页面、同一时刻，对五类元素做「写 class → 读 `getComputedStyle().color`」：

| 被测元素 | 样式重算耗时 |
|---|---|
| 编辑器本身（`[contenteditable]`） | 62.5ms |
| 侧栏 `<aside class="dpt-sidecar">`（better-sidebar 的 DOM） | 59.1ms |
| **刚创建、空内容、与页面毫无关系的孤立 div** | **54.5ms** |
| **同一个 div，放进 shadow root** | **0ms** |
| 同一个 div，放回 light DOM | 55.1ms |

孤立 div 的 54.5ms 是决定性的：它不在编辑器的布局范围内，也不是 better-sidebar 的节点，
**成本却和编辑器一样高**。⇒ 量的不是「这一块的布局」。

### 证据二：关掉样式表，成本归零

| | 读 `color`（只需样式） | 读 `offsetHeight`（需布局） |
|---|---|---|
| 正常 CSS（217 表 / 8819 规则） | **59.4ms** | 55.2ms |
| 禁用全部样式表 | **0ms** | **0ms** |

两者几乎相等，说明读几何只是**触发器**：真正耗时的是它前面的样式重算。
浏览器每次写 class 后无法预知影响范围，必须重新把 6365 个节点与 8819 条规则做匹配。
失效树优化在存在大量全局 / 后代选择器时会退化成全文档遍历。

### 证据三：better-sidebar 抬高的是「基础税」而非单次成本

| | DOM 节点 | 样式表 | CSS 规则 | 写 class 后重算 |
|---|---|---|---|---|
| 启用 | 6362 | 217 | **8819** | 58.1ms |
| 禁用 | 6277 | 201 | **7704** | 55.9ms |

单次重算成本**几乎相同**（58 vs 56ms）。差异不在这里，在**触发次数**：

### 证据四：每键的写读次数被放大 3.5 倍

8 次真实 `@` 按键，hook 全部几何读取与样式写入：

| | 几何读取 | 样式写入（`setAttribute('class')`） |
|---|---|---|
| **启用** | 67 次 | **45 次** |
| **禁用** | 41 次 | **13 次** |

写入次数 3.5 倍 × 单次 58ms 级重算 ⇒ 长按场景的 3.5s vs 1s。

写入方的调用栈全部指向 lexical 编辑器：

```
setAttribute.class | Element.setAttribute < O < Mx
```

### 证据五：端到端对照（20 次 @ 按键）

**必须区分两种输入方式**，只有「真实按键」那一组可直接对比：

| 输入方式 | better-sidebar | 总耗时 | longtask | 主线程阻塞 | >100ms 慢帧 |
|---|---|---|---|---|---|
| **真实按键**（`press` × 20） | 启用 | **3250 / 3356ms** | 21 / 21 个 | 1724 / 1794ms | 20 / 20 |
| **真实按键**（`press` × 20） | 禁用 | **950 / 972ms** | **2 / 2 个** | 75 / 106ms | 1 / 1 |
| 合成输入（`execCommand`，**仅参考**） | 启用 | 3731ms | 22 个 | 1927ms | 22 |

> ⚠️ 上表第三行是早期用 `execCommand('insertText')` 合成的输入，**方法与前两行不同**，
> 不可与真实按键组直接相除做倍数比较。另有 1 轮启用态合成输入（span 未采集）为 longtask 18、blocking 157ms。
>
> 早期表格里的 `950–1034ms`、`21–22 个`、`1724–1927ms`、`75–140ms` 等区间把两种输入方式混在了一起，已按此表更正。

`long-animation-frame` 的脚本级归因（启用态，每个长任务）：

```
client.js&rev=859be67ef6f0:124ms  (forced 106.8)
client.js&rev=859be67ef6f0:121ms  (forced 113.8)
client.js&rev=859be67ef6f0:122ms  (forced 113)
```

`859be67ef6f0` = `@deepseek-ai/dsh-client-ui-input-trigger`，命中点 lexical 的选区 / DOM 计算。

### 证据六：为什么「写 class」会波及全文档（机制部分）

用户追问：**「这个页面结构根本没有变动啊，为什么要计算它」**
**「我们这个编辑器只有这么一小块呀，为什么要算这么大的一个范围」**

答案不是「浏览器在算编辑器那一块的布局」，而是**它在算「这些 CSS 规则可能命中谁」**。

#### 浏览器的实际流程

1. 写 `el.setAttribute('class', ...)` → 浏览器**只标脏，不立刻计算**（否则每写一次就要全算一遍）
2. 有东西需要样式（`getComputedStyle` / `offsetHeight` / 重绘调度）→ 结算脏队列
3. 结算时**必须知道「这条规则会影响哪些元素」**。而 `.parent .child`、`.a + .b`、`.katex *` 这类选择器
   无法只靠元素自身判断，索引失效 → **退化为全文档遍历**

#### 四组对照（同一元素，读 `getComputedStyle().color`）

| 场景 | 重算耗时 |
|---|---|
| **A. 改这个元素自己的 class** | **61.6ms** |
| **B. 改这个元素自己的内联 `style.color`** | **0ms** |
| **C. 改一个完全无关元素的 class** | **55.6ms** |
| **D. 什么都不改，只读** | **0ms** |

四组数据各自证明了什么：

- **B = 0ms**：内联 `style.color` 浏览器明确知道只有这一个元素变了、且不影响其他元素 → 精准更新。**证明重算不是不可避免的。**
- **C = 55.6ms**：改的是**别的元素**，读的是目标元素，照样 55ms。
  **证明浏览器无法证明「这个 class 不会影响目标」，只能保守全算。**
- **D = 0ms**：不写就不算。**证实「写是扳机、读是扣动」，读本身不贵。**

#### 本页面的规则构成（8078 条选择器）

| 类型 | 数量 | 说明 |
|---|---|---|
| 后代选择器（`.a .b`） | **2404** | 无法用元素自身索引 |
| 通配符（`.katex *`、`.a > *`） | 57 | 可能命中任意元素 |
| 兄弟选择器（`+` / `~` / `:has()`） | 6 | 需看邻居 |
| 单一选择器（可精确索引） | 6642 | 这部分本身没问题 |

**30% 的后代选择器足以让精确索引整体失效** —— 只要有规则必须靠祖先/邻居判断，
浏览器就无法保证「改 A 不会影响 B」，只能走全文档。

#### 结论口径

> 成本边界由**规则的作用域**决定，**不由元素的物理位置和面积**决定。
> 依据：一个刚创建、空内容、与页面毫无关系的孤立 `div`，同样付出 54.5ms。

### 技术栈核实：不是 CSS-in-JS

用户追问「样式都是用 React 那种 CSS in Js 来做的吗」。实测**不是**：

| 检测项 | 结果 |
|---|---|
| emotion（`css-xxx` 类 / `data-emotion`） | **0** |
| styled-components 特征 | **0** |
| `<link rel=stylesheet>` | 2 个（`vendor-*.css`、`index-*.css`） |
| `<style data-plugin-css>` | **212 个**，打包期生成的静态 CSS |
| 带 CSS Modules 哈希类名的元素 | 1710 个 |

技术栈是 **Vite + CSS Modules**，全部规则静态生成、以 `<style data-plugin-css data-plugin="<插件名>">` 注入。

按插件统计规则数（共 7795 条）：

| 插件 | 规则数 | 样式表数 |
|---|---|---|
| dsh-context | 1524 | 22 |
| **dsh-better-sidebar** | **1115** | **16** |
| dsh-deep-ptc-mode | 602 | 1 |
| ui-trajectory | 360 | 4 |
| ui-plugin-manager | 301 | 1 |

### React 的角色：发起者，不是耗时来源

hook `setAttribute` 并检查目标节点是否带 React fiber 键：

```
8 次 @ 按键 → 45 次 class 写入
其中落在 React 节点上：45 次（100%）
唯一调用栈：O < Mx < Mm   （React DOM 提交阶段）
按标签：DIV 23 / SPAN 21 / BUTTON 1
```

**React 是扳机，不是耗时来源**：它每 diff 出一个 class 变化就写一次；
那 45 次写入在 better-sidebar 开与关时**都会执行**，差异只在「写入触发多贵的重算」。

### 证据七：better-sidebar 的规则贡献（隔离收益）

| 条件 | 单次样式重算 |
|---|---|
| 全部 CSS（7795 条规则） | **81.3ms** |
| **关掉 better-sidebar 的 1115 条** | **51.9ms** |

省 **36%**，高于其 14% 的规则占比 ⇒ 它的规则里判断成本较高的写法（后代/通配）占比更高。
注意：这 36% 是**隔离收益**，不等于「只有 better-sidebar 有问题」——
dsh-context 1524 条比它还多，只是本轮未单独做消融。

### 本轮排除的错误归因

这些都在本轮被实测排除，不要再往这些方向查：

| 曾被怀疑 | 排除依据 |
|---|---|
| `measure → slotFree → slotOccupied`（§23） | 只在**空会话**渲染兜底入口时存在；有会话时 `[data-dsh-dock-fallback]` 计数为 **0** |
| `session.phase` 每秒轮询 | 有会话时首次返回 `blank:false` 即 `clearInterval`；且只影响网络，不影响按键延迟 |
| `@` 菜单本身 | `gBCR` 仅由 42 涨到 68，增量微小 |
| 窗口 resize 触发重对齐 | 长按期间 `resize` 事件计数为 **0** |
| 单次布局变慢 | 干净布局下读几何为 **0ms**（命中缓存）；单次重算在两种状态下几乎相同 |

### 可操作方向（仅验证了收益，未验证改造成本）

| # | 方向 | 已验证的收益 | 未验证的部分 |
|---|---|---|---|
| 1 | 把 better-sidebar 的样式移出全局作用域（shadow DOM / `@scope`） | 同一元素在 shadow root 内为 **0ms** | 改造工作量、样式能否全部迁入影子树、与宿主主题变量的交互 |
| 2 | 削减全局规则总数 | 规则数：better-sidebar 1115 条占 14%，关掉其样式表省 **36%** 重算 | 具体哪 104 条后代/通配规则来自它、改写后的收益 |
| 3 | 减少 React 的 class diff 次数 | 8 键 45 次写入（100% 在 React 节点上） | 能否在不破坏 lexical 的前提下稳定 className |
| 4 | 短期规避：写长 `@` 提示词时临时停用该插件 | 真实按键 20 次 @：3250/3356ms → 950/972ms | — |

**收益排序的依据**：证据七显示 better-sidebar 占 14% 规则却贡献 36% 重算成本，
但 **dsh-context 的 1524 条规则比它还多，本轮未单独做消融** —— 不能据此认定
「只有 better-sidebar 有问题」。

### 本节结论的适用范围（诚实边界）

| 结论 | 证据强度 |
|---|---|
| 成本是**样式重算**而非布局 | ✅ 强。禁用全部样式表后归零；只读 `color` 与读 `offsetHeight` 等值 |
| 成本与元素位置/面积**无关** | ✅ 强。孤立 div 54.5ms，与编辑器 62.5ms 同级 |
| 后代选择器导致无法索引 | ⚠️ **机制推断 + 规则计数，未做单项消融**。2404 条后代选择器的存在是实测；「它们正是索引失效的原因」是基于浏览器行为的推断，未通过「只删后代选择器」验证 |
| shadow DOM 可归零 | ✅ 强。同一元素 shadow 内 0ms / light DOM 55.1ms |
| better-sidebar 贡献 36% | ✅ 强。开关其 16 个样式表实测 81.3 → 51.9ms |
| React 是写入发起者 | ✅ 强。45/45 落在 React 节点，唯一栈 `O < Mx < Mm` |

### 方法学教训（第 26 条）

```
「结构没变为什么要重算」不是用户的误解，是浏览器的设计：
  重算由「写操作」触发，不由「结构变化」触发。
  浏览器无法判断一次 class 改动是否影响哪些元素，只能把脏队列留给下一次读取。

归因时不要停在「强制布局 1218ms」这种合并指标上：
  它把样式重算和布局混在一起。用「只读 color（纯样式）」与
  「读 offsetHeight（样式+布局）」两组对照拆开，再禁用样式表做零点校准。

判据：若一个与页面毫无关系的孤立元素也付出同样成本
  ⇒ 成本来自全局 CSS 规则量，与元素面积、位置、DOM 相关性都无关。
  此时优化目标不是「减少节点」或「缩小范围」，而是「隔离规则作用域」。

反面对照要成对出现，否则无法排除「读本身贵」：
  同一元素 改自己 class 61.6ms / 改自己内联 style 0ms / 改无关元素 class 55.6ms / 纯读 0ms。
  内联 style 的 0ms 证明代价并非不可避免；纯读的 0ms 证明读不贵。
```

---
## 附：相关文档

- [PERF-REPORT-2026-11-24.md](PERF-REPORT-2026-11-24.md) —— 完整性能报告，含全部原始数据
- [TEST-REPORT.md](TEST-REPORT.md) —— 179 项测试
- [README.md](README.md) —— 插件说明
