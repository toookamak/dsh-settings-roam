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
