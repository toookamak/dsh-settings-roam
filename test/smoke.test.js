import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('package.json 声明了插件身份与 patch 挂载点', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, '@toookamak/dsh-settings-roam')
  assert.deepEqual(pkg.dsh.bundle.patch, ['./cordis.patch.yml'])
  assert.equal(pkg.type, 'module')
})
