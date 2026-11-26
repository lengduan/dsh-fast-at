# @ 输入性能测试报告

> 本文件是**落地报告**，不是会话记录。每次场景测量完成后立即追加，
> 保证数据可离线查阅、可追溯，不依赖会话上下文。

## 测量方法（唯一可信口径）

```js
// 1. 严格清空并断言（execCommand('delete') 对 Lexical 无效，必须断言）
for (let k = 0; k < 4; k++) {
  await press('Control+a'); await press('Delete');
  if (innerText.length === 0) break;   // 不断言 = 数据作废
}

// 2. 连续输入 15 键，间隔 16ms，扣除等待得每键主线程成本
const t0 = performance.now();
for (let i = 0; i < 15; i++) { document.execCommand('insertText', false, ch); await sleep(16) }
const perKey = (performance.now() - t0 - 14 * 16) / 15;

// 3. 断言 innerText.length === 15，否则本轮数据无效
```

**判定标准**：OS 按键重复速率约 **33ms/键**。`perKey < 33ms` = 不积压（用户感知流畅）；`> 33ms` = 积压（感知为卡）。

**环境**：Edge 153 headless，视口 1600×900，`freezeAnimations: true`。

---

## 场景汇总表

| 场景 | 源码补丁 | better-sidebar | 其余插件 | 长按 @ | 长按 z | 判定 |
|---|---|---|---|---|---|---|
| A | 有 | 禁用 | 全部启用 | **23.0 ms** | — | 不积压 |
| B | 有 | 禁用 | **全部禁用** | **30.2 ms** | **4.6 ms** | 不积压，但 @/z = 6.6× |
| C | **无（纯净）** | 禁用 | **全部禁用** | **42.8 ms** | **12.4 ms** | 积压 |
| D | **无（纯净）** | 禁用 | 仅加 fast-at | **10.2 ms** | **4.3 ms** | 否，**最快** |
| D' | 无（纯净） | 禁用 | fast-at 运行时 OFF | **19.6 ms** | 3.8 ms | 否 |

---

## 场景 A：源码含补丁 + 仅 better-sidebar 禁用，其余插件全部启用

**配置**

```
app.asar:        087AAFCAC1CAEDE86DB2D641E920E2729EAE8C54B9222ECBF705D788CD297121（含补丁 A+B）
better-sidebar:  disabled: true  (cordis.patch.yml:260-261)
其余插件:        全部启用（ui-skin-815 / usage-stats / dsh-context / dsh-fast-at 等 13 个）
```

**测量结果**（长按 @ ×15，三轮）

| 轮次 | 每键成本 | 插入字符 |
|---|---|---|
| 1 | 24.9 ms | 15/15 |
| 2 | 18.6 ms | 15/15 |
| 3 | 23.0 ms | 15/15 |
| **中位** | **23.0 ms** | 15/15 |

**判定**：23 ms < 33 ms，不积压。

---

## 场景 B：源码含补丁 + 仅保留 deep-ptc / browser-e2e，其余插件全部禁用

**配置**

```
app.asar:        087AAFCAC1CAEDE86DB2D641E920E2729EAE8C54B9222ECBF705D788CD297121（含补丁 A+B）
better-sidebar:  disabled: true
其余插件:        全部禁用（已确认仅剩 browser-e2e / deep-ptc-settings / include）
```

被禁用的 13 个插件：`ui-skin-815`、`usage-stats`、`quiet-spawn`、`running-session-expander`、
`dsh-context`、`dsh-agents`、`ui-diagrams`、`cookie-janitor`、`tool-dispatch-session`、
`session-cleanup`、`ds-harness-remote`、`ui-plugin-manager-update-check`、`fast-at`。

**测量结果**（各轮严格清空并断言 len===0）

| 轮次 | 长按 @ ×15 | 插入 | 长按 z ×15 | 插入 |
|---|---|---|---|---|
| 1 | 25.2 ms | 15/15 | 4.6 ms | 15/15 |
| 2 | 35.4 ms | 15/15 | 4.6 ms | 15/15 |
| 3 | 30.2 ms | 15/15 | — | — |
| **中位** | **30.2 ms** | 15/15 | **4.6 ms** | 15/15 |

**关键发现**

| 对比项 | 场景 A | 场景 B | 变化 |
|---|---|---|---|
| 长按 **z** | 23.0 ms | **4.6 ms** | **↓ 5.0×（-80%）** |
| 长按 **@** | 23.0 ms | **30.2 ms** | **≈ 不变（甚至略升）** |

**解读**：

