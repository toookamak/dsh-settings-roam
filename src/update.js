/**
 * 插件自更新：判断「装的是哪一版」与「最新是哪一版」。
 *
 * 为什么需要这一层：这个插件是从 Git 仓库装的（`github:owner/repo`）。
 * DSH 的插件安装入口在**依赖没有变化**时会拒绝安装
 * （`ambiguous-install`：它靠「profile 的 dependencies 前后差异」判断
 * 到底装上了哪一个包，git 形态的 spec 走不到它的兜底匹配）。
 * 所以「重新装一遍同一个来源」这条路是死的，必须让 spec 本身发生变化。
 *
 * 于是更新的做法是：把 spec 收敛成带**具体提交号**的形式
 * （`github:owner/repo#<40 位 sha>`）。文件内容没变、来源还是那个仓库，
 * 但 spec 变了，安装入口就能正常判定。实测过：装上旧提交，再把它换成新提交，
 * 能正常更新（见 test/update.test.js 与演练记录）。
 *
 * 两条实测约束：
 *   1. **必须用完整的 40 位 sha**。短 sha 解析不了——
 *      `pnpm` 报 `Could not resolve 525bf38 to a commit`：它按 ref 列表解析，
 *      而 ref 列表里没有短 sha 这种东西。
 *   2. 更新完要重启才生效。插件已经加载在内存里，换掉磁盘上的文件
 *      不会让运行中的那一份跟着变。
 *
 * 本模块保持纯净：解析与判断不碰文件系统、不碰网络。
 * 「读本机装的是哪一版」与「问远端最新是哪一版」由服务层拿结果喂进来。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as yaml from 'js-yaml'

const run = promisify(execFile)

/** 判断结果的几种形态。界面与命令行按这个分支说话。 */
export const UPDATE_REASONS = Object.freeze([
  // 还没问过远端。设置页每次打开都会取一次状态，那一次刻意不联网，
  // 所以它是常态而非异常——必须和「问了但问不到」（unreachable）分开。
  'unchecked',
  'up-to-date',
  'update-available',
  'unknown-version',
  'not-git',
  'unreachable',
  // profile 的依赖清单里根本没有本插件——不是「装成了别的形态」，
  // 而是「不知道它是怎么装进来的」。跟 not-git 分开，免得给出一个指向
  // 本地链接安装的说法，而用户手上根本没有链接安装。
  'no-spec',
])

/** 快捷形态 → 站点。pnpm 与 DSH 都认这几个前缀（install-spec.ts 的 GIT_SHORTHAND）。 */
const SHORTHANDS = Object.freeze({
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  gist: 'gist.github.com',
})

/**
 * 长得像「主机名:路径」但不是 Git 仓库的那几个前缀。
 *
 * `link:/home/...` 与 `git@github.com:o/r` 在字符串形态上是同一类东西
 * （`xx:yy`），只靠形状分不开，所以显式排掉 pnpm 自己的那几个协议。
 */
const NON_GIT_PREFIX = /^(link|file|workspace|npm|patch|portal|exec|virtual|node)$/i

/**
 * 从一条依赖 spec 里认出 Git 仓库地址。
 *
 * 认不出来就返回 null，而不是猜一个：`link:`／`file:`／普通版本号
 * 这类装法没有「最新提交」可言，硬套一个更新动作只会把用户的依赖写坏。
 *
 * @param {string} spec 例如 github:owner/repo#abc、https://host/o/r.git、git@host:o/r.git
 * @returns {{repoUrl: string, host: string, path: string, ref: string|null}|null}
 */
export function parseGitSpec(spec) {
  if (typeof spec !== 'string') return null
  const text = spec.trim().replace(/^git\+/, '')
  if (text === '') return null

  const split = value => {
    const hash = value.indexOf('#')
    return hash === -1
      ? { path: value, ref: null }
      : { path: value.slice(0, hash), ref: value.slice(hash + 1) || null }
  }

  // 形态一：快捷前缀，例如 github:owner/repo
  const shortcut = /^(github|gitlab|bitbucket|gist):(.+)$/.exec(text)
  if (shortcut !== null) {
    const host = SHORTHANDS[shortcut[1]]
    const { path, ref } = split(shortcut[2])
    if (path === '') return null
    return { repoUrl: `https://${host}/${stripGitSuffix(path)}.git`, host, path, ref }
  }

  // 形态二：完整 URL，例如 https://github.com/o/r.git、ssh://git@host/o/r.git
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/.exec(text)
  if (url !== null) {
    const host = url[1]
    const { path, ref } = split(url[2])
    if (path === '') return null
    return { repoUrl: `https://${host}/${stripGitSuffix(path)}.git`, host, path, ref }
  }

  // 形态三：git 的 scp 写法，例如 git@github.com:o/r.git
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(.+)$/.exec(text)
  if (scp !== null) {
    const host = scp[1]
    const { path, ref } = split(scp[2])
    // 排掉 pnpm 自己的协议、盘符（C:\...）、以及缺斜杠的裸串
    if (NON_GIT_PREFIX.test(host)) return null
    if (host.length < 2) return null
    if (path === '' || !path.includes('/')) return null
    return { repoUrl: `https://${host}/${stripGitSuffix(path)}.git`, host, path, ref }
  }

  return null
}

/** 去掉末尾的 .git，拼 URL 时统一补一个。 */
function stripGitSuffix(path) {
  return path.replace(/\.git$/, '')
}

