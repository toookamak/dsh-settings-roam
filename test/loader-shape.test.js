import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')

// ─── 文件级契约 ──────────────────────────────────────────────────────
// 这些断言只看文本，不需要加载 bundle：它们锁的是「包长什么样」，
// 真装载验收（scripts/verify-load.mjs）负责锁「装上去能不能用」。

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

// ─── 测试用运行环境 ──────────────────────────────────────────────────
//
// 这里不是 React，也不假装是。它只做到「让组件跑一遍并把树交出来」：
// hooks 在单次渲染内按调用顺序存值，没有重渲染（组件只被调用一次）。
// 需要「跨渲染才成立」的断言一律退回源码层，不在这层伪造。

let hookState = []
let hookIndex = 0

const REACT = {
  // flat(Infinity)：React 也会摊平嵌套数组（FIELDS.map(...) 作为一个子节点传进来）
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => {
    // 每调用一次组件就换一份 hooks（render 里重置）；这里把当下那份捕获住，
    // 否则子组件渲染时重置会把父组件的 setter 指向一份空数组。
    const store = hookState
    const slot = hookIndex++
    if (!(slot in store)) {
      store[slot] = typeof initial === 'function' ? initial() : initial
    }
    return [
      store[slot],
      next => { store[slot] = typeof next === 'function' ? next(store[slot]) : next },
    ]
  },
  useEffect: () => {},
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useRef: value => ({ current: value }),
}

/**
 * 宿主提供的界面组件（@deepseek-ai/dsh-client-ui-primitives）。
 *
 * 它们是「宿主渲染的」，所以 render() 不展开它们——保留结构用来断言
 * 「我们用的是宿主组件，不是裸 HTML 元素」。
 */
const PRIMITIVES = {
  Button: function Button(props) { return { type: 'Button', props, children: props?.children ?? [] } },
  Input: function Input(props) { return { type: 'Input', props, children: [] } },
  StateDot: function StateDot(props) { return { type: 'StateDot', props, children: [] } },
  IconDownloadOutlineRegular: 'ICON_DOWNLOAD',
  IconRefreshOutlineRegular: 'ICON_REFRESH',
  IconRightUpOutlineRegular: 'ICON_UP',
  IconFolderOpenOutlineRegular: 'ICON_FOLDER',
  IconCopyOutlineRegular: 'ICON_COPY',
}

const HOST_COMPONENTS = new Set([PRIMITIVES.Button, PRIMITIVES.Input, PRIMITIVES.StateDot])

/**
 * 按官方协议加载一次客户端 bundle，返回导出对象。
 * @param {string} tag 用于绕开 ESM 模块缓存
 * @param {{withoutPrimitives?: boolean}} [options]
 */
