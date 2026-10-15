#!/usr/bin/env node
/**
 * 设置漫游的命令行入口。
 *
 * 为什么要有它
 * ────────────
 * 在此之前，15 个模块全是库函数，用户拿不到任何可以「用一次」的东西。
 * 命令行入口让第一阶段可以被真实验证：能取到什么配置、导出的文件长什么样，
 * 都能直接看到，而不是从单元测试的断言里去推断。
 *
 * 也刻意先做命令行而非界面：界面要过浏览器半侧装载那一关，多一层变量；
 * 命令行能更快暴露真实问题。
 *
 * 用法
 * ────
 *   dsh-settings-roam inspect         取一次配置，打印摘要（不写任何地方）
 *   dsh-settings-roam export [目录]   取一次配置并导出到磁盘供核对
 *   dsh-settings-roam doctor          检查环境与配置是否齐备
 *
 * 退出码：0 成功，1 失败，2 用法错误。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '../src/home-paths.js'
import { createSyncService } from '../src/service.js'
import { createGitBackend } from '../src/backends/git.js'
import { timestamp } from '../src/backup.js'
import { buildPushOverview } from '../src/overview.js'
import { DEFAULT_BRANCH } from '../src/constants.js'
import { buildReportView, explainSkip } from '../src/report.js'

const USAGE = `设置漫游 —— 把一台机器的 DSH 配置搬到另一台

用法：
  dsh-settings-roam inspect           取一次配置并打印摘要（只读，不写任何地方）
  dsh-settings-roam export [目录]     取一次配置并导出到磁盘，供打开核对
  dsh-settings-roam import <目录>     读一份导出包（默认只算计划，不动本机）
  dsh-settings-roam push [目录]       推到云端（默认只算差异，--yes 才写）
  dsh-settings-roam pull              从云端拉回本机（默认只算差异，--yes 才写）
  dsh-settings-roam doctor            检查数据根目录、云端仓库配置是否齐备
  dsh-settings-roam help              显示这份帮助

选项：
  --dsh-home <路径>   覆盖 DSH 数据根目录（默认 $DSH_HOME 或 ~/.dsh）
  --profile <名字>    指定要同步哪个 profile（默认自动判断唯一的一个）
  --repo <地址>       云端 git 仓库地址（未配置时 export 仍可用）
  --branch <名字>     备份放在仓库的哪条分支（默认 settings-roam）
  --yes, -y           push／pull／import 时真正写入；不加时只打印计划
  --json              以 JSON 输出，便于脚本处理

说明：
  inspect 与 export 都不需要云端仓库——第一阶段的目标是「能取到配置」，
  没有网络也应当可用。

  import 与 pull 刻意分两步：先只算一遍「会改什么」给你看，加上 --yes 才真的写。
  写入前会把被覆盖的文件备份下来，报告里给出备份路径。
  包里的本机项（监听地址、主题、默认模型这类）一律不写回——
  这台机器保持它自己的值。

  push 默认也会先导出到本地一份（可以用 [目录] 指定位置），
  这样「推上去的」和「你核对过的」是同一份内容。
  凭据由系统 git 自己管（credential helper），本程序不接触任何密码与令牌。
`

/** 极简参数解析。刻意不引第三方库：这个入口要能在任何环境直接跑起来。 */
export function parseArgs(argv) {
  const options = { json: false, yes: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--yes' || arg === '-y') options.yes = true
    else if (arg === '--dsh-home') options.dshHome = argv[++i]
    else if (arg === '--repo') options.repo = argv[++i]
    else if (arg === '--profile') options.profile = argv[++i]
    else if (arg === '--branch') options.branch = argv[++i]
    else if (arg.startsWith('--dsh-home=')) options.dshHome = arg.slice('--dsh-home='.length)
    else if (arg.startsWith('--repo=')) options.repo = arg.slice('--repo='.length)
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg.startsWith('--branch=')) options.branch = arg.slice('--branch='.length)
    else if (arg === '-h' || arg === '--help') options.help = true
    else rest.push(arg)
  }
  return { command: rest[0] ?? 'inspect', args: rest.slice(1), options, unknown: [] }
}

/**
 * 组装服务。命令行与插件走同一条装配路径，
 * 否则「命令行能跑、插件里不行」这类偏差无法被发现。
 */