/**
 * 把 spec 收敛成带具体提交号的形式。
 *
 * 已有的 ref 会被换掉（包括「装在某条分支上」的旧写法）：
 * 更新要的是确定的那一个提交，留着 branch 名下次又回到「不知道装的是哪一版」。
 *
 * @param {string} spec
 * @param {string} commit 完整的 40 位 sha
 * @returns {string}
 */
export function specWithCommit(spec, commit) {
  const text = String(spec ?? '').trim()
  const hash = text.indexOf('#')
  const base = hash === -1 ? text : text.slice(0, hash)
  return `${base}#${commit}`
}

/**
 * 从 profile 的 pnpm 锁文件里读出「这个包实际装的是哪个提交」。
 *
 * 为什么不信 package.json 里那条 spec：它多半没带提交号
 * （`github:owner/repo` 就是跟着默认分支走），而「现在装的是哪一版」
 * 只记在锁文件的解析结果里——那里写着真实拉下来的那个 tar.gz 的提交号。
 *
 * 读不出来返回 null，不猜。调用方据此说「读不出装的是哪一版」。
 *
 * @param {string} lockText pnpm-lock.yaml 的内容
 * @param {string} packageName 例如 @toookamak/dsh-settings-roam
 * @returns {string|null}
 */
export function installedCommitFromLock(lockText, packageName) {
  if (typeof lockText !== 'string' || lockText === '') return null
  let doc = null
  try {
    doc = yaml.load(lockText, { schema: yaml.JSON_SCHEMA })
  } catch {
    return null
  }
  if (doc === null || typeof doc !== 'object') return null

  const sections = ['dependencies', 'devDependencies', 'optionalDependencies']
  for (const importer of Object.values(doc.importers ?? {})) {
    if (importer === null || typeof importer !== 'object') continue
    for (const section of sections) {
      const record = importer[section]?.[packageName]
      if (record === undefined) continue
      const found = commitIn(String(record?.version ?? record?.specifier ?? ''))
      if (found !== null) return found
    }
  }

  // 兜底：锁文件里「包名@git 地址」这样的键（pnpm 的 packages / snapshots 段）
  for (const key of Object.keys(doc.packages ?? {})) {
    if (!key.startsWith(`${packageName}@`)) continue
    const found = commitIn(key)
    if (found !== null) return found
  }
  return null
}

/** 从一段文本里抠出 codeload/archive 形态里的提交号。 */
function commitIn(text) {
  const match = /(?:tar\.gz|archive)\/([0-9a-f]{40})(?:[^0-9a-f]|$)/i.exec(text)
  return match === null ? null : match[1].toLowerCase()
}

/**
 * 三分判断：要不要更新。
 *
 * @param {{spec?: string|null, installedCommit?: string|null, remoteCommit?: string|null}} input
 * @returns {{spec: string|null, repoUrl: string|null, installedCommit: string|null,
 *   remoteCommit: string|null, needsUpdate: boolean, reason: string}}
 */
export function planUpdate(input = {}) {
  const spec = typeof input.spec === 'string' && input.spec.trim() !== '' ? input.spec.trim() : null
  const installedCommit = normalizeCommit(input.installedCommit)
  const remoteCommit = normalizeCommit(input.remoteCommit)
  const parsed = parseGitSpec(spec ?? '')

  const base = {
    spec,
    repoUrl: parsed?.repoUrl ?? null,
    installedCommit,
    remoteCommit,
    needsUpdate: false,
  }

  // 不是从 Git 装的（link:、file:、版本号），没有「最新提交」这回事。
  // 本地链接安装恰恰是**开发时**用的形态，那种情况下更新由代码本身完成。
  if (parsed === null) return { ...base, reason: 'not-git' }
  if (remoteCommit === null) return { ...base, reason: 'unreachable' }
  if (installedCommit === null) return { ...base, needsUpdate: true, reason: 'unknown-version' }
  if (installedCommit === remoteCommit) return { ...base, reason: 'up-to-date' }
  return { ...base, needsUpdate: true, reason: 'update-available' }
}

/** 只接受完整的 sha；别的一律当作「读不出来」。 */
function normalizeCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null
}

/** 给界面与命令行看的短号。 */
export function shortCommit(commit) {
  return typeof commit === 'string' && commit.length >= 7 ? commit.slice(0, 7) : ''
}

/**
 * 问远端「默认分支现在指到哪个提交」。
 *
 * 用 HEAD 而不是某个分支名：`github:owner/repo` 这种写法装的就是默认分支的
 * 当前提交，拿别的分支去比会得出错误的「要不要更新」。
 *
 * 失败一律吞成 null（网络不通、仓库不存在、没认证都可能），
 * 上层据此说「问不到远端」，而不是把一个 git 的原始报错甩给用户。
 *
 * @param {string} repoUrl
 * @param {{timeoutMs?: number, runGit?: Function}} [options]
 * @returns {Promise<string|null>}
 */
export async function readRemoteHead(repoUrl, options = {}) {
  if (typeof repoUrl !== 'string' || repoUrl === '') return null
  const exec = options.runGit ?? ((args, opts) => run('git', args, opts))
  try {
    const { stdout } = await exec(['ls-remote', repoUrl, 'HEAD'], {
      timeout: options.timeoutMs ?? 20000,
      // 没有终端可问密码：卡在认证提示上比直接失败更糟
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
    })
    const match = /^([0-9a-f]{40})\s/m.exec(String(stdout))
    return match === null ? null : match[1].toLowerCase()
  } catch {
    return null
  }
}
