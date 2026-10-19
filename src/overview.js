/**
 * 把同步结果整理成界面概述。
 *
 * 为什么要单独一层
 * ────────────────
 * service 层产出的是「事实」（文件列表、差异、导出路径），
 * 界面要的是「概述」（同步了几项、来自哪台机器、去哪看详情）。
 * 把这段转换放在这里，而不是塞进 client.js：
 *   1. client.js 是浏览器半侧，不能 import 宿主模块，且要保持极简；
 *   2. 这段逻辑可被单元测试直接验证，不必经浏览器装载。
 *
 * 设计取向（依据用户要求「页面上要有概述显示」）
 * ─────────────────────────────────────────────
 * 只给概述，不铺开逐项清单。要看细节应去打开导出的文件——
 * 那里可以逐字核对，比在界面上滚动长列表有用。
 * 所以概述里每个数字都配「去哪看」的真实路径。
 */

/**
 * 从 preparePush 的结果构建概述。
 *
 * @param {object} plan - preparePush 的返回
 * @param {{now?: Date}} [options]
 * @returns {object|null} 无内容时返回 null（界面据此不渲染空区块）
 */
export function buildPushOverview(plan, options = {}) {
  const files = plan?.files ?? []
  if (files.length === 0) return null

  const summary = plan.summary ?? {}
  const exported = plan.exported ?? null
  const plugins = countPlugins(files)

  const stats = [
    { label: '公共配置', value: countByPrefix(files, 'config/profile.patch.yml') },
    { label: '技能', value: countByPrefix(files, 'skills/') },
    // 与「本机现状」同一个口径：只数自己装的，DSH 自带的在 meta 里。
    { label: '插件', value: plugins === null ? '—' : plugins.thirdParty },
  ]

  const meta = []
  const at = options.now ?? new Date()
  meta.push(formatTime(at))
  if (plan.generatedBy) meta.push(`来自 ${plan.generatedBy}`)
  if (plugins !== null && plugins.official > 0) {
    meta.push(`插件名单共 ${plugins.total} 项（其中 DSH 自带 ${plugins.official} 项）`)
  }

  const diffTotal = (summary.add ?? 0) + (summary.modify ?? 0) + (summary.delete ?? 0)
  if (diffTotal > 0) {
    meta.push(`与云端有 ${diffTotal} 项差异`)
  }

  return {
    title: '本次将同步',
    stats,
    meta,
    location: exported?.exportPath ?? null,
    total: files.length,
  }
}

/**
 * 从本机现状构建概述：这台机器上准备带走的东西。
 *
 * 与其它三个概述的关键差别：它不来自任何一次动作，而是「一打开就该有」的
 * 常态视图。用户选完 profile 后第一件想确认的事就是「这是我要备份的内容吗」，
 * 这个答案不能藏在「先点一次导出」后面——那正是原先预览区一直空着的原因：
 * 三个动作各自都有概述，但没有任何一个会在用户还没动作时先说话。
 *
 * 每个数字都配一条能核对的下落：公共条目留在哪个文件、有几个技能、
 * 哪些项被留在本机。用户据此判断要不要动那个按钮，而不是盲点。
 *
 * @param {object|null} inspect - prepareInspect 的返回
 * @param {{now?: Date}} [options]
 * @returns {object|null} 无现状可读时返回 null
 */
export function buildInspectOverview(inspect, options = {}) {
  if (inspect === null || inspect === undefined) return null

  const shared = inspect.shared?.length ?? 0
  const machine = inspect.machine?.length ?? 0
  const excluded = inspect.excludedIds?.length ?? 0
  // skills 是文件级记录，一个技能可能有多个文件。两个数字分开给：
  // 「装了几个技能」与「会同步几个文件」是两件事，混成一个数会答错其中一件。
  const skillFiles = inspect.skills?.length ?? 0
  const skillCount = inspect.skillNames?.length
    ?? new Set((inspect.skills ?? []).map(r => String(r?.relPath ?? '').split('/')[0])).size
  const plugins = summarizeBundles(inspect.bundles)

  const stats = [
    { label: '模型供应商', value: inspect.providers?.count ?? 0 },
    // 取不到插件名单时给一个明确的占位符，不能给 0：
    // 0 会被读成「这台机器一个插件都没装」，而事实是我们没问到。
    // 数的是自己装的：DSH 自带的那批在 meta 里单独交代。
    { label: '已装插件', value: plugins === null ? '—' : plugins.thirdParty },
    { label: '公共配置项', value: shared },
    { label: '技能', value: skillCount },
  ]

  const meta = [`读取于 ${formatTime(options.now ?? new Date())}`]
  if (skillFiles > 0) meta.push(`技能共 ${skillFiles} 个文件`)
  if (machine > 0) meta.push(`留在本机 ${machine} 项`)
  if (excluded > 0) meta.push(`不同步 ${excluded} 项`)
  if (plugins === null) {
    meta.push('插件名单暂不可用（没问到插件管理服务）')
  } else if (plugins.official > 0) {
    // 名单里也有 DSH 自带的 bundle。它们不进主数字，但不能不说——
    // 否则用户核对名单时会以为备份漏了东西。
    meta.push(`插件名单共 ${plugins.total} 项（其中 DSH 自带 ${plugins.official} 项）`)
  }

  const details = [
    { key: 'providers', items: inspect.providers?.names ?? [] },
    ...(plugins === null ? [] : [
      { key: 'thirdPartyPlugins', items: inspect.bundles.thirdParty ?? [] },
      { key: 'officialPlugins', items: inspect.bundles.official ?? [] },
    ]),
    { key: 'sharedConfig', items: (inspect.shared ?? []).map(row => row?.id).filter(Boolean) },
    { key: 'machineConfig', items: (inspect.machine ?? []).map(row => row?.id).filter(Boolean) },
    { key: 'excludedConfig', items: inspect.excludedIds ?? [] },
    { key: 'skills', items: inspect.skillNames ?? [] },
  ].map(group => ({
    ...group,
    items: [...new Set(group.items.filter(name => typeof name === 'string' && name !== ''))].sort(),
  }))

  return {
    title: '这台机器上可同步的内容',
    stats,
    meta,
    // 清单默认折叠显示：概况卡保持紧凑，用户仍能在页面内核对具体名称。
    // 插件按官方/第三方分组；技能按技能目录名计数，不展开文件级细目。
    details,
    // 配置文件的绝对路径：用户想逐字核对自己配了什么时，去这里看。
    location: inspect.patchFile ?? null,
    total: shared,
  }
}