async function loadClient(tag, options = {}) {
  let exported = null
  const loadedIds = []
  const warned = []
  const realWarn = console.warn
  console.warn = (...args) => { warned.push(args.join(' ')) }
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        loadedIds.push(id)
        exported = factory(spec => {
          if (spec === 'react') return REACT
          if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
            if (options.withoutPrimitives) throw new Error('未提供界面组件')
            return PRIMITIVES
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
    console.warn = realWarn
  }
  exported.loadedIds = loadedIds
  exported.warned = warned
  return exported
}

/**
 * 把元素树展开到「宿主元素」一层。
 *
 * 测试用的 createElement 不认识函数型 type，所以 h(ConfigCard, …) 产出的树里
 * 仍嵌着 {type: ConfigCard, props} 这样的组件元素。这里手动调一次拿到输出；
 * 宿主提供的组件不调用，原样保留。
 */
function render(el) {
  if (el === null || el === undefined || typeof el !== 'object') return el
  if (typeof el.type === 'function') {
    if (HOST_COMPONENTS.has(el.type)) return { ...el }
    hookState = []
    hookIndex = 0
    return render(el.type(el.props ?? {}))
  }
  return {
    ...el,
    children: (el.children ?? []).map(render).filter(c => c !== null && c !== undefined),
  }
}

const isButton = el => el?.type === PRIMITIVES.Button
const isInput = el => el?.type === PRIMITIVES.Input
const byClass = (el, className) => (el?.children ?? []).find(c => c?.props?.className === className)
const flat = el => JSON.stringify(el)

/** 造一个 configForms 认得出来的命名空间视图（schema 是 $ref 风格）。 */
function namespaceView(ns, keys = ['repoUrl', 'branch', 'profileName', 'exportRoot', 'importRoot']) {
  return { ns, schema: { uid: 21, refs: { 21: { dict: Object.fromEntries(keys.map((k, i) => [k, i])) } } } }
}

/**
 * 造一个配置表单假体。
 * @param {object} [overrides]
 */
function fakeForm(overrides = {}) {
  const calls = { set: [], unset: [] }
  const form = {
    calls,
    snapshot: { status: 'ready', writable: true, value: {}, ...overrides.snapshot },
    getSnapshot() { return this.snapshot },
    subscribe: () => () => {},
    set: async (key, value) => {
      calls.set.push([key, value])
      if (overrides.reject) throw overrides.reject
      return overrides.accept ?? true
    },
    unset: async (key) => {
      calls.unset.push(key)
      if (overrides.reject) throw overrides.reject
      return overrides.accept ?? true
    },
  }
  return form
}

/**
 * 造一个客户端上下文。
 *
 * 与宿主半侧 test/apply-host.test.js 同一个理由：真客户端上下文也是
 * 「没 inject 过就不给读」，这里只提供被声明过的那几个服务，
 * 顺手把 effect 收下来，好断言「语言包是在 effect 里登记的」。
 * @param {object} [overrides]
 */
function clientCtx(overrides = {}) {
  const registered = []
  const effects = []
  const dictionaries = []
  const injected = []
  const ctx = {
    registered,
    effects,
    dictionaries,
    injected,
    slots: {
      inject: (name, fn) => { ctx.injectedSlot = name; fn() },
      register: (spec, component) => {
        registered.push({ spec, component })
        return () => {}
      },
    },
    // locale 是声明过的依赖，按 Cordis 的语义它一定存在
    locale: {
      bind: () => (key) => (key === 'nav' ? '设置漫游（译）' : key),
      register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
    },
    effect: (fn, label) => { effects.push({ fn, label }); return () => {} },
    // configForms 不是声明过的依赖，只能经 ctx.inject 拿
    inject: (deps, fn) => {
      injected.push(deps)
      fn(Object.fromEntries(deps.map(d => [d, overrides.captured?.[d]])))
    },
    ...overrides,
  }
  return ctx
}

// ─── 挂载契约 ────────────────────────────────────────────────────────
// 原先 client.js 只导出一堆组件，没有 apply 与 inject：
// 模块加载器会接受它，但没有任何东西会去挂载，设置页上是一片空白且不报错。

test('手写 lazy-CJS bundle 能被模块加载器真实接受（E4 实测）', async () => {
  // 这一步不能只看文件文本，必须真的按官方协议加载一次。
  // 官方协议见 packages/client/modules：window.__ModuleLoader__.load({ id, factory }),
  // factory(require) 返回导出，require 用裸说明符解析 loader 模块表。
  const exported = await loadClient('e4')
  const pkg = JSON.parse(read('package.json'))

  assert.deepEqual(exported.loadedIds, [pkg.name], '登记的 id 必须恰好是裸包名一次')
  assert.ok(exported && typeof exported === 'object', 'factory 必须返回导出对象')
  assert.equal(typeof exported.Section, 'function', '要贡献设置分区，必须导出 Section')
})

test('客户端导出 apply 与 inject —— 否则界面一片空白且不报错', async () => {
  const exported = await loadClient('mount')
  assert.equal(typeof exported.apply, 'function', '必须导出 apply，否则没有东西会挂载它')
  assert.ok(Array.isArray(exported.inject), '必须导出 inject')
})

test('inject 是字符串数组，不是函数 —— 这是实测纠正过来的一处错', async () => {
  const exported = await loadClient('deps')
  // 官方的 exports.inject 一律是数组
  // （packages/client/ui-settings-plugins/src/client/index.ts:28
  //  `export const inject = ['slots', 'locale']`），它声明的是「要用到哪些
  // 客户端服务」。写成函数的话注入器读不到依赖声明。
  assert.ok(Array.isArray(exported.inject), 'inject 必须是数组')
  assert.deepEqual(
    [...exported.inject].sort(),
    ['locale', 'slots'],
    '只声明真正用到的两个服务 —— 多声明一个就多一处「官方改名就装不上」的风险',
  )
})

test('声明了的客户端服务必须真的被用到 —— inject 不能有名无实', async () => {
  const src = read('client.js')
  for (const service of ['slots', 'locale']) {
    assert.ok(src.includes(`ctx.${service}`), `inject 声明了 ${service}，但源码里没有用到它`)
  }
})

test('configForms 走 ctx.inject 而不是写进 inject 数组 —— 它在宿主半侧还没声明', async () => {
  const exported = await loadClient('form-inject')
  const ctx = clientCtx()
  exported.apply(ctx)
  assert.ok(
    ctx.injected.includes('configForms') || ctx.injected.some(d => d.includes('configForms')),
    'configForms 必须经 ctx.inject 拿到',
  )
  assert.ok(!exported.inject.includes('configForms'), 'inject 数组里不该出现还没在宿主声明的服务')
})

test('apply 经 slots.inject 注册到 settings.section 槽位', async () => {
  const exported = await loadClient('slot')
  const ctx = clientCtx()
  exported.apply(ctx)

  assert.equal(ctx.injectedSlot, 'settings.section', '槽位名必须是字符串 settings.section')
  assert.equal(ctx.registered.length, 1, '只贡献一节，不占别处（界面决策 U2）')
  const { spec, component } = ctx.registered[0]
  assert.equal(spec.name, 'settings.section', '注册 spec 里的 name 也要是这个字符串')
  assert.equal(spec.id, 'settings-roam', 'id 用于去重与卸载')
  assert.equal(typeof spec.label, 'function', '分区标签必须是函数（延迟取语言包）')
  assert.equal(spec.locale, '@toookamak/dsh-settings-roam')
  assert.equal(typeof component, 'function', '挂载的必须是组件')
})

test('apply 在 effect 里登记语言包 —— 不登记的话 label 查的是不存在的命名空间', async () => {
  const exported = await loadClient('locale-reg')
  const ctx = clientCtx()
  exported.apply(ctx)

  assert.equal(ctx.effects.length, 1, '语言包登记必须挂在 effect 上，随插件卸载')
  assert.equal(ctx.effects[0].label, 'dsh-settings-roam: section dictionaries')

  // effect 在真上下文里由 Cordis 执行；这里手动跑一遍看登记了什么
  ctx.effects[0].fn()
  assert.equal(ctx.dictionaries.length, 1)
  assert.equal(ctx.dictionaries[0].ns, '@toookamak/dsh-settings-roam')
  assert.deepEqual(Object.keys(ctx.dictionaries[0].dicts).sort(), ['en', 'zh'])
})

test('语言包与 locale/*.json 内容一致 —— 内联是为了 bundle，不能各写各的', async () => {
  const exported = await loadClient('locale-sync')
  for (const lang of ['zh', 'en']) {
    const onDisk = JSON.parse(read(`locale/${lang}.json`))
    assert.deepEqual(
      exported.LOCALES[lang], onDisk,
      `client.js 内联的 ${lang} 与 locale/${lang}.json 不一致；` +
      '前者给浏览器半侧用，后者给宿主侧的插件清单读 meta.title／meta.description',
    )
  }
})

test('语言包登记失败时标签仍有兜底 —— 不因取不到翻译就整节不显示', async () => {
  const exported = await loadClient('label')
  // 语言服务在（声明过就一定在），但按键取不到值：字典还没登记完就会这样
  const ctx = clientCtx({ locale: { bind: () => () => undefined, register: () => () => {} } })
  exported.apply(ctx)
  const label = ctx.registered[0].spec.label()
  assert.equal(typeof label, 'string')
  assert.ok(label.length > 0, '标签必须有兜底文案')
})

test('语言服务整个缺席时也不得崩 —— 兜底路径要能独立成立', async () => {
  const exported = await loadClient('label-nolocale')
  const ctx = clientCtx({ locale: undefined })
  assert.doesNotThrow(() => exported.apply(ctx), '取不到翻译不该让整节挂掉')
  assert.equal(ctx.registered[0].spec.label(), '设置漫游')
})

test('apply 注册的标签优先取语言包', async () => {
  const exported = await loadClient('label2')
  const ctx = clientCtx()
  exported.apply(ctx)
  assert.equal(ctx.registered[0].spec.label(), '设置漫游（译）')
})

// ─── 视觉：用宿主的设计系统，不是浏览器默认样式 ──────────────────────
// 用户原话（m02561）：「设置界面很丑」。真浏览器复现确认：裸 h('div')/h('button')
// 拿到的是浏览器默认样式（灰色系统方块按钮、默认字号行高），与旁边官方分区
// 不像同一个软件。以下几条把「以后不许再退回裸元素」固化下来。

test('界面用宿主提供的组件，而不是裸 HTML 元素', async () => {
  const exported = await loadClient('primitives')
  const section = render(exported.Section({
    state: { kind: 'clean', status: { configured: true }, form: fakeForm() },
    actions: {},
  }))
  const configCard = byClass(section, 'roam-card roam-config')
  const field = byClass(configCard, 'roam-field')

  assert.ok(isInput(byClass(field, 'roam-field-input')), '输入框要用宿主的 Input')
  assert.equal(
    (byClass(section, 'roam-actions').children ?? []).filter(isButton).length,
    4,
    '四个动作都要用宿主的 Button',
  )
})

test('源码里不再有自带样式的裸按钮 —— 这才是「丑」的根源', () => {
  const src = read('client.js')
  assert.ok(!/'roam-button'/.test(src), '自定义按钮类名是上一版的做法，已由宿主 Button 取代')
  assert.ok(!/'roam-input'/.test(src), '自定义输入框类名同上')
  // 允许的唯一例外是「界面组件取不到」时的降级路径，它只能落在裸元素上
  assert.ok(
    (src.match(/h\('button', \{/g) ?? []).length <= 1,
    '裸 button 只应出现在降级路径里',
  )
})

test('界面组件取不到时降级为可用元素，而不是整节崩掉', async () => {
  const exported = await loadClient('primitives-missing', { withoutPrimitives: true })
  assert.ok(
    exported.warned.some(w => w.includes('界面组件')),
    '降级要留下痕迹，不能静默',
  )
  const section = render(exported.Section({
    state: { kind: 'clean', status: { configured: true } },
    actions: {},
  }))
  const buttons = (byClass(section, 'roam-actions').children ?? []).filter(c => c?.type === 'button')
  assert.equal(buttons.length, 4, '降级后仍要给出四个可点的按钮，只是没有宿主的样式')
})

test('样式表按 id 幂等注入 —— 反复挂载不堆样式', () => {
  const src = read('client.js')
  assert.match(src, /getElementById\(STYLE_ID\)/, '注入前必须按 id 判重')
  assert.match(src, /const STYLE_ID = '/, '样式表要有稳定 id')
})

test('样式用设计令牌，不写死颜色 —— 暗色主题下不能是白底黑字', () => {
  const src = read('client.js')
  const css = src.slice(src.indexOf('const CSS = ['), src.indexOf("].join('')"))
  assert.ok(css.includes('var(--dsw-'), '样式必须用宿主的设计令牌')
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(css),
    '不得写死颜色 —— 写死就跟着主题一起错',
  )
  // 字体只有「等宽展示路径」这一处需要自己指定，其余一律继承宿主
  const withFamily = css.match(/[^{}]*\{[^}]*font-family[^}]*\}/g) ?? []
  assert.equal(withFamily.length, 1, '不应该到处自己指定字体')
  assert.match(withFamily[0], /roam-path/, '唯一该自己指定字体的是等宽显示的路径')
})

// ─── 状态行 ──────────────────────────────────────────────────────────

test('状态行的每一类状态各给一句极简文案（U3）', async () => {
  const exported = await loadClient('u3')

  // busy 与 loading 共用「正在进行」的措辞是刻意的，所以这里给 busy 带上具体动作
  const cases = [
    ['loading', {}],
    ['busy', { text: '正在准备这次推送…' }],
    ['error', { message: '云端仓库地址不对。' }],
    ['needs-config', {}],
    ['empty-cloud', {}],
    ['has-diff', {}],
    ['review', {}],
    ['done', {}],
    ['clean', {}],
  ]
  const texts = new Set()
  for (const [kind, extra] of cases) {
    const el = render(exported.StatusLine({ state: { kind, count: 3, ...extra } }))
    const text = String(el.children.find(c => c?.type === 'span')?.children?.[0] ?? '')
    assert.ok(text.length > 0, `${kind} 必须有文案`)
    // 极简：不铺垫、不解释设计意图，一句话说清
    assert.ok(text.split('。').filter(Boolean).length <= 2, `${kind} 的文案不应超过一句话`)
    texts.add(text)
  }
  assert.equal(texts.size, cases.length, '各类状态的文案必须彼此不同')
})

test('状态是带状态点的，不只是文字 —— 「一眼看出」靠形态', async () => {
  const exported = await loadClient('statedot')
  const el = render(exported.StatusLine({ state: { kind: 'has-diff', count: 2 } }))
  assert.ok(el.children.some(c => c?.type === PRIMITIVES.StateDot), '要有状态点')
  assert.equal(el.props['data-tone'], 'warning', '语气要落在属性上，交给样式表处理')
})

test('未配置云端仓库时，只有拉取与推送禁用 —— 导出与导入不依赖云端', async () => {
  const exported = await loadClient('disabled')
  const section = render(exported.Section({
    state: { kind: 'needs-config', status: { configured: false } },
    actions: {},
  }))
  const buttons = (byClass(section, 'roam-actions').children ?? []).filter(isButton)
  // 点下去必然失败的按钮，和「按钮没接上线」在用户眼里是同一件事
  assert.equal(buttons[0].props.disabled, false, '导出不依赖云端，必须可点')
  assert.equal(buttons[1].props.disabled, false, '导入读的是本机目录，不该被云端配置挡住')
  assert.equal(buttons[2].props.disabled, true, '未配置时拉取要禁用')
  assert.equal(buttons[3].props.disabled, true, '未配置时推送要禁用')
})

test('加载中与执行中禁用全部动作 —— 不给双击留下第二次请求', async () => {
  const exported = await loadClient('busy')
  for (const kind of ['loading', 'busy']) {
    const section = render(exported.Section({
      state: { kind, status: { configured: true } },
      actions: {},
    }))
    const buttons = (byClass(section, 'roam-actions').children ?? []).filter(isButton)
    assert.ok(buttons.every(b => b.props.disabled === true), `${kind} 时三个按钮都该禁用`)
  }
})

// ─── 配置项（用户要求「设置页面要有基础的配置选项」）──────────────────
// 地址／选项一律不硬编码进源码：写在源码里的选项，改一次要重新装一次插件。
// 字段由 index.js 的 Config schema 自动生成表单，这里锁住界面这一侧。

test('配置卡列出每个字段，且每个字段都带说明文字', async () => {
  const exported = await loadClient('config-fields')
  const card = render(exported.ConfigCard({ form: fakeForm(), t: exported.makeT('zh') }))

  assert.equal(byClass(card, 'roam-card-title').children[0], '云端仓库')
  const fields = (card.children ?? []).filter(c => c?.props?.className === 'roam-field')
  assert.equal(fields.length, 5, '每个字段都要出现在界面上')
  for (const field of fields) {
    const label = byClass(field, 'roam-field-label')
    const hint = byClass(field, 'roam-field-hint')
    assert.ok(label?.children?.[0]?.length > 0, '每个字段都要有标签')
    assert.ok(hint?.children?.[0]?.length > 10, '每个字段都要有说明 —— 键名敲错了既不报错也不生效')
  }
})

test('每个字段都必须说明自己起什么作用 —— 尤其不能让「导入目录」继续自称没用', async () => {
  const exported = await loadClient('config-stage')
  const card = render(exported.ConfigCard({ form: fakeForm(), t: exported.makeT('zh') }))
  const fields = (card.children ?? []).filter(c => c?.props?.className === 'roam-field')
  const hints = fields.map(f => byClass(f, 'roam-field-hint').children[0])
  assert.equal(hints.length, 5)
  assert.ok(hints.every(h => typeof h === 'string' && h.length > 0), '每个字段都要有说明')
  // 第二阶段已落地，界面上不能再留着「尚未生效」的占位话术——用户会以为它没用
  assert.ok(
    !hints.some(h => /尚未生效|占位/.test(h)),
    '导入已经能用了，标签与说明里都不该再说它没生效',
  )
  assert.ok(
    hints.some(h => /导出的包|导出目录/.test(h)),
    '导入目录的说明要说清它去哪找包',
  )
})

test('输入框显示配置里当下的值', async () => {
  const exported = await loadClient('config-values')
  const form = fakeForm({ snapshot: { value: { repoUrl: 'https://example.com/a.git' } } })
  const card = render(exported.ConfigCard({ form, t: exported.makeT('zh') }))
  const fields = (card.children ?? []).filter(c => c?.props?.className === 'roam-field')
  const inputs = fields.map(f => byClass(f, 'roam-field-input'))
  assert.equal(inputs[0].props.value, 'https://example.com/a.git')
  assert.equal(inputs[1].props.value, '', '没填过的字段显示为空，不是 undefined')
})

test('改动后失焦即提交，提交的是输入框里当下的值', async () => {
  const exported = await loadClient('config-commit')
  const form = fakeForm({ snapshot: { value: { repoUrl: 'old' } } })
  const card = render(exported.ConfigCard({ form, t: exported.makeT('zh') }))
  const input = byClass(
    (card.children ?? []).find(c => c?.props?.className === 'roam-field'),
    'roam-field-input',
  )

  const outcome = await input.props.onBlur({ target: { value: 'https://new.example.com/x.git' } })
  assert.equal(outcome, 'ok')
  assert.deepEqual(form.calls.set, [['repoUrl', 'https://new.example.com/x.git']])

  input.props.onChange({ target: { value: 'typed' } })
  assert.equal(form.calls.set.length, 1, 'onChange 只改草稿，不落盘')
})

test('保存成功后回头问一次宿主状态 —— 否则「已保存」与点不动的按钮并存', async () => {
  const exported = await loadClient('config-saved-callback')
  const form = fakeForm({ snapshot: { value: { repoUrl: 'old' } } })
  let savedCount = 0
  const card = render(exported.ConfigCard({
    form,
    t: exported.makeT('zh'),
    onSaved: () => { savedCount += 1 },
  }))
  const input = byClass(
    (card.children ?? []).find(c => c?.props?.className === 'roam-field'),
    'roam-field-input',
  )

  await input.props.onBlur({ target: { value: 'https://new.example.com/x.git' } })
  assert.equal(savedCount, 1, '保存成功必须触发一次刷新')

  // 反向对照：被拒绝的写入不能刷新——那会让界面显示「宿主已接受」，
  // 而实际什么都没落盘。
  const refused = fakeForm({ snapshot: { value: { repoUrl: 'old' } }, accept: false })
  const refusedCard = render(exported.ConfigCard({
    form: refused,
    t: exported.makeT('zh'),
    onSaved: () => { savedCount += 1 },
  }))
  const refusedInput = byClass(
    (refusedCard.children ?? []).find(c => c?.props?.className === 'roam-field'),
    'roam-field-input',
  )
  await refusedInput.props.onBlur({ target: { value: 'nope' } })
  assert.equal(savedCount, 1, '写入被拒时不该刷新')
})

test('清空字段即清除该配置项 —— 不是写一个空字符串进去', async () => {
  const exported = await loadClient('config-unset')
  const form = fakeForm({ snapshot: { value: { repoUrl: 'https://old' } } })
  const card = render(exported.ConfigCard({ form, t: exported.makeT('zh') }))
  const input = byClass(
    (card.children ?? []).find(c => c?.props?.className === 'roam-field'),
    'roam-field-input',
  )

  await input.props.onBlur({ target: { value: '' } })
  assert.deepEqual(form.calls.unset, ['repoUrl'])
  assert.deepEqual(form.calls.set, [], '清空不该写成空的字符串')
})

test('值没变就不提交 —— 不制造无意义的写盘', async () => {
  const exported = await loadClient('config-noop')
  const form = fakeForm({ snapshot: { value: { repoUrl: 'same' } } })
  const card = render(exported.ConfigCard({ form, t: exported.makeT('zh') }))
  const input = byClass(
    (card.children ?? []).find(c => c?.props?.className === 'roam-field'),
    'roam-field-input',
  )

  assert.equal(await input.props.onBlur({ target: { value: 'same' } }), 'unchanged')
  assert.deepEqual(form.calls.set, [])
  assert.deepEqual(form.calls.unset, [])
})

test('宿主拒绝写入时如实返回，不谎报成功', async () => {
  const exported = await loadClient('config-refused')
  const form = fakeForm({ snapshot: { value: { repoUrl: 'old' } }, accept: false })
  const card = render(exported.ConfigCard({ form, t: exported.makeT('zh') }))
  const input = byClass(
    (card.children ?? []).find(c => c?.props?.className === 'roam-field'),
    'roam-field-input',
  )

  assert.equal(await input.props.onBlur({ target: { value: 'new' } }), 'refused')

  // configForms 只回一个布尔，宿主的原始理由到不了前端。
  // 所以失败文案必须自己把最常见的原因说清楚，否则用户看到的是一句无解的「保存失败」。
  const t = exported.makeT('zh')
  const shown = exported.describeNote(exported.failureNote('', t), { status: 'ready' }, t)
  assert.ok(/没有保存成功/.test(shown), '要说清楚这次没保存成功')
  assert.ok(/覆盖|别处/.test(shown), '要点出「这个条目在别处也被声明了」这个最常见的原因')
})

test('宿主抛出具体理由时，把它一并显示出来', async () => {
  const exported = await loadClient('config-throw')
  const form = fakeForm({
    snapshot: { value: { repoUrl: 'old' } },
    reject: new Error('boom-detail'),
  })
  const card = render(exported.ConfigCard({ form, t: exported.makeT('zh') }))
  const input = byClass(
    (card.children ?? []).find(c => c?.props?.className === 'roam-field'),
    'roam-field-input',
  )
  assert.equal(await input.props.onBlur({ target: { value: 'new' } }), 'failed')

  const t = exported.makeT('zh')
  const shown = exported.describeNote(exported.failureNote('boom-detail', t), { status: 'ready' }, t)
  assert.match(shown, /boom-detail/, '宿主给了理由就不能吞掉')
})

test('表单取不到时说清是取不到，而不是给一片空白', async () => {
  const exported = await loadClient('config-unavailable')
  const form = fakeForm({ snapshot: { status: 'unavailable' } })
  const card = render(exported.ConfigCard({ form, t: exported.makeT('zh') }))
  const text = flat(card)
  assert.ok(/不可编辑|尚未就绪|还没就绪|取不到/.test(text), '要给一句能行动的话')
  assert.equal((card.children ?? []).some(c => c?.props?.className === 'roam-field'), false, '取不到就不渲染空输入框')
})

test('resolveForm 按 schema 形状认出自己的命名空间', async () => {
  const exported = await loadClient('resolve-form')
  const form = fakeForm()
  const configForms = {
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: [namespaceView('someone-else', ['a']), namespaceView('dsh-settings-roam')] } }) }),
    get: ns => (ns === 'dsh-settings-roam' ? form : null),
  }
  assert.equal(exported.resolveForm(configForms), form)
})

