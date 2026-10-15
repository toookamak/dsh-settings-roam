/**
 * 读回一份导出包：校验它，再算出「要往本机写什么」。
 *
 * 为什么单独一个模块，而不并进 service
 * ────────────────────────────────────
 * 这个模块要能回答一个不依赖本机状态的问题：「这份包本身是不是可信的、
 * 里面有什么、其中哪些是**绝不允许写回**的」。答完之后才轮到 service 决定
 * 写到哪、怎么备份、怎么回读校验。把两件事混在一起，就无法单独测试
 * 「包里有一设备器的监听地址时会不会被挡住」——而那正是本插件存在的理由。
 *
 * 导入源只接受本程序导出的包（用户裁定）
 * ──────────────────────────────────────
 * 判据是包里的 manifest.json：它记录了每个文件的大小与 sha256。
 * 没有清单的目录一律拒绝，而不是「尽力而为地猜里面有什么」。
 * 但清单本身也可能被人改过，所以校验之后**还要**过一遍归属表：
 * 清单可信不等于内容该写——归属表是最后一道闸门。
 *
 * 与导出的镜像关系
 * ────────────────
 *   src/export.js  本机 → 包        （只带走公共项）
 *   src/import.js  包 → 本机        （只写回公共项，其余逐条说明为何不写）
 *   两侧用同一张归属表。任一侧放宽，另一侧就形同虚设。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { parsePatchList, splitByTopLevelId } from './yaml-loader.js'
import { hashContent, safeRelPath } from './export.js'
import { OWNERSHIP } from './ownership.js'

/** 包内清单的文件名。它的存在与否，就是「这是不是一个我们的包」的判据。 */
export const MANIFEST_FILENAME = 'manifest.json'

/** 本模块认识的清单结构版本。 */
export const SUPPORTED_SCHEMA_VERSION = 1

/** 包内约定的几个路径。 */
export const PACKAGE_PATHS = Object.freeze({
  patch: 'config/profile.patch.yml',
  bundles: 'config/bundles.json',
  skillsPrefix: 'skills/',
})

/**
 * 定位真正的包目录。
 *
 * 用户手上的路径有两种可能：
 *   1. 直接是某一次的导出目录（里面有 manifest.json）
 *   2. 是导出根目录（里面是按时间戳分的若干次导出）
 * 第二种是默认设置下的常态——设置页里的「导出目录」填的就是根目录。
 * 让用户自己找到最新的那一次，是一个不必要的负担。
 *
 * 选「最新」按目录名排序，而不是按 mtime：目录名是 <时间戳>，字典序即时间序，
 * 而 mtime 会被复制、解压、同步等操作改变。
 *
 * @param {string} dir
 * @param {{existsSync: Function, readdirSync: Function}} [fsLike]
 * @returns {string} 含有 manifest.json 的目录
 */
export function resolvePackageDir(dir, fsLike = { existsSync, readdirSync }) {
  if (fsLike.existsSync(join(dir, MANIFEST_FILENAME))) return dir

  let entries = []
  try {
    entries = fsLike.readdirSync(dir, { withFileTypes: true })
  } catch {
    throw new Error(`读不到这个目录：${dir}`)
  }

  const candidates = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => fsLike.existsSync(join(dir, name, MANIFEST_FILENAME)))
    .sort()

  if (candidates.length === 0) {
    throw new Error(
      `这个目录里没有找到导出包：${dir}\n` +
      '导入只接受本程序导出的包（目录里应当有 manifest.json）。' +
      '如果你指的是导出根目录，请确认里面至少有一次成功的导出。',
    )
  }

  return join(dir, candidates[candidates.length - 1])
}

/**
 * 读一份导出包。
 *
 * 只做「读」与「结构是否成立」的判断，不做内容层面的取舍——取舍在 planImport。
 *
 * @param {string} dir - 已经由 resolvePackageDir 定位过的目录
 * @param {{existsSync: Function, readFileSync: Function}} [fsLike]
 * @returns {{dir: string, manifest: object, files: {path: string, content: string, bytes: number}[], unlisted: string[]}}
 */
