/**
 * 路由层测试。
 *
 * 这一层是「界面上能看见什么」的唯一来源：浏览器半侧拿不到宿主模块，
 * 它看到的全部事实都经过这里。所以这里要钉住的不是内部实现，
 * 而是三件对用户可见的事：
 *   1. 没配云端时本机现状仍能读出来（第一阶段目标：不联网也要能取配置）；
 *   2. 推送/拉取必须「先预览、再确认」，确认的必须正是预览过的那一份；
 *   3. 出错时回一句能直接显示给人看的话，而不是一段堆栈。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ROUTES, ROUTE_PREFIX, describeRoutes, createRouteHandlers } from '../src/routes.js'

/** 造一个够用的假 service。只实现路由真正调用的那些方法。 */
function fakeService(overrides = {}) {
  const calls = {
    preparePush: 0, confirmPush: 0, preparePull: 0, applyPull: 0,
    prepareImport: 0, applyImport: 0,
    prepareImportArgs: [], applyImportArgs: [],
  }
  const base = {
    dshRoot: '/home/u/.dsh',
    isConfigured: () => true,
    defaultExportRoot: () => '/home/u/.dsh/settings-roam/export',
    defaultBackupRoot: () => '/home/u/.dsh/settings-roam/backup',
    describeProfile: () => ({ name: 'web', auto: true }),
    prepareInspect: async () => ({
      patchFile: '/home/u/.dsh/profiles/web/cordis.patch.yml',
      patchExists: true,
      total: 9,
      shared: [{ id: 'llm-pi-ai' }],
      machine: [{ id: 'webserver' }],
      excludedIds: [{ id: 'dsh-auth-gate' }],
      skills: [{ relPath: 'a/SKILL.md' }],
      skillCheck: { consistent: true, complete: true },
    }),
    preparePush: async () => {
      calls.preparePush += 1
      return {
        files: [{ path: 'config/profile.patch.yml', content: 'x' }],
        summary: { add: 1, modify: 0, delete: 0 },
        comparedWithRemote: false,
        skillCheck: { consistent: true, complete: true },
      }
    },
    confirmPush: async () => {
      calls.confirmPush += 1
      return { pushed: 1 }
    },
    preparePull: async () => {
      calls.preparePull += 1
      return {
        remoteRows: [{ id: 'llm-pi-ai' }],
        summary: { add: 0, modify: 1, delete: 0 },
        skillCheck: { consistent: true, complete: true },
      }
    },
    applyPull: async () => {
      calls.applyPull += 1
      return { applied: [{ name: 'x' }], skipped: [], backupPath: '/tmp/bk' }
    },
    defaultImportRoot: () => '/tmp/import',
    describeImportSource: () => ({
      dir: '/tmp/import', resolved: null, available: false,
      errors: [], warnings: [], generatedAt: null, generatedBy: null, fileCount: 0,
    }),
    prepareImport: async (input) => {
      calls.prepareImport += 1
      calls.prepareImportArgs.push(input)
      return {
        packageDir: '/tmp/import/20261015-120000',
        patchRows: [{ id: 'llm-pi-ai' }],
        skillFiles: [{ relPath: 'a/SKILL.md' }],
        refused: [{ name: 'webserver', reason: 'machine' }],
        empty: false,
      }
    },
    applyImport: async (plan, input) => {
      calls.applyImport += 1
      calls.applyImportArgs.push(input)
      return { applied: [{ name: 'llm-pi-ai' }], skipped: [], backupPath: '/tmp/bk2' }
    },
  }
  return { service: { ...base, ...overrides }, calls }
}

const deps = (overrides) => {
  const { service, calls } = fakeService(overrides)
  return {
    service,
    calls,
    buildPushOverview: () => ({ title: '本次将同步', stats: [], meta: [], location: '/e' }),
    buildPullOverview: (report, options = {}) => ({
      title: options.title ?? '本次拉取结果',
      stats: [],
      meta: [],
      location: options.location ?? '/b',
      appliedLabel: options.appliedLabel ?? null,
    }),
    buildImportOverview: () => ({ title: '本次将导入', stats: [], meta: [], location: '/i' }),
  }
}