test('resolveForm 在表单还没就绪时返回 null，而不是抛错', async () => {
  const exported = await loadClient('resolve-form-empty')
  assert.equal(exported.resolveForm(undefined), null)
  assert.equal(exported.resolveForm({}), null)
  assert.equal(exported.resolveForm({ get: () => null, describe: () => { throw new Error('还没就绪') } }), null)
  assert.equal(exported.resolveForm({ get: () => null, describe: () => ({ getSnapshot: () => ({ view: { namespaces: [] } }) }) }), null)
})

// ─── 概述显示（用户要求「页面上要有概述」）────────────────────────────
// 取向：只给概述，不铺开逐项清单。要看细节去打开导出的文件。

test('概述渲染计数与「去哪看详情」的路径', async () => {
  const exported = await loadClient('ov')
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
  const out = flat(render(exported.Overview({ state })))

  assert.ok(out.includes('本次将同步'), '要有标题')
  assert.ok(out.includes('公共配置') && out.includes('技能') && out.includes('插件'), '三类计数都要有')
  assert.ok(out.includes('2026-10-15 09:07'), '要有时间')
  assert.ok(out.includes('machine-a'), '要标明来源机器')
  assert.ok(out.includes('/x/export/1'), '要给出详情所在路径')
})

test('概述只给概述 —— 不把逐项文件清单铺进界面', async () => {
  const exported = await loadClient('ov-list')
  const state = {
    overview: {
      title: '本次将同步',
      stats: [{ label: '技能', value: 2 }],
      meta: [],
      location: '/x/export/1',
      // 即便宿主多传了文件清单，界面也不应逐项铺开
      files: [{ path: 'skills/one/SKILL.md' }, { path: 'skills/three/SKILL.md' }],
    },
  }
  const out = flat(render(exported.Overview({ state })))
  assert.ok(!out.includes('skills/one'), '不逐项列出文件路径')
  assert.ok(!out.includes('skills/three'), '不逐项列出文件路径')
})

