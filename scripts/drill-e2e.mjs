#!/usr/bin/env node
/**
 * 第一期端到端演练（Task 15）。
 *
 * 前面每个任务都是分模块验证的。这个脚本把整条链路在**两个独立数据根目录**
 * 上真的跑一遍，验证设计 §3.2（推送）与 §3.3（拉取）两条流程能否走通。
 *
 * 为什么必须专门有这个脚本：
 * 前 14 个任务各自绿灯，推不出整链路成立。Task 14 已经证明过一次——
 * 三个缺陷全都只在真实装配时出现。契约边界、时序、路径处理同理。
 *
 * 演练的核心命题（本项目存在的理由）：
 *   主机 A 的局域网 IP 绝不能跟着配置漂到从机 B 上。
 * 整份快照里只有 llm-pi-ai 一项该跨机器，其余 8 项都是本机的。
 *
 * 用法：node scripts/drill-e2e.mjs
 * 退出码 0 表示全部核对项通过。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGitBackend } from '../src/backends/git.js'
import { PACKAGE_NAME } from '../src/constants.js'
import { createSyncService } from '../src/service.js'
import { parsePatchList } from '../src/yaml-loader.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')

const root = join('/tmp', `roam-drill-${process.pid}`)
const repo = join(root, 'cloud.git')
const machineA = join(root, 'machine-a')
const machineB = join(root, 'machine-b')

/** 语义深比较（键顺序无关）。 */
function deepEqual(a, b) {
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b))
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortDeep(v[k])]))
  }
  return v
}

/** 核对结果累积。 */
const checks = []
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail })
  console.log(`${passed ? '✓' : '✗'} ${name}${detail === '' ? '' : ` —— ${detail}`}`)
}

/**
 * 主机 A 的真实配置样本。
 *
 * 取自本机实际的 cordis.patch.yml，但把局域网地址换成了占位地址——
 * 演练记录要进版本库，不能带上真实的机器信息。
 * 结构、条目数、每项归属都与真实样本一致（9 个顶层条目）。
 */
const PATCH_A = `# LAN bind: DSH rejects 0.0.0.0; use the concrete LAN address.
- id: webserver
  config:
    host: '10.0.0.7'
    port: 3080
- id: dsh-auth-gate
  config:
    mode: password
    cookieSecure: false
    publicHost: '10.0.0.7:3080'
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
        models:
          - id: deepseek-v4.1-flash
            name: OP | DeepSeek V4.1 Flash
            contextWindow: 1000000
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: muyuan
    model: deepseek-v4.1-flash
- id: typert-gateway
  config:
    websocketHeartbeatIntervalMs: 15000
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: danger-full-access
- id: session-log-deepseek
  name: "@deepseek-ai/dsh-session-log-deepseek"
  config:
    enabled: false
`

/**
 * 从机 B 自己的配置：局域网地址不同、主题不同、默认模型不同。
 * 这些差异在拉取后必须**原样保留**——它们正是「本机」的含义。
 */
const PATCH_B = `- id: webserver
  config:
    host: '10.0.0.9'
    port: 3080
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      stale-provider:
        apiKeyEnv: STALE_KEY
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: workspace-write
`

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/**
 * 取云端提交历史。
 * 空仓库时 git log 会以退出码 128 失败，这是正常的「还没有任何提交」，
 * 不是错误，故单独处理，避免脚本在干净起步时崩掉。
 */
