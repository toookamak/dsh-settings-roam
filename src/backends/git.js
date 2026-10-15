/**
 * git 介质实现。
 *
 * 三条实现约束：
 *
 *   1. 一律走子进程调用系统 git，不自造 git 客户端。
 *      认证因此全部落在系统 credential helper 上，插件代码里永不出现密钥。
 *
 *   2. 错误信息必须脱敏。git 的报错会把 URL 原样带出来，
 *      而 URL 里可能含用户名与密码。所有对外抛出的消息都要先过 scrub()。
 *
 *   3. 无改动时不提交。云端仓库的历史被当作审计轨迹用，
 *      塞满「无改动」的空提交会让这份轨迹失去意义。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { assertBackend } from './index.js'

/**
 * 抹掉文本里可能出现的凭据。
 * 形如 scheme://user:pass@host 的部分，把 user:pass 换成掩码。
 * @param {string} text
 * @returns {string}
 */
export function scrub(text) {
  return String(text).replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@')
}

/**
 * 在指定工作区运行一条 git 命令。
 * @param {string} cwd
 * @param {string[]} args
 * @param {{allowFailure?: boolean}} [options]
 * @returns {string} stdout
 */
function git(cwd, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (options.allowFailure === true) return ''
    const detail = scrub(error?.stderr || error?.message || '未知错误').trim()
    throw new Error(`git ${args[0]} 失败：${detail}`)
  }
}

/**
 * 建一个 git 后端。
 * @param {{repoUrl: string, workDir: string, branch?: string,
 *          author?: {name: string, email: string}}} config
 * @returns {object} 满足 BACKEND_METHODS 的后端
 */
export function createGitBackend(config) {
  const { repoUrl, workDir, branch = 'main' } = config
  const author = config.author ?? { name: 'dsh-settings-roam', email: 'roam@localhost' }
  const safeUrl = scrub(repoUrl)

  const isRepo = () => existsSync(join(workDir, '.git'))

  /**
   * 取工作区当前的实际分支名。
   *
   * 不硬编码分支名：系统的 init.defaultBranch 可能是 main 也可能是 master，
   * 而克隆一个已有仓库时分支名由远端决定。硬编码会让 push 报
   * 「源引用规格 main 没有匹配」——这个错误在实践中很难一眼看出成因。
   */
  function currentBranch() {
    const name = git(workDir, ['symbolic-ref', '--short', 'HEAD']).trim()
    return name === '' ? branch : name
  }

  function commit(message) {
    // 先看有没有待提交的东西。没有就直接返回，避免空提交污染历史。
    const status = git(workDir, ['status', '--porcelain']).trim()
    if (status === '') return false
    git(workDir, ['add', '-A'])
    git(workDir, [
      '-c', `user.name=${author.name}`,
      '-c', `user.email=${author.email}`,
      'commit', '--quiet', '-m', message,
    ])
    return true
  }

  const backend = {
    /** 准备工作区：没有就克隆。可重复调用。 */
    async ensureReady() {
      if (isRepo()) return
      mkdirSync(dirname(workDir), { recursive: true })
      // 克隆到临时目录再改名：克隆中途失败时不会留下半个工作区，
      // 否则下次启动会被 isRepo() 误判为已就绪。
      const staging = `${workDir}.staging-${process.pid}-${Date.now()}`
      try {
        git(dirname(workDir), ['clone', '--quiet', '--branch', branch, repoUrl, staging])
      } catch (error) {
        // 空裸库没有 main 分支，直接 clone 会报错。这是「新建云端」的正常情况，
        // 退到不指定分支的克隆。仍然失败才把原始错误交出（已脱敏）。
        try {
          git(dirname(workDir), ['clone', '--quiet', repoUrl, staging])
        } catch {
          rmSync(staging, { recursive: true, force: true })
          throw error
        }
      }
      rmSync(workDir, { recursive: true, force: true })
      renameSync(staging, workDir)
    },

    /** 把远端的新提交取回工作区。 */
    async pull() {
      if (!isRepo()) throw new Error(`工作区未就绪：${workDir}`)
      git(workDir, ['pull', '--quiet', '--no-rebase', 'origin', currentBranch()], {
        allowFailure: true,
      })
    },

    /**
     * 提交并推送到远端。无改动时什么都不做。
     * @returns {Promise<{committed: boolean}>}
     */
    async push(message) {
      if (!isRepo()) throw new Error(`工作区未就绪：${workDir}`)
      if (!commit(message)) return { committed: false }
      git(workDir, ['push', '--quiet', 'origin', currentBranch()])
      return { committed: true }
    },

    /**
     * 读云端文件。不存在返回 null —— 调用方要区分「没有这份配置」与「读取失败」。
     * @returns {Promise<string|null>}
     */
    async readFile(relPath) {
      const abs = join(workDir, relPath)
      if (!existsSync(abs)) return null
      return readFileSync(abs, 'utf8')
    },

    /** 写云端文件并落盘到工作区（提交由 push 统一做）。 */
    async writeFile(relPath, content) {
      const abs = join(workDir, relPath)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, 'utf8')
    },

    /** 供界面与错误信息使用，已脱敏。 */
    describe() {
      return `git 仓库 ${safeUrl}（分支 ${branch}）`
    },
  }

  assertBackend(backend)
  return backend
}
