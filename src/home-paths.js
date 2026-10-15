/**
 * 数据根目录解析。
 *
 * 为什么不 import 官方包，而是自己实现一份：
 * `@deepseek-ai/dsh-home-paths` 随 harness 发行，**不在 npm 上独立可装**，
 * 第三方插件声明它会导致安装时解析失败（真装载验收实测）。
 * 官方生态里的第三方插件（如 dshmarket）同样是自己复刻一份，其
 * src/home-paths.ts 的注释原话就是「same semantics as the current
 * `@deepseek-ai/dsh-home-paths` package」。
 *
 * 复刻的代价是语义可能漂移，所以下面的实现逐行对照官方源码写成：
 *   packages/util/home-paths/src/index.ts:70  defaultDshHome
 *   packages/util/home-paths/src/index.ts:87  expandHomePath
 *   packages/util/home-paths/src/index.ts:101 resolveRoot
 *   packages/util/home-paths/src/index.ts:135 resolveDshHome
 * 任何一处官方语义变更，都需要同步这里；测试里用参数化用例固化全部优先级分支。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 覆盖数据根目录的环境变量名，与官方 DSH_HOME_ENV 一致。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * 默认数据根目录：`~/.dsh`。
 * 对照 packages/util/home-paths/src/index.ts:70。
 * @returns {string}
 */
export function defaultDshHome() {
  return join(homedir(), '.dsh')
}

/**
 * 展开配置里支持的波浪号写法。
 * 对照 packages/util/home-paths/src/index.ts:87。
 *
 * 注意只展开单独或当前用户的 `~` 形式（`~`、`~/x`、`~\x`），
 * `~other/x` 不展开——官方就是如此，多展开反而会造成路径歧义。
 * @param {string} path
 * @returns {string}
 */
export function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 按优先级解析数据根目录：显式配置 → `$DSH_HOME` → `~/.dsh`。
 * 对照 packages/util/home-paths/src/index.ts:135。
 *
 * 「空白视为未设置」这一条是官方的安全设计：空白的覆盖值绝不能把根目录
 * 解析到当前工作目录——那会让插件去读写项目目录，是危险的失败模式。
 * @param {string} [configured] - 显式覆盖，优先级最高
 * @param {Record<string, string|undefined>} [env] - 读取 DSH_HOME 的环境映射
 * @returns {string} 规范化后的绝对路径
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured
    ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())
  return resolve(expandHomePath(selected))
}

/**
 * 在已解析的数据根目录下拼一段子路径。
 * 对照 packages/util/home-paths/src/index.ts:160。
 * @param {...string} segments
 * @returns {string}
 */
export function dshHomePath(...segments) {
  return join(resolveDshHome(), ...segments)
}

/**
 * profiles 子目录名。
 * 对照 packages/boot/app-boot/src/profile.ts:37 `export const PROFILES_DIR = 'profiles'`。
 */
export const PROFILES_DIR = 'profiles'

/**
 * profile 的 patch 文件名。
 * 对照 packages/boot/app-boot/src/profile.ts:40
 * `export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'`。
 */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/**
 * 解析某个 profile 的 patch 文件绝对路径。
 *
 * 为什么要单独抽出来（这是一处真实缺陷的修复）
 * ────────────────────────────────────────
 * 原实现写的是 `join(dshRoot, 'cordis.patch.yml')`，即数据根目录下直接找。
 * 但 DSH 的真实布局是 `<dshRoot>/profiles/<profileName>/cordis.patch.yml`
 * （见 packages/boot/app-boot/src/profile.ts:276 与 :452 的 profilesDir = join(home, PROFILES_DIR)）。
 * 后果：对真实数据根运行 inspect 时读到 0 个条目——用户明明配了东西，
 * 工具却说「什么都没有」。而单元测试因为把 fixture 也建在根目录下，
 * 全部通过，照不出这个偏差。
 *
 * 这不只是「路径写错」：它属于「插件对 DSH 的数据布局做了假设」这一类问题。
 * 凡是这类假设都必须在真实布局上验证过，否则测试再绿也不代表能用。
 *
 * @param {string} dshRoot - 已解析的数据根目录
 * @param {string} profileName - profile 名，如 'web'
 * @returns {string}
 */
export function profilePatchPath(dshRoot, profileName) {
  return join(dshRoot, PROFILES_DIR, profileName, PROFILE_PATCH_FILENAME)
}

/**
 * 列出现有的 profile 名。
 *
 * 用于在没有显式指定 profile 时自动选择——用户不该被要求先知道
 * 「我的配置在哪个 profile 里」，那是 DSH 的内部组织方式。
 *
 * @param {string} dshRoot
 * @param {{readdirSync: Function, existsSync: Function}} fsLike - 便于测试注入
 * @returns {string[]} 按字典序，保证结果稳定可断言
 */
export function listProfiles(dshRoot, fsLike = {}) {
  const { readdirSync, existsSync } = fsLike
  const dir = join(dshRoot, PROFILES_DIR)
  if (typeof existsSync !== 'function' || !existsSync(dir)) return []
  if (typeof readdirSync !== 'function') return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}
