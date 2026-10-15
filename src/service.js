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

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parsePatchList, renderPatches } from './yaml-loader.js'
import { extractShared } from './extract.js'
import { buildSnapshot, serializeSnapshot } from './snapshot.js'
import { diffSnapshots, summarizeDiff } from './diff.js'
import { applyPatchFile, verifyWriteBack } from './apply.js'
import { scanSkills, listSkillNames } from './skills.js'
import { assertBackend } from './backends/index.js'

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

  const patchFile = join(dshRoot, 'cordis.patch.yml')

  /** 读本机 patch 条目。文件不存在时视为空。 */
  function readLocalRows() {
    if (!existsSync(patchFile)) return []
    const text = readFileSync(patchFile, 'utf8')
    return text.trim() === '' ? [] : parsePatchList(text)
  }

  /** 收集技能文件内容：{ 'skills/<名>/<相对路径>': 内容 }。 */
  function collectSkillFiles() {
    const out = {}
    for (const name of listSkillNames(skillsRoot)) {
      for (const record of scanSkills(skillsRoot, [name])) {
        const abs = join(skillsRoot, record.relPath)
        out[`skills/${record.relPath}`] = readFileSync(abs, 'utf8')
      }
    }
    return out
  }

  return {
    /**
     * 推送准备：组装要写入云端的文件与差异。**只读，不写任何地方。**
     * @param {{generatedBy: string, bundles?: object, now?: Date}} input
     * @returns {Promise<{files: {path: string, content: string}[], diff: object[], summary: object}>}
     */
    async preparePush(input = {}) {
      const backend = requireBackend()
      const rows = readLocalRows()
      const { patch } = extractShared({ patchRows: rows })

      const patchContent = renderPatches(patch, 'settings-roam')
      const files = [
        { path: CLOUD_PATHS.patch, content: patchContent },
        ...Object.entries(collectSkillFiles()).map(([path, content]) => ({ path, content })),
      ]
      if (input.bundles !== undefined) {
        files.push({
          path: CLOUD_PATHS.bundles,
          content: JSON.stringify(input.bundles, null, 2) + '\n',
        })
      }

      // 与云端现状比对，供界面展示
      await backend.ensureReady()
      await backend.pull()
      const remoteSnapshotText = await backend.readFile(CLOUD_PATHS.snapshot)
      const remoteEntries = remoteSnapshotText === null
        ? []
        : (JSON.parse(remoteSnapshotText).entries ?? [])

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

      return {
        files: [...files, snapshotFile],
        diff,
        summary: summarizeDiff(diff),
        patchRows: patch,
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
      return {
        diff,
        summary: summarizeDiff(diff),
        remoteRows,
        remotePatchText: patchText,
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

      if (plan.remoteRows.length > 0) {
        const result = applyPatchFile({
          targetFile: patchFile,
          sharedRows: plan.remoteRows,
          backupRoot: options?.backupRoot,
        })

        // 写后回读校验：C2 的落地。警告非空即视为失败，不静默放过。
        const check = verifyWriteBack(patchFile, plan.remoteRows)
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
        backupPath: options?.backupRoot ?? '',
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
  }
}
