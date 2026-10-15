import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPushOverview, buildPullOverview } from '../src/overview.js'

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
  assert.equal(byLabel['插件'], 3, '官方 2 + 第三方 1，合并成一个数字')
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

test('插件名单内容损坏时该计数归零，但不拖垮整个概述', () => {
  const o = buildPushOverview({
    files: [
      { path: 'config/profile.patch.yml', content: 'x\n' },
      { path: 'config/bundles.json', content: '{ 这不是 JSON' },
    ],
    summary: {},
  })

  const byLabel = Object.fromEntries(o.stats.map(s => [s.label, s.value]))
  assert.equal(byLabel['插件'], 0, '坏数据只影响这一条统计')
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