const get = path => new Request(`http://localhost${path}`, { method: 'GET' })
const post = (path, body) => new Request(`http://localhost${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

// ─── 只读现状 ────────────────────────────────────────────────────────

test('status 未配置云端时依然可用 —— 第一阶段不联网也要能取到配置', async () => {
  const d = deps({ isConfigured: () => false })
  const handlers = createRouteHandlers(d)

  const res = await handlers.fetch(get(ROUTES.status))
  const body = await res.json()

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.configured, false, '要如实告诉界面「没配云端」，界面据此显示引导语')
  // 没配云端不妨碍读出本机现状 —— 这正是「未配置也要能用」的含义
  assert.equal(body.sharedCount, 1)
  assert.equal(body.machineCount, 1)
  assert.equal(body.skillCount, 1)
})

test('status 把被排除的项也报出来 —— 否则用户无从查证「我配的东西怎么没过去」', async () => {
  const handlers = createRouteHandlers(deps())
  const body = await (await handlers.fetch(get(ROUTES.status))).json()
  assert.equal(body.excludedCount, 1)
})

test('status 带上 profile 与导出目录，界面不必自己拼路径', async () => {
  const handlers = createRouteHandlers(deps())
  const body = await (await handlers.fetch(get(ROUTES.status))).json()
  assert.equal(body.profile.name, 'web')
  assert.equal(body.exportRoot, '/home/u/.dsh/settings-roam/export')
})

// ─── 预览 → 确认 的两段式（界面决策 U1）────────────────────────────────

test('没预览过就确认推送：拒绝，并告诉用户先预览', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)

  const res = await handlers.fetch(post(ROUTES.push, { step: 'confirm', token: 'whatever' }))
  const body = await res.json()

  assert.equal(res.status, 409)
  assert.equal(body.ok, false)
  assert.equal(d.calls.confirmPush, 0, '拒绝时绝不能已经写了云端')
  assert.match(body.error, /预览/, '要告诉用户下一步该做什么，而不是只说失败')
})

test('预览后确认：确认的正是预览过的那一份，且恰好只写一次', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)

  const prepared = await (await handlers.fetch(post(ROUTES.push, { step: 'prepare' }))).json()
  assert.ok(prepared.token, '预览必须发一个 token，否则无从判断确认的是哪一份')
  assert.equal(d.calls.preparePush, 1)
  assert.equal(d.calls.confirmPush, 0, '预览阶段绝不能落盘')

  const done = await (await handlers.fetch(post(ROUTES.push, { step: 'confirm', token: prepared.token }))).json()
  assert.equal(done.ok, true)
  assert.equal(d.calls.confirmPush, 1)
})

test('预览阶段不落盘：prepare 不触发任何写入动作', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)

  await handlers.fetch(post(ROUTES.pull, { step: 'prepare' }))
  assert.equal(d.calls.preparePull, 1)
  assert.equal(d.calls.applyPull, 0, '拉取的预览绝不能改本机文件')

  await handlers.fetch(post(ROUTES.push, { step: 'prepare' }))
  assert.equal(d.calls.confirmPush, 0, '推送的预览绝不能写云端')
})

test('token 一次性 —— 连点两次确认不会重复执行', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)

  const { token } = await (await handlers.fetch(post(ROUTES.push, { step: 'prepare' }))).json()
  await handlers.fetch(post(ROUTES.push, { step: 'confirm', token }))
  const second = await handlers.fetch(post(ROUTES.push, { step: 'confirm', token }))

  assert.equal(second.status, 409)
  assert.equal(d.calls.confirmPush, 1, '第二次不得再执行一次')
})

test('重新预览会让上一份 token 作废 —— 确认的必须是刚看过的那份差异', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)

  const first = await (await handlers.fetch(post(ROUTES.push, { step: 'prepare' }))).json()
  await handlers.fetch(post(ROUTES.push, { step: 'prepare' }))
  const res = await handlers.fetch(post(ROUTES.push, { step: 'confirm', token: first.token }))

  assert.equal(res.status, 409)
  assert.equal(d.calls.confirmPush, 0, '拿旧差异去写云端正是这里要防的事')
})

test('待确认的操作是另一种时拒绝 —— 预览了推送却去确认拉取', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)

  const { token } = await (await handlers.fetch(post(ROUTES.push, { step: 'prepare' }))).json()
  const res = await handlers.fetch(post(ROUTES.pull, { step: 'confirm', token }))

  assert.equal(res.status, 409)
  assert.equal(d.calls.applyPull, 0)
})

test('预览放太久就作废 —— 不用十分钟前的差异覆盖现在的配置', async () => {
  let now = 1_000_000
  const d = deps()
  const handlers = createRouteHandlers({ ...d, now: () => new Date(now) })

  const { token } = await (await handlers.fetch(post(ROUTES.push, { step: 'prepare' }))).json()
  now += 11 * 60 * 1000
  const res = await handlers.fetch(post(ROUTES.push, { step: 'confirm', token }))

  assert.equal(res.status, 409)
  assert.equal(d.calls.confirmPush, 0)
})

// ─── 拉取路径 ────────────────────────────────────────────────────────

test('拉取确认后回报告与概述，界面据此显示结果', async () => {
  const handlers = createRouteHandlers(deps())
  const { token } = await (await handlers.fetch(post(ROUTES.pull, { step: 'prepare' }))).json()
  const body = await (await handlers.fetch(post(ROUTES.pull, { step: 'confirm', token }))).json()

  assert.equal(body.ok, true)
  assert.equal(body.report.backupPath, '/tmp/bk', '要带出备份位置，用户才知道去哪回退')
  assert.equal(body.overview.title, '本次拉取结果')
})

test('拉取预览报出云端条目数，界面才能说清「云端一共有多少条」', async () => {
  const handlers = createRouteHandlers(deps())
  const body = await (await handlers.fetch(post(ROUTES.pull, { step: 'prepare' }))).json()
  assert.equal(body.remoteCount, 1)
})

// ─── 协议与错误面 ────────────────────────────────────────────────────

test('推送预览只回文件路径名，不回内容', async () => {
  const handlers = createRouteHandlers(deps())
  const body = await (await handlers.fetch(post(ROUTES.push, { step: 'prepare' }))).json()
  assert.deepEqual(body.files, ['config/profile.patch.yml'])
  assert.ok(!JSON.stringify(body).includes('"content"'), '内容可能很大，界面只给概述')
})

test('GET 推送路由被拒 —— 写操作不能由一次导航触发', async () => {
  const handlers = createRouteHandlers(deps())
  const res = await handlers.fetch(get(ROUTES.push))
  assert.equal(res.status, 405)
})

test('不认识的路径回 404，不认识的 step 回 400', async () => {
  const handlers = createRouteHandlers(deps())
  assert.equal((await handlers.fetch(get('/api/settings-roam.nope'))).status, 404)
  assert.equal((await handlers.fetch(post(ROUTES.push, { step: 'wat' }))).status, 400)
})

test('坏 JSON 体当作空对象 —— 不因为一个语法错就整个失败', async () => {
  const handlers = createRouteHandlers(deps())
  const req = new Request(`http://localhost${ROUTES.push}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ 这不是 JSON',
  })
  const res = await handlers.fetch(req)
  assert.equal(res.status, 200, '空体等价于默认的 prepare')
})

