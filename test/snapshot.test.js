import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCHEMA_VERSION, buildSnapshot, serializeSnapshot, parseSnapshot } from '../src/snapshot.js'

test('快照模型含 schema 版本、生成时间、来源机器与逐项摘要', () => {
  const snap = buildSnapshot({
    generatedBy: 'test-machine',
    generatedAt: '2026-10-15T00:00:00.000Z',
    files: [
      { path: 'config/profile.patch.yml', kind: 'shared', content: 'x' },
      { path: 'notes.md', kind: 'shared', content: 'y' },
    ],
  })
  assert.equal(snap.schemaVersion, SCHEMA_VERSION)
  assert.equal(snap.generatedBy, 'test-machine')
  assert.equal(snap.generatedAt, '2026-10-15T00:00:00.000Z')
  assert.equal(snap.entries.length, 2)
  assert.equal(snap.entries[0].path, 'config/profile.patch.yml')
  assert.equal(typeof snap.entries[0].hash, 'string')
  assert.ok(snap.entries[0].hash.length > 0, '每项应有内容摘要')
})

test('相同内容摘要相同，内容变化摘要变化', () => {
  const a = buildSnapshot({ generatedBy: 'm', generatedAt: 'T', files: [{ path: 'p', kind: 'shared', content: 'abc' }] })
  const b = buildSnapshot({ generatedBy: 'm', generatedAt: 'T', files: [{ path: 'p', kind: 'shared', content: 'abc' }] })
  const c = buildSnapshot({ generatedBy: 'm', generatedAt: 'T', files: [{ path: 'p', kind: 'shared', content: 'abd' }] })
  assert.equal(a.entries[0].hash, b.entries[0].hash)
  assert.notEqual(a.entries[0].hash, c.entries[0].hash)
})

test('序列化与解析往返保真', () => {
  const snap = buildSnapshot({
    generatedBy: 'm', generatedAt: 'T',
    files: [{ path: 'p', kind: 'shared', content: 'abc' }],
  })
  const text = serializeSnapshot(snap)
  const back = parseSnapshot(text)
  assert.deepEqual(back, snap)
})

test('解析非法快照时抛出可读错误', () => {
  assert.throws(() => parseSnapshot('{"schemaVersion":999,"entries":[]}'), /schema 版本/)
  assert.throws(() => parseSnapshot('not json'), /不是合法 JSON/)
})
