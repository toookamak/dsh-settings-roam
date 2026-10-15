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
import { buildPushOverview } from '../src/overview.js'

const USAGE = `设置漫游 —— 把一台机器的 DSH 配置搬到另一台

用法：
  dsh-settings-roam inspect           取一次配置并打印摘要（只读，不写任何地方）
  dsh-settings-roam export [目录]     取一次配置并导出到磁盘，供打开核对
  dsh-settings-roam doctor            检查数据根目录、云端仓库配置是否齐备
  dsh-settings-roam help              显示这份帮助

选项：
  --dsh-home <路径>   覆盖 DSH 数据根目录（默认 $DSH_HOME 或 ~/.dsh）
  --profile <名字>    指定要同步哪个 profile（默认自动判断唯一的一个）
  --repo <地址>       云端 git 仓库地址（未配置时 export 仍可用）
  --json              以 JSON 输出，便于脚本处理

说明：
  inspect 与 export 都不需要云端仓库——第一阶段的目标是「能取到配置」，
  没有网络也应当可用。涉及云端的动作会在后续阶段补上。
`

/** 极简参数解析。刻意不引第三方库：这个入口要能在任何环境直接跑起来。 */
export function parseArgs(argv) {
  const options = { json: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--dsh-home') options.dshHome = argv[++i]
    else if (arg === '--repo') options.repo = argv[++i]
    else if (arg === '--profile') options.profile = argv[++i]
    else if (arg.startsWith('--dsh-home=')) options.dshHome = arg.slice('--dsh-home='.length)
    else if (arg.startsWith('--repo=')) options.repo = arg.slice('--repo='.length)
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
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

async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.options.help || parsed.command === 'help') {
    console.log(USAGE)
    return 0
  }

  const commands = { inspect: cmdInspect, export: cmdExport, doctor: cmdDoctor }
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