test('内部异常回一句可显示的话，不带堆栈与绝对路径', async () => {
  const d = deps({
    preparePush: async () => {
      throw new Error('git push 失败：远端拒绝（凭据已隐藏）')
    },
  })
  const handlers = createRouteHandlers(d)
  const res = await handlers.fetch(post(ROUTES.push, { step: 'prepare' }))
  const body = await res.json()

  assert.equal(res.status, 500)
  assert.equal(body.ok, false)
  assert.match(body.error, /git push 失败/)
  assert.ok(!/\bat\s+\w+.*:\d+:\d+/.test(body.error), '不得把堆栈回给界面')
})

test('describeRoutes 给出五条路由，方法与路径齐全', () => {
  const routes = describeRoutes(deps())
  assert.deepEqual(
    routes.map(r => r.path),
    [ROUTES.status, ROUTES.export, ROUTES.import, ROUTES.push, ROUTES.pull],
  )
  assert.deepEqual(routes[0].methods, ['GET'])
  assert.deepEqual(routes[1].methods, ['POST'])
  assert.deepEqual(routes[2].methods, ['POST'])
  assert.deepEqual(routes[3].methods, ['POST'])
  assert.deepEqual(routes[4].methods, ['POST'])
  for (const r of routes) {
    assert.equal(typeof r.fetch, 'function')
    assert.equal(r.requestBody, 'buffered')
  }
})

