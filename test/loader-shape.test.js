import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')

test('package.json 声明的每个文件都真实存在', () => {
  const pkg = JSON.parse(read('package.json'))
  for (const f of pkg.files) {
    // files 里声明的每一项都必须在磁盘上真实存在，否则发布出去的包是残缺的
    assert.ok(existsSync(join(root, f)), `package.json 的 files 声明了 ${f}，但文件不存在`)
  }
})

test('客户端 bundle 是 lazy-CJS factory 形态（E3）', () => {
  const src = read('client.js')
  assert.match(src, /__ModuleLoader__\.load\(/, '必须调用 window.__ModuleLoader__.load')
  assert.match(src, /factory\s*[:(]/, '必须提供 factory')
  assert.ok(
    !/^\s*import\s/m.test(src),
    '不得使用 ESM import——解析靠注入的 require，不是 import map',
  )
})

test('客户端 bundle 登记的 id 与包名一致', () => {
  const pkg = JSON.parse(read('package.json'))
  const src = read('client.js')
  const id = pkg.name
  assert.ok(src.includes(`"${id}"`) || src.includes(`'${id}'`), `bundle 里的 id 必须是 ${id}`)
})

test('浏览器半侧挂在裸包名那一行（E2）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.dsh?.client, 'package.json 必须有 dsh.client')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject), 'inject 必须是数组')
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'),
    '要往设置分区贡献界面，必须 inject ui-settings',
  )
})

test('宿主半侧导出 apply，且不依赖构建产物', () => {
  const src = read('index.js')
  assert.match(src, /export\s+(async\s+)?function\s+apply\s*\(/, '宿主半侧必须导出 apply')
  assert.ok(!src.includes('lib/'), '宿主半侧不得引用 lib/ 构建产物')
})

test('patch 文件把自己插进 Loader（E1 的配套）', () => {
  const src = read('cordis.patch.yml')
  const pkg = JSON.parse(read('package.json'))
  assert.match(src, /- insert:/, 'patch 必须用 insert 把自己插进 Loader')
  assert.ok(src.includes(pkg.name), 'patch 里的 name 必须是裸包名（E2）')
})

test('patch 用裸包名，不用子路径（E2）', () => {
  const src = read('cordis.patch.yml')
  const nameLines = src.split('\n').filter(l => /^\s*name:/.test(l))
  assert.ok(nameLines.length > 0, 'patch 必须有 name 字段')
  for (const line of nameLines) {
    const value = line.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '')
    assert.ok(
      !value.includes('/', value.indexOf('/') + 1) || value.startsWith('@'),
      `name ${value} 看起来像子路径导出`,
    )
    assert.ok(!value.includes('/client'), 'name 不得指向 /client 子路径')
  }
})

test('设置分区的注册名是字符串 settings.section，不是槽位树路径', () => {
  const src = read('client.js')
  assert.ok(
    src.includes("'settings.section'") || src.includes('"settings.section"'),
    '必须用字符串 settings.section 注册（实测签名）',
  )
  assert.ok(
    !src.includes('sidebar.settings.settings.section'),
    '槽位树路径不是注册名，照抄树会注册失败',
  )
})

test('文案极简，但跳过项仍带可行动的说明（U3 与 §3.4 的张力处理）', () => {
  const src = read('client.js')
  assert.ok(
    /explainSkip|explanation/.test(src),
    '跳过项必须仍带可行动的说明，不能只报一个失败计数',
  )
})

test('图标是单色矢量，不含文字', () => {
  const src = read('icon.svg')
  assert.match(src, /<svg/, 'icon.svg 必须是 SVG')
  assert.ok(!/<text/.test(src), '图标不含文字（随主题着色，文字会失真）')
})

test('两套语言文件都齐，且 meta 字段一致', () => {
  const zh = JSON.parse(read('locale/zh.json'))
  const en = JSON.parse(read('locale/en.json'))
  assert.ok(zh.meta?.title, 'zh.json 需要 meta.title')
  assert.ok(en.meta?.title, 'en.json 需要 meta.title')
  assert.deepEqual(
    Object.keys(zh.meta).sort(),
    Object.keys(en.meta).sort(),
    '两种语言的字段必须一一对应，缺一个会显示为键名',
  )
})

