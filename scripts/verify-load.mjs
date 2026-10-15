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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')

/** 本插件的包名。载荷层与组合树里都用它做断言，写一处免得对不上。 */
const PLUGIN_NAME = '@toookamak/dsh-settings-roam'

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

/**
 * 向系统要一个当下空闲的端口。
 *
 * 让 DSH 自己挑是不行的：它的缺省值是 3080，本机常常已经有实例占着。
 * @returns {Promise<number>} 可用的端口号
 */
function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => { resolvePromise(port) })
    })
  })
}

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
function bootAndCapture(waitMs = 45_000, required = [], probe = null, port = null) {
  return new Promise((resolvePromise) => {
    // 端口必须自己挑一个空闲的再显式传进去。不传时 DSH 会落到默认的 3080
    // （packages/bundle/web-app/cordis.patch.yml:184 `ctx.webStartup.port ?? 3080`），
    // 而本机可能正有一个真实实例在监听同一个端口——验收请求就会打到那个实例上：
    // 插件当然「不存在」，甚至可能往用户的真实数据根里写导出文件。
    // 这类失败看起来像插件坏了，其实是脚本端口撞了。
    const args = [cliBin, '--profile', profile]
    if (port !== null) args.push('--port', String(port))
    const child = spawn(process.execPath, args, {
      env: { ...process.env, DSH_HOME: home, ROAM_PROBE_OUT: join(home, "roam-probe.log") },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let settled = false
    let graceTimer = null
    let probing = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      resolvePromise(out)
    }
    const stop = () => {
      child.kill('SIGTERM')
      finish()
    }
    // probe 是「趁进程还活着问它一句」的机会：真发一次 HTTP 请求，
    // 比事后看日志有没有报错强得多——路由指歪了、没注册上都只有真请求才知道。
    const runProbe = () => {
      if (probing) return
      probing = true
      const url = (out.match(/dsh web:\s*(https?:\/\/\S+)/) ?? [])[1] ?? null
      Promise.resolve()
        .then(() => (probe === null ? undefined : probe(url, out)))
        .catch(error => { probeError = error })
        .finally(() => { clearTimeout(graceTimer); stop() })
    }
    const ready = () => {
      // 必须等所有期望的信号都出现再收尾，否则会在探针打印之前就把它杀掉。
      // 初版只等「服务监听」，结果探针的定时输出永远来不及出现。
      const base = /dsh web: http|did not activate/.test(out)
      return base && required.every(pattern => pattern.test(out))
    }
    const onData = (chunk) => {
      out += chunk
      if (ready() && !probing) {
        clearTimeout(graceTimer)
        // 稍等片刻收集同批日志，再发请求
        graceTimer = setTimeout(runProbe, 400)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', finish)

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish()
    }, waitMs)
  })
}

/** 请求探针带出来的结果，供第 8 步断言。 */
let routeProbe = {
  attempted: false, error: null, status: null, body: null,
  exportStatus: null, exportBody: null,
}
let probeError = null

function cleanup() {
  // ROAM_KEEP=1 时保留隔离目录，便于事后翻日志排查；默认清理干净。
  if (process.env.ROAM_KEEP === '1') {
    console.log(`（ROAM_KEEP=1，保留隔离目录 ${home}）`)
    return
  }
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
  //
  //    刻意**不**先手写 manifest 里的依赖：`dsh plugin add` 是在
  //    「依赖名在装之前不存在」的前提下才把它追加进 dsh.profile.bundles
  //    （packages/boot/plugin-manager/src/operations.ts:93
  //    `if (beforeDeps.has(name)) continue`）。先手写一行 link: 会让这一步
  //    被跳过，插件于是既不进 bundles 也不进组合树——一个由验收脚本自己
  //    制造的假故障，看起来却像插件坏了。
  const patched = run(['plugin', '--profile', profile, 'add', pluginRoot])
  if (patched.status !== 0) {
    console.error('安装插件失败：')
    console.error(patched.stderr || patched.stdout)
    process.exit(2)
  }

  // 它必须作为 profile 层被登记。这是「插件的 cordis.patch.yml 会被组合进来」
  // 的前提；只登记依赖而不登记 bundle，装载期什么都不会发生。
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const registeredBundles = manifest.dsh?.profile?.bundles ?? []
  if (!registeredBundles.includes(PLUGIN_NAME)) {
    console.error(`✗ 插件没有被登记为 profile 层（dsh.profile.bundles）：${JSON.stringify(registeredBundles)}`)
    failed = true
  }

  // 3. 在 profile 的 patch 层插入条目。
  //    这一步是必需的：只装包不会让插件进 Loader 树，
  //    `dsh plugin add` 只做依赖安装。
  //    顺带装一个探针插件：它只做一件事——把 ctx.settings.describe() 里
  //    属于本插件的那一条打印出来。设置页的表单来自 describe() 的投影，
  //    只有真的调一次才知道字段到底进没进表单（漏 .volatile() 时是静默跳过）。
  const probeDir = join(home, 'roam-probe')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(join(probeDir, 'package.json'), JSON.stringify({
    name: 'roam-probe', version: '0.0.0', type: 'module', main: 'index.js',
  }, null, 2) + '\n')
  writeFileSync(join(probeDir, 'index.js'), [
    "import { appendFileSync } from 'node:fs'",
    "const probeOut = process.env.ROAM_PROBE_OUT ?? '/tmp/roam-probe.log'",
    "const require$ = () => ({ appendFileSync })",
    "export const name = 'roam-probe'",
    "export const inject = ['settings']",
    'export function apply(ctx) {',
    '  const dump = (tag) => {',
    '    try {',
    "      const rows = ctx.settings.describe().filter(r => String(r.ns).includes('settings-roam'))",
    // descriptor.schema 是 $ref 风格的 JSON（{uid, refs}），根对象在 refs[uid] 上，
    // 它的 dict 又把字段名映射到 refs 的下标（数字）。直接读 schema.dict 会得到
    // undefined —— 实测踩过，表现为「条目在，但字段列表是空的」。
    '      const view = rows.map(r => {',
    '        const root = r.schema?.refs?.[r.schema?.uid] ?? r.schema',
    '        const base = root?.meta?.default ?? {}',
    '        return {',
    '          ns: String(r.ns), autoGenerate: r.autoGenerate,',
    '          keys: Object.keys(root?.dict ?? {}),',
    '          defaults: base,',
    '        }',
    '      })',
    // 必须用 warn 而不是 info：官方日志管道默认只导出到 warn 级
    // （packages/boot/app-boot/src/index.ts:987 的 levels: { default: 2 }），
    // 用 info 打印的探针输出根本到不了终端——这一点实测踩过。
    // 直接写 stderr，不走 ctx.logger：
    // 实测 ctx.logger 的输出到不了这个进程的终端（官方日志管道默认只导出到
    // warn 级，而导出目标也不是启动进程的 stdio）。探针只求「能把结果带出来」，
    // 因此绕开日志系统，顺手落一份文件便于事后核对。
    "      const line = 'ROAM-PROBE ' + tag + ' ' + JSON.stringify(view)",
    "      process.stderr.write(line + '\\n')",
    "      try { require$('node:fs').appendFileSync(probeOut, line + '\\n') } catch {}",
    "    } catch (error) { process.stderr.write('ROAM-PROBE ' + tag + ' ERROR ' + error.message + '\\n') }",
    '  }',
    // 定时重复打印：describe() 只列出已激活的条目，
    // 早打一次可能我们的插件还没就位，所以隔一段再打一次。
    '  let n = 0',
    '  const tick = () => { dump(n++); if (n < 8) setTimeout(tick, 500) }',
    '  tick()',
    '}',
    '',
  ].join('\n'))

  // 只插探针：本插件声明了 dsh.bundle.patch，`plugin add` 已把它列进
  // dsh.profile.bundles，自带 patch 会被组合进来。再插一条会造成同 id 重复插入，
  // 组合取第一条（没有 config 的那份），设置页写入就会被判成「被别处覆盖」而失败。
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# 由 verify-load.mjs 生成，仅用于验收。',
    '- insert:',
    '    - id: roam-probe',
    "      name: 'roam-probe'",
    '',
  ].join('\n'))

  // 探针也要经 `dsh plugin add` 走一遍安装流程。
  // 手工往 manifest 里塞 link: 依赖是不够的——pnpm 没实际 link 进 node_modules，
  // 结果报「roam-probe (roam-probe): failed to import」。这与我们插件自身的
  // 「只装包不进 Loader 树」是同一类问题的另一面：两件事都做齐才成。
  const probeAdded = run(['plugin', '--profile', profile, 'add', probeDir])
  if (probeAdded.status !== 0) {
    console.error('安装探针插件失败：')
    console.error(probeAdded.stderr || probeAdded.stdout)
    process.exit(2)
  }

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
  const output = await bootAndCapture(60_000, [/ROAM-PROBE/], async (url) => {
    routeProbe.attempted = true
    if (url === null) {
      routeProbe.error = '没能从启动输出里取到服务地址'
      return
    }
    // 界面看到的每一件事都经过这条路由。真请求一次，才算验证了「句柄能通」。
    //
    // 但 Connection 层在物理载体上先施加一套信任策略：不带会话 cookie 的请求
    // 一律 401（packages/client/connection/src/browser-auth.ts:315 的
    // writeUnauthorized）。浏览器是先打开 `/?token=…` 换成 cookie 再访问 API 的，
    // 这里照做——否则验的就不是「界面能不能取数」，而是「不认证能不能取数」。
    const base = new URL(url)
    routeProbe.url = base.origin
    const token = base.searchParams.get('token')
    const headers = {}
    if (token !== null) {
      const handshake = await fetch(`${base.origin}/?token=${encodeURIComponent(token)}`, {
        redirect: 'manual',
      })
      const cookie = handshake.headers.getSetCookie?.()?.[0]
        ?? handshake.headers.get('set-cookie')
      if (cookie) headers.cookie = cookie.split(';')[0]
    }
    const res = await fetch(`${base.origin}/api/settings-roam.status`, { headers })
    routeProbe.status = res.status
    routeProbe.body = await res.json().catch(() => null)

    // 光「读得到」还不够。用户要的是「实际文件确实落得出来」，
    // 所以再真调一次导出，然后去磁盘上看那份文件在不在。
    const exp = await fetch(`${base.origin}/api/settings-roam.export`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    })
    routeProbe.exportStatus = exp.status
    routeProbe.exportBody = await exp.json().catch(() => null)
  }, await freePort())

  if (/did not activate/.test(output)) {
    console.error('✗ 插件未能激活：')
    for (const line of output.split('\n')) {
      if (/dsh-settings-roam|roam-probe|did not activate|Error|error|TypeError/.test(line)) console.error(`  ${line}`)
    }
    failed = true
  } else {
    console.log('✓ 无 "did not activate" 告警——插件已被 Loader 成功激活')
  }

  // 6. 设置页上真的会出现这个插件吗。
  //    判定依据是官方 describe() 的投影结果，不是我们的假设。
  // 逐行取「这一行的剩余部分」再解析，不要用 \[.*?\] 这种非贪婪方括号匹配：
  // 结果里含空数组（"keys":[]），非贪婪会在第一个 ] 处截断，解析必然失败。
  const probeLines = output.split('\n').filter(line => line.includes('ROAM-PROBE'))
  let last = null
  for (const line of probeLines) {
    const payload = line.slice(line.indexOf('ROAM-PROBE') + 'ROAM-PROBE'.length).trim()
    const json = payload.replace(/^\d+\s*/, '')
    if (!json.startsWith('[')) continue
    try { last = JSON.parse(json) } catch { /* 半行输出，跳过 */ }
  }
  if (last === null) {
    console.error('✗ 没拿到设置页投影探针的输出，无法确认配置项是否出现在设置页')
    failed = true
  } else if (last.length === 0) {
    console.error('✗ 设置页里没有本插件的配置表单（describe() 跳过了该条目）')
    console.error('  最可能的原因：Config 字段漏了 .volatile()，volatileForm() 返回 undefined')
    failed = true
  } else {
    const entry = last[0]
    const expected = ['branch', 'exportRoot', 'importRoot', 'profileName', 'repoUrl']
    const got = [...entry.keys].sort()
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      console.error(`✗ 设置页字段与预期不符：期望 ${expected.join('/')}，实际 ${got.join('/')}`)
      failed = true
    } else {
      console.log(`✓ 设置页会出现本插件的配置表单：${got.join('、')}`)
      console.log(`  命名空间 ${entry.ns}，自动生成表单 autoGenerate=${entry.autoGenerate}`)
    }
  }

  // 7. 不该有「未识别的配置项」告警。
  //    真实装载时 loader 不会往 config 里塞额外键，这条告警理应完全沉默；
  //    一旦出现，说明我们的已知键清单与 loader 实际传入的形状对不上。
  if (/不是可识别的选项/.test(output)) {
    console.error('✗ 出现了「未识别的配置项」告警，已知键清单与实际传入的形状不一致：')
    for (const line of output.split('\n')) {
      if (line.includes('不是可识别的选项')) console.error(`  ${line}`)
    }
    failed = true
  } else {
    console.log('✓ 无「未识别的配置项」告警——已声明的配置键与 loader 传入的形状一致')
  }

  // 8. 真发一次请求，确认界面取数的那条路由真的通了。
  //    前面几步证明的是「插件装上了、激活了、表单有了」；
  //    这一步证明的是「设置页上那两个按钮真能拿到数据」。
  //    两者是不同的失败面：路由没注册、路径写歪、handler 返回了非 Response，
  //    都不影响前几步通过。
  if (probeError !== null) {
    console.error(`✗ 路由探针自身出错：${probeError.message}`)
    failed = true
  } else if (!routeProbe.attempted) {
    console.error('✗ 没能对运行中的实例发请求（未到达可探针的阶段）')
    failed = true
  } else if (routeProbe.error !== null) {
    console.error(`✗ ${routeProbe.error}`)
    failed = true
  } else if (routeProbe.status !== 200) {
    console.error(`✗ /api/settings-roam.status 返回 HTTP ${routeProbe.status}`
      + `（请求 ${routeProbe.url}）${routeProbe.status === 401 ? '——会话未建立' : ''}`)
    console.error(`  ${JSON.stringify(routeProbe.body)}`)
    failed = true
  } else if (routeProbe.body?.ok !== true) {
    console.error('✗ 路由通了但响应体不合约定：')
    console.error(`  ${JSON.stringify(routeProbe.body)}`)
    failed = true
  } else {
    const b = routeProbe.body
    // 光「返回 200」不足以下结论：路径解析错了也会返回一份全 0 的合法响应。
    // 所以还要断言它读的确实是我们这个隔离 profile 的 patch 文件。
    const problems = []
    if (b.patchExists !== true) problems.push('没找到 profile 的 patch 文件（路径解析可能错了）')
    if (b.profile?.name !== profile) problems.push(`profile 名不符：${b.profile?.name} ≠ ${profile}`)
    if (!String(b.exportRoot ?? '').startsWith(home)) problems.push(`导出目录不在隔离根下：${b.exportRoot}`)
    if (problems.length > 0) {
      console.error('✗ 路由通了，但它看的不是我们期望的那个 profile：')
      for (const p of problems) console.error(`  ${p}`)
      failed = true
    } else {
      console.log(`✓ 界面取数路由可用：HTTP 200，本机公共配置 ${b.sharedCount} 项、`
        + `本机专属 ${b.machineCount} 项、技能 ${b.skillCount} 个`)
      console.log(`  profile=${b.profile.name} 已配置云端=${b.configured}`
        + ` patch 文件已读到=${b.patchExists}`)
    }
  }

  // 9. 导出真落盘了吗。
  //    「页面上要有概述」与「实际文件要确实落出来」是两件事：
  //    前者只看响应体就能骗过，后者必须去磁盘上点一下。
  if (routeProbe.exportStatus !== 200 || routeProbe.exportBody?.ok !== true) {
    console.error(`✗ 导出路由失败：HTTP ${routeProbe.exportStatus} `
      + `${JSON.stringify(routeProbe.exportBody)}`)
    failed = true
  } else {
    const where = routeProbe.exportBody.exported?.exportPath ?? null
    if (where === null) {
      console.error('✗ 导出没有回报落盘位置，用户无从去核对')
      failed = true
    } else if (!existsSync(where)) {
      console.error(`✗ 导出回报了位置但目录不存在：${where}`)
      failed = true
    } else if (!existsSync(join(where, 'manifest.json'))) {
      console.error(`✗ 导出目录里没有清单文件：${where}`)
      console.error(`  实际内容：${readdirSync(where).join('、')}`)
      failed = true
    } else {
      const names = readdirSync(where)
      console.log(`✓ 导出真实落盘：${names.length} 项，含清单文件`)
      console.log(`  位置 ${where}`)
      console.log(`  内容 ${names.join('、')}`)
    }
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
