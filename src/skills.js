/**
 * 技能目录的读写。
 *
 * 设计 §4.7 的两个硬要求：
 *   1. 保留文件模式 —— 脚本靠可执行位工作，丢了就在目标机器上静默失效。
 *   2. 同步前必须能审查脚本内容 —— 技能脚本会在目标机器上执行，
 *      差异视图里要能看到脚本的新增与改动，不能当不透明二进制默默搬过去。
 *
 * 主通道是直读 ~/.dsh/skills/，ctx.skills 只作校验通道（设计决策 26）：
 * 技能本体就是文件，直读得到的就是要同步的内容；走 ctx.skills 反而多一层抽象。
 */

import { readdirSync, statSync, mkdirSync, copyFileSync, chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join, sep, dirname } from 'node:path'
import { createBackup } from './backup.js'

/**
 * 列出技能目录下的技能名（各技能一个子目录）。
 * @param {string} skillsRoot - 形如 ~/.dsh/skills
 * @returns {string[]}
 */
export function listSkillNames(skillsRoot) {
  let entries
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries.filter(e => e.isDirectory()).map(e => e.name)
}

/**
 * 递归扫描技能目录，返回每个文件的可比较记录。
 * @param {string} skillsRoot
 * @param {string[]} [only] - 只扫描这些技能；省略则全部
 * @returns {{relPath: string, size: number, executable: boolean}[]}
 */
export function scanSkills(skillsRoot, only) {
  const wanted = only ?? listSkillNames(skillsRoot)
  const out = []
  const walk = (dir, relBase) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
      if (entry.isDirectory()) {
        walk(abs, rel)
        continue
      }
      if (!entry.isFile()) continue
      const st = statSync(abs)
      out.push({
        relPath: rel.split(sep).join('/'),
        size: st.size,
        executable: (st.mode & 0o100) !== 0,
      })
    }
  }
  for (const name of wanted) {
    const abs = join(skillsRoot, name)
    try {
      if (!statSync(abs).isDirectory()) continue
    } catch {
      continue
    }
    walk(abs, name)
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

/**
 * 把指定技能复制到目标目录，保留可执行位。
 * @param {string} skillsRoot - 源技能根目录
 * @param {string[]} names - 要复制的技能名
 * @param {string} destRoot - 目标根目录（技能会成为其子目录）
 * @returns {string[]} 实际复制的技能名
 */
export function copySkills(skillsRoot, names, destRoot) {
  const copied = []
  for (const name of names) {
    const src = join(skillsRoot, name)
    let st
    try {
      st = statSync(src)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const walk = (dir, relBase) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
        const dest = join(destRoot, name, rel)
        if (entry.isDirectory()) {
          mkdirSync(dest, { recursive: true })
          walk(abs, rel)
          continue
        }
        if (!entry.isFile()) continue
        mkdirSync(join(dest, '..'), { recursive: true })
        copyFileSync(abs, dest)
        // 保留模式位：脚本靠可执行位工作
        const mode = statSync(abs).mode & 0o777
        chmodSync(dest, mode)
      }
    }
    mkdirSync(join(destRoot, name), { recursive: true })
    walk(src, '')
    copied.push(name)
  }
  return copied
}

/**
 * 用 ctx.skills 校验直读结果（校验通道）。
 * 不一致说明有技能来自非本机的 provider 来源，这本身值得报告。
 * @param {object} skillService - ctx.skills
 * @param {string[]} directNames - 直读得到的技能名
 * @returns {Promise<{consistent: boolean, complete: boolean, serviceNames: string[]}>}
 */
export async function crossCheckSkills(skillService, directNames) {
  const snap = await skillService.snapshot()
  const serviceNames = snap.skills.map(s => s.name)
  const a = [...directNames].sort()
  const b = [...serviceNames].sort()
  return {
    consistent: JSON.stringify(a) === JSON.stringify(b),
    complete: snap.complete !== false,
    serviceNames,
  }
}

/**
 * 把一份导出包里的技能文件写回本机技能目录。
 *
 * 与 copySkills 的区别：copySkills 是「从另一个技能目录搬」，来源是活的文件系统，
 * 模式位可以从源文件读；这里是「从包里的内容重建」，模式位只能来自清单记录
 * （清单里没有 executable 时按 0o644 写，与没有可执行位的普通文件一致）。
 *
 * 写入前逐个备份已存在的目标文件。技能目录里可能有用户自己改过的东西，
 * 覆盖它而不留副本，等于把「回退」这件事变成一句空话。
 *
 * @param {{
 *   skillsRoot: string,
 *   files: {path: string, content: string, executable?: boolean}[],
 *   targetPathOf: (path: string) => string,
 *   backupRoot?: string,
 *   stamp?: string,
 * }} input
 * @returns {{written: string[], failed: {path: string, reason: string}[], backup: object|null}}
 */
export function applySkillFiles(input) {
  const { skillsRoot, files, targetPathOf, backupRoot } = input
  const written = []
  const failed = []

  const targets = files.map(file => ({ file, target: targetPathOf(file.path) }))
  const existing = targets.filter(item => existsSync(item.target)).map(item => item.target)

  let backup = null
  if (backupRoot !== undefined && backupRoot !== null && existing.length > 0) {
    backup = createBackup({ files: existing, destRoot: backupRoot, stamp: input.stamp })
  }

  for (const { file, target } of targets) {
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.content, 'utf8')
      // 保留可执行位（设计 §4.7）：脚本靠它工作，丢了会在目标机器上静默失效。
      chmodSync(target, file.executable === true ? 0o755 : 0o644)
      written.push(file.path)
    } catch (error) {
      failed.push({ path: file.path, reason: String(error?.message ?? error) })
    }
  }

  return { written, failed, backup }
}

/** 技能根目录的子目录名，供调用方拼接。 */
export const SKILLS_DIRNAME = 'skills'