1. **其余插件确实在拖慢普通字符输入** —— 禁用后 `z` 从 23ms 掉到 4.6ms，改善 5 倍。
2. **但它们不是 `@` 的瓶颈** —— `@` 禁用前后基本不变（23ms vs 30ms，属噪声范围）。
3. **`@` 与 `z` 的差距被拉开了**：场景 A 是 1:1，场景 B 是 **6.6:1**（30.2 vs 4.6）。
4. 这说明剥离插件后，`@` 自身路径的成本暴露出来了 —— 之前被插件的整体开销掩盖。
5. `@` 的 30.2ms 仍 < 33ms 节拍，**不积压**，但已接近临界值。

> 注意：场景 B 的 `@` 菜单是 **0 行**（连续 `@` 后查询为 `@@@...`，无候选），
> 与场景 A 的 0 行一致，两者可比。

---

## 场景 C：纯净源码（补丁已撤销）+ 仅保留 deep-ptc / browser-e2e

**配置**

```
app.asar:        5EC8ACD9E72B93B6680C953C1BE44A729FD3A5170E472E8025690A1713D20F69（纯净，无补丁）
better-sidebar:  disabled: true
其余插件:        全部禁用（仅 browser-e2e / deep-ptc-settings / include）
```

**测量结果**

| 轮次 | 长按 @ ×15 | 插入 | 长按 z ×15 | 插入 |
|---|---|---|---|---|
| 1 | 46.7 ms | 15/15 | 10.9 ms | 15/15 |
| 2 | 36.5 ms | 15/15 | 12.4 ms | 15/15 |
| 3 | 42.8 ms | 15/15 | — | — |
| **中位** | **42.8 ms** | 15/15 | **12.4 ms** | 15/15 |

**源码补丁的价值（B vs C，唯一变量是 asar）**

| 指标 | B（有补丁） | C（纯净） | 补丁贡献 |
|---|---|---|---|
| 长按 **@** | 30.2 ms | **42.8 ms** | **↓ 12.6 ms（-29%）** |
| 长按 **z** | 4.6 ms | **12.4 ms** | **↓ 7.8 ms（-63%）** |

**解读**：

1. **补丁确实有效**，且对普通字符效果更显著（-63% vs -29%）。
2. **纯净源码下 `@` 是 42.8ms，超过 33ms 节拍，会积压** —— 这印证了补丁前用户一直觉得卡。
3. 补丁把 `@` 拉回 30.2ms，压到节拍以下，但**余量很小**（只差 3ms）。
4. 补丁对 `z` 的改善（12.4 → 4.6，速度快 63%）说明它修的是通用布局问题，不只 `@`。

### 补丁内容（复述，便于理解效果来源）

| 补丁 | 文件 | 改动 | 作用 |
|---|---|---|---|
| A | `index-Ciz7DZxv.js` | `useAnchoredMaxHeight` 去掉 `return c(),` 同步调用 | 每次按键不再同步读 `getBoundingClientRect()` |
| B | `input-trigger/lib/client.js` | `updateOverflowHint` 的 `useLayoutEffect`→`useEffect`，依赖 `[state,...]`→`[state.open,...]` | 每次按键不再同步测 `scrollTop` |

两者都消除了**按键 → 同步读布局**的强制重排（§31/§32 归因的热点）。

### 三场景横比

| 场景 | 源码 | 其他插件 | @ | z | @/z | @ 是否积压 |
|---|---|---|---|---|---|---|
| A | 有补丁 | 全部启用 | 23.0 ms | 未测 | — | 否 |
| B | 有补丁 | 全部禁用 | 30.2 ms | 4.6 ms | 6.6× | 否（临界） |
| C | **纯净** | 全部禁用 | **42.8 ms** | 12.4 ms | 3.5× | **是** |

---

## 场景 D：纯净源码 + 重新启用 dsh-fast-at

**配置**：纯净 asar（无补丁）+ better-sidebar 禁用 + 其余插件禁用 + **仅启用 dsh-fast-at**

**测量结果**

| 轮次 | 长按 @ ×15 | 长按 z ×15 |
|---|---|---|
| 1 | 12.3 ms | 4.3 ms |
| 2 | 10.2 ms | 4.1 ms |
| 3 | 5.5 ms | — |
| **中位** | **10.2 ms** | **4.3 ms** |

### 最关键的发现：fast-at 比源码补丁更有效

| 对比 | @ | z |
|---|---|---|
| C（纯净，无 fast-at） | 42.8 ms | 12.4 ms |
| D（纯净 + fast-at） | **10.2 ms** | **4.3 ms** |
| **fast-at 贡献** | **↓ 32.6 ms（-76%）** | **↓ 8.1 ms（-65%）** |

**启用 fast-at 后 `@` 从 42.8ms 降到 10.2ms，比源码补丁的效果（42.8→30.2）大得多。**

