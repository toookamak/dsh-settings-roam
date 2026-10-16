import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPushOverview, buildPullOverview, buildImportOverview, buildInspectOverview } from '../src/overview.js'

const FILES = [
  { path: 'config/profile.patch.yml', content: '- id: llm-pi-ai\n' },
  { path: 'config/bundles.json', content: JSON.stringify({ official: ['a', 'b'], thirdParty: ['c'] }) },
  { path: 'skills/one/SKILL.md', content: '# one\n' },
  { path: 'skills/two/SKILL.md', content: '# two\n' },
]

test('推送概述给出三类计数，各对应一条真实来源', () => {
  const o = buildPushOverview({
    files: FILES,
    summary: { add: 2, modify: 1, delete: 0 },
    generatedBy: 'machine-a',
  })

  assert.equal(o.title, '本次将同步')
  const byLabel = Object.fromEntries(o.stats.map(s => [s.label, s.value]))
  assert.equal(byLabel['公共配置'], 1)
  assert.equal(byLabel['技能'], 2, '一个技能目录算一个技能，不是按文件数')
  assert.equal(byLabel['插件'], 1, '只数自己装的；DSH 自带的那批不进这个数字')
  assert.ok(
    o.meta.some(m => m.includes('插件名单共 3 项（其中 DSH 自带 2 项）')),
    '自带的那批不能就这么消失，要在 meta 里交代',
  )
})

test('概述包含时间与来源，用于判断「是不是我刚才那次」', () => {
  const o = buildPushOverview(
    { files: FILES, summary: {}, generatedBy: 'machine-a' },
    { now: new Date('2026-10-15T09:07:00Z') },
  )

  const joined = o.meta.join(' | ')
  assert.match(joined, /2026-10-15 \d{2}:\d{2}/, '应有本地时间，精确到分钟')
  assert.match(joined, /来自 machine-a/)
})

test('有差异时在概述里点出数量', () => {
  const o = buildPushOverview({
    files: FILES,
    summary: { add: 3, modify: 2, delete: 1 },
  })
  assert.ok(o.meta.some(m => m.includes('6 项差异')))
})

test('无差异时不提差异 —— 零项差异是噪音', () => {
  const o = buildPushOverview({
    files: FILES,
    summary: { add: 0, modify: 0, delete: 0 },
  })
  assert.ok(!o.meta.some(m => m.includes('差异')))
})

test('概述指向导出目录，用户据此去看详情', () => {
  const o = buildPushOverview({
    files: FILES,
    summary: {},
    exported: { exportPath: '/home/u/.dsh/settings-roam/export/2026-10-15-0907' },
  })
  assert.equal(o.location, '/home/u/.dsh/settings-roam/export/2026-10-15-0907')
})

test('没有导出时 location 为 null —— 不给一个打不开的路径', () => {
  const o = buildPushOverview({ files: FILES, summary: {} })
  assert.equal(o.location, null)
})

test('空计划返回 null，界面据此不渲染空区块', () => {
  assert.equal(buildPushOverview({ files: [], summary: {} }), null)
  assert.equal(buildPushOverview(null), null)
})

test('插件名单内容损坏时给占位符，但不拖垮整个概述', () => {
  const o = buildPushOverview({
    files: [
      { path: 'config/profile.patch.yml', content: 'x\n' },
      { path: 'config/bundles.json', content: '{ 这不是 JSON' },
    ],
    summary: {},
  })

  const byLabel = Object.fromEntries(o.stats.map(s => [s.label, s.value]))
  assert.equal(byLabel['插件'], '—', '读不出来就说读不出来，不能报 0')
  assert.equal(byLabel['公共配置'], 1, '其它统计照常给出')
  assert.ok(o.title, '概述本身仍然可用')
})

