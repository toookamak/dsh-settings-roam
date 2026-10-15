#!/usr/bin/env node
/**
 * 界面预览：起一个隔离的 DSH 实例并装入本插件，用于在真实浏览器里看设置分区。
 *
 * 为什么不能只看单元测试：
 * loader-shape.test.js 用一个假 React 断言「组件函数返回了什么」，
 * 它永远看不见「长得丑不丑」「点了有没有反应」——那需要真浏览器。
 * 而用户正在用的实例（3080）背后是他自己的数据与登录态，
 * 既不能随便改，也不该拿去做试验。所以另起一个隔离实例。
 *
 * 与 verify-load.mjs 的区别：verify-load 是「跑完一轮断言就退出」，
 * 本脚本是「把实例留在那里等人来看」——前台运行，Ctrl-C 结束。
 *
 * 用法：
 *   node scripts/ui-preview.mjs [--port 3099] [--keep]
 *
 * 启动后终端会打印带 token 的访问地址，直接丢给浏览器即可。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePatchList, renderPatches } from '../src/yaml-loader.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const dshRepo = process.env.DSH_REPO ?? '/home/tokamak/dev/tools/deepseek-harness'
const cliBin = join(dshRepo, 'apps/cli/lib/bin.js')

const argv = process.argv.slice(2)
const portArg = argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : '3099'
const keep = argv.includes('--keep')

if (!existsSync(cliBin)) {
  console.error(`找不到 DSH CLI：${cliBin}（用 DSH_REPO 指定检出位置）`)
  process.exit(2)
}

const home = join('/tmp', `roam-ui-${portArg}`)
const profile = 'ui'
const profileDir = join(home, 'profiles', profile)

function run(args) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
    timeout: 180_000,
  })
}

rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })

const created = run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
if (created.status !== 0) {
  console.error('建立预览 profile 失败：')
  console.error(created.stderr || created.stdout)
  process.exit(2)
}

// 装插件：走官方安装流程，装的是当前工作区（link:）。
const added = run(['plugin', '--profile', profile, 'add', pluginRoot])
if (added.status !== 0) {
  console.error('安装插件失败：')
  console.error(added.stderr || added.stdout)
  process.exit(2)
}

// 我们的包声明了 dsh.bundle.patch，所以 `plugin add` 会把它列进
// package.json 的 dsh.profile.bundles，它自带的 cordis.patch.yml 随之被组合进来——
// 通常这一步就够了。先看一眼组合树，只有它没进去时才手动补一条 insert。
//
// 为什么要先看：两边都写会让同一个条目被插入两次。组合时按 id 取第一条，
// 于是先插进来的那份（没有 config）赢，设置页写入会被判成
// 「Configuration for ... is overridden by a home patch or command-line overlay」
// 而失败——一个看起来像插件坏了、实际是预览脚本自己制造的假故障。
//
// 另一个更隐蔽的自伤：**不能把这个文件整个覆盖掉**。
// 上一版在「已经组合进来」时把文件写成 `[]`，结果是把在界面上填过的
// 仓库地址、导入目录一并抹掉——于是「填好设置 → 重启实例 → 看有没有生效」
// 这条最需要验的路根本走不通，而症状看起来像插件没保存。
// 现在只做两件事：清掉我们自己可能留下的重复条目，其余内容原样不动。
const patchFile = join(profileDir, 'cordis.patch.yml')
const composed0 = run(['--profile', profile, '--dump-config'])
const alreadyComposed = (composed0.stdout ?? '').includes('dsh-settings-roam')

if (alreadyComposed) {
  if (existsSync(patchFile)) {
    const parsed = parsePatchList(readFileSync(patchFile, 'utf8'))
    const kept = parsed.filter(row => row?.id !== 'dsh-settings-roam'
      && !(Array.isArray(row?.insert) && row.insert.some(e => e?.id === 'dsh-settings-roam')))
    if (kept.length !== parsed.length) {
      writeFileSync(patchFile, renderPatches(kept, 'ui-preview 清理重复条目'))
      console.log('已从 profile 的 cordis.patch.yml 里清掉重复的本插件条目（其余内容保留）。')
    }
  }
} else {
  const parsed = existsSync(patchFile) ? parsePatchList(readFileSync(patchFile, 'utf8')) : []
  parsed.push({ insert: [{ id: 'dsh-settings-roam', name: '@toookamak/dsh-settings-roam' }] })
  writeFileSync(patchFile, renderPatches(parsed, 'ui-preview 补插本插件'))
}

const composed = alreadyComposed ? composed0 : run(['--profile', profile, '--dump-config'])
if (!(composed.stdout ?? '').includes('dsh-settings-roam')) {
  console.error('插件条目没有进入 Loader 组合树：')
  console.error((composed.stdout ?? '').slice(-1500))
  process.exit(2)
}

console.log(`预览实例数据根目录：${home}`)
console.log(`插件：${pluginRoot}（link，改完代码重启本脚本即可生效）\n`)

// 前台启动，把输出直接透传给终端——里面那行带 token 的地址就是访问入口。
const child = spawn(process.execPath, [
  cliBin, '--profile', profile, '--port', String(portArg), '--no-open',
], {
  env: { ...process.env, DSH_HOME: home },
  stdio: 'inherit',
})

const bye = () => {
  child.kill('SIGTERM')
  if (!keep) setTimeout(() => rmSync(home, { recursive: true, force: true }), 500).unref?.()
}
process.on('SIGINT', () => { bye(); process.exit(0) })
process.on('SIGTERM', () => { bye(); process.exit(0) })
child.on('exit', code => process.exit(code ?? 0))