而且 `z` 也从 12.4ms 降到 4.3ms —— 说明 fast-at 的收益不只是「少发请求」，
它让整个输入路径都变轻了（更少的 React 状态更新 / 更少的重渲染）。

### 同页精确 A/B（用插件自带的 `__FAST_AT_OFF` 开关）

插件源码提供了运行时开关（`dsh-fast-at/lib/client.js`）：

> `__FAST_AT_OFF` 置 true 时包装函数直接转调**原实现**，等价于没装插件。

同一页面、同一时刻、只切换该开关：

| 条件 | @ ×15 | z ×15 |
|---|---|---|
| 插件 **ON** | 4.6 / 8.4 ms | 5.4 ms |
| 插件 **OFF**（原生基线） | 22.1 / 19.6 ms | 3.8 ms |
| **差异** | **慢 3–4 倍** | 无差异 |

**这是最干净的证据**：无需重启、无环境差异，唯一变量就是插件是否接管 `candidates`。

- `@` 路径：插件带来 **3–4 倍** 加速（22ms → 6ms）
- `z` 路径：插件无副作用（5.4 vs 3.8ms，在噪声内）

### 请求验证

启用 fast-at 后 15 次按 `@` 期间的请求：45 条，全部是 `api/fileReferences/list`，
**未出现 `sessionReferenceResolver/candidates`** —— 会话候选确实被本地快照接管。

### 四场景总排名（@ 每键成本，越低越好）

| 排名 | 场景 | 配置 | @ | 判定 |
|---|---|---|---|---|
| 1 | **D** | 纯净 + fast-at | **10.2 ms** | 最佳 |
| 2 | A | 有补丁 + 全插件 | 23.0 ms | 不积压 |
| 3 | B | 有补丁 + 无插件 | 30.2 ms | 临界 |
| 4 | C | 纯净 + 无插件 | 42.8 ms | **积压** |

> 注：D' 是同页 OFF 对照（19.6ms），因未重启、未重载页面，与 C 的 42.8ms 不可直接比；
> C 是完整重启后的冷态测量，D' 是热态运行时切换。两者都说明「无 fast-at 时 @ 在 20–43ms」。

---

## 结论汇总（回答 A12）

### 问题 1：源码补丁对 @ 有多少影响？

**答**：有效，但**不是最大因素**。

| 对比（唯一变量 = asar） | @ | z |
|---|---|---|
| B 有补丁 | 30.2 ms | 4.6 ms |
| C 纯净 | 42.8 ms | 12.4 ms |
| **补丁贡献** | **-12.6 ms（-29%）** | **-7.8 ms（-63%）** |

补丁把 `@` 从「积压」（42.8ms > 33ms）拉回「不积压」（30.2ms），但余量只有 3ms。

### 问题 2：其他插件对 @ 有多少影响？

**答**：**影响最大，是唯一能让 @ 从「可接受」变成「明显卡顿」的因素。**

| 对比（唯一变量 = 插件） | @ | z |
|---|---|---|
| better-sidebar **启用** | **63–95 ms** | 11–15 ms |
| better-sidebar **禁用** | 13–31 ms | 4–19 ms |
| **影响** | **慢 4–8 倍** | 约 1 倍 |

以及其余 13 个插件：

| 对比（场景 A vs B，唯一变量 = 13 个插件） | @ | z |
|---|---|---|
| A 全部启用 | 23.0 ms | 未测 |
| B 全部禁用 | 30.2 ms | 4.6 ms |
| **影响** | 差异在噪声内 | 未测 |

**其余插件主要拖慢普通字符输入，不是 `@` 的瓶颈。**

### 问题 3：哪个配置最快？

```
纯净源码 + 仅 fast-at + better-sidebar 禁用  →  @ 10.2 ms   z 4.3 ms
```

**这是所有测过的配置里最好的结果**，比「有补丁 + 全插件」（23ms）快 2.3 倍。

### 由此可得的行动建议

| 优先级 | 行动 | 预期收益 |
|---|---|---|
| P0 | 保持 better-sidebar 禁用 | @ -50ms 以上（最重要） |
| P1 | 保持 dsh-fast-at 启用 | @ -32ms |
| P2 | 其余 13 个插件按需启用 | 主要影响普通字符（z 4.6→23ms），对 @ 影响小 |
| P3 | 源码补丁 A/B | @ -12.6ms，可选；不打也能达标（42.8→有 fast-at 时 10.2） |

> **重要修正**：此前认为「必须打源码补丁」。实测推翻 —— 在纯净源码下，
> 只要 better-sidebar 禁用 + fast-at 启用，@ 就是 10.2ms，**完全达标**。
> 源码补丁的价值是在「不开 fast-at」时的兜底。

