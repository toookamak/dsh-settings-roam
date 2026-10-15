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
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from './src/home-paths.js'
import { createGitBackend } from './src/backends/git.js'
import { createSyncService } from './src/service.js'
import { buildPushOverview, buildPullOverview, buildImportOverview } from './src/overview.js'
import { describeRoutes } from './src/routes.js'

export const name = 'settings-roam'

/**
 * 插件配置的 schema —— 设置页上的「基础配置选项」就是它。
 *
 * DSH 的设置页按这个 schema 自动生成表单（packages/settings/settings/src/index.ts:302
 * 的 describe() 把 Config schema 投影成表单），写回的是 profile 的 cordis.patch.yml，
 * 再经 app-boot 的 config-reload（packages/boot/app-boot/src/index.ts:302）重跑
 * 本插件的 apply——所以这里加一个字段，设置页就多一个输入框，且改完即生效，
 * 不需要为「填个仓库地址」自己画一套表单。
 *
 * 为什么用 schemastery：官方就是这么做的（packages/client/ui-theme/src/index.ts:37、
 * ui-settings-general/src/index.ts:14 都导出 Config）。自带界面只会多一套要维护的东西，
 * 还会与设置页里其它插件长得不一致。
 *
 * 为什么它只在 peerDependencies 里且标 optional：schemastery 与 cordis 一样是宿主包，
 * 随 harness 发行、不在 npm 上独立可装。声明成硬依赖会让插件在别的机器上装不上。
 * 官方生态里的第三方插件（如 dshmarket）正是用 optional peerDependency 处理这件事。
 *
 * 字段说明刻意写成用户能读懂的话：设置页上原样显示这些字符串，
 * 「repoUrl」这种词对产品使用者没有意义。未接入的字段一律注明「尚未生效」——
 * 宁可看起来没做完，也不要让人以为它已经在工作。
 */
export const Config = z.object({
  repoUrl: z.string().default('').description(
    '云端仓库地址，用于把公共配置存到远端（第三阶段）。留空时插件仍可使用，只是不能推送与拉取。',
  ).volatile(),
  profileName: z.string().default('').description(
    '要同步哪个 profile。留空时自动：只有一个就用它，多于一个会明确报错，不会替你猜。',
  ).volatile(),
  exportRoot: z.string().default('').description(
    '导出目录。推送前会先在这里落一份可以逐项核对的副本；留空时放在数据根目录下。',
  ).volatile(),
  importRoot: z.string().default('').description(
    '【尚未生效】导入来源目录，用于从本程序导出的包里回填配置（第二阶段）。',
  ).volatile(),
})

/**
 * 为什么每个字段都必须 .volatile()——这一条不写下来，下一个人一定会踩：
 *
 * 设置页的表单由 volatileForm() 过滤得到（packages/settings/settings/src/schema.ts:37），
 * 只有「最近的 volatile 祖先」下的字段才会进入表单；一个 volatile 字段都没有时
 * 它返回 undefined，describe()（packages/settings/settings/src/index.ts:302）
 * 随即跳过整个条目——设置页上**什么都不显示**，且不报任何错。
 *
 * 也就是说：漏写 .volatile() 不是「字段不可编辑」，而是「这个插件在设置页里不存在」。
 * 官方 ui-theme（packages/client/ui-theme/src/index.ts:37）与
 * ui-settings-general（packages/client/ui-settings-general/src/index.ts:14）
 * 的每个字段都带 .volatile()，原因就在这里。
 *
 * 代价是解析后拿到的是 Volatile 引用而不是普通值，读的时候要 .get()
 * （官方同样如此：config.preference.get()）。下面的 readOption() 就是干这个的。
 */

/**
 * 读路径依赖 settings（describe）与 skills（交叉校验），缺失就不该启动。
 *
 * pluginManager 不在 inject 里：插件名单属于「有则收集、没有也能用」的能力。
 * 把它加进 inject 会让插件在缺少该服务的环境下直接不启动，
 * 而它缺了只是少一份名单，不该阻断同步。
 */
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
 * @param {object} [config] - 由上面的 Config schema 解析后的插件配置
 * @param {string} [config.dshHome] - 覆盖数据根目录，仅测试与多实例场景需要
 * @param {string} [config.repoUrl] - 云端仓库地址；留空时插件装着但待配置
 * @param {string} [config.profileName] - 指定同步哪个 profile；留空时自动判定
 * @param {string} [config.exportRoot] - 导出目录；留空时用数据根目录下的默认位置
 * @param {string} [config.backendKind] - 介质类型，第一期只支持 'git'
 */