test('手写 lazy-CJS bundle 能被模块加载器真实接受（E4 实测）', async () => {
  // 这一步不能只看文件文本，必须真的按官方协议加载一次。
  // 官方协议见 packages/client/modules：window.__ModuleLoader__.load({ id, factory }),
  // factory(require) 返回导出，require 用裸说明符解析 loader 模块表。
  const loaded = []
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        loaded.push(id)
        exported = factory((spec) => {
          if (spec === 'react') {
            return { createElement: (type, props, ...children) => ({ type, props, children }) }
          }
          throw new Error(`未预期的依赖：${spec}`)
        })
      },
    },
  }
  try {
    await import(`../client.js?e4=${Date.now()}`)
  } finally {
    delete globalThis.window
  }

  const pkg = JSON.parse(read('package.json'))
  assert.deepEqual(loaded, [pkg.name], '登记的 id 必须恰好是裸包名一次')
  assert.ok(exported && typeof exported === 'object', 'factory 必须返回导出对象')
  assert.equal(typeof exported.Section, 'function', '要贡献设置分区，必须导出 Section')
})

test('状态行的四类状态各给一句极简文案（U3）', async () => {
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        exported = factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }) }))
      },
    },
  }
  try {
    await import(`../client.js?u3=${Date.now()}`)
  } finally {
    delete globalThis.window
  }

  const cases = ['empty-cloud', 'has-diff', 'needs-config', 'clean']
  const texts = new Set()
  for (const kind of cases) {
    const el = exported.StatusLine({ state: { kind, count: 3 } })
    const text = String(el.children[0] ?? '')
    assert.ok(text.length > 0, `${kind} 必须有文案`)
    // 极简：不铺垫、不解释设计意图，一句话说清
    assert.ok(text.split('。').filter(Boolean).length <= 2, `${kind} 的文案不应超过一句话`)
    texts.add(text)
  }
  assert.equal(texts.size, 4, '四类状态的文案必须彼此不同')
})

test('跳过项渲染的是说明文字，不是失败计数（§3.4）', async () => {
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        exported = factory(() => ({
          createElement: (type, props, ...children) => ({ type, props, children }),
        }))
      },
    },
  }
  try {
    await import(`../client.js?skip=${Date.now()}`)
  } finally {
    delete globalThis.window
  }

  const item = { name: 'demo-plugin', explanation: '把它发布到 registry 之后才能同步过来。' }
  const row = exported.Section({ state: { kind: 'has-diff', count: 1, skipped: [item] } })
  // Section 的第一个子元素是状态行，第二个是跳过区
  const flat = JSON.stringify(row)
  assert.ok(flat.includes('demo-plugin'), '要显示是哪个插件')
  assert.ok(flat.includes('发布到 registry'), '必须给出可行动的说明')
  assert.ok(!/失败\s*\d+|skip count/i.test(flat), '不得退化成失败计数')
})

test('概述区给出统计、来源与落盘位置，但不铺开逐项清单', async () => {
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        exported = factory(() => ({
          createElement: (type, props, ...children) => ({ type, props, children }),
        }))
      },
    },
  }
  try {
    await import(`../client.js?ov=${Date.now()}`)
  } finally {
    delete globalThis.window
  }

  const state = {
    kind: 'clean',
    overview: {
      title: '上次推送',
      stats: [
        { label: '公共配置', value: 1 },
        { label: '技能', value: 3 },
        { label: '插件', value: 12 },
      ],
      meta: ['2026-10-15 12:00', '来自 machine-a'],
      location: '/home/u/.dsh/settings-roam/export/2026-10-15-120000',
    },
  }

  const el = exported.Overview({ state })
  const flat = JSON.stringify(el)

  assert.ok(flat.includes('上次推送'), '要有标题')
  assert.ok(flat.includes('公共配置'), '要有统计项')
  assert.ok(flat.includes('machine-a'), '要能看出这份来自哪台机器')
  assert.ok(
    flat.includes('export/2026-10-15-120000'),
    '要给出真实落盘路径 —— 用户据此去打开核对',
  )
})

test('没有概述数据时不渲染空区块', async () => {
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        exported = factory(() => ({
          createElement: (type, props, ...children) => ({ type, props, children }),
        }))
      },
    },
  }
  try {
    await import(`../client.js?ov2=${Date.now()}`)
  } finally {
    delete globalThis.window
  }

  assert.equal(exported.Overview({ state: {} }), null)
  assert.equal(exported.Overview({ state: undefined }), null)
})