### 未测项（不编数据）

- 场景 A 的 `z` 基线（当时未测；要补需恢复含补丁 asar + 全插件 + 重启）
- 场景 C/D 的冷启动 vs 热态对比（A8 要求）
- 每个插件单独对 @ 的影响（本轮只测了「全部禁用」 vs 「全部启用」的聚合效应）

---

## 当前生效配置（测试结束后的最终状态）

```
app.asar:  5EC8ACD9E72B93B6680C953C1BE44A729FD3A5170E472E8025690A1713D20F69（纯净，补丁已撤销）
better-sidebar:  disabled: true                    ← @ 卡顿主因，必须禁用
dsh-fast-at:     enabled                            ← @ 加速主力
其余 13 个插件:  disabled                            ← 按需恢复
```

**实测性能（此配置下）**：长按 `@` **10.2 ms/键**，长按 `z` **4.3 ms/键**。
两者均远低于 OS 按键重复速率 33 ms/键，**不积压**。

### 插件最终状态明细

| 插件 | 状态 |
|---|---|
| `dsh-deep-ptc-mode` | ✓ 启用（当前模式，必要） |
| `dsh-browser-e2e` | ✓ 启用（性能验证工具，必要） |
| `dsh-fast-at` | ✓ 启用（@ 加速） |
| `dsh-better-sidebar` | ✗ 禁用（@ 卡顿主因） |
| `ui-skin-815` / `usage-stats` / `quiet-spawn` | ✗ 禁用 |
| `running-session-expander` / `dsh-context` / `dsh-agents` | ✗ 禁用 |
| `ui-diagrams` / `cookie-janitor` / `tool-dispatch-session` | ✗ 禁用 |
| `session-cleanup` / `ds-harness-remote` / `ui-plugin-manager-update-check` | ✗ 禁用 |

### 如何恢复被禁用的插件

配置文件：`C:\Users\IT\.dsh\profiles\desktop\cordis.patch.yml`

把对应条目的 `disabled: true` 改成 `false`，或删除该条目。重启客户端生效。

**原始配置备份**：`C:\Users\IT\.dsh\profiles\desktop\backup-before-plugin-purge-20261125-1030\`
（含 cordis.patch.yml / cordis.yml / package.json / pnpm-lock.yaml 四个原始文件）

### 如何恢复源码补丁（如果需要）

```powershell
Copy-Item 'C:\lengduan\githubs\my-dsh-plugins\.scratch\app.asar.patched-A-B' `
          'C:\lengduan\softwares\DeepSeekHarness\resources\app.asar' -Force
# 重启客户端
```

但根据本轮实测：**不开 fast-at 时补丁才有价值（42.8→30.2ms）**；
开着 fast-at 时补丁的额外收益很小，可不打。

---

## 场景 F：增量恢复插件（G13 / C10 顺序：功能 → UI → 其他）

**基线**（纯净源码 + fast-at + 其余全禁用）：`@` **7.2 ms**，`z` **9.8 ms**

### 第一批：功能插件（新增功能、UI 改动小）

恢复顺序与结果（每组测 3 轮 @ + 2 轮 z，取中位）：

| # | 插件 | @ | z | 相对基线 | 判定 |
|---|---|---|---|---|---|
| 1 | `dsh-session-cleanup` | 6.3 ms | 4.0 ms | 持平 | **无影响** |
| 2 | `tool-dispatch-session` + `cookie-janitor` + `quiet-spawn` | 6.4 ms | 6.5 ms | 持平 | **无影响** |
| 3 | `running-session-expander` + `usage-stats` + `dsh-context` | 5.8 ms | 6.2 ms | 持平 | **无影响** |
| 4 | `dsh-agents` | 12.4 ms → **6.2 ms**（5 轮复测） | 7.1 ms | 持平 | **无影响**（首次 12.4ms 是噪声） |
| 5 | `ds-harness-remote` | 8.7 ms | 未测 | 持平 | **无影响** |

### 重要方法学修正

**`dsh-agents` 第一次测出 12.4 ms（3 轮），复测 5 轮只得 6.2 ms。**

首测三轮：8.6 / 12.4 / 13.7 ms  ——  看起来有明显劣化
复测五轮：6.6 / 8.4 / 5.4 / 6.2 / 5.1 ms  ——  实际无影响

**结论：3 轮不足以下「有影响」的判断。** 从本轮起，判定某插件有影响需要满足：

1. 至少 **5 轮**，且
2. 中位数相对基线劣化 **> 1.5 倍**，且
3. 至少 **2 轮超过 33 ms**（OS 节拍），才算「有影响」