export function readPackage(dir, fsLike = { existsSync, readFileSync }) {
  const manifestPath = join(dir, MANIFEST_FILENAME)
  if (!fsLike.existsSync(manifestPath)) {
    throw new Error(`这个目录里没有 ${MANIFEST_FILENAME}：${dir}`)
  }

  let manifest
  try {
    manifest = JSON.parse(fsLike.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`清单不是合法 JSON（${MANIFEST_FILENAME}）：${error?.message ?? error}`)
  }

  if (manifest?.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `这份包的清单版本不受支持：期望 ${SUPPORTED_SCHEMA_VERSION}，实际 ${manifest?.schemaVersion}。` +
      '多半是更新版本导出的包，请升级本程序后再导入。',
    )
  }

  const listed = Array.isArray(manifest.files) ? manifest.files : []
  const files = []
  for (const record of listed) {
    const path = String(record?.path ?? '')
    if (path === '') continue
    const abs = join(dir, safeRelPath(path))
    if (!fsLike.existsSync(abs)) continue
    files.push({ path, content: fsLike.readFileSync(abs, 'utf8'), bytes: record?.bytes })
  }

  return { dir, manifest, files, unlisted: [] }
}

/**
 * 校验包的内容与清单是否一致。
 *
 * 分两档，因为旧版清单里没有 sha256：
 *   - 有 sha256 → 逐文件比对内容
 *   - 没有     → 只能比字节数，并明确告知「这份包没有校验值」
 * 把后者降级为警告而不是错误：拒绝一个由更早版本导出的包，对用户没有帮助。
 *
 * @param {{manifest: object, files: object[]}} pkg
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validatePackage(pkg) {
  const errors = []
  const warnings = []
  const listed = Array.isArray(pkg.manifest?.files) ? pkg.manifest.files : []
  const present = new Map(pkg.files.map(file => [file.path, file]))

  for (const record of listed) {
    const path = String(record?.path ?? '')
    if (!present.has(path)) {
      errors.push(`清单里列了 ${path}，但包里没有这个文件（包不完整或被截断）`)
    }
  }

  const hasHashes = listed.some(record => typeof record?.sha256 === 'string')
  if (!hasHashes && listed.length > 0) {
    warnings.push(
      '这份包没有校验值（由更早的版本导出），只能按文件大小校验，无法发现内容被改动。',
    )
  }

  for (const file of pkg.files) {
    const record = listed.find(item => item?.path === file.path)
    if (record === undefined) continue

    if (typeof record.sha256 === 'string') {
      const actual = hashContent(file.content)
      if (actual !== record.sha256) {
        errors.push(`${file.path} 的内容与清单不符（包被改动过，或复制过程中损坏了）`)
      }
      continue
    }

    if (typeof record.bytes === 'number') {
      const actual = Buffer.byteLength(file.content, 'utf8')
      if (actual !== record.bytes) {
        errors.push(`${file.path} 的大小与清单不符（清单记 ${record.bytes} 字节，实际 ${actual} 字节）`)
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * 算出「要把包里的什么写到本机」。
 *
 * **只读**：不碰任何文件，只返回一份计划。真正写入在 service 里，且必须先备份。
 *
 * 拒绝的三种情形，以及为什么拒绝而不是跳过得更安静些：
 *   本机条目   包里出现监听地址、主题、默认模型这类项时**一律不写**。
 *              它们是各机器各自的东西，带过去正是本项目要解决的问题本身；
 *              而且包由本程序导出时根本不会有这些项，出现了就说明包不可信。
 *   不同步条目 权限、会话日志这类不属于公共线也不属于本机的项。
 *   不认识的路径 既不是公共配置、不是插件名单、也不是技能文件的路径。
 *              不认识的路径也写下去，等于把「包」当成可执行内容来信任。
 *
 * 拒绝不是失败：被拒绝的项会连同理由一起进入报告，用户可以逐条看到。
 * 静默跳过才会真正伤到人——「我明明备份了，怎么没回来」将无从查证。
 *
 * @param {{dir: string, manifest: object, files: object[]}} pkg
 * @returns {{
 *   packageDir: string,
 *   patchRows: object[],
 *   skillFiles: {path: string, content: string}[],
 *   pluginNames: object|null,
 *   refused: {path: string, reason: string, explanation: string}[],
 *   generatedAt: string|null,
 *   generatedBy: string|null,
 * }}
 */