test('路由路径是 /api 开头的完整路径 —— 相对名会被静默 404', () => {
  // rpc-host.ts 用 this.fetchRoutes.get(url.pathname) 做等值匹配，
  // 并把 route.path 交给 endpointFromPath('/api', ...) 校验。
  // 所以既不能少前导斜杠，也不能少了 /api 前缀。
  for (const path of Object.values(ROUTES)) {
    assert.ok(path.startsWith('/api/'), `${path} 必须位于 /api 之下`)
    assert.equal(path, path.trim(), '路径不得带空白')
  }
  assert.equal(ROUTE_PREFIX, '/api/settings-roam')
})

test('三条路由的路径互不相同 —— 重复注册会被 Connection 层直接抛错', () => {
  const paths = Object.values(ROUTES)
  assert.equal(new Set(paths).size, paths.length)
})

test('浏览器半侧用的路径与宿主注册的路径逐字一致', () => {
  // client.js 不能 import 这个模块（它是浏览器 bundle，这是宿主模块），
  // 所以只能各写一份。这条断言就是防两边写歪的那道闸。
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const path of Object.values(ROUTES)) {
    assert.ok(src.includes(`'${path}'`), `client.js 里必须出现 ${path}`)
  }
})

// ─── 本地导出（第一阶段：不联网也要能把配置取出来）────────────────

test('导出不需要云端仓库 —— 第一阶段的目标不依赖远端', async () => {
  const d = deps({ isConfigured: () => false })
  const handlers = createRouteHandlers(d)

  const res = await handlers.fetch(post(ROUTES.export, {}))
  const body = await res.json()

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.ok(body.overview, '要给概述：页面上要显示同步了什么')
  assert.equal(d.calls.preparePush, 1)
  assert.equal(d.calls.confirmPush, 0, '导出绝不能写云端')
  assert.equal(d.calls.applyPull, 0, '导出绝不能改本机配置')
})

test('导出不要求 token —— 它无副作用，不必让用户多点两次', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)

  // 未经任何预览直接导出
  const res = await handlers.fetch(post(ROUTES.export, {}))
  assert.equal(res.status, 200)
  assert.equal(d.calls.preparePush, 1)
})

test('导出与推送算出的是同一份内容 —— 核对过的和推上去的必须一致', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)

  const exported = await (await handlers.fetch(post(ROUTES.export, {}))).json()
  const prepared = await (await handlers.fetch(post(ROUTES.push, { step: 'prepare' }))).json()

  assert.deepEqual(exported.files, prepared.files, '两条路径的文件清单必须逐项相同')
  assert.equal(d.calls.preparePush, 2, '两者都走 preparePush，不另起一条易漂移的路径')
})

