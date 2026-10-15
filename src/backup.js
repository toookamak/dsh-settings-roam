/**
 * 备份与回退。
 * 设计决策 17：应用前先备份，支持回退。这是「可回退」需求的落地。
 *
 * 备份目录按时间戳分开，而不是覆盖同一个目录——用户可能需要回到更早的一次状态。
 */

import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, isAbsolute, relative } from 'node:path'

/**
 * 生成时间戳字符串，形如 20261015-120000。
 * @param {Date} [now]
 * @returns {string}
 */
export function timestamp(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/**
 * 把一组文件备份到带时间戳的目录下。
 *
 * 路径在备份目录内按【绝对路径去掉根】保留层级，这样回退时能还原到原位，
 * 且不会因不同盘符或前缀而互相覆盖。
 *
 * @param {{files: string[], destRoot: string, stamp?: string}} input
 * @returns {{backupPath: string, backedUp: string[], failed: {path: string, error: string}[]}}
 */
export function createBackup(input) {
  const stamp = input.stamp ?? timestamp()
  const backupPath = join(input.destRoot, stamp)
  mkdirSync(backupPath, { recursive: true })
  const backedUp = []
  const failed = []
  for (const file of input.files) {
    try {
      if (!existsSync(file) || !statSync(file).isFile()) {
        failed.push({ path: file, error: '文件不存在' })
        continue
      }
      const rel = isAbsolute(file) ? relative('/', file) : file
      const dest = join(backupPath, rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(file, dest)
      backedUp.push(file)
    } catch (error) {
      failed.push({ path: file, error: String(error?.message ?? error) })
    }
  }
  return { backupPath, backedUp, failed }
}

/**
 * 从备份回退指定文件。
 * @param {{backupPath: string}} info - createBackup 的返回
 * @param {string[]} files - 要回退的文件（绝对路径，与备份时一致）
 * @returns {{restored: string[], failed: {path: string, error: string}[]}}
 */
export function restoreFromBackup(info, files) {
  const restored = []
  const failed = []
  for (const file of files) {
    try {
      const rel = isAbsolute(file) ? relative('/', file) : file
      const src = join(info.backupPath, rel)
      if (!existsSync(src)) {
        failed.push({ path: file, error: '备份中没有这个文件' })
        continue
      }
      mkdirSync(dirname(file), { recursive: true })
      copyFileSync(src, file)
      restored.push(file)
    } catch (error) {
      failed.push({ path: file, error: String(error?.message ?? error) })
    }
  }
  return { restored, failed }
}
