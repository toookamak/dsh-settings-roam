/**
 * 推送侧抽取：按归属表从本机配置里抽出公共线。
 *
 * 这是本设计的核心动作。实测数据显示 cordis.patch.yml 有 9 个顶层条目，
 * 其中只有 llm-pi-ai 一个进公共线。所以抽取的最小单位是【顶层条目】，
 * 不是整个文件——按文件整体同步会把 webserver.host 的局域网 IP 带到新机器上，
 * 恰好犯下本项目要解决的那个错误。
 *
 * 风险评估（设计 §7.3 最后一行）：第三方插件会在 patch 里留下 insert 行。
 * 若误把 insert 行当配置项抽取，会写坏别的机器的加载顺序。所以这里显式识别并排除。
 */

import { ownershipOf } from './ownership.js'
import { splitByTopLevelId } from './yaml-loader.js'

/**
 * 识别 patch 里不该被抽取的条目。
 * @param {object[]} rows
 * @returns {{id: string, reason: string}[]}
 */
export function detectUnexpectable(rows) {
  const found = []
  for (const row of rows) {
    if (row?.insert !== undefined) {
      found.push({ id: row.id, reason: 'has-insert-rows' })
    }
  }
  return found
}

/**
 * 从本机配置抽取公共线。
 *
 * @param {{patchRows?: object[]}} input - 本机 cordis.patch.yml 解析后的条目
 * @returns {{
 *   patch: object[],           // 要写进云端的公共条目
 *   entries: {path: string, kind: string, ownership: string}[],  // 逐项归属，供界面展示
 *   unexpectable: {id: string, reason: string}[],                // 被识别并排除的条目
 * }}
 */
export function extractShared(input) {
  const patchRows = input.patchRows ?? []
  const { shared } = splitByTopLevelId(patchRows)
  const unexpectable = detectUnexpectable(patchRows)
  const unexpectableIds = new Set(unexpectable.map(u => u.id))

  const entries = []
  for (const row of patchRows) {
    entries.push({
      path: `patch:${row.id}`,
      kind: 'patch',
      ownership: ownershipOf('patch', row.id),
    })
  }

  // 只有确认属于公共线、且不是 insert 痕迹的条目才真正抽取
  const patch = shared.filter(row => !unexpectableIds.has(row.id))

  return { patch, entries, unexpectable }
}

/**
 * 判断一次抽取是否“干净”：有没有本该进公共线却被排除的条目。
 * 供界面在推送前提示用户。
 * @param {{patch: object[], unexpectable: object[]}} result
 * @returns {boolean}
 */
export function isExtractionClean(result) {
  return result.unexpectable.length === 0
}
