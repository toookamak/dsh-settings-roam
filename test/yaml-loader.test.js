import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePatchList, splitByTopLevelId, renderPatches, mergeSharedInto,
} from '../src/yaml-loader.js'

const SAMPLE = [
  '# 首行注释，验证注释不保真这一已知代价',
  '- id: webserver',
  '  config:',
  "    host: '10.0.0.5'",
  '    port: 3080',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      demo:',
  '        apiKeyEnv: DEMO_KEY',
  '- id: ui-theme',
  '  config:',
  '    preference: dark',
  '',
].join('\n')

test('解析顶层数组并保留方言节点', () => {
  const rows = parsePatchList(SAMPLE)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(r => r.id), ['webserver', 'llm-pi-ai', 'ui-theme'])
})

test('!!js 表达式解析为表达式节点且不被求值', () => {
  const rows = parsePatchList([
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      demo:',
    '        apiKeyEnv: !!js process.env.DEMO_KEY',
    "        baseURL: !!js '`${process.env.HOST}/v1`'",
    '',
  ].join('\n'))
  const cfg = rows[0].config.providers.demo
  assert.equal(typeof cfg.apiKeyEnv, 'object')
  assert.equal(cfg.apiKeyEnv.__jsExpr, 'process.env.DEMO_KEY')
  assert.equal(cfg.baseURL.__jsExpr, '`${process.env.HOST}/v1`')
})

test('按顶层条目切分，得到 shared / machine / excluded 三组', () => {
  const rows = parsePatchList(SAMPLE)
  const { shared, machine, excluded } = splitByTopLevelId(rows)
  assert.deepEqual(shared.map(r => r.id), ['llm-pi-ai'])
  assert.deepEqual(machine.map(r => r.id).sort(), ['ui-theme', 'webserver'])
  assert.deepEqual(excluded, [])
})

test('渲染保留 !!js 标签', () => {
  const rows = parsePatchList([
    '- id: llm-pi-ai',
    '  config:',
    '    k: !!js process.env.X',
    '',
  ].join('\n'))
  const text = renderPatches(rows)
  assert.match(text, /!!js/)
})

test('C1：新增公共条目走 insert，目标行不存在也能写入', () => {
  const target = parsePatchList("- id: webserver\n  config:\n    host: '10.0.0.5'\n")
  const shared = parsePatchList("- id: llm-pi-ai\n  config:\n    providers:\n      demo:\n        apiKeyEnv: DEMO_KEY\n")
  const { rows, warnings } = mergeSharedInto(target, shared)
  assert.ok(rows.some(r => r.id === 'llm-pi-ai'), '公共条目应被写入')
  assert.ok(rows.some(r => r.id === 'webserver' && r.config.host === '10.0.0.5'), '本机条目应零损伤')
  assert.deepEqual(warnings, [], '不应产生警告')
})

test('C2：静默跳过必须被转换成可见失败', () => {
  const target = parsePatchList("- id: webserver\n  config:\n    host: '10.0.0.5'\n")
  // 故意用 id-patch 打一个不存在的行，复现官方的静默跳过
  const { warnings } = mergeSharedInto(target, [], { forceIdPatchForTest: 'no-such-id' })
  assert.ok(warnings.length > 0, 'warn 回调必须被收集为非空')
  assert.match(warnings.join(' '), /not found/)
})

test('C3：同名条目已存在时整行替换 config（非深合并）', () => {
  const target = parsePatchList([
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      old: {}',
    '    extra: keep-me',
    '',
  ].join('\n'))
  const shared = parsePatchList([
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      demo:',
    '        apiKeyEnv: DEMO_KEY',
    '',
  ].join('\n'))
  const { rows } = mergeSharedInto(target, shared)
  const row = rows.find(r => r.id === 'llm-pi-ai')
  assert.equal(row.config.extra, undefined, 'config 为全量替换，旧键不应残留')
  assert.deepEqual(Object.keys(row.config.providers), ['demo'])
})

test('往返保真：原文解析 → 渲染 → 再解析，语义等价', () => {
  const rows = parsePatchList(SAMPLE)
  const again = parsePatchList(renderPatches(rows))
  assert.deepEqual(again, rows)
})
