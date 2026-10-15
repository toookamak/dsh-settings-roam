/**
 * 唯一允许直接接触 DSH Loader YAML 方言的模块。
 *
 * 不放自造 YAML 逻辑：解析走 @deepseek-ai/cordis-plugin-include 的 entryListSchema，
 * 渲染走同款方言 schema —— 与 `dsh --dump-config` 保持一致，
 * 保证插件写出的格式永远和官方工具可互认。
 *
 * 三条硬约束（由 2026-10-15 实测得出，见实现计划「验证结论」）：
 *   C1 新增条目走 insert，不用 id-patch —— id-patch 打空行是静默跳过。
 *   C2 warn 回调必须收集，回调非空即视为异常 —— 官方不抛错。
 *   C3 同名行匹配时 config 是全量替换，非深合并 —— 必须先在内存合并完整 config。
 */

import * as yaml from 'js-yaml'
import { entryListSchema, applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { isSharedPatchId, isMachinePatchId } from './ownership.js'

/**
 * 解析一份 patch 文件文本。
 * @param {string} text - 文件内容
 * @returns {object[]} 顶层条目数组
 */
export function parsePatchList(text) {
  const parsed = yaml.load(text, { schema: entryListSchema })
  if (!Array.isArray(parsed)) {
    throw new Error('patch 文件必须是顶层 YAML 数组')
  }
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`第 ${index + 1} 项必须是映射（一个 Loader patch 条目）`)
    }
  }
  return parsed
}

/**
 * 按顶层条目 id 把条目分成三组。抽取的最小单位是条目，不是文件——见设计 §4.6。
 * @param {object[]} rows
 * @returns {{shared: object[], machine: object[], excluded: object[]}}
 */
export function splitByTopLevelId(rows) {
  const shared = []
  const machine = []
  const excluded = []
  for (const row of rows) {
    if (isSharedPatchId(row.id)) shared.push(row)
    else if (isMachinePatchId(row.id)) machine.push(row)
    else excluded.push(row)
  }
  return { shared, machine, excluded }
}

/**
 * 把条目渲染成 YAML 文本。
 *
 * 已知代价：注释不保真。官方渲染器不保留手写注释，会生成自己的 `# == <来源>`
 * 分隔注释。本插件只写公共条目，而注释密集的本机条目不在写回范围，故接受此代价，
 * 换取「格式与 dsh --dump-config 永远一致」的收益。
 * @param {object[]} rows
 * @param {string} [label] - 来源标签，写入分隔注释
 * @returns {string}
 */
export function renderPatches(rows, label = 'dsh-settings-roam') {
  const header = `# 由设置漫游生成，来源：${label}\n`
  return header + yaml.dump(rows, { schema: entryListSchema, noRefs: true, lineWidth: -1 })
}

/**
 * 把公共条目合并进目标条目列表，返回新列表与警告。
 *
 * 分两条路径，这是 C1 与 C3 的落地：
 *   - 目标里没有这个 id → 用 insert 追加（C1）
 *   - 目标里已有这个 id → 在内存中把 config 整体替换为公共版（C3）
 *
 * @param {object[]} targetRows - 目标机器当前的条目列表
 * @param {object[]} sharedRows - 要合入的公共条目
 * @param {{forceIdPatchForTest?: string}} [options] - 仅供测试注入
 * @returns {{rows: object[], warnings: string[], applied: string[]}}
 */
export function mergeSharedInto(targetRows, sharedRows, options = {}) {
  const warnings = []
  const applied = []
  const warn = (message, ...args) => {
    let index = 0
    warnings.push(String(message).replace(/%C/g, () => JSON.stringify(args[index++])))
  }

  let current = structuredClone(targetRows)

  // 测试钩子：复现官方的静默跳过（C2 的反例）
  if (options.forceIdPatchForTest !== undefined) {
    current = applyEntryPatches(current, [{ id: options.forceIdPatchForTest, config: {} }], warn)
    return { rows: current, warnings, applied }
  }

  const existingIds = new Set(current.map(r => r.id))
  const toInsert = sharedRows.filter(r => !existingIds.has(r.id))
  const toReplace = sharedRows.filter(r => existingIds.has(r.id))

  if (toInsert.length > 0) {
    current = applyEntryPatches(current, [{ insert: structuredClone(toInsert) }], warn)
    for (const row of toInsert) applied.push(row.id)
  }
  for (const row of toReplace) {
    // C3：整体替换 config。结构由共享条目完整给出，不依赖深合并。
    const patch = { id: row.id }
    if (row.name !== undefined) patch.name = row.name
    if (row.config !== undefined) patch.config = structuredClone(row.config)
    current = applyEntryPatches(current, [patch], warn)
    applied.push(row.id)
  }

  return { rows: current, warnings, applied }
}