test('概述区提供「打开」动作时带出路径', async () => {
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        exported = factory(() => ({
          createElement: (type, props, ...children) => ({ type, props, children }),
        }))
      },
    },
  }
  try {
    await import(`../client.js?ov3=${Date.now()}`)
  } finally {
    delete globalThis.window
  }

  const opened = []
  const state = {
    overview: { title: 't', stats: [], location: '/x/y' },
  }
  const el = exported.Overview({ state, actions: { onOpenExport: p => opened.push(p) } })

  // 按钮在 location 区块内部，不是 Overview 的直接子元素
  const loc = el.children.find(c => c?.props?.className === 'roam-overview-location')
  assert.ok(loc, '应有落盘位置区块')
  const button = loc.children.find(c => c?.props?.className === 'roam-open')
  assert.ok(button, '给了 onOpenExport 就该渲染打开按钮')
  button.props.onClick()
  assert.deepEqual(opened, ['/x/y'])
})

test('没有 onOpenExport 时不渲染打开按钮 —— 不给出点了没反应的控件', async () => {
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        exported = factory(() => ({
          createElement: (type, props, ...children) => ({ type, props, children }),
        }))
      },
    },
  }
  try {
    await import(`../client.js?ov4=${Date.now()}`)
  } finally {
    delete globalThis.window
  }

  const el = exported.Overview({ state: { overview: { title: 't', stats: [], location: '/x/y' } } })
  const flat = JSON.stringify(el)
  assert.ok(flat.includes('/x/y'), '路径仍要显示出来，让用户能自己找过去')
  assert.ok(!flat.includes('"roam-open"'), '但不应有无效按钮')
})

// ─── 概述显示（用户要求「页面上要有概述」）────────────────────────────
// 取向：只给概述，不铺开逐项清单。要看细节去打开导出的文件。

test('概述渲染计数与「去哪看详情」的路径', async () => {
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        exported = factory(() => ({
          createElement: (type, props, ...children) => ({ type, props, children }),
        }))
      },
    },
  }
  try {
    await import(`../client.js?ov=${Date.now()}`)
  } finally {
    delete globalThis.window
  }

  const state = {
    overview: {
      title: '本次将同步',
      stats: [
        { label: '公共配置', value: 1 },
        { label: '技能', value: 2 },
        { label: '插件', value: 3 },
      ],
      meta: ['2026-10-15 09:07', '来自 machine-a'],
      location: '/x/export/1',
    },
  }
  const flat = JSON.stringify(exported.Overview({ state }))

  assert.ok(flat.includes('本次将同步'), '要有标题')
  assert.ok(flat.includes('公共配置') && flat.includes('技能') && flat.includes('插件'), '三类计数都要有')
  assert.ok(flat.includes('2026-10-15 09:07'), '要有时间')
  assert.ok(flat.includes('machine-a'), '要标明来源机器')
  assert.ok(flat.includes('/x/export/1'), '要给出详情所在路径')
})

test('概述只给概述 —— 不把逐项文件清单铺进界面', async () => {
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        exported = factory(() => ({
          createElement: (type, props, ...children) => ({ type, props, children }),
        }))
      },
    },
  }
  try {
    await import(`../client.js?ov2=${Date.now()}`)
  } finally {
    delete globalThis.window
  }

  const state = {
    overview: {
      title: '本次将同步',
      stats: [{ label: '技能', value: 2 }],
      meta: [],
      location: '/x/export/1',
      // 即便宿主多传了文件清单，界面也不应逐项铺开
      files: [
        { path: 'skills/one/SKILL.md' },
        { path: 'skills/two/SKILL.md' },
        { path: 'skills/three/SKILL.md' },
      ],
    },
  }
  const flat = JSON.stringify(exported.Overview({ state }))

  assert.ok(!flat.includes('skills/one'), '不逐项列出文件路径')
  assert.ok(!flat.includes('skills/three'), '不逐项列出文件路径')
})

test('没有概述数据时不渲染区块 —— 不给空壳', async () => {
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        exported = factory(() => ({
          createElement: (type, props, ...children) => ({ type, props, children }),
        }))
      },
    },
  }
  try {
    await import(`../client.js?ov3=${Date.now()}`)
  } finally {
    delete globalThis.window
  }

  assert.equal(exported.Overview({ state: {} }), null)
  assert.equal(exported.Overview({ state: { overview: null } }), null)
})

