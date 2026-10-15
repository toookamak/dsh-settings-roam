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

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parsePatchList, renderPatches, splitByTopLevelId } from './yaml-loader.js'
import { profilePatchPath, listProfiles } from './home-paths.js'
import { extractShared } from './extract.js'
import { buildSnapshot, serializeSnapshot } from './snapshot.js'
import { diffSnapshots, summarizeDiff } from './diff.js'
import { applyPatchFile, verifyWriteBack } from './apply.js'
import { scanSkills, listSkillNames, crossCheckSkills, applySkillFiles } from './skills.js'
import { collectBundles } from './bundles.js'
import { exportForReview } from './export.js'
import { timestamp } from './backup.js'
import { assertBackend } from './backends/index.js'
import {
  resolvePackageDir,
  readPackage,
  validatePackage,
  planImport,
  skillTargetPath,
  isEmptyPlan,
} from './import.js'

/** 云端布局，见设计 §5.1。 */
export const CLOUD_PATHS = Object.freeze({
  snapshot: 'snapshot.json',
  patch: 'config/profile.patch.yml',
  bundles: 'config/bundles.json',
  notes: 'notes.md',
})

function hashOf(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
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
  const explicitProfile = config.profileName ?? null

  /** 用户在设置页指定的导出目录；留空时用数据根目录下的默认位置。 */
  const configuredExportRoot = config.exportRoot ?? null

  /** 用户在设置页指定的导入目录（放导出包的地方）；留空时用默认位置。 */
  const configuredImportRoot = config.importRoot ?? null

  /**
   * 默认导入目录。
   *
   * 与 defaultExportRoot 是同一个位置，这是刻意的：导出的包默认落在
   * <dshRoot>/settings-roam/export/<时间戳>，而导入默认去那里找最新的一次。
   * 用户「在这台机器导出、换台机器导入」时不必先去想路径。
   */
  function defaultImportRoot() {
    return configuredImportRoot ?? configuredExportRoot ?? join(dshRoot, 'settings-roam', 'export')
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
    if (explicitProfile !== null) return explicitProfile
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

  /** 已建好的后端实例，惰性缓存，避免重复建。 */
  let resolved = null

  /**
   * 取后端实例。未配置时抛出可据以行动的说明。
   * @returns {object}
   */
  function requireBackend() {
    if (resolved !== null) return resolved
    const source = config.backend
    if (typeof source === 'function') {
      if (backendFactoryBroken !== null) throw backendFactoryBroken
      resolved = source()
    } else {
      resolved = source ?? null
    }
    if (resolved === null) {
      throw new Error('还没配置云端仓库。先在插件设置里填上仓库地址。')
    }
    assertBackend(resolved)
    return resolved
  }

  /** 工厂自身抛错时记住它，避免每次调用都重跑一遍失败逻辑。 */
  let backendFactoryBroken = null

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
          content: readFileSync(abs, 'utf8'),
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

      return {
        patchFile: patchFile(),
        patchExists,
        total: rows.length,
        shared,
        machine,
        // 既不共享也不属于本机的项不计入同步，但要让用户看见它们被排除了，
        // 否则「我配的东西怎么没过去」会变成一个无从查证的问题。
        excludedIds: excluded.map(row => row.id).filter(Boolean),
        skills,
        skillCheck,
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
      const { patch } = extractShared({ patchRows: rows })

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
      let comparedWithRemote = false
      if (backend !== null) {
        await backend.ensureReady()
        await backend.pull()
        const remoteSnapshotText = await backend.readFile(CLOUD_PATHS.snapshot)
        remoteEntries = remoteSnapshotText === null
          ? []
          : (JSON.parse(remoteSnapshotText).entries ?? [])
        comparedWithRemote = true
      }

      const localSnapshot = buildSnapshot({
        generatedBy: input.generatedBy ?? 'unknown',
        generatedAt: (input.now ?? new Date()).toISOString(),
        files,
      })
      const diff = diffSnapshots({ entries: remoteEntries }, localSnapshot)

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

      const patchText = await backend.readFile(CLOUD_PATHS.patch)
      const remoteRows = patchText === null ? [] : parsePatchList(patchText)

      const localRows = readLocalRows()
      const localEntries = localRows.map(row => ({
        path: `patch:${row.id}`,
        kind: 'shared',
        hash: hashOf(JSON.stringify(row)),
      }))
      const remoteEntries = remoteRows.map(row => ({
        path: `patch:${row.id}`,
        kind: 'shared',
        hash: hashOf(JSON.stringify(row)),
      }))

      const diff = diffSnapshots({ entries: localEntries }, { entries: remoteEntries })

      // 拉取侧同样走双通道：云端带来的技能会落到本机，落地前先看清本机
      // 服务视图里有什么。只读，不改任何地方。
      const skillCheck = await crossCheck()

      return {
        diff,
        summary: summarizeDiff(diff),
        remoteRows,
        remotePatchText: patchText,
        skillCheck,
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

      return {
        ...plan,
        refused: [...plan.refused, ...keptLocal],
        warnings: check.warnings ?? [],
        diff,
        summary: summarizeDiff(diff),
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
      try {
        return { name: resolveProfileName(), resolved: true, reason: null }
      } catch (error) {
        return { name: explicitProfile, resolved: false, reason: String(error?.message ?? error) }
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
      return configuredExportRoot ?? join(dshRoot, 'settings-roam', 'export')
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
  }
}
