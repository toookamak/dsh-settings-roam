import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SKIP_REASONS, explainSkip, buildReportView } from '../src/report.js'

test('四类跳过原因都有针对性的说明，不是一句「失败」', () => {
  const seen = new Set()
  for (const reason of ['local-path-source', 'version-incompatible', 'registry-unreachable', 'build-blocked', 'unknown']) {
    const text = explainSkip({ reason, name: 'demo-plugin' })
    assert.ok(typeof text === 'string' && text.length > 10, `${reason} 应有足够具体的说明`)
    seen.add(text)
  }
  assert.equal(seen.size, 5, '每类原因的说明必须彼此不同')
})

test('两种跳过原因指向同一个插件时，说明也不相同', () => {
  const a = explainSkip({ reason: 'local-path-source', name: 'demo' })
  const b = explainSkip({ reason: 'build-blocked', name: 'demo' })
  assert.notEqual(a, b)
})

test('本机路径来源的说明要指出原始路径', () => {
  const text = explainSkip({ reason: 'local-path-source', name: 'demo', detail: '/home/alice/src/demo' })
  assert.ok(text.includes('/home/alice/src/demo'), '要指出是哪条路径')
})

test('版本不兼容要说明这是保护而非故障', () => {
  const text = explainSkip({ reason: 'version-incompatible', name: 'demo' })
  assert.ok(/保护|不是故障|并非故障/.test(text), '要让用户理解这不是故障')
})

test('跳过时必须能看出这个插件当前到底装没装', () => {
  const view = buildReportView({
    applied: [],
    skipped: [{ kind: 'plugin', name: 'demo', result: 'skipped', reason: 'build-blocked' }],
    needsRestart: false,
    needsCredentials: [],
    backupPath: '/tmp/bk',
  })
  assert.equal(view.plugins.length, 1)
  assert.equal(view.plugins[0].installed, false, '应明确标出未安装')
})

test('报告要提示本机偏好未随行，避免被误读为恢复失败', () => {
  const view = buildReportView({
    applied: [{ kind: 'file', name: 'patch:llm-pi-ai', result: 'ok' }],
    skipped: [],
    needsRestart: true,
    needsCredentials: ['DEMO_KEY'],
    backupPath: '/tmp/bk',
  })
  assert.ok(view.notices.some(n => n.includes('本机')), '应有本机偏好说明')
  assert.ok(view.notices.some(n => n.includes('DEMO_KEY')), '应列出要补的密钥')
  assert.ok(view.notices.some(n => n.includes('重启')), '应提示重启')
  assert.equal(view.empty, false)
})

test('空报告不产生误导性的提示', () => {
  const view = buildReportView({
    applied: [], skipped: [], needsRestart: false, needsCredentials: [], backupPath: '/b',
  })
  assert.equal(view.empty, true)
  assert.deepEqual(view.notices, [], '没有变化时不应提示重启或密钥')
})

test('跳过原因常量表覆盖设计规定的全部取值', () => {
  assert.deepEqual(
    [...SKIP_REASONS].sort(),
    ['build-blocked', 'local-path-source', 'registry-unreachable', 'unknown', 'version-incompatible'],
  )
})

// ─── 校验结果必须到达用户眼前（缺口 A 的下半截）────────────────────
// 光把校验接上还不够：结果若只留在内部对象里，用户依然看不见。

test('两路核对不一致时，报告里必须出现可读的说明', () => {
  const report = {
    applied: [{ name: 'llm-pi-ai', kind: 'patch' }],
    skillCheck: {
      checked: true,
      consistent: false,
      complete: true,
      onlyDirect: ['alpha'],
      onlyService: ['beta'],
    },
  }

  const view = buildReportView(report)
  const text = view.notices.join('\n')

  assert.match(text, /两路核对不一致/, '必须有一条说明')
  assert.match(text, /beta/, '要点名服务视图里有而目录里没有的')
  assert.match(text, /alpha/, '也要点名目录里有的')
})

test('核对一致时不产生噪音', () => {
  const report = {
    applied: [{ name: 'llm-pi-ai', kind: 'patch' }],
    skillCheck: { checked: true, consistent: true, complete: true, onlyDirect: [], onlyService: [] },
  }

  const view = buildReportView(report)
  assert.ok(
    !view.notices.join('\n').includes('两路核对不一致'),
    '一致时不该提示不一致',
  )
})

test('没跑校验时不提示，不制造「已核对」的假象', () => {
  const report = {
    applied: [{ name: 'llm-pi-ai', kind: 'patch' }],
    skillCheck: { checked: false, consistent: true, complete: false, onlyDirect: [], onlyService: [] },
  }

  const view = buildReportView(report)
  assert.ok(!view.notices.join('\n').includes('两路核对'))
})
