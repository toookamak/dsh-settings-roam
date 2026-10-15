import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isOfficialBundle, classifyBundles, readBundleNames } from '../src/bundles.js'

test('判定口径：official 为真即官方', () => {
  assert.equal(isOfficialBundle({ name: 'x', official: true, availability: 'profile' }), true)
})

test('判定口径：availability 为 installation 即官方（补 official 的缺口）', () => {
  assert.equal(isOfficialBundle({ name: 'x', official: false, availability: 'installation' }), true)
})

test('判定口径：第三方包既非 official 也非 installation', () => {
  assert.equal(isOfficialBundle({ name: 'dsh-soul', official: false, availability: 'profile' }), false)
})

test('判定口径：不用包名前缀判定', () => {
  // 即便名字带官方前缀，只要两个字段都不满足，就不是官方
  assert.equal(isOfficialBundle({ name: '@deepseek-ai/whatever', official: false, availability: 'profile' }), false)
})

test('分类：把 listBundles 结果分成官方与第三方两列', () => {
  const rows = [
    { name: '@deepseek-ai/dsh-base', official: false, availability: 'installation', enabled: true },
    { name: '@deepseek-ai/dsh-experimental-ralph-bundle', official: true, availability: 'profile', enabled: false },
    { name: 'dsh-soul', official: false, availability: 'profile', enabled: true },
    { name: 'github:toookamak/dsh-git-sentry', official: false, availability: 'profile', enabled: true },
  ]
  const { official, thirdParty } = classifyBundles(rows)
  assert.deepEqual(official.map(b => b.name).sort(), [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-experimental-ralph-bundle',
  ])
  assert.deepEqual(thirdParty.map(b => b.name).sort(), [
    'dsh-soul',
    'github:toookamak/dsh-git-sentry',
  ])
})

test('插件名单只记名字，不记启用状态', () => {
  const rows = [
    { name: 'a', official: true, availability: 'profile', enabled: true },
    { name: 'b', official: true, availability: 'profile', enabled: false },
  ]
  const names = readBundleNames(rows)
  assert.deepEqual(names.official.sort(), ['a', 'b'])
  assert.equal(JSON.stringify(names).includes('enabled'), false, '名字名单不应携带 enabled')
})