test('没有概述数据时不渲染空壳', async () => {
  const exported = await loadClient('ov-empty')
  assert.equal(exported.Overview({ state: {} }), null)
  assert.equal(exported.Overview({ state: undefined }), null)
  assert.equal(exported.Overview({ state: { overview: null } }), null)
})

test('落盘路径给一个「复制」动作 —— 路径在浏览器里点不开', async () => {
  const exported = await loadClient('ov-copy')
  const copied = []
  const state = { overview: { title: 't', stats: [], location: '/x/y' } }
  const el = render(exported.Overview({ state, actions: { onCopyPath: p => copied.push(p) } }))

  const loc = byClass(el, 'roam-loc')
  const button = (loc.children ?? []).filter(isButton)[0]
  assert.ok(button, '给了 onCopyPath 就该渲染复制按钮')
  button.props.onClick()
  assert.deepEqual(copied, ['/x/y'])
})

test('没有复制动作时不渲染按钮 —— 不给出点了没反应的控件', async () => {
  const exported = await loadClient('ov-nocopy')
  const el = render(exported.Overview({ state: { overview: { title: 't', stats: [], location: '/x/y' } } }))
  assert.ok(flat(el).includes('/x/y'), '路径仍要显示出来，让用户能自己找过去')
  assert.equal((byClass(el, 'roam-loc').children ?? []).filter(isButton).length, 0, '但不应有无效按钮')
})

