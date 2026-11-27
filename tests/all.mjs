/**
 * dsh-fast-at 全部测试的统一入口。
 *
 * 分三层，任何一层失败都要能单独复现：
 * 1. 纯函数 / 打包契约 / 冒烟（最快，毫秒级）
 * 2. host 读取层集成（索引构建 / 契约 / 过滤 / 失败路径）
 * 3. host 侧读取层（索引构建、契约、query 过滤、失败回退）
 *
 * 跑法：node tests/all.mjs
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'

import fsSync from 'node:fs'
import os from 'node:os'

/**
 * 判断本机是否有真实的会话数据（`<DSH_HOME>/sessions` 下有会话文件）。
 *
 * integration-reader / integration-cache 两组用例断言的是「本机真实会话索引」的行为：
 * 会话数量、标题覆盖、subagent 条目、磁盘 id 前缀混合情况。这些前提在干净的 CI
 * runner 上并不成立（那里没有 ~/.dsh/sessions），硬跑只会得到一连串假阴性。
 * 因此缺少真实数据时跳过，并明确标注「跳过」而不是「通过」。
 * @returns {boolean} 有真实会话数据时为 true。
 */
function hasRealSessions() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    return fsSync.readdirSync(path.join(home, 'sessions')).length > 0
  } catch {
    return false
  }
}

const REAL_SESSIONS = hasRealSessions()

const suites = [
  { name: '纯函数（client 半）', file: 'tests/test-pure.mjs' },
  { name: '打包契约', file: 'tests/test-packaging.mjs' },
  { name: '冒烟（包装/还原）', file: 'tests/test-smoke.mjs' },
  { name: 'client 半 T1 回归（变异守卫）', file: 'tests/client-t1.mjs' },
  { name: 'host 读取层集成', file: 'tests/integration-reader.mjs', requiresRealSessions: true },
  { name: '缓存落盘（v0.7）', file: 'tests/integration-cache.mjs', requiresRealSessions: true },
]

const results = []
for (const s of suites) {
  if (s.requiresRealSessions && !REAL_SESSIONS) {
    process.stdout.write('\n' + '='.repeat(60) + '\n' + s.name + '  (' + s.file + ')\n' + '='.repeat(60) + '\n')
    process.stdout.write('  跳过：本机没有真实会话数据（<DSH_HOME>/sessions 为空或不存在）\n')
    process.stdout.write('  这组用例断言的是真实会话索引的行为，干净环境里跑只会产生假阴性。\n')
    results.push({ name: s.name, code: 0, pass: null, total: null, skipped: true })
    continue
  }
  process.stdout.write('\n' + '='.repeat(60) + '\n' + s.name + '  (' + s.file + ')\n' + '='.repeat(60) + '\n')
  const r = spawnSync(process.execPath, [s.file], { encoding: 'utf8', cwd: process.cwd() })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  process.stdout.write(out)
  const m = out.match(/通过 (\d+) \/ (\d+)/)
  results.push({ name: s.name, code: r.status ?? -1, pass: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null })
}

process.stdout.write('\n' + '='.repeat(60) + '\n汇总\n' + '='.repeat(60) + '\n')
let failed = 0
for (const r of results) {
  const ok = r.code === 0
  if (!ok) failed += 1
  const counts = r.skipped ? '  （跳过）' : r.total === null ? '' : '  ' + r.pass + '/' + r.total
  process.stdout.write((ok ? '  通过  ' : '  失败  ') + r.name + counts + '\n')
}
process.stdout.write('\n' + (failed === 0 ? '全部套件通过' : failed + ' 个套件失败') + '\n')
process.exit(failed === 0 ? 0 : 1)