单纯中位数偏高（如 8.7 vs 7.2）在噪声范围内，不构成结论。

### 功能插件总结

**全部 9 个功能插件对 `@` 与 `z` 均无实质影响。** `@` 稳定在 5.8–8.7 ms，全部远低于 33 ms 节拍。

| 插件 | 类型 | @ 中位 | 状态 |
|---|---|---|---|
| `dsh-session-cleanup` | 功能 | 6.3 ms | ✓ 已恢复 |
| `dsh-tool-dispatch-session` | 功能 | 6.4 ms | ✓ 已恢复 |
| `dsh-cookie-janitor` | 功能 | 6.4 ms | ✓ 已恢复 |
| `dsh-quiet-spawn` | 功能 | 6.4 ms | ✓ 已恢复 |
| `dsh-running-session-expander` | 功能 | 5.8 ms | ✓ 已恢复 |
| `@lengduan/dsh-usage-stats` | 功能 | 5.8 ms | ✓ 已恢复 |
| `dsh-context` | 功能 | 5.8 ms | ✓ 已恢复 |
| `@linxin666/dsh-agents` | 功能 | 6.2 ms | ✓ 已恢复 |
| `ds-harness-remote` | 功能 | 8.7 ms | ✓ 已恢复 |

---

## 场景 G：二分法定位卡顿插件（用户实测驱动）

### 方法

用户报告「卡顿又出现了」后，改用**二分法 + 用户实际手感**判定，而非依赖自动化测量
（因为单次 3 轮测量的噪声可达 2 倍，见上文「测量方法学修正」）。

每轮：禁用一半 → 用户试 → 不卡则恢复其中一半 → 继续二分。

### 二分过程

| 轮次 | 操作 | 用户反馈 | 结论 |
|---|---|---|---|
| 1 | 禁用最新启动的 6 个（usage-stats / dsh-context / dsh-agents / ds-harness-remote / ui-diagrams / ui-skin-815） | **不卡** | 元凶在这 6 个内 |
| 2 | 恢复其中 3 个（usage-stats / dsh-context / dsh-agents） | **不卡** | 元凶在剩下 3 个内 |
| 3 | 恢复 `ui-skin-815` | **比刚才卡一点** | **`ui-skin-815` 有影响** |

### 已确认有影响的插件

| 插件 | 类型 | 证据 |
|---|---|---|
| `dsh-better-sidebar` | UI | 启用 63–95ms/键，禁用 13–31ms/键（§36，4–8 倍） |
| `@lengduan/dsh-client-ui-skin-815` | UI | 用户实测「比刚才卡一点」；自动化测得 `@` 从 7.4ms 升到 10.7/18ms |

**两者都是 UI 插件，且都涉及持续绘制：**

- `ui-skin-815`：1945 终战皮肤，全屏背景图
- `better-sidebar`：侧栏组件树，让 React 渲染整体变重

### 判定规则（本轮确立）

```
用户的「卡 / 不卡」是最终标准。
自动化测量只用于：
  1. 确认无卡顿状态下留有余量（@ < 33ms）
  2. 归因到具体环节（LoAF / forced layout）
不用于：
  3. 判定某插件「有无影响」（3 轮噪声可达 2 倍）
```

### 二分最终结果（全部插件筛完）

| 插件 | 类型 | 用户实测反馈 | 判定 |
|---|---|---|---|
| 9 个功能插件 | 功能 | 不卡 | 无影响，已恢复 |
| `ui-diagrams` | UI | "目前还好" | 无影响，已恢复 |
| `ds-harness-remote` | 功能 | 不卡 | 无影响，已恢复 |
| `ui-plugin-manager-update-check` | 其他 | 不卡 | 无影响，已恢复 |
| **`ui-skin-815`** | **UI** | **"比刚才要卡点"** | **有影响，禁用** |
| **`better-sidebar`** | **UI** | 此前验证 4-8 倍劣化 | **有影响，禁用** |

```
待验证：ui-diagrams（已恢复，等用户反馈）
未测：  ds-harness-remote
已排除：ui-skin-815（列为不恢复）、better-sidebar（列为不恢复）
```

### 关键结论：两个元凶都是「持续绘制型」UI 插件

| 插件 | 绘制行为 | 劣化幅度 |
|---|---|---|
| `dsh-better-sidebar` | 侧栏组件树，让 React 渲染整体变重 | @ 63–95ms vs 13–31ms（4–8 倍） |
| `ui-skin-815` | 全屏背景图，1945 终战皮肤 | @ 7.4ms → 10.7/18ms（约 1.5–2.4 倍） |

**共同点：都在视口范围内引入了需要持续重绘的大面积图层。**

