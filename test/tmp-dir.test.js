/**
 * 临时目录清理的回归测试。
 *
 * 背景：清理若只写在用例结尾，断言失败时那行执行不到，「跑失败的那几次」
 * 就会在 /tmp 留下一地目录——实测累积到 57 个。这条测试锁住的是
 * 「登记制」这个机制本身，而不是某次清理是否执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpDir, dropTmp, outstanding } from '../support/tmp-dir.js'

test('tmpDir 建出真实存在的目录，并登记为待清理', () => {
  const before = outstanding()
  const dir = tmpDir('helper-check-')
  assert.ok(existsSync(dir), '目录应真实存在')
  assert.equal(outstanding(), before + 1, '应计入待清理')
})

test('dropTmp 立刻删掉目录，并让它不再计入待清理', () => {
  const dir = tmpDir('helper-drop-')
  const before = outstanding()
  dropTmp(dir)
  assert.equal(existsSync(dir), false, '目录应已被删除')
  assert.equal(outstanding(), before - 1, '不应再计入待清理')
})

test('登记制不依赖用例走到最后一行', () => {
  // 模拟「用例中途抛错」：建完目录就直接抛，不做任何显式清理。
  // 目录此刻仍在，但已登记，进程退出时会由退出钩子回收。
  // 这里断言的是「已登记」这一事实——它才是失败路径下仍能清理的原因。
  const before = outstanding()
  try {
    const dir = tmpDir('helper-throw-')
    assert.ok(existsSync(dir))
    throw new Error('模拟断言失败')
  } catch {
    // 故意不清理
  }
  assert.equal(outstanding(), before + 1, '抛错路径下目录也必须处于已登记状态')
})