export function buildService(options = {}) {
  const dshRoot = resolveDshHome(options.dshHome)
  const backend = options.repo === undefined || options.repo === null
    ? undefined
    : () => createGitBackend({
      repoUrl: options.repo,
      workDir: join(dshRoot, 'settings-roam', 'work'),
      branch: options.branch ?? DEFAULT_BRANCH,
    })
  return {
    dshRoot,
    service: createSyncService({
      dshRoot,
      backend,
      profileName: options.profile ?? null,
    }),
  }
}

async function cmdInspect({ service, dshRoot }, options) {
  const plan = await service.prepareInspect()
  if (options.json) {
    console.log(JSON.stringify({ dshRoot, ...plan }, null, 2))
    return 0
  }

  console.log(`数据根目录：${dshRoot}`)
  console.log(`配置文件：${plan.patchFile}（${plan.patchExists ? '存在' : '不存在'}）`)
  console.log('')
  console.log(`公共配置条目：${plan.shared.length} 项`)
  for (const row of plan.shared) console.log(`  · ${row.id}`)
  console.log('')
  console.log(`留在本机的条目：${plan.machine.length} 项`)
  for (const row of plan.machine) console.log(`  · ${row.id}`)
  console.log('')
  console.log(`技能：${plan.skills.length} 个`)
  for (const skill of plan.skills.slice(0, 10)) console.log(`  · ${skill.relPath}`)
  if (plan.skills.length > 10) console.log(`  …另有 ${plan.skills.length - 10} 个`)

  // 双通道核对结果要显式说出来。只报技能个数会让人以为读路径是可信的，
  // 而设计里「直读为主 + 服务视图校验」的意义正在于发现两者不一致。
  if (plan.skillCheck && plan.skillCheck.consistent === false) {
    console.log('')
    console.log('⚠ 技能清单两路核对不一致，请先处理再同步：')
    for (const name of plan.skillCheck.serviceNames.slice(0, 5)) {
      if (!plan.skills.some(s => s.relPath.startsWith(name))) console.log(`  · ${name} 在服务视图里有，但目录里没有`)
    }
  }
  return 0
}

async function cmdExport({ service, dshRoot }, options) {
  const plan = await service.preparePush({
    generatedBy: 'cli',
    exportRoot: options.args[0] ?? service.defaultExportRoot(),
    stamp: options.args[1],
  })

  if (!plan.exported || plan.exported.error) {
    console.error('导出失败：', plan.exported?.error ?? '未知原因')
    return 1
  }

  if (options.json) {
    console.log(JSON.stringify({
      exportPath: plan.exported.exportPath,
      total: plan.exported.total,
      files: plan.exported.files,
      overview: buildPushOverview(plan),
    }, null, 2))
    return 0
  }

  const overview = buildPushOverview(plan)
  console.log(`已导出 ${plan.exported.total} 个文件：`)
  console.log(`  ${plan.exported.exportPath}`)
  console.log('')
  for (const stat of overview.stats) {
    console.log(`  ${stat.label}：${stat.value}`)
  }
  console.log('')
  console.log('打开上面目录里的「概要.md」可以逐项核对。')
  return 0
}

/**
 * 推到云端。
 *
 * 分两步，和界面里同一个道理：先算一份差异给你看，加 --yes 才真的写。
 * 不加 --yes 时连本地导出都不做——先让人看清要推什么，再决定。
 */
async function cmdPush({ service, dshRoot }, options) {
  if (!service.isConfigured()) {
    console.error('还没配置云端仓库。加一个 --repo <地址>，或在插件设置里填上。')
    return 1
  }

  const stamp = timestamp()
  const plan = await service.preparePush({
    generatedBy: options.branch === undefined ? 'cli' : `cli@${options.branch}`,
    exportRoot: options.args[0] ?? service.defaultExportRoot(),
    stamp,
  })

  const summary = plan.summary ?? { add: 0, modify: 0, delete: 0 }
  if (options.json) {
    console.log(JSON.stringify({
      willPush: plan.files.map(f => f.path),
      comparedWithRemote: plan.comparedWithRemote,
      summary,
      exportPath: plan.exported?.exportPath ?? null,
    }, null, 2))
  } else {
    console.log(`数据根目录：${dshRoot}`)
    console.log(`准备推送 ${plan.files.length} 个文件：`)
    for (const file of plan.files) console.log(`  ${file.path}`)
    if (plan.comparedWithRemote) {
      console.log(`与云端相比：新增 ${summary.add}、修改 ${summary.modify}`)
      if ((summary.delete ?? 0) > 0) {
        console.log(`云端另有 ${summary.delete} 项本机没有——不会被删掉，本程序从不删除本机的东西。`)
      }
    } else {
      console.log('没有与云端比对（这一份只说明本机有什么）。')
    }
    if (plan.exported?.exportPath) {
      console.log(`本地也留了一份可核对的副本：${plan.exported.exportPath}`)
    }
  }

  if (!options.yes) {
    console.log('')
    console.log('以上是预览，**没有写入任何地方**。确认无误后加 --yes 再跑一次。')
    return 0
  }

  const result = await service.confirmPush(plan)
  console.log('')
  console.log(`已推送到云端：${result.pushed.length} 个文件`)
  return 0
}