test('导出回的是落盘位置 —— 用户据此去打开核对', async () => {
  const d = deps({
    preparePush: async () => ({
      files: [{ path: 'config/profile.patch.yml', content: 'x' }],
      summary: { add: 1, modify: 0, delete: 0 },
      comparedWithRemote: false,
      exported: { exportPath: '/home/u/.dsh/settings-roam/export/2026-10-15-1500' },
      skillCheck: { consistent: true, complete: true },
    }),
  })
  const handlers = createRouteHandlers(d)
  const body = await (await handlers.fetch(post(ROUTES.export, {}))).json()

  assert.equal(body.exported.exportPath, '/home/u/.dsh/settings-roam/export/2026-10-15-1500')
  assert.equal(body.comparedWithRemote, false, '未配云端要如实说明差异不是与云端比出来的')
})

test('GET 导出被拒 —— 写文件不能由一次导航触发', async () => {
  const handlers = createRouteHandlers(deps())
  assert.equal((await handlers.fetch(get(ROUTES.export))).status, 405)
})

test('导出失败时回的是可显示的话，且不留下待确认状态', async () => {
  const d = deps({
    preparePush: async () => { throw new Error('导出目录不可写') },
  })
  const handlers = createRouteHandlers(d)

  const res = await handlers.fetch(post(ROUTES.export, {}))
  assert.equal(res.status, 500)
  assert.match((await res.json()).error, /导出目录不可写/)

  // 导出没有留下 pending：随后一次确认应当仍报「还没预览过」
  const confirm = await handlers.fetch(post(ROUTES.push, { step: 'confirm', token: 'x' }))
  assert.equal(confirm.status, 409)
})

// ─── 导入（第二阶段：不联网也要能把备份回填）────────────────────

test('导入不需要云端仓库 —— 第二阶段的目标不依赖远端', async () => {
  const d = deps({ isConfigured: () => false })
  const handlers = createRouteHandlers(d)

  const res = await handlers.fetch(post(ROUTES.import, { step: 'prepare' }))
  const body = await res.json()

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(d.calls.prepareImport, 1)
})

test('导入默认去服务层给的目录找包，不让界面自己拼路径', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)
  await handlers.fetch(post(ROUTES.import, { step: 'prepare' }))

  assert.equal(d.calls.prepareImportArgs[0].packageDir, '/tmp/import')
})

test('导入可以指定别的目录 —— 包放在 U 盘上也该能导', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)
  await handlers.fetch(post(ROUTES.import, { step: 'prepare', packageDir: '/mnt/usb/roam' }))

  assert.equal(d.calls.prepareImportArgs[0].packageDir, '/mnt/usb/roam')
})

test('导入预览要说明「哪些不写回」，而不只给一个数字', async () => {
  const handlers = createRouteHandlers(deps())
  const body = await (await handlers.fetch(post(ROUTES.import, { step: 'prepare' }))).json()

  assert.equal(body.step, 'prepare')
  assert.ok(typeof body.token === 'string' && body.token.length > 0)
  assert.ok(Array.isArray(body.refused) && body.refused.length > 0, '要能逐条解释为什么不写回')
})

test('没有预览就确认，导入会被挡下并说清下一步', async () => {
  const handlers = createRouteHandlers(deps())
  const res = await handlers.fetch(post(ROUTES.import, { step: 'confirm', token: 'x' }))

  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /还没有预览过/)
})

test('导入确认用预览时的 token，且只认那一次', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)
  const prepared = await (await handlers.fetch(post(ROUTES.import, { step: 'prepare' }))).json()

  const first = await handlers.fetch(post(ROUTES.import, { step: 'confirm', token: prepared.token }))
  assert.equal(first.status, 200)
  assert.equal(d.calls.applyImport, 1)

  const second = await handlers.fetch(post(ROUTES.import, { step: 'confirm', token: prepared.token }))
  assert.equal(second.status, 409, 'token 是一次性的，连点两次不该写两遍')
  assert.equal(d.calls.applyImport, 1)
})

