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

import { readdirSync, statSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs'
import { join, sep } from 'node:path'

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