// ─── 挂载契约（本轮实测发现的真问题）─────────────────────────────────
// 原先 client.js 只导出一堆组件，没有 apply 与 inject：
// 模块加载器会接受它，但没有任何东西会去挂载，设置页上是一片空白且不报错。
// 官方 packages/session-query/session-log-export/lib/client.js 末尾同样是
// `exports.apply = apply; exports.inject = inject`。

/** 按官方协议加载一次客户端 bundle，返回导出对象。 */
async function loadClient(tag) {
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        exported = factory((spec) => {
          if (spec === 'react') {
            return {
              createElement: (type, props, ...children) => ({ type, props, children }),
              useState: v => [v, () => {}],
              useCallback: f => f,
              useEffect: () => {},
            }
          }
          throw new Error(`未预期的依赖：${spec}`)
        })
      },
    },
  }
  try {
    await import(`../client.js?${tag}=${Date.now()}`)
  } finally {
    delete globalThis.window
  }
  return exported
}

test('客户端导出 apply 与 inject —— 否则界面一片空白且不报错', async () => {
  const exported = await loadClient('mount')
  assert.equal(typeof exported.apply, 'function', '必须导出 apply，否则没有东西会挂载它')
  assert.equal(typeof exported.inject, 'function', '必须导出 inject')
})

test('客户端不声明用不上的依赖', async () => {
  const exported = await loadClient('deps')
  // 声明了不用的依赖，宿主改名时本插件会连带拒绝启动 —— 白白多一处失效点。
  assert.deepEqual(exported.inject(), [], '本插件只用 React 与 fetch，无需额外依赖')
})

test('apply 经 slots.inject 注册到 settings.section 槽位', async () => {
  const exported = await loadClient('slot')

  const registered = []
  let injectedSlot = null
  const ctx = {
    slots: {
      inject: (name, fn) => {
        injectedSlot = name
        fn()
      },
      register: (spec, component) => {
        registered.push({ spec, component })
        return () => {}
      },
    },
  }

  exported.apply(ctx)

  assert.equal(injectedSlot, 'settings.section', '槽位名必须是字符串 settings.section')
  assert.equal(registered.length, 1, '只贡献一节，不占别处（界面决策 U2）')
  const { spec, component } = registered[0]
  assert.equal(spec.name, 'settings.section', '注册 spec 里的 name 也要是这个字符串')
  assert.equal(spec.id, 'settings-roam', 'id 用于去重与卸载')
  assert.equal(typeof spec.label, 'function', '分区标签必须是函数（延迟取语言包）')
  assert.equal(spec.locale, '@toookamak/dsh-settings-roam')
  assert.equal(typeof component, 'function', '挂载的必须是组件')
})

test('apply 在语言服务缺席时仍能给出标签 —— 不因取不到翻译就整节不显示', async () => {
  const exported = await loadClient('label')
  const registered = []
  // 刻意不给 ctx.locale：命令行/早期启动阶段它可能还没就绪
  const ctx = {
    slots: {
      inject: (name, fn) => fn(),
      register: (spec, component) => registered.push({ spec, component }),
    },
  }
  exported.apply(ctx)
  const label = registered[0].spec.label()
  assert.equal(typeof label, 'string')
  assert.ok(label.length > 0, '标签必须有兜底文案')
})

test('apply 注册的标签优先取语言包', async () => {
  const exported = await loadClient('label2')
  const registered = []
  const ctx = {
    slots: {
      inject: (name, fn) => fn(),
      register: (spec, component) => registered.push({ spec, component }),
    },
    locale: { bind: () => (key) => (key === 'nav' ? '设置漫游（译）' : key) },
  }
  exported.apply(ctx)
  assert.equal(registered[0].spec.label(), '设置漫游（译）')
})

// ─── U1：推送前必须先确认 ────────────────────────────────────────────

/**
 * 把元素树展开到「宿主元素」一层。
 *
 * 测试用的 createElement 不认识函数型 type，所以 h(Section, …) 产出的树里
 * 仍嵌着 {type: Pending, props} 这样的组件元素。真正渲染它们要 React；
 * 这里只需要它们的输出，于是手动调一次。
 */
