# 交接文档：@ 引用候选性能追查

> 生成时间：2026-11-25 23:30（Asia/Shanghai）
> 生成原因：原会话上下文已被污染——多轮排查中的**旧问题现象**（长按 @ 卡顿、删除卡顿、滚动卡顿、皮肤影响）与**新问题**（@ 偶发 1–4 秒延迟）在对话里交叉出现，导致结论漂移。
> **新会话请只信本文件与 `TROUBLESHOOTING-LOG.md`，不要从旧对话的叙述里取任何数字。**

---

## 0. 先读这个：当前唯一有效结论

### 0.1 症状（当前要解决的问题）

在 @ 菜单里，候选行**偶发**要 1.0–4.0 秒才出现；多数时候只要 130–170ms。
用户感知为「每隔一段时间按 @ 就卡一下」。

### 0.2 根因（已定案，见 TROUBLESHOOTING-LOG §44）

**`settings.get` 和 `fileReferences/list` 从来没有同时触发，也没有互相阻塞。**
它们串行排在 **fast-at 自己的会话索引请求**后面。真正慢的是第三个请求。

```
用户按下 @
  └─ fast-at 包装的 candidates → computeCandidates()
      ├─ await indexPathCandidates()            ← ① 串行等待点
      │   └─ fetch('/fast-at/api/sessions.list')
      │       └─ sessions-reader.query()
      │           ├─ 索引新鲜(≤30s) → 3.5–7.5ms 返回  ✓
      │           └─ 索引过期(>30s) → ensureIndex()
      │               └─ execFile(fast-at-sessions.exe)   ← ★ 阻塞源
      │                   └─ 扫 396 个 .zstd / 282.1MB = 824–3942ms  ✗
      ├─ await fetchFileItems()   ← ② 索引返回后才执行，实测 2ms
      └─ remote 源 → await control('settings.get')  ← ③ 也排在①后，实测 0.1–1ms
```

`INDEX_TTL_MS = 30_000`（`lib/sessions-reader.js:40`）。索引每 30 秒过期，过期后下一次按 @ 必然撞上重建。

### 0.3 已排除（**不要重复验证**）

| 假设 | 排除依据 |
|---|---|
| `settings.get` 端点本身慢 | 实测 0.1–1ms（安静态）；本机 `acp.backends` 为空，`backendCommandAvailable`/`where` 那段从未执行 |
| `fileReferences/list` 本身慢 | 实测 1.7–2.1ms，返回 `{ok:true,value:[]}` |
| 两者并发互相阻塞 | fetch tap 显示无重叠，`fileRef.send` 永远晚于 `fastAt.done` |
| 浏览器主线程卡顿 | 重建期间 152 帧，最大 17.9ms，0 长任务 |
| `JSON.parse` 133KB 太大 | 浏览器实测 0.4ms |
| 空结果不缓存导致重发 | 确实每轮重发，但只占 2ms |
| `ds-harness-remote` 是元凶 | 它只是排在索引后面。禁用它会「变快」是因为**整个 @ 路径少了一个源**，不是它本身慢 |

### 0.4 已验证的修复方向

索引新鲜时连续 6 次 @：**133.3 / 158.4 / 141.3 / 147.5 / 153.4 / 164.4 ms**，中位 153.4ms，全部达标 < 300ms。
所以只要把索引重建移出请求路径，问题就解决。

---

## 1. 当前环境（已核实，2026-11-25 23:30）

