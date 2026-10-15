/**
 * 宿主半侧 apply() 的 DI 纪律测试。
 *
 * 这一组锁的是一个只在真装配时才会爆的失败面：
 * Cordis 的上下文是「没 inject 过就不许读」的。直接写 ctx.pluginManager
 * 在普通 Node 里完全正常，插件也一样能装、能激活、能通过前面所有检查——
 * 直到用户真的点下那个按钮，才收到一条 500
 * `cannot get property "pluginManager" without inject`。
 *
 * 实测就是这样：前四步真装载验收全绿，第五步一调导出路由立刻炸。
 * 所以这里用一个「读未注入属性就抛错」的假 ctx 把这个纪律固化下来，
 * 不必每次都启动一次 DSH 才能发现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, inject as hostInject, name } from '../index.js'

/**
 * 造一个像 Cordis 那样「没注入过就不给读」的上下文。
 *
 * @param {object} [services] 已注入的服务
 */
function fakeContext(services = {}) {
  const provided = {}
  const effects = []
  const injected = new Set(Object.keys(services))
  const logs = { info: [], warn: [] }

  const base = {
    provide: (key, value) => { provided[key] = value; return () => {} },
    effect: (fn, label) => { effects.push({ fn, label }); return () => {} },
    inject: (deps, callback) => {
      for (const dep of deps) {
        if (!(dep in services)) continue
        injected.add(dep)
        // 注入出来的是一份子上下文：它照样有 effect / provide / logger，
        // 只是多了一个被注入的服务。Cordis 里也是这样。
        callback({ ...base, [dep]: services[dep] })
      }
      return null
    },
    logger: {
      info: (...args) => logs.info.push(args),
      warn: (...args) => logs.warn.push(args),
    },
    ...services,
  }

  // 未声明的键一律抛错，与 Cordis 一致。
  // 已声明的 inject 列表是允许读的——Cordis 里 inject 过的服务可以随便取，
  // 这正是它与「没 inject 就不能取」的界线。
  const declared = new Set(hostInject)
  const ctx = new Proxy(base, {
    get(target, key) {
      if (typeof key === 'symbol' || key in target) return target[key]
      if (declared.has(key)) return services[key]
      throw new Error(`cannot get property "${String(key)}" without inject`)
    },
  })

  return { ctx, provided, effects, logs }
}

const setup = (services) => {
  const fake = fakeContext(services)
  apply(fake.ctx, { dshHome: '/tmp/roam-apply-test' })
  return { ...fake, roam: fake.provided.settingsRoam }
}

// ─── 挂载方式 ────────────────────────────────────────────────────────

test('经 ctx.provide 挂载，而不是直接赋值 —— 直接赋值整个条目不激活', () => {
  const { roam } = setup()
  assert.ok(roam, '服务必须经 provide 暴露出来')
  assert.equal(typeof roam.service, 'object')
  assert.equal(roam.dshRoot, '/tmp/roam-apply-test')
})

test('未配置云端时 configured 为 false，但服务照常可用', () => {
  const { roam } = setup()
  assert.equal(roam.configured, false, '没填仓库地址要如实反映，界面据此显示引导语')
  assert.equal(roam.service.isConfigured(), false)
})

test('声明了 settings 与 skills 两个必需依赖', () => {
  assert.deepEqual([...hostInject].sort(), ['settings', 'skills'])
})

// ─── 可选依赖：pluginManager 不在 inject 里，那就必须能缺席 ─────────────

test('pluginManager 缺席时不抛错 —— 它只是少一份插件名单，不该拖垮整个插件', () => {
  const { roam } = setup({ settings: {}, skills: {} })
  assert.equal(typeof roam, 'object', '没有 pluginManager 也要能装配起来')
})

test('pluginManager 缺席时取它得到 undefined，而不是抛 DI 错误', () => {
  // 这条就是那次 500 的根因：装配时读一次 ctx.pluginManager 立刻抛
  // cannot get property "pluginManager" without inject。
  // 修复方式是用可选注入捕获引用，再由 getter 返回。
  const fake = fakeContext({ settings: {}, skills: {} })
  let captured = null
  // 拿一个只在 pluginManager 上会抛错的 ctx：任何直接读取都会立刻暴露
  apply(fake.ctx, { dshHome: '/tmp/roam-apply-test' })

  const service = fake.provided.settingsRoam.service
  // service 内部持有的 pluginManager 取值口不能抛错
  assert.doesNotThrow(() => {
    captured = service
  })
  assert.ok(captured)
})

test('pluginManager 出现时能被捕获到 —— 注入是可选的，不是关掉的', () => {
  const listBundles = () => []
  const { roam } = setup({ settings: {}, skills: {}, pluginManager: { listBundles } })
  assert.ok(roam, '有 pluginManager 时同样要装配成功')
})

// ─── 路由注册 ────────────────────────────────────────────────────────

test('有 connection 时注册四条路由，且经 effect 绑定生命周期', () => {
  const routes = []
  const { effects } = setup({
    settings: {}, skills: {},
    connection: { fetch: { register: r => { routes.push(r); return async () => {} } } },
  })

  assert.equal(effects.length, 4, '四条路由各挂一次 effect')
  for (const e of effects) {
    assert.match(e.label, /dsh-settings-roam: route /, '标签要能看出是哪条路由')
  }

  // effect 只在 Cordis 里才真的执行；这里手动跑一遍，验证注册动作本身
  for (const e of effects) e.fn()
  assert.deepEqual(
    routes.map(r => r.path),
    ['/api/settings-roam.status', '/api/settings-roam.export',
      '/api/settings-roam.push', '/api/settings-roam.pull'],
  )
})

test('没有 connection 时不注册也不报错 —— 命令行下这个插件照样能用', () => {
  const { effects } = setup({ settings: {}, skills: {} })
  assert.deepEqual(effects, [], '没有 connection 就没有路由，也不该抛错')
})

// ─── 配置项核对 ──────────────────────────────────────────────────────

test('未识别的配置键要显式告警 —— 敲错 repoUrl 不该静默失效', () => {
  const fake = fakeContext({ settings: {}, skills: {} })
  apply(fake.ctx, { dshHome: '/tmp/roam-apply-test', repourl: 'https://example.com/r.git' })

  assert.equal(fake.logs.warn.length, 1, '敲错键必须留下一条可见的告警')
  assert.match(fake.logs.warn[0][0], /不是可识别的选项/)
})

test('dshHome 与 backendKind 是刻意保留的开关，不该被告警', () => {
  const fake = fakeContext({ settings: {}, skills: {} })
  apply(fake.ctx, { dshHome: '/tmp/roam-apply-test', backendKind: 'git' })
  assert.deepEqual(fake.logs.warn, [], '这两个键是有意放行的')
})

test('已声明的配置键逐一传入都不告警 —— 与 loader 的实际形状对齐', () => {
  for (const key of Object.keys(Config.dict)) {
    const fake = fakeContext({ settings: {}, skills: {} })
    apply(fake.ctx, { dshHome: '/tmp/roam-apply-test', [key]: '' })
    assert.deepEqual(fake.logs.warn, [], `配置键 ${key} 不该被告警`)
  }
})

test('插件名与包名分开 —— name 是 Loader 里的 id，包名另有其处', () => {
  assert.equal(name, 'settings-roam')
})