// ─── 跳过项 ──────────────────────────────────────────────────────────

test('跳过项渲染的是说明文字，不是失败计数（§3.4）', async () => {
  const exported = await loadClient('skip')
  const item = { name: 'demo-plugin', explanation: '把它发布到 registry 之后才能同步过来。' }
  const out = flat(render(exported.Section({ state: { kind: 'has-diff', count: 1, skipped: [item] } })))

  assert.ok(out.includes('demo-plugin'), '要显示是哪个插件')
  assert.ok(out.includes('发布到 registry'), '必须给出可行动的说明')
  assert.ok(!/失败\s*\d+|skip count/i.test(out), '不得退化成失败计数')
})

// ─── U1：推送前必须先确认 ────────────────────────────────────────────

test('待确认区块给出「确认」与「取消」两个动作', async () => {
  const exported = await loadClient('pending')
  const clicked = []
  const state = {
    kind: 'review',
    pending: { kind: 'push', token: 'tok-1', text: '将推送 3 个文件', confirmLabel: '确认推送' },
  }
  const actions = {
    onConfirm: () => clicked.push('confirm'),
    onCancel: () => clicked.push('cancel'),
  }

  const section = render(exported.Section({ state, actions }))
  const pending = byClass(section, 'roam-card roam-pending')
  assert.ok(pending, '有待确认内容时必须渲染出来 —— 确认点得看得见')

  const buttons = (byClass(pending, 'roam-pending-actions').children ?? []).filter(isButton)
  assert.deepEqual(buttons.map(b => b.children[0]), ['确认推送', '取消'])

  buttons[0].props.onClick()
  buttons[1].props.onClick()
  assert.deepEqual(clicked, ['confirm', 'cancel'])
})

