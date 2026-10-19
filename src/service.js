/**
 * 同步服务：把读路径、数据模型、写路径、介质层接成推送与拉取两个动作。
 *
 * 本模块的核心设计约束来自设计 §3.2 第 6、7 步：
 * 「展示差异 → 用户确认 → commit + push」是**有意的人工确认**，
 * 因为推送是对外可见的写操作。
 *
 * 所以两个方向都拆成 prepare / confirm 两段：
 *   - preparePush / preparePull：只读，算出要写什么与差异，绝不落盘、绝不改本机文件
 *   - confirmPush / applyPull：真正执行写入
 *
 * 只要 prepare 阶段有任何写副作用，「确认」这个动作就名存实亡了。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parsePatchList, renderPatches, splitByTopLevelId } from './yaml-loader.js'
import { profilePatchPath, profileDir, listProfiles } from './home-paths.js'
import { buildSnapshot, serializeSnapshot, parseSnapshot, hashSnapshotContent } from './snapshot.js'
import { diffSnapshots, summarizeDiff } from './diff.js'
import { applyPatchFile, verifyWriteBack } from './apply.js'
import { scanSkills, listSkillNames, crossCheckSkills, applySkillFiles } from './skills.js'
import { collectBundles } from './bundles.js'
import { MACHINE_PATCH_IDS } from './ownership.js'
import {
  checkPatchEntries,
  checkPlugins,
  checkEnvRefs,
  checkSkills,
  summarizeCompat,
} from './compat.js'
import { exportForReview } from './export.js'
import { flattenConfig, applyEdits, diffConfig, buildEdits } from './edit.js'
import { timestamp } from './backup.js'
import { PACKAGE_NAME } from './constants.js'
import {
  UPDATE_REASONS,
  installedCommitFromLock,
  parseGitSpec,
  planUpdate,
  readRemoteHead,
  shortCommit,
  specWithCommit,
} from './update.js'
import { assertBackend } from './backends/index.js'
import {
  resolvePackageDir,
  readPackage,
  validatePackage,
  planImport,
  skillTargetPath,
  isEmptyPlan,
  PACKAGE_PATHS,
} from './import.js'

/** 云端布局，见设计 §5.1。 */
export const CLOUD_PATHS = Object.freeze({
  snapshot: 'snapshot.json',
  patch: 'config/profile.patch.yml',
  bundles: 'config/bundles.json',
  notes: 'notes.md',
})

/**
 * 本插件自己的版本号（自身 package.json 的 version）。
 *
 * 为什么提交号之外还要有它：提交号能唯一确定「装的是哪一次提交」，
 * 但人眼比较两个构建时，需要的是能排序的名字（0.2.0 与 0.1.0）。
 * 只补提交号会让人只能逐位比对一串十六进制。
 *
 * 读失败就返回 null：版本号只是给人看的辅助信息，
 * 不该因为它读不到就让整条自更新状态失败。
 */
const OWN_VERSION = (() => {
  try {
    const doc = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const version = doc?.version
    return typeof version === 'string' && version.trim() !== '' ? version.trim() : null
  } catch {
    return null
  }
})()