export function apply(ctx, config) {
  const dshRoot = resolveDshHome(config?.dshHome)

  /**
   * 读一个配置项。
   *
   * Config 里的字段都标了 .volatile()，解析后是 Volatile 引用而不是普通值，
   * 必须 .get() 才拿到内容（官方同样如此：config.preference.get()）。
   * 这里同时兼容普通值，是为了让直接调用 apply 的测试与手工装配不必造假引用。
   *
   * @param {string} key
   * @returns {string|null} 去空白后的值；未填或不是字符串时为 null
   */
  const readOption = (key) => {
    const field = config?.[key]
    const value = typeof field?.get === 'function' ? field.get() : field
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }

  // 可选注入：服务出现时捕获引用，始终不出现时这个回调不会运行（也就不会抛错）。
  let pluginManagerRef
  ctx.inject(['pluginManager'], (scope) => {
    pluginManagerRef = scope.pluginManager
  })

  // 后端惰性构造：仓库地址只能由用户填，YAML 里传不进对象实例。
  // 传工厂而不是实例，装配阶段就不会因子配置而崩掉（真装载验收的教训）。
  const service = createSyncService({
    dshRoot,
    profileName: readOption('profileName') ?? undefined,
    exportRoot: readOption('exportRoot') ?? undefined,
    importRoot: readOption('importRoot') ?? undefined,
    // 校验通道：直读文件是主通道，ctx.skills 是交叉校验通道。
    // 不传它读路径就退化成单通道——最坏情况是静默同步错内容而不是报警。
    skillService: ctx.skills,
    // 插件名单采集口。
    //
    // 这里绕了两道，都是真装载验收逼出来的：
    //   1. 不能直接读 ctx.pluginManager。Cordis 的 DI 纪律是「没 inject 过就
    //      不许取」——实测报 `cannot get property "pluginManager" without inject`
    //      （一次 500，导出整条路径挂掉）。而 pluginManager 刻意不在 inject 里：
    //      它缺了只是少一份插件名单，不该让整个插件不启动。
    //   2. 也不能在装配那一刻就把值取出来：该服务可能比本插件晚就绪。
    // 所以用可选注入捕获一个引用，再由 getter 惰性返回当时的值。
    pluginManager: () => pluginManagerRef,
    backend: () => {
      const repoUrl = readOption('repoUrl')
      if (repoUrl === null) {
        // 交给 createGitBackend 去拼 git 命令会得到一个难以理解的报错，
        // 这里提前拦下，给出用户能照做的说明。
        throw new Error('还没配置云端仓库。请在上面的「云端仓库地址」里填上仓库地址。')
      }
      return createGitBackend({
        repoUrl,
        workDir: join(dshRoot, 'settings-roam', 'work'),
      })
    },
  })

  // 未声明的配置键要显式告警。
  //
  // 实测：schemastery 不剥离未知键（见 test/config.test.js 的核对结论），
  // 所以用户在 cordis.patch.yml 里把 repoUrl 敲成 repourl 时既不会报错、
  // 也不会生效，表现为「我明明填了，插件却说没配置」。这类问题如果不在
  // 启动日志里说破，用户只能靠猜。dshHome 与 backendKind 是刻意保留的
  // 测试/多实例开关，不在 Config 里，故显式放行。
  const knownKeys = new Set([...Object.keys(Config.dict ?? {}), 'dshHome', 'backendKind'])
  for (const key of Object.keys(config ?? {})) {
    if (!knownKeys.has(key)) {
      ctx.logger?.warn?.(
        '设置漫游：配置项 %s 不是可识别的选项，已被忽略。可用的选项：%s',
        key,
        [...knownKeys].join('、'),
      )
    }
  }

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

    /**
     * 推送并导出可供核对的文件。
     *
     * 为什么在宿主侧提供一个组合动作，而不是让界面自己拼：
     * 界面（浏览器半侧）不能 import 宿主模块，也无法访问文件系统，
     * 它只能拿到已经算好的结果。所以「算推送计划 → 导出到磁盘 → 生成概述」
     * 这三步必须在宿主侧一次完成，把概述交给界面显示。
     *
     * 导出目录默认放在数据根目录下，用户不必配置；导出失败不阻断推送
     * （导出是给人看的副本，不是同步本身，见 src/export.js 的取舍说明）。
     *
     * @param {{generatedBy?: string, exportRoot?: string, bundles?: object}} [input]
     */
    async pushWithExport(input = {}) {
      const plan = await service.preparePush({
        ...input,
        exportRoot: input.exportRoot ?? service.defaultExportRoot(),
      })
      return { plan, overview: buildPushOverview(plan) }
    },
  })

  // 浏览器半侧取数的通道。
  //
  // 浏览器半侧是独立加载的 bundle，拿不到这个模块里的 service，也读不了文件系统，
  // 所以「本机现在有什么」只能由宿主经 HTTP 路由送出去。用 ctx.inject 而不是
  // 直接读 ctx.connection：connection 只存在于 Web 平台，而命令行下这个插件
  // 依然要能工作（第一阶段的 roam export 就不需要它）。缺了它只是没有界面，
  // 不该让整个插件不启动。
  //
  // 每条路由都经 ctx.effect 注册，卸载插件时随之注销——这也是它比在模块级
  // 挂一个全局 HTTP 服务正确的地方：一个进程可能加载多份 profile。
  ctx.inject(['connection'], (scope) => {
    for (const route of describeRoutes({ service, buildPushOverview, buildPullOverview, buildImportOverview })) {
      scope.effect(
        () => scope.connection.fetch.register(route),
        `dsh-settings-roam: route ${route.path}`,
      )
    }
  })

  ctx.logger?.info?.(
    '设置漫游已就绪，数据根目录：%s%s',
    dshRoot,
    service.isConfigured() ? '' : '（尚未配置云端仓库）',
  )
}