test('导入确认带上备份根目录 —— 动本机之前必须先留退路', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)
  const prepared = await (await handlers.fetch(post(ROUTES.import, { step: 'prepare' }))).json()
  await handlers.fetch(post(ROUTES.import, { step: 'confirm', token: prepared.token }))

  assert.ok(d.calls.applyImportArgs[0].backupRoot, '备份根目录不能为空')
})

test('导入确认后给出的是「导入结果」概述，不是拉取的', async () => {
  const handlers = createRouteHandlers(deps())
  const prepared = await (await handlers.fetch(post(ROUTES.import, { step: 'prepare' }))).json()
  const body = await (await handlers.fetch(
    post(ROUTES.import, { step: 'confirm', token: prepared.token }),
  )).json()

  // 概述的标题必须由导入指定，否则用户在一次导入之后会看到「本次拉取结果」
  assert.equal(body.overview.title, '本次导入结果')
  assert.equal(body.overview.appliedLabel, '已写入')
  assert.equal(body.overview.location, '/tmp/import/20261015-120000', '详情位置指向那个包，而不是备份目录')
  assert.ok(body.report, '报告要回给界面，跳过项才能逐条解释')
})

test('待确认的只有一份 —— 预览导入会顶掉之前预览的推送', async () => {
  const d = deps()
  const handlers = createRouteHandlers(d)
  const pushed = await (await handlers.fetch(post(ROUTES.push, { step: 'prepare' }))).json()
  await handlers.fetch(post(ROUTES.import, { step: 'prepare' }))

  const res = await handlers.fetch(post(ROUTES.push, { step: 'confirm', token: pushed.token }))
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /作废|另一种操作/)
  assert.equal(d.calls.confirmPush, 0)
})

test('GET 导入被拒 —— 它改本机文件，不能由一次导航触发', async () => {
  const handlers = createRouteHandlers(deps())
  assert.equal((await handlers.fetch(get(ROUTES.import))).status, 405)
})

test('导入包不可用时回可显示的话，且不留下待确认状态', async () => {
  const d = deps({
    prepareImport: async () => { throw new Error('那个目录里没有导出包') },
  })
  const handlers = createRouteHandlers(d)

  const res = await handlers.fetch(post(ROUTES.import, { step: 'prepare' }))
  assert.equal(res.status, 500)
  assert.match((await res.json()).error, /没有导出包/)
})

test('拉取预览会带出兼容性检查，供界面决定能不能放行', async () => {
  const d = deps({
    preparePull: async () => ({
      summary: { add: 1, modify: 0, delete: 0 },
      diff: [],
      remoteRows: [{ id: 'llm-pi-ai', name: 'pkg' }],
      remoteSkillFiles: [],
      skillCheck: null,
      compat: {
        blocked: true,
        counts: { ok: 0, warn: 0, block: 1 },
        items: [{ level: 'block', code: 'name-mismatch', name: 'llm-pi-ai', message: 'm', action: 'a' }],
      },
    }),
  })
  const handlers = createRouteHandlers(d)

  const res = await handlers.pull(post('', { step: 'prepare' }))
  const payload = await res.json()

  assert.equal(payload.compat.blocked, true)
  assert.equal(payload.compat.items[0].code, 'name-mismatch')
})

test('导入预览同样带出兼容性检查，且与拉取是同一份口径', async () => {
  const compat = { blocked: false, counts: { ok: 1, warn: 1, block: 0 }, items: [] }
  const d = deps({
    prepareImport: async () => ({
      packageDir: '/tmp/pkg',
      patchRows: [],
      skillFiles: [],
      refused: [],
      empty: false,
      compat,
    }),
  })
  const handlers = createRouteHandlers(d)

  const res = await handlers.importFrom(post('', { step: 'prepare', packageDir: '/tmp/pkg' }))
  const payload = await res.json()

  assert.deepEqual(payload.compat, compat)
})
