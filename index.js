/**
 * 设置漫游的宿主半侧。
 *
 * 这里只做两件事：建立服务实例，把它挂到 ctx 上供浏览器半侧读取。
 * 界面本身在 client.js 里，两侧通过槽位的 inject 交汇。
 *
 * 为什么挂在 ctx 上而不是模块级单例：一个 DSH 进程可能加载多份 profile，
 * 每份 profile 各有自己的数据根目录与后端配置，模块级单例会互相覆盖。
 */
import { join } from 'node:path'
import { resolveDshHome } from './src/home-paths.js'
import { createGitBackend } from './src/backends/git.js'
import { createSyncService } from './src/service.js'

export const name = 'settings-roam'

/** 读路径依赖 settings（describe）与 skills（crossCheck），缺失就不该启动。 */
export const inject = ['settings', 'skills']

/**
 * 数据根目录不由用户配置。
 *
 * 这是真装载验收暴露出来的第一处缺陷：最初把 dshRoot 写成 config 字段，
 * 结果 cordis.patch.yml 里没有它，apply 一启动就在 join(undefined, ...) 上崩溃，
 * 表现为「1 entry did not activate」。DSH 装在哪儿是运行环境事实，不是用户偏好——
 * 让用户去填一个他从不知道的绝对路径，既是坏设计，也必然填错。
 *
 * 改走 src/home-paths.js——它逐行复刻官方 @deepseek-ai/dsh-home-paths 的语义
 * （显式配置 → $DSH_HOME → ~/.dsh），保证我们与 harness 其他部分对
 * 「用户数据在哪」始终一致。为什么不直接 import 官方包：它随 harness 发行、
 * 不在 npm 上独立可装，第三方插件引用它会在安装时解析失败。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {object} [config] - 来自 cordis.patch.yml 的条目 config
 * @param {string} [config.dshHome] - 覆盖数据根目录，仅测试与多实例场景需要
 * @param {string} [config.repoUrl] - 云端仓库地址；缺省时插件装着但待配置
 * @param {string} [config.backendKind] - 介质类型，第一期只支持 'git'
 */
export function apply(ctx, config) {
  const dshRoot = resolveDshHome(config?.dshHome)

  // 后端惰性构造：仓库地址只能由用户填，YAML 里传不进对象实例。
  // 传工厂而不是实例，装配阶段就不会因子配置而崩掉（真装载验收的教训）。
  const service = createSyncService({
    dshRoot,
    backend: () => createGitBackend({
      repoUrl: config?.repoUrl,
      workDir: join(dshRoot, 'settings-roam', 'work'),
    }),
  })

  // 浏览器半侧经槽位 inject 取用。
  //
  // 必须用 ctx.provide 注册，不能直接赋值——Cordis 的 DI 纪律：往 ctx 上挂
  // 未声明的属性会抛「cannot set property ... without provide」，整个条目不激活。
  // provide 返回的 disposer 随 fiber 一起清理，插件卸载时服务自动注销，
  // 这也是它比模块级单例正确的地方。
  ctx.provide('settingsRoam', {
    service,
    dshRoot,
    configured: service.isConfigured(),
  })

  ctx.logger?.info?.(
    '设置漫游已就绪，数据根目录：%s%s',
    dshRoot,
    service.isConfigured() ? '' : '（尚未配置云端仓库）',
  )
}