| 项 | 值 |
|---|---|
| GUI 端口 | `127.0.0.1:55630`（PID 7072） |
| profile | `desktop`，`C:\Users\IT\.dsh\profiles\desktop\` |
| `app.asar` | SHA256 `5EC8ACD9E72B93B6680C953C1BE44A729FD3A5170E472E8025690A1713D20F69`，**与纯净备份完全一致**，无任何补丁 |
| 明确 disabled 的插件 | 仅 `better-sidebar` |
| `ds-harness-remote` | **启用中**（为做对照实验重新启用，结论是它无辜） |
| `ui-skin-815` | 启用中（已证明对 @ 无影响） |
| fast-at | 版本 0.2.0，已装入 profile，`link:` 方式指向仓库 |

---

## 2. 关键文件

| 文件 | 大小 | 说明 |
|---|---|---|
| `dsh-fast-at/TROUBLESHOOTING-LOG.md` | 139041 B | **主文档**，45 个章节（§0–§44）。§44 是本次定案 |
| `dsh-fast-at/PERFORMANCE-REPORT.md` | 29914 B | 性能报告，场景 A–J |
| `dsh-fast-at/lib/sessions-reader.js` | 11617 B | **待修文件**。索引 TTL / spawn / query |
| `dsh-fast-at/lib/index.js` | 5919 B | 宿主侧 HTTP 路由 `/fast-at/api/*` |
| `dsh-fast-at/lib/client.js` | 37023 B | 浏览器侧，包装 @ 源 candidates |
| `dsh-fast-at/HANDOFF.md` | 本文件 | 交接说明 |

### 2.1 `sessions-reader.js` 关键常量

```js
INDEX_TTL_MS     = 30_000   // 索引有效期
RETRY_COOLDOWN_MS = 10_000  // 重建失败冷却
TIMEOUT_MS       = 30_000   // execFile 超时
```

### 2.2 关键函数位置

- `query()` — 查候选，索引过期时调 `ensureIndex()` 但**不 await**
- `ensureIndex()` — 幂等，返回 `building` Promise
- `buildIndex()` — 实际 `execFile(fast-at-sessions.exe, ['--root', root, '--limit','999999','--title-limit','30'])`
- `computeCandidates()` — `client.js` 里串行 `await indexPathCandidates()` → `await fetchFileItems()`

---

## 3. 修复方案（未实施，等确认）

按性价比排序：

### 方案 1：把重建移出请求路径（改动最小，推荐先做）

```js
// sessions-reader.js 现在：
const age = Date.now() - index.at
const stale = age >= INDEX_TTL_MS
if (stale) ensureIndex()   // 不 await，但仍会 spawn 子进程抢 I/O

// 改法：加定时后台重建，query() 里删掉 if (stale) ensureIndex()
setInterval(() => {
  if (Date.now() - (index?.at ?? 0) >= INDEX_TTL_MS) ensureIndex()
}, 5000)
```

### 方案 2：增量索引（治本，改 Rust）

Rust 侧记录每个会话文件 mtime，下次只读变化的。396 个里通常只有 1–2 个变，能把 824–3942ms 降到 10ms 量级。

### 方案 3：缩小 Rust 输出体积

现在每次输出 133,840 字符（全量 396 条），一次 @ 只用 20 条。改成 Rust 侧 `--limit 20` 截断。

### 方案 4：并行化 computeCandidates

```js
// client.js 现在：
const sessionItems = await indexPathCandidates(...)
fileItems = await fetchFileItems(...)

// 改法：
const [sessionItems, fileItems] = await Promise.all([
  indexPathCandidates(...),
  fetchFileItems(...),
])
```

---

## 4. 测量方法（必须遵守，否则数字无效）

### 4.1 唯一有效的长按通道

`browser_e2e_press` 的单发 / `repeat:N` / `recipe` / `fill(mode:"keystrokes")` **全部无效**（有约 930–1011ms 的工具侧节流）。
唯一有效：`document.execCommand('insertText')` + `await sleep(16)`。

### 4.2 清空编辑器必须用真实按键

`execCommand('selectAll')` + `delete` **不可靠**（第二轮起会残留），必须用真实 `Ctrl+A` / `Delete`，并断言 `innerText.length === 0`。

### 4.3 必须开 freezeAnimations

`browser_e2e_start({ headless: true, freezeAnimations: true })`。

### 4.4 记录 send/done 绝对时间戳

这是本次定案的关键手法。不要只记「耗时」，要记**何时发出、何时收到完整响应体**：

```js
window.fetch = async function(...a) {
  const u = ...;
  const t0 = performance.now();
  const res = await orig.apply(this, a);
  await res.clone().text();   // ← 关键：等 body 真正读完
  const t1 = performance.now();
  // 记录 t0 / t1
}
```

**判据**：若慢的请求全部在同一刻 `done`、而 `send` 时刻各不相同 ⇒ 它们在排队等同一个更早的任务，不存在交互。

---

## 5. 已知的上下文污染点（新会话务必警惕）

原会话里混杂了**至少 4 个不同问题**，它们的叙述互相污染：

| 编号 | 问题 | 状态 | 与当前问题关系 |
|---|---|---|---|
| P1 | 长按 @ 连续输入卡顿（每键几十 ms） | 已解决，better-sidebar 是主因，已禁用 | **无关**。那是「每键成本」，现在是「偶发整段延迟」 |
| P2 | 删除路径小卡顿 | 已解决 | **无关** |
| P3 | 会话区滚动偶发卡顿 | 已查清：首次滚动的一次性布局，与皮肤无关 | **无关** |
| P4 | @ 菜单偶发 1–4 秒延迟 | **← 当前问题** | 见 §0.2 |

**污染的具体表现**（我在原会话里犯过的错，新会话不要重犯）：

1. 用 P1 的度量（每键 ms）去解释 P4 的现象（整段秒级延迟），结论必然漂移。
2. 把 `settings.get` 2 秒当成「端点慢」，实际上它只是排队（见 §0.3）。
3. 把 `fileReferences` 「2 秒」当成执行慢，实际上它是 2 秒后才被调用。
4. 中途得出过 §41（remote 的 settings.get 阻塞）、§43（空结果不缓存）两个**错误定案**，都已被 §44 推翻。**读文档时按章节号取最新结论，不要读 §41/§43 就当结论。**

---

## 6. 新会话的建议起点

1. 先读 `TROUBLESHOOTING-LOG.md` 的 **§0**（当前唯一有效结论）和 **§44**（定案）。
2. 读本文件 §0.2 的因果链，确认与自己理解一致。
3. 不要重新验证 §0.3「已排除」列表里的任何一条。
4. 直接进入修复：从方案 1 开始（改 `sessions-reader.js`，把重建移出请求路径）。
5. 修完用 §4.4 的方法验证：索引重建期间按 @，候选行应稳定 < 300ms。

---

## 7. 验证脚本模板

```js
// 1. 装 tap
await browser_e2e_evaluate({ expression: `(() => {
  window.__ev = [];
  if (!window.__of) window.__of = window.fetch;
  window.fetch = async function(...a) {
    const u = typeof a[0]==='string'?a[0]:(a[0]&&a[0].url)||'';
    const t0 = performance.now();
    window.__ev.push({u: u, k:'send', t:t0});
    const res = await window.__of.apply(this, a);
    await res.clone().text().catch(()=>{});
    window.__ev.push({u: u, k:'done', t:performance.now()});
    return res;
  };
  return 'ok';
})()` });

// 2. 无条件清空（真实按键）
for (let k = 0; k < 4; k++) {
  await browser_e2e_press({ key: 'Control+a' });
  await browser_e2e_press({ key: 'Delete' });
  await sleep(400);
  const len = await browser_e2e_evaluate({ expression: "document.querySelector(\"[contenteditable='true']\").innerText.split(String.fromCharCode(10)).join('').length" });
  if (parseInt(String(len).match(/\\d+/)?.[0] || '99') === 0) break;
}

// 3. 按 @ 并计时到候选行
const r = await browser_e2e_evaluate({ expression: `(async () => {
  const t0 = performance.now();
  const ed = document.querySelector("[contenteditable='true']");
  ed.focus();
  document.execCommand('insertText', false, '@');
  let rowsAt = -1;
  while (performance.now() - t0 < 8000) {
    await new Promise(r => requestAnimationFrame(r));
    if (document.querySelectorAll("[role='option']").length) {
      rowsAt = Math.round((performance.now()-t0)*10)/10; break;
    }
  }
  return { rowsAt, ev: window.__ev.map(x => x.u.split('/').pop() + '.' + x.k + '@' + Math.round((x.t-t0)*10)/10) };
})()` });
```

---

## 8. 参考数据

### 8.1 Rust 二进制直接执行耗时

```
fast-at-sessions.exe --root ~/.dsh/sessions --limit 999999 --title-limit 30
  第1次: 3,942 ms   输出 133,840 字符
  第2次:   824 ms
  第3次:   910 ms
  第4次: 1,138 ms
```

### 8.2 目录规模

```
C:\Users\IT\.dsh\sessions
  396 个 .zstd 会话文件，共 282.1 MB
  磁盘：SSSTC CA5-8D512-Q79 (SSD)
```

### 8.3 索引命中 vs 重建

```
命中（索引 ≤30s）：3.5–7.5 ms
重建（索引 >30s）：824–3942 ms
```

---

## 9. 回滚点

| 项 | 回滚方式 |
|---|---|
| `app.asar` | 已与 `.scratch\app.asar.backup` 一致，无需回滚 |
| 插件启停 | 改 `~/.dsh/profiles/desktop/cordis.patch.yml` 里对应 `disabled:` 值 |
| 原始配置备份 | `~/.dsh/profiles/desktop/backup-before-plugin-purge-20261125-1030\` |
| fast-at 代码 | `link:` 到仓库，直接改 `C:\lengduan\githubs\my-dsh-plugins\dsh-fast-at\lib\` |

---

## 10. 一句话给新会话

> **@ 偶发慢的唯一原因是 `sessions-reader.js` 的 `INDEX_TTL_MS = 30_000` 在请求路径上触发 `execFile` 全量重建（396 个文件 / 282MB / 824–3942ms）。`settings.get` 和 `fileReferences` 都是被排队的无辜者。修法：把重建移出请求路径。**