/**
 * 插件名单的构成；名单取不到时返回 null（与「0 个插件」区分）。
 *
 * 为什么官方与第三方要分开数：界面上的「已装插件」是给用户核对的，
 * 他数的是自己装的那些。DSH 自带的 bundle 也在名单里——名单要如实记录
 * 这台机器装载了什么——但混进同一个数字会让他觉得「我没装这么多」：
 * 装 9 个插件的人看到的却是 19。所以主数字只数自己装的，
 * 自带的那批在 meta 里单独交代。
 *
 * @param {{official?: string[], thirdParty?: string[]}|null|undefined} bundles
 * @returns {{official: number, thirdParty: number, total: number}|null}
 */
function summarizeBundles(bundles) {
  if (bundles === null || bundles === undefined) return null
  const official = bundles.official?.length ?? 0
  const thirdParty = bundles.thirdParty?.length ?? 0
  return { official, thirdParty, total: official + thirdParty }
}

/**
 * 从导入计划构建概述（确认之前给用户看的那一眼）。
 *
 * 与推送概述的关键差别：这里必须把「不会写回本机」的项数摆出来。
 * 推送时用户关心的是「我带走了什么」；导入时他真正需要知道的是
 * 「这台机器有哪些东西不会被换掉」——那正是同步配置与复制环境的区别。
 */
export function buildImportOverview(plan, options = {}) {
  const patchRows = plan?.patchRows ?? []
  const skillFiles = plan?.skillFiles ?? []
  const refused = plan?.refused ?? []
  if (patchRows.length === 0 && skillFiles.length === 0 && refused.length === 0) return null

  const stats = [
    { label: '配置项', value: patchRows.length },
    { label: '技能文件', value: skillFiles.length },
  ]
  if (refused.length > 0) {
    stats.push({ label: '本机项（不写回）', value: refused.length })
  }

  const meta = []
  if (plan?.generatedAt) meta.push(formatIsoTime(plan.generatedAt))
  if (plan?.generatedBy) meta.push(`来自 ${plan.generatedBy}`)
  if (plan?.empty === true) meta.push('包里没有需要写回的内容')

  return {
    title: '本次将导入',
    stats,
    meta,
    // 详情在包里，不在界面上——包里能逐字核对，界面滚动长列表没用。
    location: plan?.packageDir ?? null,
    total: patchRows.length + skillFiles.length,
  }
}

/**
 * 从拉取报告构建概述。
 *
 * 跳过项不计入 stats——它们没有发生。把它们混进数字会让概述失真。
 */
export function buildPullOverview(report, options = {}) {
  const applied = report?.applied ?? []
  const skipped = report?.skipped ?? []
  if (applied.length === 0 && skipped.length === 0) return null

  const stats = [
    { label: options.appliedLabel ?? '已应用', value: applied.length },
  ]
  if (skipped.length > 0) {
    stats.push({ label: options.skippedLabel ?? '已跳过', value: skipped.length })
  }

  const meta = [formatTime(options.now ?? new Date())]
  if (report?.backupPath) {
    meta.push('已备份，可回退')
  }

  return {
    title: options.title ?? '本次拉取结果',
    stats,
    meta,
    // 拉取后没有导出目录；详情在报告列表与备份里。
    location: options.location ?? (report?.backupPath || null),
    total: applied.length,
  }
}

function countByPrefix(files, prefix) {
  return files.filter(f => f.path === prefix || f.path.startsWith(prefix)).length
}

/**
 * 包里的插件名单构成；名单不在文件里、或内容坏掉时返回 null。
 * 与 summarizeBundles 同一个口径：官方与第三方分开给。
 * @param {{path: string, content: string}[]} files
 * @returns {{official: number, thirdParty: number, total: number}|null}
 */
function countPlugins(files) {
  const file = files.find(f => f.path === 'config/bundles.json')
  if (!file) return null
  try {
    const parsed = JSON.parse(file.content)
    const official = parsed.official?.length ?? 0
    const thirdParty = parsed.thirdParty?.length ?? 0
    return { official, thirdParty, total: official + thirdParty }
  } catch {
    // 名单内容坏了不该让概述整体失败——它只是一条统计。
    return null
  }
}

/** 本地时间，精确到分钟：界面不需要秒，也不需要时区后缀。 */
function formatTime(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 把 ISO 时间串按本地时区显示。
 *
 * 包里的 generatedAt 是 ISO 串（导出时由 toISOString 写的），
 * 直接显示会带 Z 和毫秒；解析不了就原样返回，不要为了好看把它变成「无效日期」。
 * @param {string} iso
 * @returns {string}
 */
function formatIsoTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  return formatTime(date)
}