test('配置保存后的刷新回调要一路传到配置卡 —— 断在中间就退回「点了没反应」', async () => {
  const exported = await loadClient('saved-wiring')
  const onSaved = () => {}
  // 刻意不调 render()：一旦展开，配置卡就只剩渲染结果，看不到它收到的 props。
  const section = exported.Section({
    state: { kind: 'needs-config', form: fakeForm() },
    actions: { onSaved },
  })
  // Section 是纯展示组件，配置卡以组件元素的形式嵌在树里，props 直接可查。
  const card = (section.children ?? []).find(c => c?.type === exported.ConfigCard)
  assert.ok(card, '有表单时必须渲染配置卡')
  assert.equal(card.props.onSaved, onSaved, '刷新回调必须传到配置卡')
})

test('没有待确认内容时不渲染待确认区 —— 不给空壳', async () => {
  const exported = await loadClient('pending2')
  const section = render(exported.Section({ state: { kind: 'clean' }, actions: {} }))
  assert.equal(byClass(section, 'roam-card roam-pending'), undefined, '没有 pending 时不该出现确认区')
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
  assert.match(src, /pending/, '预览结果要落到待确认状态里')
  assert.ok(
    !/onClick:\s*\(\)\s*=>\s*request\([^)]*['"]?confirm/.test(src),
    '按钮不得直接触发确认',
  )
})

test('预览之后停在「待确认」，不能显示成已完成', async () => {
  const src = read('client.js')
  const body = src.slice(src.indexOf('const begin = React.useCallback'), src.indexOf('const confirm = React.useCallback'))
  // 预览那一瞬间什么都还没写。原先这里写成 kind:'done'（推送）与 'has-diff'（拉取），
  // 用户看到的是「已完成」，而实际上还要点一次「确认」。
  assert.ok(
    /kind:\s*'review'/.test(body),
    '预览后必须进入 review 状态 —— 显示「已完成」会让用户以为已经写完了',
  )
  assert.ok(!/kind:\s*'done'/.test(body), '预览不是完成')
})

// ─── 动作区 ──────────────────────────────────────────────────────────

test('动作区第一个是「导出到文件」，且每个按钮都真接上了动作', async () => {
  const exported = await loadClient('actions')
  const clicked = []
  const section = render(exported.Section({
    state: { kind: 'clean', status: { configured: true } },
    actions: {
      onExport: () => clicked.push('export'),
      onImport: () => clicked.push('import'),
      onPull: () => clicked.push('pull'),
      onPush: () => clicked.push('push'),
    },
  }))
  const buttons = (byClass(section, 'roam-actions').children ?? []).filter(isButton)

  assert.equal(buttons[0].children[0], '导出到文件', '第一次打开这一节最该点的是它')
  assert.deepEqual(buttons.map(b => b.children[0]), ['导出到文件', '导入', '拉取', '推送'])
  for (const b of buttons) b.props.onClick()
  assert.deepEqual(clicked, ['export', 'import', 'pull', 'push'])
})

test('导出不经过确认流程 —— 无副作用的本地动作不该多点两次', async () => {
  const src = read('client.js')
  // 边界用下一个函数的名字，不用注释文本——注释改一个字就会切出后面所有东西，
  // 那时断言会「因为读到了别的代码」而失败，而不是因为导出真的走错了流程。
  const body = src.slice(src.indexOf('const beginExport'), src.indexOf('const begin = React.useCallback'))
  assert.ok(body.includes('ROUTES.export'), '导出要打导出路由')
  assert.ok(!body.includes('pending'), '导出不产生待确认状态')
  assert.ok(!body.includes('step:'), '导出没有 prepare/confirm 两段')
})

// ─── 兼容性检查的呈现 ────────────────────────────────────────────────

test('检查结果里「不需要做什么」的项不摆出来 —— 否则真正要注意的会被淹掉', async () => {
  const exported = await loadClient('compat-filter')
  const notable = exported.compatNotable({
    blocked: false,
    counts: { ok: 3, warn: 1, block: 1 },
    items: [
      { level: 'ok', name: 'a', code: 'entry-update' },
      { level: 'warn', name: 'b', code: 'plugin-missing' },
      { level: 'block', name: 'c', code: 'name-mismatch' },
    ],
  })
  assert.deepEqual(notable.map(i => i.name), ['b', 'c'])
})

test('检查结果缺失时不崩 —— 老版本服务不返回这个字段', async () => {
  const exported = await loadClient('compat-missing')
  assert.deepEqual(exported.compatNotable(null), [])
  assert.deepEqual(exported.compatNotable({}), [])
  assert.deepEqual(exported.compatNotable({ items: 'nope' }), [])
})

test('预览里逐条摆出需要注意的项，连「下一步怎么办」一起给', async () => {
  const exported = await loadClient('compat-pending')
  const state = {
    kind: 'review',
    pending: {
      kind: 'pull',
      token: 'tok',
      text: '云端有 1 条配置，其中 1 项与本机不同。确认后改动本机。',
      confirmLabel: '确认拉取',
      compat: {
        blocked: false,
        counts: { ok: 0, warn: 1, block: 0 },
        items: [{
          level: 'warn', name: 'dshmarket', code: 'plugin-missing',
          message: '插件「dshmarket」本机没有装。', action: '先按你原来的方式装上，再重启 DSH。',
        }],
      },
    },
  }
  const tree = exported.Pending({ state, actions: {}, t: key => key })
  const text = flat(tree)

  assert.ok(text.includes('本机没有装'), '应当摆出这条提醒')
  assert.ok(text.includes('再重启 DSH'), '只说问题不说怎么办，用户还是不知道下一步')

  // 确认按钮仍然是可点的：提醒不该变成路障。
  const actionsRow = byClass(tree, 'roam-pending-actions')
  const confirm = actionsRow.children.find(isButton)
  assert.notEqual(confirm.props.disabled, true, '只有 warn 时不该禁用确认')
})

test('有拦下的项时不给可点的确认 —— 这类项点下去不报错也不生效', async () => {
  const exported = await loadClient('compat-blocked')
  const state = {
    kind: 'review',
    pending: {
      kind: 'pull',
      token: 'tok',
      text: '预览',
      compat: {
        blocked: true,
        counts: { ok: 0, warn: 0, block: 1 },
        items: [{
          level: 'block', name: 'llm-pi-ai', code: 'name-mismatch',
          message: '「llm-pi-ai」本机指向的是别的包。', action: '先确认要保留哪一个。',
        }],
      },
    },
  }
  // 用真的语言包，顺带验证 compat.blocked 这个键确实存在（写错键会露出键名）。
  const tree = exported.Pending({ state, actions: {}, t: exported.makeT('zh') })
  const actionsRow = byClass(tree, 'roam-pending-actions')
  const confirm = actionsRow.children.find(isButton)

  assert.equal(confirm.props.disabled, true, '有拦下的项时确认必须是禁用的')
  assert.ok(!flat(tree).includes('compat.blocked'), '语言包里应当真有这个键')
  assert.ok(flat(tree).includes('不会生效'), '还要说清为什么不让点')

  // 取消仍然可点：用户总得能退出去。
  const cancel = actionsRow.children.filter(isButton)[1]
  assert.notEqual(cancel.props.disabled, true)
})