test('拉取概述只数已应用项，跳过项单独计', () => {
  const o = buildPullOverview({
    applied: [{ name: 'a' }, { name: 'b' }],
    skipped: [{ name: 'c' }],
    backupPath: '/bk/1',
  })

  const byLabel = Object.fromEntries(o.stats.map(s => [s.label, s.value]))
  assert.equal(byLabel['已应用'], 2)
  assert.equal(byLabel['已跳过'], 1)
  assert.ok(o.meta.some(m => m.includes('已备份')), '要说清可回退')
  assert.equal(o.location, '/bk/1')
})

test('拉取全空返回 null；全部跳过时不给「已跳过 0」', () => {
  assert.equal(buildPullOverview({ applied: [], skipped: [] }), null)

  const o = buildPullOverview({ applied: [{ name: 'a' }], skipped: [] })
  const labels = o.stats.map(s => s.label)
  assert.ok(!labels.includes('已跳过'), '没有跳过项就不显示这一项')
})

// ─── 导入概述（第二阶段的「先看后写」那一半）──────────────────────

test('导入概述把「不写回的项数」摆出来 —— 这正是它与复制环境的区别', () => {
  const view = buildImportOverview({
    packageDir: '/tmp/pkg/20261015-120000',
    generatedAt: '2026-10-15T04:00:00.000Z',
    generatedBy: 'workstation',
    patchRows: [{ id: 'llm-pi-ai' }],
    skillFiles: [{ relPath: 'a/SKILL.md' }, { relPath: 'b/SKILL.md' }],
    refused: [{ path: '本机:webserver' }, { path: '本机:ui-theme' }],
  })

  assert.equal(view.title, '本次将导入')
  assert.deepEqual(view.stats.map(s => [s.label, s.value]), [
    ['配置项', 1],
    ['技能文件', 2],
    ['本机项（不写回）', 2],
  ])
  assert.equal(view.total, 3, 'total 只数会写回的项')
  assert.equal(view.location, '/tmp/pkg/20261015-120000', '详情在包里')
})

test('没有本机项时不多出一行 0 —— 空数字会让人以为哪里没做', () => {
  const view = buildImportOverview({
    packageDir: '/tmp/pkg',
    patchRows: [{ id: 'llm-pi-ai' }],
    skillFiles: [],
    refused: [],
  })
  assert.deepEqual(view.stats.map(s => s.label), ['配置项', '技能文件'])
})

test('空洞里空空的包返回 null，界面据此不渲染空壳', () => {
  assert.equal(buildImportOverview({ patchRows: [], skillFiles: [], refused: [] }), null)
  assert.equal(buildImportOverview(null), null)
})

test('包来自哪台机器、什么时候导的，要在概述里说清', () => {
  const view = buildImportOverview({
    packageDir: '/tmp/pkg',
    generatedAt: '2026-10-15T04:00:00.000Z',
    generatedBy: 'workstation',
    patchRows: [{ id: 'llm-pi-ai' }],
    refused: [],
  })
  assert.ok(view.meta.includes('来自 workstation'))
  // 时间必须是本地可读的，不能把 ISO 串原样丢给用户
  assert.ok(view.meta.some(m => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(m)), view.meta.join(' | '))
})

test('generatedAt 坏掉时原样显示，不要变成「无效日期」', () => {
  const view = buildImportOverview({
    packageDir: '/tmp/pkg',
    generatedAt: 'not-a-date',
    patchRows: [{ id: 'x' }],
    refused: [],
  })
  assert.ok(view.meta.includes('not-a-date'))
})

test('拉取概述的标题与标签可以由调用方改 —— 导入结果复用它，但不能叫「拉取」', () => {
  const view = buildPullOverview(
    { applied: [{ name: 'a' }], skipped: [{ name: 'b' }], backupPath: '/tmp/bk' },
    { title: '本次导入结果', appliedLabel: '已写入', location: '/tmp/pkg' },
  )
  assert.equal(view.title, '本次导入结果')
  assert.equal(view.stats[0].label, '已写入')
  assert.equal(view.location, '/tmp/pkg')
})