function commitLog() {
  try {
    return execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/**
 * 某台机器的 profile 配置路径。
 *
 * 刻意用 DSH 的真实布局 profiles/<名>/cordis.patch.yml，而不是数据根目录下。
 * 演练第一版把配置直接放在数据根目录，与真实布局不同构，于是
 * 「按 profile 解析路径」这个改动在演练里完全测不出来——而它恰恰是
 * 让工具对真实数据读到 0 个条目的那处缺陷。fixture 必须与真实布局同构。
 */
function patchPathOf(dshRoot) {
  return join(dshRoot, 'profiles', 'web', 'cordis.patch.yml')
}

function setupMachine(dir, patchContent, skills = {}) {
  mkdirSync(dir, { recursive: true })
  mkdirSync(dirname(patchPathOf(dir)), { recursive: true })
  writeFileSync(patchPathOf(dir), patchContent)
  for (const [name, files] of Object.entries(skills)) {
    const skillDir = join(dir, 'skills', name)
    mkdirSync(skillDir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      const target = join(skillDir, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
  }
}

function serviceFor(dshRoot, repoUrl) {
  const workDir = join(dshRoot, 'settings-roam', 'work')
  return createSyncService({
    dshRoot,
    backend: () => createGitBackend({ repoUrl, workDir }),
  })
}

function rowsOf(dshRoot) {
  return parsePatchList(readFileSync(patchPathOf(dshRoot), 'utf8'))
}

/**
 * 取某个顶层条目的解析结果，用于比对是否被改动。
 *
 * 这里比对的是**解析后的值**，不是原始文本片段。
 * 演练第一版比的是文本，误报了三条「本机配置被改动」——实际原因是
 * 重渲染会把 '10.0.0.9' 写成 10.0.0.9，语义完全相同。断言必须比语义，
 * 否则制造假警报。注释与格式的变化是已知代价（技术取舍的方案 A）。
 */
function entryOf(dshRoot, id) {
  return rowsOf(dshRoot).find(r => r.id === id) ?? null
}

try {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  // ---------- Step 1: 两台机器 + 一个云端裸库 ----------
  git(['init', '--bare', '--quiet', repo])

  setupMachine(machineA, PATCH_A, {
    'demo-skill': { 'SKILL.md': '# Demo\n用来说明技能会被收进快照。\n' },
  })
  setupMachine(machineB, PATCH_B, {})

  console.log('\n=== Step 1 准备 ===')
  check('两个模拟机器与云端裸库已就绪', existsSync(repo) && existsSync(machineA) && existsSync(machineB))

  // ---------- Step 2: 在 A 上推送 ----------
  console.log('\n=== Step 2 推送（设计 §3.2）===')
  const svcA = serviceFor(machineA, repo)

  // 设计 §3.2 的有意确认：prepare 只读，confirm 才落盘。
  const plan = await svcA.preparePush({ generatedBy: 'machine-a', bundles: [] })

  const patchEntry = plan.files.find(f => f.path === 'config/profile.patch.yml')
  check('推送计划含公共线 patch 文件', patchEntry !== undefined)

  const pushedIds = parsePatchList(patchEntry.content).map(r => r.id)
  check('公共线只含 llm-pi-ai', pushedIds.length === 1 && pushedIds[0] === 'llm-pi-ai',
    `实际含：${pushedIds.join(', ')}`)

  check('主机 A 的局域网地址不在快照里', !patchEntry.content.includes('10.0.0.7'),
    '这是本项目要解决的根本问题')

  const allPushed = plan.files.map(f => f.content).join('\n')
  for (const leaked of ['webserver', 'ui-theme', 'permission', 'agent-default-model', 'typert-gateway']) {
    check(`本机条目 ${leaked} 未进入任何推送文件`, !allPushed.includes(leaked))
  }

  check('技能目录被收进快照', plan.files.some(f => f.path === 'skills/demo-skill/SKILL.md'))

  // prepare 阶段绝不能碰云端
  const beforePush = commitLog()
  check('prepare 阶段云端没有任何提交（确认点前不落盘）', beforePush === '')

  // 用户确认后执行
  await svcA.confirmPush(plan, '设置漫游：来自 machine-a')
  const afterPush = commitLog()
  check('confirm 后云端出现一次提交', afterPush.split('\n').filter(Boolean).length === 1)
  check('提交信息带来源标识', afterPush.includes('machine-a'))

  // ---------- Step 3: 在 B 上拉取 ----------
  console.log('\n=== Step 3 拉取（设计 §3.3）===')
  const svcB = serviceFor(machineB, repo)
  const pullPlan = await svcB.preparePull()

  const bBefore = {
    webserver: entryOf(machineB, 'webserver'),
    uiTheme: entryOf(machineB, 'ui-theme'),
    permission: entryOf(machineB, 'permission'),
  }

  const report = await svcB.applyPull(pullPlan, { backupRoot: join(machineB, 'backup') })

  const bRows = rowsOf(machineB)
  const bLlm = bRows.find(r => r.id === 'llm-pi-ai')
  check('B 的 llm-pi-ai 被更新为 A 的内容',
    bLlm !== undefined && bLlm.config.providers['opencode-go'] !== undefined,
    `实际 providers：${Object.keys(bLlm?.config?.providers ?? {}).join(', ')}`)

  check('B 原来的 stale-provider 被整体替换（config 全量替换，非深合并）',
    bLlm?.config?.providers?.['stale-provider'] === undefined)

  const bAfter = {
    webserver: entryOf(machineB, 'webserver'),
    uiTheme: entryOf(machineB, 'ui-theme'),
    permission: entryOf(machineB, 'permission'),
  }
  check('B 的 webserver 本机配置一处未动（比语义）',
    deepEqual(bAfter.webserver, bBefore.webserver), 'host 与 port 应逐字段相同')
  check('B 的主题未变（本机判定生效）',
    deepEqual(bAfter.uiTheme, bBefore.uiTheme), `实际：${JSON.stringify(bAfter.uiTheme?.config)}`)
  check('B 的权限预设未变（本机判定生效）',
    deepEqual(bAfter.permission, bBefore.permission), `实际：${JSON.stringify(bAfter.permission?.config)}`)

  check('B 的 webserver 仍是自己的地址 10.0.0.9',
    bAfter.webserver?.config?.host === '10.0.0.9')
  check('A 的地址没有漂到 B',
    !readFileSync(patchPathOf(machineB), 'utf8').includes('10.0.0.7'),
    '核心命题：本机地址不跨机器')

  const view = report
  check('报告指出需要补的密钥引用', Array.isArray(view.needsCredentials)
    && view.needsCredentials.includes('OPENCODE_GO_API_KEY'),
  `实际：${(view.needsCredentials ?? []).join(', ')}`)

  check('报告带备份位置（回退路径可用）', typeof view.backupPath === 'string' && view.backupPath !== '')
  // 演练发现的真实缺陷：报告曾返回备份根目录而非备份本身，用户照着找不到副本。
  check('报告给的备份路径就是备份本身，不是它的父目录',
    view.backupPath !== join(machineB, 'backup'))
  check('备份路径里真的找得到拉取前的副本',
    view.backupPath !== '' && existsSync(join(view.backupPath, join(machineB, 'profiles', 'web', 'cordis.patch.yml'))))

  check('报告提示需要重启', view.needsRestart === true)

  // ---------- Step 4: 反向验证——失败要说人话 ----------
  console.log('\n=== Step 4 失败路径 ===')
  const { buildReportView, explainSkip } = await import('../src/report.js')

  // 4a. 让云端出现一个来自本机路径的插件，再拉一次
  const svcA2 = serviceFor(machineA, repo)
  const plan2 = await svcA2.preparePush({ generatedBy: 'machine-a', bundles: [] })
  await svcA2.confirmPush(plan2, '设置漫游：第二次')

  const skippedView = buildReportView({
    applied: [],
    skipped: [{ kind: 'plugin', name: 'local-only-plugin', result: 'skipped', reason: 'local-path-source', detail: '/home/alice/src/local-only-plugin' }],
    needsRestart: false,
    needsCredentials: [],
    backupPath: '/tmp/x',
  })
  const explained = skippedView.plugins[0].explanation
  check('跳过项说明指出了原始路径', explained.includes('/home/alice/src/local-only-plugin'))
  check('跳过项说明给出了下一步怎么做', /发布到 registry|git/.test(explained))
  check('跳过项明确标出插件未安装', skippedView.plugins[0].installed === false)

  const fiveReasons = ['local-path-source', 'version-incompatible', 'registry-unreachable', 'build-blocked', 'unknown']
    .map(r => explainSkip({ reason: r, name: 'p' }))
  check('五类跳过原因各有不同说明，不是一句「失败」',
    new Set(fiveReasons).size === 5)
  check('版本不兼容被解释为保护而非故障',
    /保护|不是故障/.test(explainSkip({ reason: 'version-incompatible', name: 'p' })))

  // 4b. 回退
  //
  // 注意期望值是**拉取前**的状态。备份存的是拉取前那份，回退的意义就是撤销拉取。
  // 演练第二版误把「拉取后」当期望值，白报了一次失败——回退正确反而是它判错。
  const { restoreFromBackup } = await import('../src/backup.js')
  const targetFile = patchPathOf(machineB)
  const afterPullText = readFileSync(targetFile, 'utf8')
  writeFileSync(targetFile, '# 模拟被写坏\n')
  const rolled = restoreFromBackup(
    { backupPath: view.backupPath, backedUp: view.backupFiles, failed: [] },
    [targetFile],
  )
  const restoredText = readFileSync(targetFile, 'utf8')
  check('回退执行无失败项', rolled.failed.length === 0,
    `失败项：${JSON.stringify(rolled.failed)}`)
  check('回退后不再是被写坏的样子', restoredText !== '# 模拟被写坏\n')
  check('回退回到的是拉取前的状态，而非拉取后', restoredText !== afterPullText)
  check('回退后 B 的公共条目恢复为拉取前那份（只剩 stale-provider）',
    entryOf(machineB, 'llm-pi-ai')?.config?.providers?.['opencode-go'] === undefined)

  // ---------- Step 5: 本地包导入（第二阶段：不联网也能回填）----------
  //
  // 这一段刻意不复用 A/B 与裸库：第二阶段要证的正是「连不上 git 也能恢复」。
  // 用一台全新机器 C，只给它一个目录里的导出包，看它能不能把配置与技能回填，
  // 同时保住自己的本机项。
  console.log('\n=== Step 5 本地包导入（第二阶段）===')
  const machineC = join(root, 'machine-c')
  const packageRoot = join(root, 'carried-package')

  setupMachine(machineC, PATCH_B, {})

  const svcA3 = serviceFor(machineA, repo)
  const packPlan = await svcA3.preparePush({
    generatedBy: 'machine-a',
    exportRoot: packageRoot,
    bundles: [],
  })
  const packageDir = packPlan.exported.exportPath
  check('导出包落到磁盘上', existsSync(join(packageDir, 'manifest.json')))

  const svcC = createSyncService({
    dshRoot: machineC,
    // 刻意不配后端：第二阶段要证的就是「没有云端也能恢复」。
    // createSyncService 允许 backend 缺席（装配时不构造），这是缺陷 2 修出来的行为。
  })

  const beforeCPatch = readFileSync(patchPathOf(machineC), 'utf8')

  // 5a. 预览绝不能动磁盘
  const importPlan = await svcC.prepareImport({ packageDir })
  check('导入预览不改本机配置文件',
    readFileSync(patchPathOf(machineC), 'utf8') === beforeCPatch)
  check('导入预览说清了会写回什么',
    importPlan.patchRows.some(r => r.id === 'llm-pi-ai'),
    `实际：${importPlan.patchRows.map(r => r.id).join(', ')}`)
  check('导入预览说清了什么不写回', importPlan.refused.length > 0,
    `不写回：${importPlan.refused.map(r => r.name ?? r.path).join(', ')}`)
  check('导入不需要云端仓库也能算出计划', svcC.isConfigured() === false)

  // 5b. 确认后才写
  const importReport = await svcC.applyImport(importPlan, { backupRoot: join(machineC, 'backups') })

  const cCrois = rowsOf(machineC)
  check('公共配置被写了进来',
    cCrois.find(r => r.id === 'llm-pi-ai')?.config?.providers?.['opencode-go'] !== undefined)
  check('机器 C 自己的监听地址没被换掉',
    cCrois.find(r => r.id === 'webserver')?.config?.host === '10.0.0.9')
  check('机器 A 的地址绝没有被带过来',
    !readFileSync(patchPathOf(machineC), 'utf8').includes('10.0.0.7'), '这是本项目要解决的根本问题')
  check('技能文件被重建', existsSync(join(machineC, 'skills', 'demo-skill', 'SKILL.md')))
  check('导入前先备份了（有退路）',
    typeof importReport.backupPath === 'string' && importReport.backupPath !== '')
  check('报告提示本机偏好没有随行',
    (importReport.skipped ?? []).some(item => /本机|不会/.test(item.explanation ?? '')))


  // ---------- Step 6: 更新插件自己（用户要求「每次卸载重装太麻烦」）----------
  console.log('\n=== Step 6 更新插件自己 ===')
  // 为什么换的是「带提交号的依赖写法」而不是重装同一个来源：
  // DSH 的安装入口靠「依赖声明有没有变」来判定装了哪一个包，没变时它会直接
  // 报 ambiguous-install（无法从依赖变更中确定安装了哪一个包）。把 spec 换成
  // 带具体提交号的形式，依赖字符串变了，那一步就能判定——这是自更新成立的前提。
  const REPO_SPEC = 'github:toookamak/dsh-settings-roam'
  const machineD = join(root, 'machine-d')
  const profileD = join(machineD, 'profiles', 'web')
  mkdirSync(profileD, { recursive: true })
  writeFileSync(patchPathOf(machineD), PATCH_A)

  const writeManifest = (dependencies) => writeFileSync(
    join(profileD, 'package.json'),
    `${JSON.stringify({ name: 'web', dependencies }, null, 2)}\n`,
  )
  const writeLock = (sha) => writeFileSync(join(profileD, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    `      '${PACKAGE_NAME}':`,
    `        specifier: ${REPO_SPEC}`,
    `        version: https://codeload.github.com/toookamak/dsh-settings-roam/tar.gz/${sha}`,
    '',
  ].join('\n'))

  writeManifest({ [PACKAGE_NAME]: REPO_SPEC })
  const installCalls = []
  const fakeManager = { installBundle: async (spec) => { installCalls.push(spec) } }
  const svcD = createSyncService({ dshRoot: machineD, pluginManager: () => fakeManager })

  const updStatus = await svcD.describeUpdate({})
  if (updStatus.reason === 'unreachable') {
    console.log('· 跳过：问不到远端仓库（这一步需要网络，离线时不算失败）')
  } else {
    check('认得出这个插件是从哪条依赖装的', updStatus.installedSpec === REPO_SPEC,
      `实际：${updStatus.installedSpec}`)
    check('问得到远端最新的提交号', /^[0-9a-f]{40}$/.test(updStatus.remoteCommit ?? ''),
      `远端 HEAD=${updStatus.remoteCommit}`)

    const updPlan = await svcD.prepareUpdate({})
    check('算出来的是「带具体提交号的依赖写法」',
      updPlan.nextSpec === `${REPO_SPEC}#${updStatus.remoteCommit}`,
      `实际：${updPlan.nextSpec}`)
    check('只检查、不确认时，一个包都不会被装', installCalls.length === 0)

    // 没有插件管理服务时不能假装成功：给一句能照做的改法，才是可行动的错误。
    const svcNoMgr = createSyncService({ dshRoot: machineD })
    let manual = null
    try {
      await svcNoMgr.applyUpdate(updPlan)
    } catch (error) {
      manual = error
    }
    check('拿不到插件管理服务时不假装成功，而是给出可照做的改法',
      manual?.code === 'update-unavailable' && manual?.nextSpec === updPlan.nextSpec,
      `实际：${manual?.code ?? '没有报错'}`)

    const updDone = await svcD.applyUpdate(updPlan)
    check('更新请求真的交给了插件管理服务，且用的是带提交号的那条',
      installCalls.length === 1 && installCalls[0] === updPlan.nextSpec,
      `实际：${installCalls.join(', ')}`)
    check('更新结果说清了更新到哪一版，以及要重启',
      updDone.updated === true && updDone.to === updPlan.remoteCommit.slice(0, 7))

    // 锁文件记下了当前提交时，就不该再报「有新版本」——否则会无休止地让人点更新。
    writeLock(updStatus.remoteCommit)
    const fresh = await svcD.describeUpdate({})
    check('已经是远端最新时不谎报有新版本', fresh.reason === 'up-to-date' && fresh.needsUpdate === false,
      `实际：${fresh.reason}`)
  }

  // ---------- 汇总 ----------
  const failed = checks.filter(c => !c.passed)
  console.log(`\n=== 汇总：${checks.length - failed.length}/${checks.length} 通过 ===`)
  if (failed.length > 0) {
    console.log('\n未通过项：')
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail === '' ? '' : ` —— ${f.detail}`}`)
  }
  process.exitCode = failed.length === 0 ? 0 : 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