function render(el) {
  if (el === null || el === undefined || typeof el !== 'object') return el
  if (typeof el.type === 'function') return render(el.type(el.props ?? {}))
  return {
    ...el,
    children: (el.children ?? []).map(render).filter(c => c !== null && c !== undefined),
  }
}

test('待确认区块给出「确认」与「取消」两个动作', async () => {
  const exported = await loadClient('pending')
  const clicked = []
  const state = {
    kind: 'clean',
    pending: { kind: 'push', token: 'tok-1', text: '将推送 3 个文件', confirmLabel: '确认推送' },
  }
  const actions = {
    onConfirm: () => clicked.push('confirm'),
    onCancel: () => clicked.push('cancel'),
  }

  const section = render(exported.Section({ state, actions }))
  // 待确认区在动作区内部，作为按钮的兄弟节点
  const actionsEl = section.children.find(c => c?.props?.className === 'roam-actions')
  const pending = actionsEl.children.find(c => c?.props?.className === 'roam-pending')
  assert.ok(pending, '有待确认内容时必须渲染出来 —— 确认点得看得见')

  const buttons = pending.children.find(c => c?.props?.className === 'roam-pending-actions').children
  // createElement 的 children 是数组，取第一个作为按钮文字
  assert.deepEqual(buttons.map(b => b.children[0]), ['确认推送', '取消'])

  buttons[0].props.onClick()
  buttons[1].props.onClick()
  assert.deepEqual(clicked, ['confirm', 'cancel'])
})

test('没有待确认内容时不渲染待确认区 —— 不给空壳', async () => {
  const exported = await loadClient('pending2')
  const section = render(exported.Section({ state: { kind: 'clean' }, actions: {} }))
  const actionsEl = section.children.find(c => c?.props?.className === 'roam-actions')
  assert.ok(
    !actionsEl.children.some(c => c?.props?.className === 'roam-pending'),
    '没有 pending 时不该出现确认区',
  )
})

test('确认时必须带上预览时发的 token —— 否则预览只是装饰', async () => {
  const src = read('client.js')
  // 这条只能在源码层断言：真正的「确认的是看过的哪一份」由宿主路由保证，
  // 界面的责任是把 token 原样带回去。漏了它，宿主只能拒绝所有确认。
  assert.match(src, /step:\s*'confirm'/, '确认请求要显式标出 step')
  assert.match(src, /token:\s*pending\.token|token:\s*prepared\.token/, '确认必须回传 token')
})

test('推送与拉取都走「预览→确认」两段，没有一键直发', async () => {
  const src = read('client.js')
  assert.match(src, /step:\s*'prepare'/, '要有预览阶段')
  // 预览后按钮变成「确认」，而不是再点一次就执行
  assert.match(src, /pending/, '预览结果要落到待确认状态里')
  assert.ok(
    !/onClick:\s*\(\)\s*=>\s*request\([^)]*['"]?confirm/.test(src),
    '按钮不得直接触发确认',
  )
})

test('动作区第一个是「导出到文件」—— 唯一不依赖云端仓库的动作', async () => {
  const exported = await loadClient('export-btn')
  const clicked = []
  const section = render(exported.Section({
    state: { kind: 'clean' },
    actions: { onExport: () => clicked.push('export'), onPull: () => {}, onPush: () => {} },
  }))
  const actionsEl = section.children.find(c => c?.props?.className === 'roam-actions')
  const buttons = actionsEl.children.filter(c => c?.type === 'button')

  assert.equal(buttons[0].children[0], '导出到文件', '第一次打开这一节最该点的是它')
  assert.deepEqual(buttons.slice(1).map(b => b.children[0]), ['拉取', '推送'])
  buttons[0].props.onClick()
  assert.deepEqual(clicked, ['export'])
})

test('导出不经过确认流程 —— 无副作用的本地动作不该多点两次', async () => {
  const src = read('client.js')
  const body = src.slice(src.indexOf('const beginExport'), src.indexOf('/** 统一处理'))
  assert.ok(body.includes("ROUTES.export"), '导出要打导出路由')
  assert.ok(!body.includes('pending'), '导出不产生待确认状态')
  assert.ok(!body.includes("step:"), '导出没有 prepare/confirm 两段')
})
