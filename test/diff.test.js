import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffSnapshots, summarizeDiff } from '../src/diff.js'

const snapshotOf = (pairs) => ({
  schemaVersion: 1, generatedAt: 'T', generatedBy: 'm',
  entries: pairs.map(([path, hash]) => ({ path, kind: 'shared', hash })),
})

test('识别新增项', () => {
  const local = snapshotOf([['a', 'h1']])
  const remote = snapshotOf([['a', 'h1'], ['b', 'h2']])
  const items = diffSnapshots(local, remote)
  const b = items.find(i => i.path === 'b')
  assert.equal(b.action, 'add')
})

test('识别修改项', () => {
  const local = snapshotOf([['a', 'h1']])
  const remote = snapshotOf([['a', 'h2']])
  const items = diffSnapshots(local, remote)
  assert.equal(items.length, 1)
  assert.equal(items[0].action, 'modify')
})

test('识别删除项', () => {
  const local = snapshotOf([['a', 'h1'], ['b', 'h2']])
  const remote = snapshotOf([['a', 'h1']])
  const items = diffSnapshots(local, remote)
  const b = items.find(i => i.path === 'b')
  assert.equal(b.action, 'delete')
})

test('相同项不进差异列表', () => {
  const local = snapshotOf([['a', 'h1']])
  const remote = snapshotOf([['a', 'h1']])
  assert.deepEqual(diffSnapshots(local, remote), [])
})

test('每项带归属与人类可读的一句话说明', () => {
  const local = snapshotOf([['a', 'h1']])
  const remote = snapshotOf([['a', 'h2'], ['b', 'h3']])
  const items = diffSnapshots(local, remote)
  for (const item of items) {
    assert.ok(item.ownership, '应有归属字段')
    assert.ok(typeof item.summary === 'string' && item.summary.length > 0, '应有一句话说明')
  }
})

test('汇总差异条数，供界面与报告使用', () => {
  const local = snapshotOf([['a', 'h1'], ['b', 'h2']])
  const remote = snapshotOf([['a', 'h2'], ['c', 'h3']])
  const stats = summarizeDiff(diffSnapshots(local, remote))
  assert.equal(stats.add, 1)
  assert.equal(stats.modify, 1)
  assert.equal(stats.delete, 1)
  assert.equal(stats.total, 3)
})