export function planImport(pkg) {
  const refused = []
  const patchRows = []
  const skillFiles = []
  let pluginNames = null

  const refuse = (path, reason, explanation) => {
    refused.push({ path, reason, explanation })
  }

  for (const file of pkg.files) {
    const path = file.path

    if (path === PACKAGE_PATHS.bundles) {
      // 只记名字，不安装。第二期的范围是「把数据装回去」，
      // 驱动官方安装流程是第三期的事——现在把它写进报告，
      // 用户至少知道自己当初装过哪些插件。
      try {
        pluginNames = JSON.parse(file.content)
      } catch {
        refuse(path, 'unreadable', '插件名单不是合法 JSON，已忽略这一项。')
      }
      continue
    }

    if (path === PACKAGE_PATHS.patch) {
      let rows
      try {
        rows = parsePatchList(file.content)
      } catch (error) {
        refuse(path, 'unreadable', `公共配置不是合法的 Loader patch：${error?.message ?? error}`)
        continue
      }

      const { shared, machine, excluded } = splitByTopLevelId(rows)
      for (const row of shared) {
        patchRows.push(row)
      }
      for (const row of machine) {
        refuse(
          `${path}#${row.id ?? '(无 id)'}`,
          'machine-entry',
          `「${row.id}」属于本机配置（监听地址、主题、默认模型这类），不随导入改变。` +
          '这一项保留本机当前的值。',
        )
      }
      for (const row of excluded) {
        refuse(
          `${path}#${row.id ?? '(无 id)'}`,
          'excluded-entry',
          row.id === undefined
            ? '这一条没有 id（例如 insert 行），它只描述别处的加载顺序，不写回。'
            : `「${row.id}」不在公共线范围内，不写回。`,
        )
      }
      continue
    }

    if (path.startsWith(PACKAGE_PATHS.skillsPrefix)) {
      // 包内的技能路径仍要再压一层：包可能是别人给的，
      // 而 safeRelPath 已经在读的时候压过，这里补一层是为了
      // 「计划里出现的路径」本身也不可能越界。
      const rel = safeRelPath(path.slice(PACKAGE_PATHS.skillsPrefix.length))
      if (rel === '_' || isAbsolute(rel)) {
        refuse(path, 'unknown-path', '这个技能的路径不合法，已忽略。')
        continue
      }
      skillFiles.push({ path: PACKAGE_PATHS.skillsPrefix + rel, content: file.content })
      continue
    }

    refuse(
      path,
      'unknown-path',
      '不认识的路径。导入只接受公共配置、插件名单与技能文件三类内容，' +
      '其余一律不写回本机。',
    )
  }

  patchRows.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  skillFiles.sort((a, b) => a.path.localeCompare(b.path))

  return {
    packageDir: pkg.dir,
    patchRows,
    skillFiles,
    pluginNames,
    refused,
    generatedAt: pkg.manifest?.generatedAt ?? null,
    generatedBy: pkg.manifest?.generatedBy ?? null,
  }
}

/** 计划是否为空——界面据此决定要不要显示「将写入 0 项」这种空壳。 */
export function isEmptyPlan(plan) {
  return plan.patchRows.length === 0 && plan.skillFiles.length === 0
}

/** 归属判定复述，供测试与报告核对「这张表确实被用到了」。 */
export { OWNERSHIP }

/**
 * 目标机器上，某个技能文件应当写到哪里。
 *
 * 单独抽出来是为了让 service 与测试用同一处定义：
 * 路径拼法是跨平台最容易出错的地方（见演练记录关于备份路径的那一节）。
 *
 * @param {string} skillsRoot
 * @param {string} packagePath - 形如 skills/<名>/SKILL.md
 * @returns {string}
 */
export function skillTargetPath(skillsRoot, packagePath) {
  const rel = String(packagePath).slice(PACKAGE_PATHS.skillsPrefix.length)
  return join(skillsRoot, ...safeRelPath(rel).split(/[/\\]/).filter(Boolean))
}

/** 目录是否存在且是目录。给 resolvePackageDir 之外的调用方用。 */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