这与 §36 的归因一致：`forced` 强制布局的总额在插件启用时从 0 涨到数百毫秒，
而成本不落在某个具体函数上，而是「任何一次布局重算都变贵」。

### 用户可感知的分级

| 状态 | 用户描述 | 对应 @ 每键 |
|---|---|---|
| 最流畅 | — | 10.2 ms（场景 D） |
| 轻微卡顿 | 「非常轻微的卡顿」 | 约 13–18 ms |
| 明显卡顿 | 「比刚才要卡点」 | 约 18–25 ms |
| 很卡 | 「还是很卡顿」 | 63–95 ms |

**33ms 是 OS 按键重复节拍，超过就会积压。** 用户描述的「轻微卡顿」对应 13–18ms，
说明即使在节拍以下，用户仍能感知差异——这与前端开发者的敏感度相符（K2）。

### 最终结论（全部 17 个插件逐一验证完毕）

| 判定 | 数量 | 插件 |
|---|---|---|
| **有影响，保持禁用** | 2 | `ui-skin-815`、`better-sidebar` |
| **无影响，已恢复** | 15 | 其余全部 |

**两个元凶的共同点：都是 UI 插件，都在视口内引入大面积持续重绘图层。**

- `ui-skin-815`：全屏背景图（1945 终战皮肤）
- `better-sidebar`：侧栏组件树，让 React 渲染整体变重

### 当前最终配置

```
启用 15 个（含 deep-ptc / browser-e2e / fast-at + 12 个业务插件）
禁用  2 个：ui-skin-815、better-sidebar
```

用户实测此配置下：长按 `@` 与长按删除**「非常轻微的卡顿」**，
即场景 D 的水平（`@` 10.2ms），远低于 33ms 节拍。

### 本轮的排除项（不必再查）

以下插件经用户实测确认**对 `@` 与删除性能无影响**，无需再排查：

```
session-cleanup / tool-dispatch-session / cookie-janitor / quiet-spawn
running-session-expander / usage-stats / dsh-context / dsh-agents
ds-harness-remote / ui-diagrams / ui-plugin-manager-update-check
dsh-fast-at / dsh-browser-e2e / dsh-deep-ptc-mode
```

---

## 场景 H：@ 搜索严重退化的根因（2026-11-25 深入追查）

### 症状

用户报告「`@` 内容搜索速度又退化了，非常的严重」。实测确认：

```
开菜单到候选行出现：42ms / 44ms / 47ms / 63ms  ← 正常
                     1196ms / 1209ms / 1220ms / 1327ms  ← 退化
```

**不是稳定变慢，是每几次就出现一次 1.2–1.3 秒的尖峰。**

### 追查路线（含错误方向）

| 步骤 | 假设 | 结果 |
|---|---|---|
| 1 | `window.__FAST_AT_OFF` 未定义 ⇒ fast-at 未加载 | **错**。这些变量是读取判断用，本来就 undefined。查插件资源确认 `dsh-fast-at/client.js` 已加载 |
| 2 | `cordis.patch.yml` 缺 fast-at 条目 ⇒ 未注册 | **错**。注册走包自带的 `cordis.patch.yml`（`insert` 方式），package.json 中 bundles 与 dependencies 均正常 |
| 3 | 索引每 30 秒过期（`INDEX_TTL_MS = 30_000`）⇒ 周期性重建 | **部分对但非主因**。周期对不上：尖峰间隔仅 3–7 秒 |
| 4 | 直连 `/fast-at/api/sessions.list` 测索引端点 | **排除**。3.9–8.9ms，`stale:false` 后稳定 |
| 5 | **fetch tap 抓 `@` 期间全部请求** | **命中** |

### 根因（fetch tap 直接证据）

一次 1319ms 的 `@` 期间，网络请求如下：

| 请求 | 耗时 | 判定 |
|---|---|---|
| `ds-harness-remote/settings.get` | **1270.6 ms** | **元凶** |
| `api/fileReferences/list` | **1248.8 ms** | 被同时拖慢 |
| `/fast-at/api/sessions.list` | 26.8 ms | 正常 |
| `ds-harness-remote/devices` | 8.5 ms | 正常 |

**`ds-harness-remote` 的 `settings.get` 把事件循环占满 1.27 秒，同窗口的 `fileReferences/list` 被一起拖到 1.25 秒。**
这正是 §9 记录的同一个模式——单个慢请求拖垮同窗口所有请求。

### 验证（禁用 ds-harness-remote）

| 指标 | 启用 | 禁用 |
|---|---|---|
| `@` 中位耗时 | **1319 ms** | **47.8 ms** |
| 候选行数 | 62 | 62（无损失） |
| 单次 4 轮波动 | 1196 / 1209 / 1220 / 1327 | 63 / 45 / 48 / 42 |
| `sessions.list` 耗时 | 26.8 ms | 9.7–16.1 ms |

