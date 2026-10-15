import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractShared, detectUnexpectable } from '../src/extract.js'
import { parsePatchList } from '../src/yaml-loader.js'

const PATCH = [
  '# LAN bind: 首行注释',
  '- id: webserver',
  '  config:',
  "    host: '192.168.31.7'",
  '    port: 3080',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      demo:',
  '        apiKeyEnv: DEMO_KEY',
  '        baseURL: https://example.invalid/v1',
  '- id: ui-theme',
  '  config:',
  '    preference: dark',
  '',
].join('\n')

test('抽取只保留公共条目，本机条目一概不进', () => {
  const rows = parsePatchList(PATCH)
  const { patch } = extractShared({ patchRows: rows })
  assert.deepEqual(patch.map(r => r.id), ['llm-pi-ai'])
})

test('抽取结果里不含本机专属取值（局域网 IP 绝不出现）', () => {
  const rows = parsePatchList(PATCH)
  const { patch } = extractShared({ patchRows: rows })
  const text = JSON.stringify(patch)
  assert.equal(text.includes('192.168.31.7'), false, '局域网 IP 不得进公共线')
  assert.equal(text.includes('ui-theme'), false, '主题属本机，不得进公共线')
  assert.equal(text.includes('preference'), false)
})

test('抽取保留 apiKeyEnv 引用名，但不含密钥值', () => {
  const rows = parsePatchList(PATCH)
  const { patch } = extractShared({ patchRows: rows })
  const providers = patch[0].config.providers
  assert.equal(providers.demo.apiKeyEnv, 'DEMO_KEY', '引用名要同步')
  assert.equal(JSON.stringify(patch).includes('sk-'), false, '不得出现密钥形态的串')
})

test('抽取报告逐项的归属，便于界面展示', () => {
  const rows = parsePatchList(PATCH)
  const { entries } = extractShared({ patchRows: rows })
  const byPath = Object.fromEntries(entries.map(e => [e.path, e.ownership]))
  assert.equal(byPath['patch:llm-pi-ai'], 'shared')
  assert.equal(byPath['patch:webserver'], 'machine')
  assert.equal(byPath['patch:ui-theme'], 'machine')
})

test('识别 patch 里第三方插件留下的 insert 行', () => {
  const rows = parsePatchList([
    '- id: some-third-party',
    '  insert:',
    '    - id: injected-by-plugin',
    '      name: some-pkg',
    '',
  ].join('\n'))
  const found = detectUnexpectable(rows)
  assert.deepEqual(found.map(f => f.id), ['some-third-party'])
  assert.equal(found[0].reason, 'has-insert-rows')
})

test('insert 行不作为配置项抽取（否则会写坏别的机器的加载顺序）', () => {
  const rows = parsePatchList([
    '- id: llm-pi-ai',
    '  config:',
    '    providers: {}',
    '- id: some-third-party',
    '  insert:',
    '    - id: injected-by-plugin',
    '',
  ].join('\n'))
  const { patch, unexpectable } = extractShared({ patchRows: rows })
  assert.deepEqual(patch.map(r => r.id), ['llm-pi-ai'])
  assert.equal(unexpectable.length, 1, 'insert 行应被识别并排除')
})