function hashOf(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function safeSnapshotPath(path) {
  return typeof path === 'string'
    && path !== ''
    && !path.startsWith('/')
    && !path.includes('\\')
    && !path.split('/').some(part => part === '' || part === '.' || part === '..')
    && (/^config\/(profile\.patch\.yml|bundles\.json)$/.test(path)
      || path === 'notes.md'
      || path.startsWith(PACKAGE_PATHS.skillsPrefix))
}

async function readVerifiedSnapshot(backend) {
  const text = await backend.readFile(CLOUD_PATHS.snapshot)
  if (text === null) return { text: null, snapshot: null, files: new Map() }
  const snapshot = parseSnapshot(text)
  const files = new Map()
  const seen = new Set()
  for (const entry of snapshot.entries) {
    if (!safeSnapshotPath(entry?.path) || seen.has(entry.path)) {
      throw new Error('云端快照包含无效或重复的文件路径，已停止同步。')
    }
    seen.add(entry.path)
    const content = await backend.readFile(entry.path)
    if (content === null) throw new Error(`云端文件缺失，已停止同步：${entry.path}`)
    if (typeof entry.hash !== 'string' || hashSnapshotContent(content) !== entry.hash) {
      throw new Error(`云端文件校验不一致，已停止同步：${entry.path}。请检查云端副本后再试。`)
    }
    files.set(entry.path, content)
  }
  return { text, snapshot, files }
}

function patchFieldTransfers(localRows, remoteRows, direction) {
  const local = new Map((localRows ?? []).map(row => [row.id, row]))
  const remote = new Map((remoteRows ?? []).map(row => [row.id, row]))
  const destination = direction === 'pull' ? remote : local
  const source = direction === 'pull' ? local : remote
  const items = []
  for (const [id, next] of destination) {
    const previous = source.get(id)
    const before = new Map(flattenConfig(previous?.config ?? {}).map(field => [field.path, field.value]))
    const after = new Map(flattenConfig(next?.config ?? {}).map(field => [field.path, field.value]))
    const paths = new Set([...before.keys(), ...after.keys()])
    for (const path of paths) {
      const had = before.has(path)
      const has = after.has(path)
      if (had === has && JSON.stringify(before.get(path)) === JSON.stringify(after.get(path))) continue
      items.push({
        path: `patch:${id}.config.${path}`,
        action: !has ? 'remove' : !had ? 'add' : 'modify',
      })
    }
  }
  return items
}

/** 推送时用本机勾选项替换云端同 ID 配置，同时保留未勾选及本机缺少的云端项。 */
function mergeSelectedPatchRows(localRows, remoteRows, selectedIds) {
  const localById = new Map(localRows.map(row => [row.id, row]))
  const seen = new Set()
  const merged = []
  for (const remote of remoteRows) {
    if (selectedIds.has(remote.id) && localById.has(remote.id)) {
      merged.push(localById.get(remote.id))
      seen.add(remote.id)
    } else {
      merged.push(remote)
      if (localById.has(remote.id)) seen.add(remote.id)
    }
  }
  for (const local of localRows) {
    if (!seen.has(local.id)) merged.push(local)
  }
  return merged
}

/**
 * 从 patch 文本里收集 provider 的 apiKeyEnv 引用名。
 *
 * 引用名不是密钥（设计 §6.2），但新机器上若没配这个环境变量，
 * 一发消息就会认证失败。报告提前把它列出来，用户就不必猜。
 *
 * @param {object[]} rows
 * @returns {string[]}
 */
export function collectApiKeyRefs(rows) {
  const refs = []
  for (const row of rows) {
    const providers = row?.config?.providers
    if (providers === undefined || typeof providers !== 'object') continue
    for (const def of Object.values(providers)) {
      const ref = def?.apiKeyEnv
      if (typeof ref === 'string' && ref !== '' && !refs.includes(ref)) refs.push(ref)
    }
  }
  return refs.sort()
}

/**
 * 收集公共线上的模型供应商名。
 *
 * 「这台机器配了几家供应商、都是谁」是用户在把配置推出去之前第一件想确认的事
 * （用户原话：想看到概述，比如配置了几个模型供应商）。
 *
 * 只数公共条目：本机专属条目里的 provider 不会进云端，把它们算进来会让
 * 概述与实际带走的内容对不上——概述失真比没有概述更糟。
 *
 * @param {object[]} rows
 * @returns {string[]}
 */
export function collectProviderNames(rows) {
  const names = []
  for (const row of rows) {
    const providers = row?.config?.providers
    if (providers === undefined || providers === null || typeof providers !== 'object') continue
    for (const name of Object.keys(providers)) {
      if (!names.includes(name)) names.push(name)
    }
  }
  return names.sort()
}

/**
 * 建一个同步服务。
 *
 * backend 可以是实例，也可以是一个返回实例的函数（或 undefined）。
 *
 * 为什么允许后两者——真装载验收暴露的设计错误：
 * 最初这里无条件 assertBackend(backend)，要求装配时就有一个完整后端。
 * 但后端的仓库地址与工作目录只能由用户在界面上填，YAML 配置里传不进对象实例，
 * 于是插件每次启动都在 apply 阶段崩溃，整个条目不激活（Loader 报
 * 「1 entry did not activate」）。插件应当能装着但待配置，而不是装不上。
 *
 * 因此：装配阶段只记录「怎么拿到后端」，真正要用时才解析；
 * 未配置时由调用方拿到明确的「还没配置」错误，而不是一个空指针。
 *
 * @param {{backend?: object|(() => object), dshRoot: string, skillsRoot?: string}} config
 */
export function createSyncService(config) {
  const { dshRoot } = config
  const skillsRoot = config.skillsRoot ?? join(dshRoot, 'skills')

  /**
   * 要同步哪个 profile 的配置。
   *
   * 原先这里假设配置在数据根目录下（join(dshRoot, 'cordis.patch.yml')），
   * 但 DSH 的真实布局是 <dshRoot>/profiles/<名>/cordis.patch.yml
   * （packages/boot/app-boot/src/profile.ts:276 与 :452）。
   * 该假设让工具在真实数据上读到 0 个条目，而单元测试因 fixture 同构而全绿。
   *
   * profile 名的确定顺序：
   *   1. 显式传入 config.profileName（界面/命令行可指定）
   *   2. 只有一个 profile 时自动选它（绝大多数用户只有 web 一个）
   *   3. 多于一个且未指定时明确报错而不是猜——猜错会写坏另一个 profile
   */
  /**
   * 读一个用户可改的选项。**必须在调用时读，不能在装配时读一次存起来。**
   *
   * 真装载里试出来的：DSH 改配置是**原地更新运行中的 config 对象**
   * （config-editor 在写盘前就调 resolveConfig(fiber.runtime, resolved)），
   * 插件不会被重新 apply。所以装配时捕获的常量永远停在旧值上——
   * 表现为「设置页填了、显示已保存、重启才对」，而界面上一点报错都没有。
   *
   * 顺带兼容两种来源：配置文件里是 Volatile 引用（要 .get()），
   * 命令行传进来的是普通字符串。
   */
  const liveOptions = config.options ?? config
  const readOption = (key) => {
    const field = liveOptions?.[key]
    const value = typeof field?.get === 'function' ? field.get() : field
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }
  const explicitProfile = () => readOption('profileName')
  const configuredExportRoot = () => readOption('exportRoot')
  const configuredImportRoot = () => readOption('importRoot')

  /** 配置项名单是显式允许列表；无效配置按空名单处理，避免意外扩大同步范围。 */
  function selectedPluginIds(optionName) {
    const raw = readOption(optionName)
    if (raw === null) return new Set(['llm-pi-ai'])
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return new Set()
      return new Set(parsed.filter(id => typeof id === 'string' && id.trim() !== ''))
    } catch {
      return new Set()
    }
  }

  /** 机器专属项和插入指令永不进入插件选择同步。 */
  function selectablePluginRows(rows) {
    const machineIds = new Set(MACHINE_PATCH_IDS)
    return (rows ?? []).filter(row => typeof row?.id === 'string'
      && row.insert === undefined
      && !machineIds.has(row.id))
  }

  /**
   * 默认导入目录。
   *
   * 与 defaultExportRoot 是同一个位置，这是刻意的：导出的包默认落在
   * <dshRoot>/settings-roam/export/<时间戳>，而导入默认去那里找最新的一次。
   * 用户「在这台机器导出、换台机器导入」时不必先去想路径。
   */
  function defaultImportRoot() {
    return configuredImportRoot() ?? configuredExportRoot() ?? join(dshRoot, 'settings-roam', 'export')
  }

  /**
   * 看一眼导入目录里有没有可用的包。**绝不抛错。**
   *
   * 界面每次打开都要显示这一条，而「目录还没建」「用户还没导出过」
   * 是完全正常的状态。做成会抛错的函数，会让「打开设置页」这件事
   * 在正常环境下失败。
   *
   * @param {{packageDir?: string}} [input]
   * @returns {{dir: string, resolved: string|null, available: boolean, errors: string[],
   *   warnings: string[], generatedAt: string|null, generatedBy: string|null, fileCount: number}}
   */
  function describeImportSource(input = {}) {
    const dir = input.packageDir ?? defaultImportRoot()
    const empty = {
      dir,
      resolved: null,
      available: false,
      errors: [],
      warnings: [],
      generatedAt: null,
      generatedBy: null,
      fileCount: 0,
    }
    try {
      const resolved = resolvePackageDir(dir)
      const pkg = readPackage(resolved)
      const check = validatePackage(pkg)
      return {
        ...empty,
        resolved,
        available: check.ok,
        errors: check.errors,
        warnings: check.warnings,
        generatedAt: pkg.manifest?.generatedAt ?? null,
        generatedBy: pkg.manifest?.generatedBy ?? null,
        fileCount: Array.isArray(pkg.manifest?.files) ? pkg.manifest.files.length : 0,
      }
    } catch (error) {
      return { ...empty, errors: [String(error?.message ?? error)] }
    }
  }

  /** 解析出本次操作的目标 profile 名。 */
  function resolveProfileName() {
    const explicit = explicitProfile()
    if (explicit !== null) return explicit
    const names = listProfiles(dshRoot, { readdirSync, existsSync })
    if (names.length === 1) return names[0]
    if (names.length === 0) {
      throw new Error(
        `没有在 ${join(dshRoot, 'profiles')} 下找到任何 profile。请先从 DSH 启动一次，或显式指定 profile 名。`,
      )
    }
    throw new Error(
      `发现多个 profile（${names.join('、')}），无法确定同步哪一个。请显式指定 profile 名。`,
    )
  }

  /**
   * 校验通道用的技能服务（ctx.skills）。没传就跳过校验。
   *
   * 为什么要它：直读文件是主通道，但它只能看见「文件在不在」，
   * 看不见「这个技能是不是来自非本机的 provider」。少了这条校验，
   * 读路径就退化成单通道，最坏情况是静默同步错内容而不是报警。
   */
  const skillService = config.skillService ?? null

  /**
   * 插件名单来源。传函数而不是实例：该服务可能比本插件晚就绪。
   * 取不到时返回 null，由调用方决定退化成什么行为。
   */
  const pluginManagerSource = config.pluginManager ?? null

  /**
   * 按当前设置取得后端实例。设置页会原地更新 config，不能缓存实例，
   * 否则切换 Git / WebDAV 后仍会继续访问首次创建的后端。
   * @returns {object}
   */
  function requireBackend() {
    const source = config.backend
    const backend = typeof source === 'function' ? source() : source ?? null
    if (backend === null) {
      throw new Error('还没配置云端仓库。先在插件设置里填上仓库地址。')
    }
    assertBackend(backend)
    return backend
  }

  /**
   * 尝试取后端；取不到或装配失败时返回 null，不抛错。
   *
   * 用于「有云端更好、没有也能做」的路径（例如导出到本地文件）。
   * 与 requireBackend 的分工：需要真正推送/拉取时必须用 requireBackend，
   * 让缺失配置立刻变成可见的错误；只是准备内容时用这个，允许降级。
   * @returns {object|null}
   */
  function tryBackend() {
    try {
      return requireBackend()
    } catch {
      return null
    }
  }

  /**
   * 是否已具备同步条件。界面用它决定显示「拉取」还是「去配置」。
   * @returns {boolean}
   */
  function isConfigured() {
    try {
      requireBackend()
      return true
    } catch {
      return false
    }
  }

  /**
   * 目标 patch 文件的绝对路径（惰性解析并缓存）。
   *
   * 之所以做成函数而不是常量：profile 名可能要到运行时才能确定
   * （自动探测唯一的 profile），解析失败时要抛出可据以行动的说明，
   * 而不是在 createSyncService 时就让装配失败。
   */
  let patchFileCache = null
  function patchFile() {
    if (patchFileCache === null) {
      patchFileCache = profilePatchPath(dshRoot, resolveProfileName())
    }
    return patchFileCache
  }

  /** 读本机 patch 条目。文件不存在时视为空。 */
  function readLocalRows() {
    if (!existsSync(patchFile())) return []
    const text = readFileSync(patchFile(), 'utf8')
    return text.trim() === '' ? [] : parsePatchList(text)
  }

  /**
   * 收集技能文件内容：{ 'skills/<名>/<相对路径>': {content, executable} }。
   *
   * 带上 executable 是刻意的：技能里的脚本靠可执行位工作，
   * 导入侧只拿到内容就重建不出这个位，脚本会在目标机器上静默失效（设计 §4.7）。
   */
  function collectSkillFiles() {
    const out = {}
    for (const name of listSkillNames(skillsRoot)) {
      for (const record of scanSkills(skillsRoot, [name])) {
        const abs = join(skillsRoot, record.relPath)
        out[`skills/${record.relPath}`] = {
          content: readFileSync(abs),
          executable: record.executable,
        }
      }
    }
    return out
  }

  /**
   * 采集本机插件名单。
   *
   * 设计决策 8：只记名字。名单是动态的（本机就有先后关闭的可选包），
   * 所以每次都重新读，不当固定快照。
   *
   * 取不到 pluginManager 时返回 null 而不是空名单——空名单会被
   * 当成「这台机器一个插件都没装」，写进云端后覆盖掉真实名单。
   * 两个「没有」必须区分：没有名单 vs 名单是空的。
   *
   * @returns {Promise<{official: string[], thirdParty: string[]}|null>}
   */
  async function collectPluginNames() {
    if (pluginManagerSource === null) return null
    const manager = typeof pluginManagerSource === 'function'
      ? pluginManagerSource()
      : pluginManagerSource
    if (manager === null || manager === undefined) return null

    try {
      const { official, thirdParty } = await collectBundles(manager)
      return { official, thirdParty }
    } catch {
      // 采集失败也只是少一份名单，不该让推送整体失败。
      return null
    }
  }

    /**
   * 可编辑的公共条目有哪些。
   *
   * 只列公共线上的、且本机真的存在的那几条：编辑本机项没有意义
   * （它们本来就不参与同步），编辑一条本机没有的条目则是「新增」，
   * 那是另一件事，不该混在这个入口里。
   *
   * @returns {{id: string, name?: string, fields: object[]}[]}
   */
  /**
   * 自更新相关的读取。
   *
   * 三个事实分开取，谁也不替谁兜底：
   *   - 装的是哪一版：profile 的依赖清单里那条 spec（多半没带提交号）
   *   - 实际拉下来的是哪个提交：只在 pnpm 锁文件的解析结果里
   *   - 远端最新是哪个提交：要联网问
   * 任何一项读不出来就如实返回 null，由 planUpdate 说明「读不出来」，
   * 而不是拿另一项凑一个看起来像答案的东西。
   */
  function updateContext() {
    const dir = profileDir(dshRoot, resolveProfileName())
    const manifestPath = join(dir, 'package.json')
    const lockPath = join(dir, 'pnpm-lock.yaml')

    let installedSpec = null
    if (existsSync(manifestPath)) {
      try {
        const doc = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const spec = doc?.dependencies?.[PACKAGE_NAME]
        if (typeof spec === 'string' && spec.trim() !== '') installedSpec = spec.trim()
      } catch {
        installedSpec = null
      }
    }

    let installedCommit = null
    if (existsSync(lockPath)) {
      try {
        installedCommit = installedCommitFromLock(readFileSync(lockPath, 'utf8'), PACKAGE_NAME)
      } catch {
        installedCommit = null
      }
    }

    return { dir, installedSpec, installedCommit }
  }

  /** 拿到插件管理服务；没注入或还没就绪时返回 null。 */
  function resolvePluginManager() {
    if (pluginManagerSource === null) return null
    const manager = typeof pluginManagerSource === 'function'
      ? pluginManagerSource()
      : pluginManagerSource
    return manager ?? null
  }

  /**
   * 看一眼「装的是哪一版、最新是哪一版」。**绝不抛错**，界面每次打开都要调。
   *
   * 为什么不只在点「检查更新」时才调：用户要先看见当前版本，
   * 才知道该不该点那个按钮；而这条信息里只有一半要联网。
   *
   * @param {{remoteCommit?: string|null, gitOptions?: object, reason?: string}} [input]
   * @returns {Promise<object>}
   */
  async function describeUpdate(input = {}) {
    const empty = {
      installedSpec: null,
      installedCommit: null,
      // 本插件自己的版本号：不管装成了哪种形态都读得出来，所以每一支都带上它。
      pluginVersion: OWN_VERSION,
      remoteCommit: null,
      repoUrl: null,
      needsUpdate: false,
      canInstall: false,
      reason: 'unreachable',
      error: null,
    }

    let context = null
    try {
      context = updateContext()
    } catch (error) {
      // 多 profile 又没指定时这里会失败——那是可展示的状态，不是崩溃
      return { ...empty, error: String(error?.message ?? error) }
    }

    const { installedSpec, installedCommit } = context
    // 一条依赖都没有 vs 有一条但不是 git 形态：两者的下一步动作完全不同，
    // 前者要用户先去把插件装上，后者是「开发时的本地链接」或「装的版本号」。
    if (typeof installedSpec !== 'string' || installedSpec.trim() === '') {
      return { ...empty, installedSpec: installedSpec ?? null, installedCommit, reason: 'no-spec' }
    }
    const parsed = parseGitSpec(installedSpec)
    if (parsed === null) {
      return { ...empty, installedSpec, installedCommit, reason: 'not-git' }
    }

    try {
      // remoteCommit 显式传 null 表示「这一趟不联网」。设置页每次打开都会问一次状态，
      // 不该因为看一眼界面就跑 `git ls-remote`。这时原因标成 unchecked，
      // 而不是 unreachable——「没问」与「问了问不到」在界面上必须能分开说。
      const asked = input.remoteCommit === undefined
      const remoteCommit = asked
        ? await readRemoteHead(parsed.repoUrl, input.gitOptions)
        : input.remoteCommit
      const plan = planUpdate({ spec: installedSpec, installedCommit, remoteCommit })
      const reason = !asked && remoteCommit === null ? 'unchecked' : plan.reason
      const manager = resolvePluginManager()
      return {
        ...plan,
        reason,
        // planUpdate 把它叫 spec；对外统一叫 installedSpec，
        // 免得调用方要在两个名字之间猜哪个是「装的那一条」。
        installedSpec: plan.spec,
        pluginVersion: OWN_VERSION,
        canInstall: typeof manager?.installBundle === 'function',
        error: null,
      }
    } catch (error) {
      return {
        ...empty,
        installedSpec,
        installedCommit,
        repoUrl: parsed.repoUrl,
        error: String(error?.message ?? error),
      }
    }
  }

  /**
   * 算出「更新到最新」要做的那一件事。**只读。**
   *
   * 结果是「把依赖换成带具体提交号的写法」，而不是「重新装一遍同一个来源」——
   * 后者会被 DSH 的安装入口拒掉（依赖没变化时它无法判定装了哪一个包）。
   *
   * @param {{remoteCommit?: string|null, gitOptions?: object}} [input]
   * @returns {Promise<object>}
   */
  async function prepareUpdate(input = {}) {
    const status = await describeUpdate(input)

    if (status.error !== null) {
      const error = new Error(status.error)
      error.code = 'update-unknown'
      throw error
    }
    if (status.reason === 'no-spec') {
      const error = new Error(
        '这个 profile 的依赖清单里没有本插件，认不出它当初是怎么装进来的。'
        + '先按插件页给的地址装一次，之后就能在这里更新了。',
      )
      error.code = 'update-no-spec'
      throw error
    }
    if (status.reason === 'not-git') {
      const error = new Error(
        '这一份不是从 Git 仓库装的，没有「最新版本」可以比。本地链接安装用于开发，改完代码重启即可。',
      )
      error.code = 'update-not-git'
      throw error
    }
    // 'unchecked' 是「这一趟没问」（状态接口用的措辞）。放到「我要更新」这个
    // 语境里，它就是「手上没有远端提交可比」——和问不到是一回事，结果都是不能更新。
    if (status.reason === 'unchecked' || status.reason === 'unreachable') {
      const error = new Error(
        '问不到远端仓库的最新提交。检查网络，或确认这个仓库还在、当前身份能读它。',
      )
      error.code = 'update-unreachable'
      throw error
    }

    return {
      ...status,
      // 带上要写进去的那条 spec，用户能看到依赖会被改成什么
      nextSpec: specWithCommit(status.installedSpec, status.remoteCommit),
      // 认不出来时给 null 而不是空串：界面要按「有没有」分支说话，
      // 空串会渲染成「有新版本： → ca727d9」这样一句半截话。
      from: shortCommit(status.installedCommit) || null,
      to: shortCommit(status.remoteCommit) || null,
      noop: !status.needsUpdate,
    }
  }

  /**
   * 真正执行更新：让插件管理服务把依赖换成新的提交并重新安装。
   *
   * 改完必须重启才生效——运行中的这一份代码在内存里，
   * 磁盘上的文件换了不会让它跟着变。
   *
   * @param {object} plan prepareUpdate 的结果
   * @returns {Promise<{updated: boolean, reason?: string, nextSpec?: string, to?: string}>}
   */
  async function applyUpdate(plan) {
    if (!plan?.needsUpdate) return { updated: false, reason: plan?.reason ?? 'up-to-date' }

    const manager = resolvePluginManager()
    if (typeof manager?.installBundle !== 'function') {
      const spec = plan.nextSpec ?? ''
      const error = new Error(
        `这个环境里没拿到插件管理服务，无法自动更新。可以手动把依赖改成 ${spec}，再让 DSH 重新安装。`,
      )
      error.code = 'update-unavailable'
      error.nextSpec = spec
      throw error
    }

    try {
      await manager.installBundle(plan.nextSpec)
    } catch (error) {
      const wrapped = new Error(`更新没成功：${String(error?.message ?? error)}`)
      wrapped.code = 'update-failed'
      wrapped.nextSpec = plan.nextSpec
      throw wrapped
    }

    return { updated: true, nextSpec: plan.nextSpec, to: shortCommit(plan.remoteCommit) }
  }

  function listEditableEntries() {
    const rows = readLocalRows()
    const split = splitByTopLevelId(rows)
    return split.shared.map(row => ({
      id: row.id,
      name: row.name,
      fields: flattenConfig(row.config ?? {}),
    }))
  }

  /**
   * 恢复前的兼容性检查。
   *
   * 为什么单独抽成一层：拉取与导入都要用，而且两者的判断口径必须一致——
   * 「同一个包，从云端拉和从本地包导入，结论不一样」会让用户没法信任这个检查。
   *
   * @param {{remoteRows?: object[], remoteSkillFiles?: object[],
   *   bundleNames?: object|null, installed?: object|null}} input
   * @returns {Promise<object>} summarizeCompat 的结果
   */
  async function runCompat(input = {}) {
    const rows = input.remoteRows ?? []
    const skillFiles = input.remoteSkillFiles ?? []
    const localRows = readLocalRows()

    // input.bundleNames 是「要写回的名单」（云端或导入包里的），
    // installed 是「本机现在装了什么」。两者不能混。
    // undefined 表示「去问本机」，null 表示「问不到，别猜」——
    // 把「问不到」当成「本机一个插件都没有」会误报一片缺失。
    const installed = input.installed !== undefined
      ? input.installed
      : await collectPluginNames()

    const items = [
      ...checkPatchEntries(rows, localRows),
      ...checkPlugins(input.bundleNames ?? null, installed),
      ...checkEnvRefs(collectApiKeyRefs(rows), process.env),
      ...checkSkills(skillFiles, path => existsSync(skillTargetPath(skillsRoot, path))),
    ]
    return summarizeCompat(items)
  }

  /**
   * 直读结果与服务视图交叉校验。
   *
   * 不一致本身不是故障：它说明有技能来自非本机的 provider 来源。
   * 但这件事必须让用户看见——推送时会把直读到的东西带走，
   * 若服务视图里有而直读里没有，那部分不会被同步，用户有权先知道。
   *
   * @returns {Promise<{checked: boolean, consistent: boolean, complete: boolean, onlyDirect: string[], onlyService: string[]}>}
   */
async function crossCheck() {
    const directNames = listSkillNames(skillsRoot)
    if (skillService === null) {
      // 没接校验通道时如实说明「没验」，不假装验过了。
      return { checked: false, consistent: true, complete: false, onlyDirect: [], onlyService: [] }
    }

    let result
    try {
      result = await crossCheckSkills(skillService, directNames)
    } catch (error) {
      // 校验通道自身坏了，不该拖垮推送，但必须留下痕迹。
      return {
        checked: false,
        consistent: true,
        complete: false,
        onlyDirect: [],
        onlyService: [],
        error: String(error?.message ?? error),
      }
    }

    const serviceSet = new Set(result.serviceNames)
    const directSet = new Set(directNames)
    return {
      checked: true,
      consistent: result.consistent,
      complete: result.complete,
      onlyDirect: directNames.filter(n => !serviceSet.has(n)).sort(),
      onlyService: result.serviceNames.filter(n => !directSet.has(n)).sort(),
    }
  }
  return {
    /**
     * 检查一次本机配置：取到什么、什么留在本机、技能有哪些。
     *
     * **只读**，不碰云端、不写任何地方。第一阶段的目标就是「能取到需要的配置」，
     * 所以这个动作必须在没有网络、没有配置云端仓库时也能用——
     * 它是用户第一次接触这个插件时能看到的真实结果。
     *
     * @returns {Promise<object>}
     */
    async prepareInspect() {
      const patchExists = existsSync(patchFile())
      const localConfigModifiedAt = patchExists ? statSync(patchFile()).mtime.toISOString() : null
      const rows = readLocalRows()
      const { shared, machine, excluded } = splitByTopLevelId(rows)
      const skills = scanSkills(skillsRoot)
      // 校验通道是尽力而为：服务不可用时只影响「能不能交叉核对」，
      // 不影响直读结果本身——直读才是主通道。
      let skillCheck = null
      try {
        skillCheck = await crossCheck()
      } catch {
        skillCheck = null
      }

      // 概述所需的三个数，各说一件事：配了几家供应商、装了几个技能、
      // 装了几个插件。它们都不是「同步内容」本身，而是用户判断
      // 「这是不是我要备份的那份」时的凭据。
      const providerNames = collectProviderNames(shared)
      // 技能按目录名去重：skills 是文件级记录，一个技能可能横跨好几个文件，
      // 直接数记录会把「一个技能」报成「五个」。
      const skillNames = [...new Set(
        skills.map(record => String(record?.relPath ?? '').split('/')[0]).filter(Boolean),
      )].sort()
      // 插件名单取不到时是 null，不是空数组——两个「没有」必须区分
      // （collectPluginNames 的说明里写了为什么）。
      const bundles = await collectPluginNames()

      return {
        patchFile: patchFile(),
        patchExists,
        localConfigModifiedAt,
        total: rows.length,
        shared,
        machine,
        // 既不共享也不属于本机的项不计入同步，但要让用户看见它们被排除了，
        // 否则「我配的东西怎么没过去」会变成一个无从查证的问题。
        excludedIds: excluded.map(row => row.id).filter(Boolean),
        syncablePatchIds: selectablePluginRows(rows).map(row => row.id).sort(),
        skills,
        skillCheck,
        providers: { count: providerNames.length, names: providerNames },
        skillNames,
        bundles,
      }
    },

    /** 上传列表来自本机；下载列表同时包含云端条目，便于新机器选择尚未配置的插件。 */
    async pluginSelectionOptions() {
      const localIds = selectablePluginRows(readLocalRows()).map(row => row.id)
      let remoteIds = []
      const backend = tryBackend()
      if (backend !== null) {
        await backend.ensureReady()
        await backend.pull()
        const verified = await readVerifiedSnapshot(backend)
        const patchText = verified.files.get(CLOUD_PATHS.patch) ?? null
        if (patchText !== null) {
          remoteIds = selectablePluginRows(parsePatchList(patchText)).map(row => row.id)
        }
      }
      return {
        uploadPluginIds: [...new Set(localIds)].sort(),
        downloadPluginIds: [...new Set([...localIds, ...remoteIds])].sort(),
      }
    },

    /**
     * 只读地比较本机可移植配置与云端快照。
     * 返回的本地时间是 cordis.patch.yml 的 mtime（文件级时间，不代表每个字段的独立修改时间）。
     *
     * 另外回两个「说清对比对象」的字段，都是实测逼出来的：
     *   - remoteDescription：比的是哪个仓库的哪条分支。分支配错时，
     *     用户看到的会是「云端什么都没有」，而不是「我刚才改的那条分支」。
     *   - remoteSnapshotExists：云端这条分支上到底有没有快照。
     *     没有时不能把「全部分本机内容」当成真正的差异来呈现。
     */
    async compareWithRemote() {
      const backend = requireBackend()
      await backend.ensureReady()
      await backend.pull()
      const rows = readLocalRows()
      const localConfigModifiedAt = existsSync(patchFile())
        ? statSync(patchFile()).mtime.toISOString()
        : null
      const uploadIds = selectedPluginIds('uploadPluginIds')
      const patch = selectablePluginRows(rows).filter(row => uploadIds.has(row.id))
      const files = [
        { path: CLOUD_PATHS.patch, content: renderPatches(patch, 'settings-roam') },
        ...Object.entries(collectSkillFiles()).map(([path, entry]) => ({
          path,
          content: entry.content,
          executable: entry.executable,
        })),
      ]
      const verified = await readVerifiedSnapshot(backend)
      const remotePatchText = verified.files.get(CLOUD_PATHS.patch) ?? null
      const remotePatchRows = remotePatchText === null ? [] : parsePatchList(remotePatchText)
      files[0].content = renderPatches(
        mergeSelectedPatchRows(patch, selectablePluginRows(remotePatchRows), uploadIds),
        'settings-roam',
      )
      const localSnapshot = buildSnapshot({
        generatedBy: 'settings-roam-compare',
        generatedAt: new Date().toISOString(),
        files,
      })
      const remoteSnapshot = verified.snapshot ?? { entries: [], generatedAt: null }
      const diff = diffSnapshots(remoteSnapshot, localSnapshot)
      return {
        diff,
        summary: summarizeDiff(diff),
        comparedWithRemote: true,
        localConfigModifiedAt,
        remoteUploadedAt: typeof backend.lastUploadAt === 'function'
          ? await backend.lastUploadAt()
          : null,
        remoteSnapshotGeneratedAt: remoteSnapshot.generatedAt ?? null,
        remoteSnapshotExists: verified.text !== null,
        remoteDescription: typeof backend.describe === 'function' ? backend.describe() : null,
      }
    },

    /**
     * 推送准备：组装要写入云端的文件与差异。**只读，不写任何地方。**
     * @param {{generatedBy: string, bundles?: object, now?: Date}} input
     * @returns {Promise<{files: {path: string, content: string}[], diff: object[], summary: object}>}
     */
    async preparePush(input = {}) {
      // 云端仓库是可选的：本阶段的「导出到本地文件」不需要它。
      // 原先这里无条件 requireBackend()，导致未配置仓库时连导出都做不了——
      // 而「不联网也能把配置取出来」正是第一阶段的目标。
      const backend = tryBackend()
      const rows = readLocalRows()
      const uploadIds = selectedPluginIds('uploadPluginIds')
      const patch = selectablePluginRows(rows).filter(row => uploadIds.has(row.id))

      const patchContent = renderPatches(patch, 'settings-roam')
      const files = [
        { path: CLOUD_PATHS.patch, content: patchContent },
        ...Object.entries(collectSkillFiles()).map(([path, entry]) => ({
          path,
          content: entry.content,
          executable: entry.executable,
        })),
      ]

      // 双通道校验：直读是主通道，服务视图是校验通道。只读，不影响写入。
      const skillCheck = await crossCheck()

      // 插件名单：调用方显式传入优先；否则自己从 pluginManager 采集。
      // 两者都拿不到时不写这个文件——空名单会覆盖掉云端真实名单。
      const bundles = input.bundles !== undefined
        ? input.bundles
        : await collectPluginNames()
      if (bundles !== null && bundles !== undefined) {
        files.push({
          path: CLOUD_PATHS.bundles,
          content: JSON.stringify(bundles, null, 2) + '\n',
        })
      }

      // 与云端现状比对，供界面展示。
      // 未配置云端（backend 为 null）时跳过：导出到本地文件不需要比对，
      // 此时把所有内容视为「新增」，并在结果里标明未与云端比对，
      // 避免界面上出现一个看起来像「全部都要新增」的误导性差异。
      let remoteEntries = []
      let remoteFiles = new Map()
      let remoteRevision = null
      let comparedWithRemote = false
      if (backend !== null) {
        await backend.ensureReady()
        await backend.pull()
        const verified = await readVerifiedSnapshot(backend)
        remoteEntries = verified.snapshot?.entries ?? []
        remoteFiles = verified.files
        remoteRevision = verified.text === null ? null : hashOf(verified.text)
        comparedWithRemote = true
        const remotePatchText = remoteFiles.get(CLOUD_PATHS.patch) ?? null
        const remotePatchRows = remotePatchText === null ? [] : parsePatchList(remotePatchText)
        files[0].content = renderPatches(
          mergeSelectedPatchRows(patch, selectablePluginRows(remotePatchRows), uploadIds),
          'settings-roam',
        )
      }

      const localSnapshot = buildSnapshot({
        generatedBy: input.generatedBy ?? 'unknown',
        generatedAt: (input.now ?? new Date()).toISOString(),
        files,
      })
      const diff = diffSnapshots({ entries: remoteEntries }, localSnapshot)
      const remotePatchText = remoteFiles.get(CLOUD_PATHS.patch) ?? null
      const remotePatchRows = remotePatchText === null ? [] : parsePatchList(remotePatchText)

      // 云端已有的其它文件（如 bundles.json、notes.md）不在本次推送范围，
      // 但它们仍在云端，摘要要保留，否则下次比对会误判为「本机没有」。
      const carriedOver = remoteEntries.filter(
        entry => !localSnapshot.entries.some(e => e.path === entry.path),
      )
      const snapshotFile = {
        path: CLOUD_PATHS.snapshot,
        content: serializeSnapshot({
          ...localSnapshot,
          entries: [...localSnapshot.entries, ...carriedOver],
        }),
      }

      // 导出到磁盘供核对：调用方指定 exportRoot 才导。
      // 这是「文件确实落出来」的落地——用户能直接打开看到带走了什么，
      // 而不是只能从界面上的数字去猜。
      let exported = null
      if (input.exportRoot !== undefined && input.exportRoot !== null) {
        try {
          exported = exportForReview({
            files,
            exportRoot: input.exportRoot,
            stamp: input.stamp ?? timestamp(input.now ?? new Date()),
            generatedAt: (input.now ?? new Date()).toISOString(),
            generatedBy: input.generatedBy ?? 'unknown',
            summary: summarizeDiff(diff),
          })
        } catch (error) {
          // 导出失败不该阻断推送：导出是给人看的副本，不是同步本身。
          exported = { error: String(error?.message ?? error) }
        }
      }

      return {
        files: [...files, snapshotFile],
        diff,
        transfers: files.map(file => ({
          path: file.path,
          changed: diff.some(item => item.path === file.path && item.action !== 'delete'),
          details: file.path === CLOUD_PATHS.patch
            ? patchFieldTransfers(patch, remotePatchRows, 'push')
            : [],
        })),
        remoteRevision,
        verifiedRemoteFileCount: remoteEntries.length,
        summary: summarizeDiff(diff),
        patchRows: patch,
        skillCheck,
        exported,
        // 是否与云端比对过。未配置仓库时为 false，
        // 此时 diff 只反映「本机有什么」，不代表「云端缺什么」。
        comparedWithRemote,
      }
    },

    /**
     * 执行推送：把 prepare 的结果写入云端。
     * 这一步之后内容对外可见，故须用户确认后再调用。
     * @param {object} plan - preparePush 的返回
     * @param {string} [message]
     */
    async confirmPush(plan, message = '设置漫游：推送') {
      const backend = requireBackend()
      await backend.ensureReady()
      await backend.pull()
      const latest = await readVerifiedSnapshot(backend)
      const latestRevision = latest.text === null ? null : hashOf(latest.text)
      if (plan?.remoteRevision !== undefined && latestRevision !== plan.remoteRevision) {
        throw new Error('预览后云端内容发生了变化，本次未推送。请重新预览并核对差异。')
      }
      for (const file of plan.files) {
        await backend.writeFile(file.path, file.content)
      }
      await backend.push(message)
      return { pushed: plan.files.map(f => f.path) }
    },


    /**
     * 拉取准备：算出云端与本机的差异。**只读，绝不改本机文件。**
     * @returns {Promise<{diff: object[], summary: object, remoteRows: object[]}>}
     */
    async preparePull() {
      const backend = requireBackend()
      await backend.ensureReady()
      await backend.pull()

      const verified = await readVerifiedSnapshot(backend)
      const snapshot = verified.snapshot
      const verifiedFiles = verified.files
      const patchText = verifiedFiles.get(CLOUD_PATHS.patch) ?? null
      const remoteRowsRaw = patchText === null ? [] : parsePatchList(patchText)
      const downloadIds = selectedPluginIds('downloadPluginIds')
      const remoteRows = selectablePluginRows(remoteRowsRaw).filter(row => downloadIds.has(row.id))

      const localRows = selectablePluginRows(readLocalRows()).filter(row => downloadIds.has(row.id))
      const localEntries = localRows.map(row => ({
        path: `patch:${row.id}`,
        kind: 'shared',
        hash: hashOf(JSON.stringify(row)),
      })).concat(Object.entries(collectSkillFiles()).map(([path, entry]) => ({
        path,
        kind: 'shared',
        hash: hashOf(entry.content),
      })))
      const remoteEntries = remoteRows.map(row => ({
        path: `patch:${row.id}`,
        kind: 'shared',
        hash: hashOf(JSON.stringify(row)),
      })).concat((snapshot?.entries ?? [])
        .filter(entry => typeof entry.path === 'string' && entry.path.startsWith(PACKAGE_PATHS.skillsPrefix))
        .map(entry => ({ path: entry.path, kind: 'shared', hash: entry.hash })))

      const diff = diffSnapshots({ entries: localEntries }, { entries: remoteEntries })

      // 云端有哪些技能文件？只有快照清单知道——后端刻意只有 readFile / writeFile
      // 五个动作，没有「列目录」，这样换 WebDAV 之类的介质时不必另加接口。
      // 原先这里只读了配置，于是「拉取」把供应商定义带回来了、技能却没带回来，
      // 而报告上一个字都没提，看起来像技能本来就不同步。
      const remoteSkillFiles = []
      if (snapshot !== null) {
        for (const entry of snapshot.entries) {
          const path = entry?.path
          if (typeof path !== 'string' || !path.startsWith(PACKAGE_PATHS.skillsPrefix)) continue
          const content = verifiedFiles.get(path)
          remoteSkillFiles.push({
            path,
            content,
            executable: entry.executable === true,
          })
        }
      }

      // 拉取侧同样走双通道：云端带来的技能会落到本机，落地前先看清本机
      // 服务视图里有什么。只读，不改任何地方。
      const skillCheck = await crossCheck()

      // 云端记着上次推送时的插件名单，拿它做恢复前检查：
      // 名单里有而本机没装的插件，配置会照常写回但要等插件装上才有用。
      const bundlesText = verifiedFiles.get(CLOUD_PATHS.bundles) ?? null
      let cloudBundles = null
      if (bundlesText !== null && bundlesText !== '') {
        try {
          cloudBundles = JSON.parse(bundlesText)
        } catch {
          cloudBundles = null
        }
      }

      const compat = await runCompat({
        remoteRows,
        remoteSkillFiles,
        bundleNames: cloudBundles,
      })
      const patchChanges = patchFieldTransfers(localRows, remoteRows, 'pull')

      return {
        diff,
        summary: summarizeDiff(diff),
        // 确认预览只列真正会从云端应用的项；本机独有项会保留，不会删除。
        transfers: [
          ...remoteRows.map(row => ({
            path: `patch:${row.id}`,
            action: diff.find(item => item.path === `patch:${row.id}`)?.action ?? 'same',
            changed: diff.some(item => item.path === `patch:${row.id}` && item.action !== 'delete'),
            details: patchChanges
              .filter(item => item.path.startsWith(`patch:${row.id}.`)),
          })),
          ...remoteSkillFiles.map(file => ({
            path: file.path,
            action: diff.find(item => item.path === file.path)?.action ?? 'same',
            changed: diff.some(item => item.path === file.path && item.action !== 'delete'),
            details: [],
          })),
        ],
        remoteRevision: verified.text === null ? null : hashOf(verified.text),
        verifiedRemoteFileCount: snapshot?.entries.length ?? 0,
        remoteRows,
        remotePatchText: patchText,
        remoteSkillFiles,
        skillCheck,
        compat,
      }
    },

    /**
     * 执行拉取：应用配置、出报告。
     *
     * 文件类配置走备份 → 合并 → 写入 → 回读校验（Task 9、10 已有的两条约束）。
     * @param {object} plan - preparePull 的返回
     * @param {{backupRoot: string}} options
     * @returns {Promise<object>} RestoreReport
     */
    async applyPull(plan, options) {
      if (plan?.remoteRevision !== undefined) {
        const backend = requireBackend()
        await backend.ensureReady()
        await backend.pull()
        const latest = await readVerifiedSnapshot(backend)
        const latestRevision = latest.text === null ? null : hashOf(latest.text)
        if (latestRevision !== plan.remoteRevision) {
          throw new Error('预览后云端内容发生了变化，本次未写入本机。请重新预览并核对差异。')
        }
      }
      // 兼容性检查里只要有一条 block 级别的问题，就停下来。
      //
      // 这类问题的共同特征是「写下去不报错，只是不生效、或者覆盖掉别的东西」——
      // 让用户先处理掉再写，比等他日后从「配置看着有、行为不对」倒查要省得多。
      // warn 级别的一律放行：提醒不该变成路障。
      if (plan?.compat?.blocked) {
        const blocking = plan.compat.items.filter(entry => entry.level === 'block')
        const error = new Error(blocking.map(entry => `${entry.name}：${entry.message}\n${entry.action}`).join('\n\n'))
        error.code = 'compat-blocked'
        error.items = blocking
        throw error
      }

      const applied = []
      const skipped = []
      // 报告要给用户「回退到这里」的路径，因此必须是真正装着副本的那一层目录，
      // 而不是它的父目录。空字符串表示本次没有备份（例如新机器首次拉取）。
      let backup = null

      if (plan.remoteRows.length > 0) {
        const result = applyPatchFile({
          targetFile: patchFile(),
          sharedRows: plan.remoteRows,
          backupRoot: options?.backupRoot,
        })
        backup = result.backup

        // 写后回读校验：C2 的落地。警告非空即视为失败，不静默放过。
        const check = verifyWriteBack(patchFile(), plan.remoteRows)
        if (result.ok && check.ok) {
          for (const id of result.applied) {
            applied.push({ kind: 'file', name: `patch:${id}`, result: 'ok' })
          }
        } else {
          for (const id of [...result.warnings, ...check.missing, ...check.mismatch]) {
            skipped.push({ kind: 'file', name: String(id), result: 'skipped', reason: 'unknown' })
          }
        }
      }

      // 技能文件：同样先备份再写。可执行位跟着内容一起落，否则技能里的脚本
      // 会在新机器上静默失效（设计 §4.7 第 1 条）。
      const skillFiles = plan.remoteSkillFiles ?? []
      if (skillFiles.length > 0) {
        const result = applySkillFiles({
          skillsRoot,
          files: skillFiles,
          targetPathOf: path => skillTargetPath(skillsRoot, path),
          backupRoot: options?.backupRoot,
          stamp: options?.stamp,
        })
        if (result.backup !== null && backup === null) backup = result.backup
        for (const path of result.written) {
          applied.push({ kind: 'file', name: path, result: 'ok' })
        }
        for (const item of result.failed) {
          skipped.push({
            kind: 'file',
            name: item.path,
            result: 'skipped',
            reason: 'unreadable',
            detail: item.reason,
          })
        }
      }

      return {
        applied,
        skipped,
        needsRestart: applied.length > 0,
        needsCredentials: collectApiKeyRefs(plan.remoteRows),
        backupPath: backup?.backupPath ?? '',
        backupFiles: backup?.backedUp ?? [],
      }
    },

    /**
     * 导入准备：读一份本程序导出的包，校验它，算出「将要写什么」。
     *
     * **只读，一个字节都不写。** 与 preparePush / preparePull 同一纪律：
     * 用户要先看到会改什么，再决定要不要写。
     *
     * 为什么导入源限定为「本程序导出的包」（用户裁定 m01703）：
     * 只有这种包带着清单与逐文件校验值，才能判断内容是否完整、有没有被改过。
     * 接受任意目录等于放弃这层判断，而恢复配置恰恰是最不该赌的一步。
     *
     * @param {{packageDir?: string}} input
     * @returns {Promise<object>}
     */
    async prepareImport(input = {}) {
      const dir = resolvePackageDir(input.packageDir ?? defaultImportRoot())
      const pkg = readPackage(dir)
      const check = validatePackage(pkg)
      if (!check.ok) {
        // 包不可用就不给「写一半」的机会：这是硬停，不是跳过某一项。
        const error = new Error(check.errors.join('\n'))
        error.code = 'package-invalid'
        error.errors = check.errors
        error.warnings = check.warnings ?? []
        throw error
      }

      const plan = planImport(pkg)

      // 与本机现状比对。语义与拉取一致：第一个参数是「现在」，第二个是「写完之后」。
      const localRows = readLocalRows()
      const toEntries = rows => rows.map(row => ({
        path: `patch:${row.id}`,
        kind: 'shared',
        hash: hashOf(JSON.stringify(row)),
      }))
      const diff = diffSnapshots(
        { entries: toEntries(localRows) },
        { entries: toEntries(plan.patchRows) },
      )

      // 本机这一侧「有意不动」的项，也要进报告。
      //
      // 导出包根本不会带上本机项，所以这不会是「包里被塞了本机项」那条路径；
      // 它回答的是另一个问题：「我在新机器上导入完之后，这台机器原本的监听地址
      // 和主题去哪了？」用户看不到这句话，就只能靠猜——而猜错的代价是以为恢复失败了。
      const localSplit = splitByTopLevelId(localRows)
      const refusedIds = new Set(plan.refused.map(item => item.name ?? ''))
      const keptLocal = []
      for (const row of localSplit.machine) {
        if (row.id === undefined || refusedIds.has(row.id)) continue
        keptLocal.push({
          path: `本机:${row.id}`,
          name: row.id,
          source: 'local',
          reason: 'machine-entry',
          explanation: `「${row.id}」是本机配置（监听地址、主题、默认模型这类），`
            + '导入不会改变它，这台机器上保持当前的值。',
        })
      }
      for (const row of localSplit.excluded) {
        if (row.id === undefined || refusedIds.has(row.id)) continue
        keptLocal.push({
          path: `本机:${row.id}`,
          name: row.id,
          source: 'local',
          reason: 'excluded-entry',
          explanation: `「${row.id}」不在公共线范围内，导入不会碰它。`,
        })
      }

      let skillCheck = null
      try {
        skillCheck = await crossCheck()
      } catch {
        skillCheck = null
      }

      const compat = await runCompat({
        remoteRows: plan.patchRows,
        remoteSkillFiles: plan.skillFiles,
        bundleNames: plan.pluginNames,
      })

      return {
        ...plan,
        refused: [...plan.refused, ...keptLocal],
        warnings: check.warnings ?? [],
        diff,
        summary: summarizeDiff(diff),
        compat,
        skillCheck,
        skillsRoot,
        patchFile: patchFile(),
        empty: isEmptyPlan(plan),
      }
    },

    /**
     * 执行导入。
     *
     * 与 applyPull 同一条纪律：备份 → 写入 → 回读校验，警告非空即视为失败。
     * 但导入还多一层必须说清的事：包里有、而本机**有意不写回**的那些项，
     * 必须原样出现在报告里。否则用户会把「导入完成」理解为「环境完全一致」，
     * 而这正是本项目从头到尾要消除的那个误解。
     *
     * @param {object} plan - prepareImport 的返回
     * @param {{backupRoot?: string}} options
     * @returns {Promise<object>} RestoreReport
     */
    async applyImport(plan, options = {}) {
      // 兼容性检查里只要有一条 block 级别的问题，就停下来。
      //
      // 这类问题的共同特征是「写下去不报错，只是不生效、或者覆盖掉别的东西」——
      // 让用户先处理掉再写，比等他日后从「配置看着有、行为不对」倒查要省得多。
      // warn 级别的一律放行：提醒不该变成路障。
      if (plan?.compat?.blocked) {
        const blocking = plan.compat.items.filter(entry => entry.level === 'block')
        const error = new Error(blocking.map(entry => `${entry.name}：${entry.message}\n${entry.action}`).join('\n\n'))
        error.code = 'compat-blocked'
        error.items = blocking
        throw error
      }
      const applied = []
      const skipped = []
      const backups = []
      const backupRoot = options?.backupRoot ?? join(dshRoot, 'settings-roam', 'backup')
      const stamp = timestamp()

      if (Array.isArray(plan.patchRows) && plan.patchRows.length > 0) {
        const result = applyPatchFile({
          targetFile: patchFile(),
          sharedRows: plan.patchRows,
          backupRoot,
        })
        if (result.backup) backups.push(result.backup)

        const check = verifyWriteBack(patchFile(), plan.patchRows)
        if (result.ok && check.ok) {
          for (const id of result.applied) {
            applied.push({ kind: 'file', name: `patch:${id}`, result: 'ok' })
          }
        } else {
          for (const id of [...result.warnings, ...check.missing, ...check.mismatch]) {
            skipped.push({ kind: 'file', name: String(id), result: 'skipped', reason: 'unknown' })
          }
        }
      }

      if (Array.isArray(plan.skillFiles) && plan.skillFiles.length > 0) {
        const result = applySkillFiles({
          skillsRoot,
          files: plan.skillFiles,
          targetPathOf: path => skillTargetPath(skillsRoot, path),
          backupRoot,
          stamp,
        })
        if (result.backup) backups.push(result.backup)
        for (const path of result.written) {
          applied.push({ kind: 'file', name: path, result: 'ok' })
        }
        for (const item of result.failed) {
          skipped.push({
            kind: 'file',
            name: item.path,
            result: 'skipped',
            reason: 'unreadable',
            detail: item.reason,
          })
        }
      }

      // 有意不写回的项：不是失败，但正是「同步配置」与「复制环境」的区别所在。
      for (const item of plan.refused ?? []) {
        skipped.push({
          kind: 'config',
          name: item.path,
          result: 'skipped',
          reason: item.reason,
          explanation: item.explanation,
        })
      }

      return {
        applied,
        skipped,
        needsRestart: applied.length > 0,
        needsCredentials: collectApiKeyRefs(plan.patchRows ?? []),
        backupPath: backups[0]?.backupPath ?? '',
        backupFiles: backups.flatMap(item => item.backedUp ?? []),
        pluginNames: plan.pluginNames ?? null,
        packageDir: plan.packageDir ?? '',
        skillCheck: plan.skillCheck ?? null,
      }
    },

    /**
     * 是否已具备同步条件。
     *
     * 界面用它决定显示「拉取」还是「去配置云端仓库」。
     * 插件装上了但还没配仓库是正常状态，不是故障。
     * @returns {boolean}
     */
    isConfigured,

    /** 数据根目录，供界面与诊断显示。 */
    dshRoot,

    /**
     * 描述当前的目标 profile，**不抛错**。
     *
     * 为什么不做成一个 profileName 属性：解析在一个 profile 都没有或存在多个时
     * 会失败（见 resolveProfileName），而界面每次打开都要读它。属性的形式会让
     * 「读取当前状态」这件事在特定环境下直接炸掉，界面无从显示原因。
     * 这里把失败也当作一种可展示的状态返回。
     *
     * @returns {{name: string|null, resolved: boolean, reason: string|null}}
     */
    describeProfile() {
      // 候选名单一并带出去：多 profile 时界面要能让用户直接选一个，
      // 而不是把「请显式指定 profile 名」这句话丢给用户，让他自己去找名字怎么拼。
      let profiles = []
      try {
        profiles = listProfiles(dshRoot, { readdirSync, existsSync })
      } catch {
        profiles = []
      }
      try {
        return { name: resolveProfileName(), resolved: true, reason: null, profiles, needsChoice: false }
      } catch (error) {
        return {
          name: explicitProfile(),
          resolved: false,
          reason: String(error?.message ?? error),
          profiles,
          // 有候选才叫「要选一个」；一个都没有时（还没启动过 DSH）
          // 给一组空按钮只会让人更困惑。
          needsChoice: profiles.length > 1,
        }
      }
    },

    /**
     * 默认备份目录。
     *
     * 和 defaultExportRoot 同理：备份放哪儿归服务层定，界面只需要用。
     * 拉取会改本机文件，因此备份不是可选项——留空就等于「应用前不备份」，
     * 那会让报告里的回退路径变成一句空话。
     * @returns {string}
     */
    defaultBackupRoot() {
      return join(dshRoot, 'settings-roam', 'backup')
    },

    /**
     * 默认导出目录。
     *
     * 导出目录的默认值归服务层定，不归界面定：界面是浏览器半侧，
     * 它拿不到（也不该去猜）DSH 数据根目录在哪。这里给出来，
     * 界面只管用。
     * @returns {string}
     */
    defaultExportRoot() {
      // 用户在设置页填了导出目录就用它，否则落在数据根目录下。
      // 落在数据根目录下是刻意的：它天然属于这台机器，不会被误同步。
      return configuredExportRoot() ?? join(dshRoot, 'settings-roam', 'export')
    },

    /**
     * 配置编辑：算出改完之后的条目。**只读，绝不改本机文件。**
     *
     * @param {{id?: string, edits?: object[],
     *   set?: Record<string, string>, unset?: string[], types?: Record<string, string>}} input
     * @returns {Promise<object>}
     */
    async prepareEdit(input = {}) {
      const rows = readLocalRows()
      const shared = splitByTopLevelId(rows).shared
      if (shared.length === 0) {
        const error = new Error(
          'profile 里还没有可编辑的公共配置条目。先推送一次，或者检查这份 profile 的 cordis.patch.yml。',
        )
        error.code = 'no-editable-entry'
        throw error
      }

      const id = input.id ?? shared[0].id
      const entry = shared.find(row => row.id === id)
      if (entry === undefined) {
        const error = new Error(
          `profile 里没有「${id}」这一条。当前可编辑的是：${shared.map(r => r.id).join('、')}。`,
        )
        error.code = 'entry-not-found'
        error.available = shared.map(row => row.id)
        throw error
      }

      // set/unset 的文本形式由命令行与界面给出，这里统一按字段原类型解析。
      let edits = input.edits
      if (edits === undefined) {
        const types = {}
        for (const field of flattenConfig(entry.config ?? {})) types[field.path] = field.type
        const built = buildEdits({
          set: input.set ?? {},
          unset: input.unset ?? [],
          types: { ...types, ...(input.types ?? {}) },
        })
        if (!built.ok) {
          const error = new Error(built.errors.map(e => `${e.path}：${e.error}`).join('\n'))
          error.code = 'edit-invalid'
          error.errors = built.errors
          throw error
        }
        edits = built.edits
      }

      const applied = applyEdits(entry, edits)
      if (!applied.ok) {
        const error = new Error(applied.errors.map(e => `${e.path}：${e.error}`).join('\n'))
        error.code = 'edit-invalid'
        error.errors = applied.errors
        throw error
      }

      const before = entry.config ?? {}
      const after = applied.entry.config ?? {}

      return {
        id,
        name: entry.name,
        before,
        after,
        fields: flattenConfig(before),
        changed: diffConfig(before, after),
        rows: [applied.entry],
        patchFile: patchFile(),
      }
    },

    /**
     * 配置编辑：写回本机。与同步走同一条路径——备份、合并、写后回读。
     *
     * @param {object} plan - prepareEdit 的结果
     * @param {{backupRoot?: string}} [options]
     * @returns {Promise<object>}
     */
    async applyEdit(plan, options = {}) {
      const result = applyPatchFile({
        targetFile: patchFile(),
        sharedRows: plan.rows,
        backupRoot: options.backupRoot,
      })
      const check = verifyWriteBack(patchFile(), plan.rows)

      // 写后回读：C2 的落地。警告非空即视为没写成功，不报一句「已保存」了事。
      const warnings = [...result.warnings, ...check.missing, ...check.mismatch]
      if (!result.ok || !check.ok) {
        const error = new Error(
          `配置没有写成功：${warnings.join('；')}\n`
          + '多半是这一条在别处也被声明了（例如 profile 的 cordis.patch.yml 或启动参数），写入会被它覆盖。',
        )
        error.code = 'write-failed'
        error.warnings = warnings
        throw error
      }

      return {
        id: plan.id,
        applied: result.applied,
        changed: plan.changed,
        backupPath: result.backup?.backupPath ?? '',
        warnings,
      }
    },

    /**
     * 默认去哪个目录找导出包。
     *
     * 和 defaultExportRoot 同理：目录归服务层定，界面只需要用。
     * 刻意与导出默认位置一致——同机导出再导入时用户不必先想路径。
     * @returns {string}
     */
    defaultImportRoot,

    /**
     * 看一眼导入目录里有没有可用的包。**绝不抛错**，界面每次打开都要调。
     * @param {{packageDir?: string}} [input]
     * @returns {object}
     */
    describeImportSource,

    /**
     * 列出可编辑的公共条目（设置页的编辑区用它）。
     * @returns {{id: string, name?: string, fields: object[]}[]}
     */
    listEditableEntries,

    describeUpdate,
    prepareUpdate,
    applyUpdate,
  }
}