/**
 * 从云端拉回本机。
 *
 * 默认只算差异。加 --yes 才会写本机，写之前先备份。
 */
/**
 * 打印兼容性检查结果。
 *
 * 只打 warn 与 block：ok 的那些是「不需要做什么」，逐条报出来只会把
 * 真正要注意的几条淹掉。全绿时也要说一句——用户需要知道检查跑过了。
 */
function printCompat(compat) {
  if (compat === null || compat === undefined) return
  const notable = compat.items.filter(entry => entry.level !== 'ok')
  console.log('')
  if (notable.length === 0) {
    console.log(`兼容性检查：${compat.counts.ok} 项都没有问题。`)
    return
  }
  console.log(`兼容性检查：${notable.length} 项需要注意（不会阻止执行，除非标了「停」）`)
  for (const entry of notable) {
    const mark = entry.level === 'block' ? '停' : '!'
    console.log(`  ${mark} ${entry.message}`)
    console.log(`    → ${entry.action}`)
  }
}

async function cmdPull({ service, dshRoot }, options) {
  if (!service.isConfigured()) {
    console.error('还没配置云端仓库。加一个 --repo <地址>，或在插件设置里填上。')
    return 1
  }

  const plan = await service.preparePull()
  const summary = plan.summary ?? { add: 0, modify: 0, delete: 0 }

  if (options.json) {
    console.log(JSON.stringify({
      diff: plan.diff,
      summary,
      compat: plan.compat ?? null,
      cloudRows: plan.remoteRows.map(row => row.id ?? '(无 id)'),
    }, null, 2))
  } else {
    console.log(`数据根目录：${dshRoot}`)
    console.log(`云端与本机相比：新增 ${summary.add}、修改 ${summary.modify}`)
    for (const item of plan.diff) {
      // delete 在这里的含义是「本机有、云端没有」。标注清楚，
      // 免得用户以为点 --yes 会把本机的条目删掉——我们从不删本机的东西。
      const mark = item.action === 'add' ? '＋' : item.action === 'delete' ? '·' : '～'
      const note = item.action === 'delete' ? '（本机独有，不会删除）' : ''
      console.log(`  ${mark} ${item.path}${note}`)
    }
  }

  if (!options.json) printCompat(plan.compat)

  if (!options.yes) {
    if (plan.compat?.blocked) {
      console.log('')
      console.log('上面标了「停」的项必须先处理：直接写下去不会报错，但也不会生效。')
      return 1
    }
    console.log('')
    console.log('以上是预览，**本机文件一个字节都没改**。确认无误后加 --yes 再跑一次。')
    return 0
  }

  const report = await service.applyPull(plan, { backupRoot: service.defaultBackupRoot() })
  const view = buildReportView(report)
  console.log('')
  console.log(`已应用 ${view.applied.length} 项，跳过 ${view.skipped.length} 项。`)
  for (const notice of view.notices) console.log(`· ${notice}`)
  if (report.backupPath) console.log(`覆盖前的原件已备份到：${report.backupPath}`)
  return 0
}

