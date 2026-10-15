import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ownershipOf, OWNERSHIP, SHARED_PATCH_IDS, MACHINE_PATCH_IDS, isSharedPatchId } from '../src/ownership.js'

test('三态取值存在且互不相同', () => {
  assert.equal(OWNERSHIP.SHARED, 'shared')
  assert.equal(OWNERSHIP.MACHINE, 'machine')
  assert.equal(OWNERSHIP.EXCLUDED, 'excluded')
})

test('patch 顶层条目：llm-pi-ai 属公共线', () => {
  assert.equal(ownershipOf('patch', 'llm-pi-ai'), OWNERSHIP.SHARED)
  assert.equal(isSharedPatchId('llm-pi-ai'), true)
})

test('patch 顶层条目：8 个本机条目全部判为本机', () => {
  const machineIds = ['webserver', 'dsh-auth-gate', 'ui-settings-general',
    'agent-default-model', 'typert-gateway', 'ui-theme', 'permission', 'session-log-deepseek']
  for (const id of machineIds) {
    assert.equal(ownershipOf('patch', id), OWNERSHIP.MACHINE, `${id} 应判为本机`)
    assert.equal(isSharedPatchId(id), false, `${id} 不应进公共线`)
  }
  assert.equal(MACHINE_PATCH_IDS.length, 8)
  assert.deepEqual(SHARED_PATCH_IDS, ['llm-pi-ai'])
})

test('密钥与账号数据判为不同步', () => {
  assert.equal(ownershipOf('file', '.credentials.yaml'), OWNERSHIP.EXCLUDED)
  assert.equal(ownershipOf('file', 'auth/users.yaml'), OWNERSHIP.EXCLUDED)
  assert.equal(ownershipOf('file', 'storages/dsh_auth_sessions.json'), OWNERSHIP.EXCLUDED)
  assert.equal(ownershipOf('file', 'storages/session_projcache/'), OWNERSHIP.EXCLUDED)
  assert.equal(ownershipOf('file', 'node_modules/'), OWNERSHIP.EXCLUDED)
})

test('技能与插件名单属公共线', () => {
  assert.equal(ownershipOf('skills', 'agent-browser'), OWNERSHIP.SHARED)
  assert.equal(ownershipOf('bundles', 'dsh-soul'), OWNERSHIP.SHARED)
})

test('未知项默认为不同步（保守失败）', () => {
  assert.equal(ownershipOf('patch', 'some-unknown-id'), OWNERSHIP.EXCLUDED)
  assert.equal(ownershipOf('unknown-kind', 'x'), OWNERSHIP.EXCLUDED)
})
