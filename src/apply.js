/**
 * 拉取侧应用：备份 → 合并 → 写入 → 写后回读校验。
 *
 * 设计决策 25 的落地，并遵守两条实测约束：
 *   C2：applyEntryPatches 的 warn 回调必须收集，回调非空即视为写入异常。
 *       官方在目标行不存在时【不抛错】，只经 warn 报一句 not found。
 *   C3：同名行匹配时 config 是全量替换而非深合并，合并必须在内存中先做好。
 *
 * 不做自动降级：读路径可以「A 失败换 B」，写路径不行——两条都试可能产生副作用，
 * 跳过则意味着这台机器的配置停在半改状态。处置是「回退这一项 + 列为需人工处理」。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parsePatchList, renderPatches, mergeSharedInto } from './yaml-loader.js'
import { createBackup, restoreFromBackup } from './backup.js'

/**
 * 把云端的公共条目应用到本机 patch 文件。
 *
 * 路径：先备份 → 读取本机现状 → 在内存中合并 → 渲染 → 写出 → 调用方随后回读校验。
 *
 * @param {{
 *   targetFile: string,
 *   sharedRows: object[],
 *   backupRoot?: string,
 *   __forceWarnForTest?: boolean,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   warnings: string[],
 *   applied: string[],
 *   backup: object|null,
 *   wrote: boolean,
 * }}
 */
export function applyPatchFile(input) {
  const { targetFile, sharedRows, backupRoot } = input

  // 1. 备份（文件不存在时不备份——新机器场景没有可备份的内容）
  let backup = null
  if (backupRoot !== undefined && existsSync(targetFile)) {
    backup = createBackup({ files: [targetFile], destRoot: backupRoot })
  }

  // 2. 读取本机现状
  let localRows = []
  if (existsSync(targetFile)) {
    const text = readFileSync(targetFile, 'utf8')
    localRows = text.trim() === '' ? [] : parsePatchList(text)
  }

  // 3. 在内存中合并（C3：不指望 patch 做局部合并）
  const merged = mergeSharedInto(
    localRows,
    sharedRows,
    input.__forceWarnForTest === true ? { forceIdPatchForTest: 'no-such-id-for-warning' } : {},
  )

  // 4. 渲染并写出
  mkdirSync(dirname(targetFile), { recursive: true })
  writeFileSync(targetFile, renderPatches(merged.rows, 'settings-roam'), 'utf8')

  return {
    ok: merged.warnings.length === 0,
    warnings: merged.warnings,
    applied: merged.applied,
    backup,
    wrote: true,
  }
}

/**
 * 写后回读校验：确认文件里确实变成了预期值。
 * 这是把「静默失败」转换成「可见失败」的那一步。
 * @param {string} targetFile
 * @param {object[]} expectedRows - 期望存在的公共条目
 * @returns {{ok: boolean, missing: string[], mismatch: string[]}}
 */
export function verifyWriteBack(targetFile, expectedRows) {
  if (!existsSync(targetFile)) {
    return { ok: false, missing: expectedRows.map(r => r.id), mismatch: [] }
  }
  const actual = parsePatchList(readFileSync(targetFile, 'utf8'))
  const actualMap = new Map(actual.map(r => [r.id, r]))
  const missing = []
  const mismatch = []
  for (const expected of expectedRows) {
    const got = actualMap.get(expected.id)
    if (got === undefined) {
      missing.push(expected.id)
      continue
    }
    if (JSON.stringify(got.config) !== JSON.stringify(expected.config)) {
      mismatch.push(expected.id)
    }
  }
  return { ok: missing.length === 0 && mismatch.length === 0, missing, mismatch }
}

/**
 * 回退一项已应用的配置。
 * 写路径不「跳过」，而是「回退这一项 + 列为需人工处理」。
 * @param {{backupPath: string}} backupInfo
 * @param {string} targetFile
 * @returns {{restored: string[], failed: object[]}}
 */
export function rollbackApplied(backupInfo, targetFile) {
  return restoreFromBackup(backupInfo, [targetFile])
}
