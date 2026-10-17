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
 *
 *   4. 我们只占一条分支，且是**孤儿分支**。
 *      同一个人往往用一个库放多个插件的备份，各占一条分支。若把我们的分支
 *      建在别人分支的提交之上，工作区里会混进别的插件的文件——既会让我们
 *      的清单收进不属于自己的东西，也让「这个库能不能删」变得说不清。
 *      孤儿分支没有父提交，我们的分支上永远只有我们自己的文件。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, readdirSync } from 'node:fs'
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
  const { repoUrl, workDir } = config
  // 没指定分支时**不动分支**（沿用远端已有的那条）。
  // 指定了才占一条自己的分支——插件与命令行都会指定，所以实际路径上总是有值；
  // 这条默认规则是给「只想用这个后端做一次简单同步」的调用方留的。
  const branch = typeof config.branch === 'string' && config.branch.trim() !== ''
    ? config.branch.trim()
    : null
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
    if (name !== '') return name
    // HEAD 还没指向任何分支（刚建的空库）时给一个名字，好让 push 有目标。
    return branch ?? 'main'
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

  /**
   * 确保工作区停在我们的分支上。
   *
   * 三种情况：
   *   1. 远端已有这条分支 —— 克隆时已经拿到，什么都不用做
   *   2. 远端没有（第一次用，或者同库共用的别人建了别的分支）—— 建一条孤儿分支
   *   3. 工作区已经在别的分支上（比如上次跑的是别的插件）—— 切过去
   */
  function ensureOurBranch() {
    if (branch === null) return
    if (currentBranch() === branch) return
    // 本地已经有这条分支（之前用过），直接切过去，不要重建——
    // checkout --orphan 在分支已存在时会报「分支已经存在」。
    // 切完顺手清掉别的分支留下的未跟踪文件，否则它们会被当成我们的内容。
    const existing = git(workDir, ['branch', '--list', '--format=%(refname:short)', branch]).trim()
    if (existing !== '') {
      git(workDir, ['checkout', '--quiet', branch])
      git(workDir, ['clean', '-fdq'], { allowFailure: true })
      return
    }
    // checkout --orphan 会把当前分支的文件留在索引里，所以先切再清。
    git(workDir, ['checkout', '--orphan', branch])
    git(workDir, ['rm', '-r', '-f', '--quiet', '--ignore-unmatch', '.'], { allowFailure: true })
    // 索引清空后工作区可能还剩空目录，一并清掉，避免它们被当成我们的内容收进清单。
    for (const entry of readdirSync(workDir)) {
      if (entry === '.git') continue
      rmSync(join(workDir, entry), { recursive: true, force: true })
    }
  }

  const backend = {
    /** 准备工作区：没有就克隆。可重复调用。 */
    async ensureReady() {
      if (isRepo()) {
        ensureOurBranch()
        return
      }
      mkdirSync(dirname(workDir), { recursive: true })
      // 克隆到临时目录再改名：克隆中途失败时不会留下半个工作区，
      // 否则下次启动会被 isRepo() 误判为已就绪。
      const staging = `${workDir}.staging-${process.pid}-${Date.now()}`
      try {
        if (branch === null) throw new Error('未指定分支，直接克隆')
        git(dirname(workDir), ['clone', '--quiet', '--branch', branch, repoUrl, staging])
      } catch (error) {
        // 远端还没有这条分支（第一次用最常见的形态），或者是个空库。
        // 退到不指定分支的克隆，稍后再建我们自己的孤儿分支。
        // 仍然失败才把原始错误交出（已脱敏）。
        try {
          git(dirname(workDir), ['clone', '--quiet', repoUrl, staging])
        } catch {
          rmSync(staging, { recursive: true, force: true })
          throw error
        }
      }
      rmSync(workDir, { recursive: true, force: true })
      renameSync(staging, workDir)
      ensureOurBranch()
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

    /** 最近一次云端提交时间；空仓库返回 null。 */
    async lastUploadAt() {
      if (!isRepo()) return null
      const value = git(workDir, ['log', '-1', '--format=%cI', '--', 'snapshot.json'], { allowFailure: true }).trim()
      return value || null
    },

    /** 供界面与错误信息使用，已脱敏。 */
    describe() {
      return branch === null ? `git 仓库 ${safeUrl}` : `git 仓库 ${safeUrl}（分支 ${branch}）`
    },
  }

  assertBackend(backend)
  return backend
}