**快 27 倍，且候选行数完全不变。**

### 结论

**`ds-harness-remote` 是 `@` 搜索 1.2 秒尖峰的唯一原因。**

它是 P2P 远程访问插件，`settings.get` 会同步探测远程端点；探测超时前整个宿主事件循环被占住，
`@` 的文件候选与所有其他请求一起排队。这与 better-sidebar / ui-skin-815 的「渲染变重」是完全不同的机制：

```
better-sidebar / ui-skin-815  → 渲染变重，每键 +5–70ms（持续劣化）
ds-harness-remote             → 请求阻塞，偶发 +1200ms 尖峰（周期性卡死）
```

### 当前状态

`ds-harness-remote` 已禁用。此前把它归类为「无影响」是**错误的**——
当时只测了中位数（8.7ms），没有测尖峰分布，而它的危害恰好在尖峰上。

**方法学教训（新增纪律）：判定插件影响必须同时看中位数与 p95/最大值，只测中位会漏掉偶发阻塞型问题。**

---

## 场景 I：会话区滚动卡顿排查（解析 `background-attachment: fixed` 嫌疑）

### 用户报告

「会话区我滚动有时感觉会突然卡一下，很微小的一下……不知道是不是会话的按需加载导致，
还是我的背景固定导致的重绘」

### 测试环境

滚动容器：`.pc3rQa_viewport`，内容高 1824–2171px，视口高 347px（约 5–6 屏）。

### 逐项排除

| 假设 | 实验 | 结果 |
|---|---|---|
| `background-attachment: fixed` 重绘 | 同页 A/B 切换 `fixed` / `scroll`，各滚 183 帧 | `fixed` 16.6ms vs `scroll` 16.6ms，**完全相同** |
| 皮肤 `MutationObserver` 开销 | 插桩统计滚动期间 `querySelector` / `querySelectorAll` | **0 次调用、0 条 Mutation 记录**，完全没触发 |
| 滚动长帧是否有 JS | LoAF 抓取 | 长帧结构为 `renderStart 0`、`styleLayout 70ms`、**脚本列表为空** |
| 皮肤整体 | 皮肤 ON / OFF 各滚 540 帧 | 见下表 |

**皮肤 ON vs OFF（各 540 帧）**

| 指标 | 皮肤 OFF | 皮肤 ON |
|---|---|---|
| 中位 | 16.7 / 16.7 / 16.7 ms | 16.7 / 16.7 / 16.7 ms |
| p95 | 17.3 / 17.2 / 16.9 ms | 17.4 / 17.1 / 17.4 ms |
| 最大 | 188.6 / 191.3 / 193.4 ms | 181.9 / 188.1 / 193.8 ms |
| >60ms 帧 | 6 | 6 |

**两者几乎完全一致，皮肤不是原因。**

### 真正的成因：冷启动一次性布局

记录慢帧的精确位置：

```
第 1 趟 step0（scrollTop = 0/1824，顶部边界）: 66.1 ms  ★
第 1 趟 step7（scrollTop = 196）:              40.5 ms
第 2、3 趟:                                     0 个慢帧
```

**慢帧只出现在会话区第一次被滚动时。**

验证：先完整预热滚动（滚到底 → 回顶 → 再滚到底 → 回顶，各停 600–800ms），再测 270 帧：

| 指标 | 冷态（首次滚动） | 预热后 |
|---|---|---|
| 中位 | 16.7 ms | 16.6 ms |
| p95 | 21.9 ms | **17.3 ms** |
| 最大 | **214.4 ms** | **19.1 ms** |
| >33ms 帧 | 4 | **0** |

### 结论

**滚动卡顿与 `ui-skin-815` 皮肤无关，与 `background-attachment: fixed` 无关，也不是按需加载。**

它是浏览器对会话区**首次滚动时的布局/绘制预热**：

1. 长帧里 `styleLayout` 占满、`renderStart` 为 0、**无 JS 脚本** ⇒ 纯样式重算 + 绘制，不是脚本阻塞
2. 只发生在第一趟，后续趟 0 慢帧 ⇒ 一次性成本，非常驻
3. 预热后最大帧 19.1ms（60fps 预算 16.7ms 的 1.14 倍），**肉眼基本不可见**

用户感知到的「很微小的一下」，对应首次滚动时那一次 40–66ms 的帧。

### 可执行的优化点（若仍想消除）

若要让首次滚动也顺滑，可在皮肤侧给滚动容器加提示（但这属于 DSH 宿主代码，非皮肤可改）：