async function cmdDoctor({ service, dshRoot }, options) {
  const checks = []
  checks.push({ name: '数据根目录可读', ok: existsSync(dshRoot), detail: dshRoot })
  checks.push({
    name: '云端仓库已配置',
    ok: service.isConfigured(),
    detail: service.isConfigured() ? '已配置' : '未配置（第一阶段不需要）',
  })

  if (options.json) {
    console.log(JSON.stringify({ dshRoot, checks }, null, 2))
    return 0
  }
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '·'} ${c.name}：${c.detail}`)
  }
  return 0
}

/**
 * 导入：先算计划给人看，加 --yes 才真的写。
 *
 * 为什么命令行也要两步
 * ────────────────────
 * 按设计 §3.2，写入本机配置是一次需要人过目的动作。界面上那一步是「点确认」，
 * 命令行上就该是「加 --yes」——如果这里一步写完，那这条纪律就只剩界面在遵守，
 * 而界面恰恰是最容易被绕开的那一层。
 *
 * 不加 --yes 时**一个字节都不写**，并且明说这件事，免得用户以为已经导进去了。
 */
async function cmdImport({ service }, options) {
  const packageDir = options.args[0]
  if (packageDir === undefined) {
    console.error('请给出要导入的包目录：dsh-settings-roam import <目录>')
    console.error('运行 dsh-settings-roam help 查看用法。')
    return 2
  }

  let plan
  try {
    plan = await service.prepareImport({ packageDir })
  } catch (error) {
    console.error(`这份包不能用：${error?.message ?? error}`)
    return 1
  }

  if (options.json && options.yes !== true) {
    console.log(JSON.stringify({
      packageDir: plan.packageDir,
      generatedAt: plan.generatedAt,
      generatedBy: plan.generatedBy,
      empty: plan.empty,
      willWrite: plan.patchRows.map(row => `patch:${row.id}`).concat(plan.skillFiles.map(f => f.path)),
      willNotWrite: plan.refused,
      summary: plan.summary,
      compat: plan.compat ?? null,
      dryRun: true,
    }, null, 2))
    return 0
  }

  if (!options.json) {
    console.log(`包目录：${plan.packageDir}`)
    if (plan.generatedAt) console.log(`导出时间：${plan.generatedAt}（来自 ${plan.generatedBy ?? '未知'}）`)
    console.log('')

    if (plan.empty) {
      console.log('这份包里没有需要写回本机的内容。')
    } else {
      console.log(`将写入本机：${plan.patchRows.length + plan.skillFiles.length} 项`)
      for (const row of plan.patchRows) console.log(`  + 配置 ${row.id}`)
      for (const file of plan.skillFiles) console.log(`  + 技能 ${file.path}`)
    }

    if (plan.refused.length > 0) {
      console.log('')
      console.log(`不会写回本机：${plan.refused.length} 项`)
      for (const item of plan.refused) {
        console.log(`  · ${explainSkip({ ...item, name: item.name ?? item.path })}`)
      }
    }
  }

  if (!options.json) printCompat(plan.compat)

  if (options.yes !== true) {
    if (options.json) return 0
    if (plan.compat?.blocked) {
      console.log('')
      console.log('上面标了「停」的项必须先处理：直接写下去不会报错，但也不会生效。')
      return 1
    }
    console.log('')
    console.log('以上只是计划，本机还没有任何改动。确认无误后加上 --yes 再执行一次。')
    return 0
  }

  const report = await service.applyImport(plan)
  const view = buildReportView(report)

  if (options.json) {
    console.log(JSON.stringify({ packageDir: plan.packageDir, ...report, view }, null, 2))
    return 0
  }

  console.log('')
  console.log(`已写入 ${report.applied.length} 项。`)
  for (const item of report.applied) console.log(`  ✓ ${item.name}`)

  if (view.skipped.length > 0) {
    console.log('')
    console.log(`${view.skipped.length} 项没有写回本机（这不是失败）：`)
    for (const item of view.skipped) {
      console.log(`  · ${explainSkip({ ...item, name: item.name ?? item.path })}`)
    }
  }

  for (const notice of view.notices) {
    console.log('')
    console.log(`注意：${notice}`)
  }

  if (report.backupPath !== '') {
    console.log('')
    console.log(`覆盖前的原件已备份到：${report.backupPath}`)
  }
  return 0
}

async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.options.help || parsed.command === 'help') {
    console.log(USAGE)
    return 0
  }

  const commands = {
    inspect: cmdInspect,
    export: cmdExport,
    import: cmdImport,
    push: cmdPush,
    pull: cmdPull,
    doctor: cmdDoctor,
  }
  const run = commands[parsed.command]
  if (!run) {
    console.error(`未知命令：${parsed.command}`)
    console.error('运行 dsh-settings-roam help 查看用法。')
    return 2
  }

  const context = buildService(parsed.options)
  // 把选项与位置参数摊平成同一层再交给命令处理函数。
  // 原先传的是整个 parsed（选项在 parsed.options 下），而命令里读的是
  // options.json —— 于是 --json 静默失效：不报错，只是照常输出人读格式。
  // 这类「参数解析对了但没接上线」的问题只有真跑一次进程才看得见。
  return run(context, { ...parsed.options, args: parsed.args })
}

// 仅在直接执行时跑 main；被测试 import 时不自动执行。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code },
    error => {
      console.error(`执行失败：${error?.message ?? error}`)
      process.exitCode = 1
    },
  )
}
