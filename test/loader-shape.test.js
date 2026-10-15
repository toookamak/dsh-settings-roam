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