// ─── 本机现状概述（打开设置页就该看见的那一块）──────────────────────
// 它不来自任何一次动作，而是「选完 profile 之后第一眼」：
// 配了几家供应商、装了几个插件 —— 用户据此确认这是不是要备份的那份。

const INSPECT = {
  patchFile: '/home/u/.dsh/profiles/web/cordis.patch.yml',
  patchExists: true,
  total: 3,
  shared: [{ id: 'llm-pi-ai' }],
  machine: [{ id: 'webserver' }, { id: 'ui-theme' }],
  excludedIds: ['ui-chat'],
  skills: [{ relPath: 'one/SKILL.md' }, { relPath: 'one/lib/a.mjs' }, { relPath: 'two/SKILL.md' }],
  skillNames: ['one', 'two'],
  providers: { count: 3, names: ['a', 'b', 'c'] },
  bundles: { official: ['x', 'y'], thirdParty: ['z'] },
}

test('本机概述回答「几家供应商、几个插件」—— 这是选完 profile 第一件想确认的事', () => {
  const o = buildInspectOverview(INSPECT, { now: new Date('2026-10-16T12:00:00Z') })
  const byLabel = Object.fromEntries(o.stats.map(s => [s.label, s.value]))

  assert.equal(byLabel['模型供应商'], 3)
  // 用户拿这个数字对自己的插件列表：19 里塞进 10 个 DSH 自带的，
  // 他会以为自己多装了一倍。
  assert.equal(byLabel['已装插件'], 1, '只数自己装的')
  assert.equal(byLabel['公共配置项'], 1)
  assert.equal(byLabel['技能'], 2, '一个技能目录算一个技能，不是按文件数')
  assert.equal(o.location, '/home/u/.dsh/profiles/web/cordis.patch.yml')
  assert.ok(
    o.meta.some(m => m.includes('插件名单共 3 项（其中 DSH 自带 2 项）')),
    '自带的要交代清楚，不能让人以为名单只记了第三方',
  )
})

test('技能数与技能文件数分开说 —— 一个技能可能横跨好几个文件', () => {
  const o = buildInspectOverview(INSPECT)
  const byLabel = Object.fromEntries(o.stats.map(s => [s.label, s.value]))
  assert.equal(byLabel['技能'], 2)
  assert.ok(o.meta.some(m => m.includes('3 个文件')), '文件数摊开写，别让两个数字打架')
})

test('插件名单取不到时给占位符而不是 0 —— 0 会被读成「一个插件都没装」', () => {
  const o = buildInspectOverview({ ...INSPECT, bundles: null })
  const byLabel = Object.fromEntries(o.stats.map(s => [s.label, s.value]))

  assert.equal(byLabel['已装插件'], '—')
  assert.ok(o.meta.some(m => m.includes('插件名单暂不可用')))
})

test('没有 DSH 自带插件时不加那条交代 —— 零项自带是噪音', () => {
  const o = buildInspectOverview({ ...INSPECT, bundles: { official: [], thirdParty: ['z'] } })
  const byLabel = Object.fromEntries(o.stats.map(s => [s.label, s.value]))

  assert.equal(byLabel['已装插件'], 1)
  assert.ok(!o.meta.some(m => m.includes('DSH 自带')), '没自带就别提')
})

test('把「留在本机」「不同步」的项数摆出来 —— 否则「我配的怎么没过去」无从查证', () => {
  const o = buildInspectOverview(INSPECT)
  const joined = o.meta.join(' | ')
  assert.match(joined, /留在本机 2 项/)
  assert.match(joined, /不同步 1 项/)
})

test('没有本机现状可读时返回 null —— 不给一份凭空的清单', () => {
  assert.equal(buildInspectOverview(null), null)
  assert.equal(buildInspectOverview(undefined), null)
})

test('本机概述也带读取时间，用来判断看到的是不是刚才那次', () => {
  const o = buildInspectOverview(INSPECT, { now: new Date('2026-10-16T12:00:00Z') })
  assert.match(o.meta.join(' | '), /读取于 2026-10-16 \d{2}:\d{2}/)
})
