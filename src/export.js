/**
 * 把「本次会同步什么」真实写到磁盘上，供用户直接打开检查。
 *
 * 为什么需要这个模块
 * ──────────────────
 * 推送此前是「内存里转一圈就写云端」：用户看不到究竟带走了什么，
 * 只能从界面上的差异数字去猜。这不是信任问题，是可用性问题——
 * 一个同步工具如果无法回答「你带走了我的什么」，它就没法被放心使用。
 *
 * 落到磁盘的是一份**可读的导出**，不是内部数据结构的转储：
 *   export/<时间戳>/
 *     manifest.json    清单：每个文件的大小、hash、来源
 *     概要.md           人读的概述：同步了什么、多少项、本机项为何没带走
 *     config/profile.patch.yml    公共配置（就是将要推送的那份）
 *     bundles.json                插件名单
 *     skills/...                  技能文件
 *
 * 与 backup 的区别（两者容易混，故写在这里）
 * ─────────────────────────────────────────
 *   backup/     应用**前**把本机文件原样存一份，用于回退。是不可读的保险丝。
 *   export/     **将要推送**的内容导出成可读形态，用于检查。是给人看的。
 * 前者保「旧」，后者展「新」。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative, isAbsolute } from 'node:path'

/**
 * 把待同步文件导出到磁盘。
 *
 * @param {object} input
 * @param {{path: string, content: string}[]} input.files - preparePush 产出的文件列表
 * @param {string} input.exportRoot - 导出根目录（通常是 <dshRoot>/settings-roam/export）
 * @param {string} input.stamp - 时间戳目录名，由调用方给定（便于测试）
 * @param {object} [input.summary] - 差异摘要，写进概述
 * @param {object} [input.report] - buildReportView 的结果，提供 notices
 * @param {string} [input.generatedBy] - 生成者标识（机器名）
 * @returns {{exportPath: string, files: string[], total: number}}
 */
export function exportForReview(input) {
  const { files, exportRoot, stamp } = input
  const exportPath = join(exportRoot, stamp)
  mkdirSync(exportPath, { recursive: true })

  const written = []

  for (const file of files) {
    const dest = join(exportPath, safeRelPath(file.path))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, file.content)
    written.push(file.path)
  }

  writeFileSync(
    join(exportPath, 'manifest.json'),
    JSON.stringify(buildManifest(input, written), null, 2) + '\n',
  )

  writeFileSync(
    join(exportPath, '概要.md'),
    renderOverview(input, written, exportPath),
  )

  return { exportPath, files: written, total: written.length }
}

/**
 * 把条目路径转成安全的相对路径。
 *
 * 条目路径来自云端快照或本机目录扫描，理论上可信，但「理论上」不足以
 * 支撑一次写文件操作——含 .. 或绝对路径的条目会写到导出目录之外。
 * 这里把风险路径就地压平成普通文件名，绝不向上跳出。
 *
 * @param {string} entryPath
 * @returns {string}
 */
export function safeRelPath(entryPath) {
  const normalized = String(entryPath).replace(/\\/g, '/')
  if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    return normalized.replace(/^[A-Za-z]:/, '').replace(/^\/+/, '').replace(/[/:]/g, '_')
  }
  const parts = normalized
    .split('/')
    .filter(part => part !== '' && part !== '.' && part !== '..')
  return parts.length === 0 ? '_' : join(...parts)
}

/**
 * 内容校验值。
 *
 * 用完整 sha256 而不是截断值：这个值要承担「这份包有没有被动过」的判断，
 * 而基于它的动作是把文件写到用户机器上，属于安全边界，不是展示字段。
 * 快照清单里用的是截断值——那边只做「变了没有」的比对，不承担写入决策。
 *
 * @param {string} content
 * @returns {string}
 */
export function hashContent(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function buildManifest(input, written) {
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? null,
    generatedBy: input.generatedBy ?? 'unknown',
    total: written.length,
    files: written.map(path => {
      const entry = input.files.find(f => f.path === path)
      const content = entry?.content ?? ''
      const record = {
        path,
        bytes: Buffer.byteLength(content, 'utf8'),
        sha256: hashContent(content),
      }
      // 可执行位单独记一笔：技能里的脚本靠它工作，丢了就在目标机器上静默失效
      // （设计 §4.7 第 1 条）。只对知道的条目记，不凭空给所有文件编一个 false。
      if (typeof entry?.executable === 'boolean') record.executable = entry.executable
      return record
    }),
    diff: input.summary ?? null,
  }
}

/**
 * 渲染人读概述。
 *
 * 原则：先说「带走了什么」，再说「没带走什么」，最后给路径。
 * 顺序不能反——用户打开这个文件，第一个问题是「同步了什么」。
 */
function renderOverview(input, written, exportPath) {
  const lines = []
  const summary = input.summary ?? {}

  lines.push('# 本次将同步的内容')
  lines.push('')
  if (input.generatedAt) lines.push(`- 生成时间：${input.generatedAt}`)
  if (input.generatedBy) lines.push(`- 生成机器：${input.generatedBy}`)
  lines.push(`- 文件总数：${written.length}`)
  lines.push('')

  lines.push('## 带走了什么')
  lines.push('')
  for (const path of written) {
    lines.push(`- \`${path}\``)
  }
  lines.push('')

  // 差异摘要：只在有内容时出现，避免全零的噪音区块。
  const hasDiff = summary && (summary.add || summary.modify || summary.delete)
  if (hasDiff) {
    lines.push('## 与云端的差异')
    lines.push('')
    lines.push(`- 新增 ${summary.add ?? 0} 项`)
    lines.push(`- 修改 ${summary.modify ?? 0} 项`)
    lines.push(`- 删除 ${summary.delete ?? 0} 项`)
    lines.push('')
  }

  if (input.report?.notices?.length > 0) {
    lines.push('## 需要留意')
    lines.push('')
    for (const notice of input.report.notices) {
      lines.push(`- ${notice}`)
    }
    lines.push('')
  }

  lines.push('## 本机专属项（不会同步）')
  lines.push('')
  lines.push('监听地址、主题、工具权限预设、默认模型留在本机，不随本次同步改变。')
  lines.push('')

  lines.push('## 这些文件在哪')
  lines.push('')
  lines.push(`\`${exportPath}\``)
  lines.push('')
  lines.push('可以直接打开上面目录里的文件逐项核对。')
  lines.push('')

  return lines.join('\n')
}

/** 导出目录相对数据根的位置，供 README 与界面引用同一处定义。 */
export const EXPORT_DIRNAME = 'export'

/** 相对路径展示用（给界面概述）。 */
export function displayPath(absolute, root) {
  const rel = relative(root, absolute)
  return rel === '' ? '.' : rel
}