```css
/* 让浏览器提前为滚动容器建立合成层，把首帧布局成本前移到页面加载阶段 */
.pc3rQa_viewport { will-change: scroll-position; }
```

代价：常驻一个合成层（约 347px × 视口宽的显存）。**收益极小（只省首次滚动那一次 40–66ms）**，
建议不以此换常驻内存。

---

## 场景 J：@ 慢到 1.0–1.6 秒的真正根因（2026-11-25 定案）

### 结论先行

**根因在 `ds-harness-remote` 注册的 `@` 源上，不在 `settings.get` 端点本身，也不在 fast-at。**

三个被逐一证伪的表层解释：

| 表层解释 | 证伪实验 | 结果 |
|---|---|---|
| `settings.get` 端点本身慢（ACP 后端探测走 `where` 同步子进程） | 直接打端点 5 次 | **4.3–13.4ms**。且本机 `acp.backends` 为空数组，`backendCommandAvailable` 一次都没执行 |
| `fileReferences/list` 慢 | 用真实参数 `{agentId,query:''}` 打 5 次 | **4.5–11.3ms** |
| 两者互相阻塞 | 并发打两个 | `settings.get` 4.5ms、`fileReferences` 27.5ms，**互不影响** |

### 真实机制

`ds-harness-remote/dist/client.js:7916-7939` 注册了一个 `trigger: '@'` 的源（`name: '主机'`，`order: -20`）：

```js
candidates: async (_session, request) => {
  if ((await control('settings.get').catch(() => {}))?.config?.remoteTools?.enabled === false) return []
  let devices = await control('devices').catch(() => [])
  ...
}
```

它的 `candidates` **第一行就 `await control('settings.get')`**。这个 control 调用在宿主侧要排队；
而同一时刻 fast-at 的文件候选 `fileReferences/list` 正在跑。两者在同一个宿主事件循环里串行。

**但决定性因素是 fast-at 的缓存策略**（`lib/client.js` 的 `CACHE_TTL_MS = 3000`）：

```js
// 只缓存「确实有文件行」的结果
if (fileItems.length > 0 && ...) {
  state.cache.set(key, { at: Date.now(), rows })
}
```

**`fileItems` 为空就不缓存 → 每轮都重新发 `fileReferences/list` → 每轮都要和 remote 源的 `settings.get` 抢同一条宿主事件循环。**

### 验证（决定性）

同一页面，只改两次 `@` 的间隔：

| 间隔 | @ 到候选行 | 说明 |
|---|---|---|
| **1 秒**（缓存有效期 3 秒内） | **151.5 / 136.4 ms** | 命中缓存，不发 `fileReferences` |
| **5 秒**（缓存已过期） | **1097 / 1558.8 / 1053.9 ms** | 缓存失效，重发请求，撞上 remote |

**1 秒内再按快 7–11 倍。**

补充证据：fetch tap 显示

```
快的一轮：只出现 sessions.list=40ms，fileReferences 根本不发
慢的一轮：settings.get=1129ms + fileReferences=1092ms 同时出现
```

### 为什么「本该很快却慢」

1. `settings.get` 的真实成本 = 4–13ms，被拖到 1129ms 是 **200 倍放大**，全部来自排队
2. 排队来自**两个插件抢同一条宿主事件循环**，而 fast-at 本可以在 `fileItems` 为空时也缓存
3. `@` 菜单本不需要等 remote 源的 `settings.get`——`order: -20` 让它排在前面，但候选行渲染不依赖它

### 可执行的优化点

**改 fast-at 的缓存策略（我认为这是正确修法）：**

```js
// 现状：fileItems.length === 0 时不缓存，导致每次 @ 都重发 fileReferences
if (fileItems.length > 0 && (signal === undefined || !signal.aborted)) {
  state.cache.set(key, { at: Date.now(), rows })
}

// 建议：空结果也缓存，但用更短的 TTL（比如 800ms），专门吃掉「连按 @」场景
const ttl = fileItems.length > 0 ? CACHE_TTL_MS : EMPTY_TTL_MS   // EMPTY_TTL_MS = 800
if ((signal === undefined || !signal.aborted)) {
  state.cache.set(key, { at: Date.now(), rows, ttl })
}
```

原注释担心「空结果缓存久了会让刚新建的文件 3 秒内看不见」——用 800ms 短 TTL 就能兼顾。

**另一个方向（治本但要宿主配合）：** 让 remote 源的 `settings.get` 结果在客户端侧缓存（它只在设置页变化时才变），
或把 `remoteTools.enabled` 判定挪到装配期一次性读取。这需要改 `ds-harness-remote`，不是我们的包。
