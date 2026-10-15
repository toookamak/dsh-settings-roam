#!/usr/bin/env node
/**
 * 真装载验收：确认插件能被 DSH 实际装载并激活。
 *
 * 为什么必须单独有这个脚本，而不是只写单元测试：
 * Task 14 暴露的三个缺陷（DSH 根目录取到 undefined、后端必须在装配时就存在、
 * 直接往 ctx 赋值被 DI 拒绝）**单元测试一个都抓不到**——它们只在真实 Loader
 * 装载与 Cordis DI 生效时才会出现。前 14 个任务的绿灯推不出整链路成立。
 *
 * 用法：
 *   node scripts/verify-load.mjs
 *
 * 前置：需要一个装了本插件的测试 profile。脚本会自己建一个隔离的
 *       DSH_HOME（/tmp 下），不碰用户正在用的 profile。
 *
 * 退出码 0 表示验收通过；非 0 且打印 "entry did not activate" 表示插件未激活。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')

/** DSH 检出位置。可由环境变量覆盖，便于在别处运行。 */
const dshRepo = process.env.DSH_REPO ?? '/home/tokamak/dev/tools/deepseek-harness'
const cliBin = join(dshRepo, 'apps/cli/lib/bin.js')

if (!existsSync(cliBin)) {
  console.error(`找不到 DSH CLI：${cliBin}`)
  console.error('设置 DSH_REPO 指向 deepseek-harness 检出位置。')
  process.exit(2)
}

const home = join('/tmp', `roam-verify-${process.pid}`)
const profile = 'roamverify'
const profileDir = join(home, 'profiles', profile)

function run(args, options = {}) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
    timeout: 120_000,
    ...options,
  })
}

/**
 * 启动 profile 并收集输出，然后主动终止。
 *
 * web app 会一直在前台监听，不会自己退出，所以不能用 spawnSync 等它结束——
 * 那会把验收脚本永久挂住（实测如此）。
 * 这里在「疑似已经启动完成」时发 SIGTERM，或者用 timeout 兜底。
 * @param {number} waitMs - 最长等待时间
 * @returns {string} 合并后的输出
 */
function bootAndCapture(waitMs = 45_000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliBin, '--profile', profile], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(out)
    }
    const onData = (chunk) => {
      out += chunk
      // 一旦看到服务监听或激活告警，就说明装载阶段已经结束
      if (/dsh web: http|did not activate|设置漫游已就绪/.test(out)) {
        clearTimeout(graceTimer)
        // 稍等片刻收集同批日志，然后终止
        graceTimer = setTimeout(() => {
          child.kill('SIGTERM')
          finish()
        }, 800)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', finish)

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish()
    }, waitMs)
    let graceTimer = null
  })
}

function cleanup() {
  rmSync(home, { recursive: true, force: true })
}

let failed = false

try {
  // 1. 建一个隔离的 profile，来源与线上一致（web 模板）
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const created = run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  if (created.status !== 0) {
    console.error('建立测试 profile 失败：')
    console.error(created.stderr || created.stdout)
    process.exit(2)
  }

  // 2. 把插件装进去。用 link: 指向本仓库，装的是当前工作区而不是发布版——
  //    这正是我们要验收的对象。
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies = {
    ...(manifest.dependencies ?? {}),
    '@toookamak/dsh-settings-roam': `link:${pluginRoot}`,
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const patched = run(['plugin', '--profile', profile, 'add', pluginRoot])
  if (patched.status !== 0) {
    console.error('安装插件失败：')
    console.error(patched.stderr || patched.stdout)
    process.exit(2)
  }

  // 3. 在 profile 的 patch 层插入条目。
  //    这一步是必需的：只装包不会让插件进 Loader 树，
  //    `dsh plugin add` 只做依赖安装。
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# 由 verify-load.mjs 生成，仅用于验收。',
    '- insert:',
    '    - id: dsh-settings-roam',
    "      name: '@toookamak/dsh-settings-roam'",
    '',
  ].join('\n'))

  // 4. 组合树里必须出现我们的条目
  const composed = run(['--profile', profile, '--dump-config'])
  const tree = composed.stdout ?? ''
  if (!tree.includes('dsh-settings-roam')) {
    console.error('✗ 插件条目没有进入 Loader 组合树')
    console.error(tree.slice(-2000))
    failed = true
  } else {
    console.log('✓ 插件条目已进入 Loader 组合树')
  }

  // 5. 真正启动一次，看有没有 "did not activate"。
  //    这是本脚本存在的理由：装载期行为只能靠真装一次来看。
  const output = await bootAndCapture()

  if (/did not activate/.test(output)) {
    console.error('✗ 插件未能激活：')
    for (const line of output.split('\n')) {
      if (/dsh-settings-roam|did not activate|Error|error/.test(line)) console.error(`  ${line}`)
    }
    failed = true
  } else {
    console.log('✓ 无 "did not activate" 告警——插件已被 Loader 成功激活')
  }

  if (/dsh web: http/.test(output)) {
    console.log('✓ DSH 正常启动到服务监听阶段')
  } else {
    console.error('✗ DSH 未到达服务监听阶段，装载可能中途失败')
    console.error(output.slice(-1500))
    failed = true
  }
} finally {
  cleanup()
}

if (failed) {
  console.error('\n真装载验收未通过。')
  process.exit(1)
}
console.log('\n真装载验收通过。')
