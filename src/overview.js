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

  const stats = [
    { label: '公共配置', value: countByPrefix(files, 'config/profile.patch.yml') },
    { label: '技能', value: countByPrefix(files, 'skills/') },
    { label: '插件', value: countPlugins(files) },
  ]

  const meta = []
  const at = options.now ?? new Date()
  meta.push(formatTime(at))
  if (plan.generatedBy) meta.push(`来自 ${plan.generatedBy}`)

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
 * 从拉取报告构建概述。
 *
 * 跳过项不计入 stats——它们没有发生。把它们混进数字会让概述失真。
 */
export function buildPullOverview(report, options = {}) {
  const applied = report?.applied ?? []
  const skipped = report?.skipped ?? []
  if (applied.length === 0 && skipped.length === 0) return null

  const stats = [
    { label: '已应用', value: applied.length },
  ]
  if (skipped.length > 0) {
    stats.push({ label: '已跳过', value: skipped.length })
  }

  const meta = [formatTime(options.now ?? new Date())]
  if (report?.backupPath) {
    meta.push('已备份，可回退')
  }

  return {
    title: '本次拉取结果',
    stats,
    meta,
    // 拉取后没有导出目录；详情在报告列表与备份里。
    location: report?.backupPath || null,
    total: applied.length,
  }
}

function countByPrefix(files, prefix) {
  return files.filter(f => f.path === prefix || f.path.startsWith(prefix)).length
}

function countPlugins(files) {
  const file = files.find(f => f.path === 'config/bundles.json')
  if (!file) return 0
  try {
    const parsed = JSON.parse(file.content)
    return (parsed.official?.length ?? 0) + (parsed.thirdParty?.length ?? 0)
  } catch {
    // 名单内容坏了不该让概述整体失败——它只是一条统计。
    return 0
  }
}

/** 本地时间，精确到分钟：界面不需要秒，也不需要时区后缀。 */
function formatTime(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}
