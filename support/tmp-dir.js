/**
 * 测试用临时目录，带进程级兜底清理。
 *
 * 为什么需要它：每个用例结尾写 `rmSync(root)` 在断言失败时执行不到——
 * 抛错就直接出了函数体。于是「跑失败的那几次」会留下目录，实测累积到
 * 57 个 /tmp/roam-*，其中大部分来自早期失败运行。清理不能依赖「走到最后一行」。
 *
 * 做法是在进程退出时统一清理。选择进程级而不是用例级（t.after）：
 * 用例级要改 8 个测试文件的每个用例签名，而这里的问题只出在「失败路径漏清理」，
 * 进程退出时清理已足够，且不需要每个用例配合。
 *
 * 仍然保留用例内的显式 rmSync：正常路径下尽早释放，也让「清理了」这件事在用例里可见。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const created = new Set()
let registered = false

/**
 * 建一个临时目录，并登记为「进程结束时清理」。
 * @param {string} prefix 目录名后缀，便于在 /tmp 里一眼看出属于哪组用例
 * @returns {string} 绝对路径
 */
export function tmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `roam-${prefix}`))
  created.add(dir)
  if (!registered) {
    registered = true
    process.on('exit', () => {
      for (const path of created) {
        try { rmSync(path, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
      }
    })
  }
  return dir
}

/** 立刻清掉一个临时目录（正常路径用）。 */
export function dropTmp(path) {
  created.delete(path)
  rmSync(path, { recursive: true, force: true })
}

/** 当前已登记但未清理的目录数，供用例断言清理是否生效。 */
export function outstanding() {
  return created.size
}
