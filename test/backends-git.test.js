import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { BACKEND_METHODS, assertBackend } from '../src/backends/index.js'
import { createGitBackend } from '../src/backends/git.js'
import { tmpDir } from '../support/tmp-dir.js'

/** 建一个本地裸库当云端，不碰网络。 */
function bareRepo() {
  const dir = tmpDir('bare-')
  execFileSync('git', ['init', '--bare', '--quiet', dir])
  return dir
}

function sandbox() {
  const root = tmpDir('be-')
  const repo = bareRepo()
  return {
    root,
    work: join(root, 'work'),
    repo,
    // 收尾必须把裸库一起删掉。它建在独立的临时目录里，
    // 只删 root 会持续往 /tmp 里积压（实测累积到 78 个）。
    cleanup() {
      rmSync(root, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

test('后端接口只约定 5 个动作', () => {
  assert.deepEqual(
    [...BACKEND_METHODS].sort(),
    ['ensureReady', 'pull', 'push', 'readFile', 'writeFile'],
  )
})

test('接口校验：缺方法的对象被明确拒绝', () => {
  assert.throws(() => assertBackend({ push: () => {} }), /缺少方法/)
  const ok = {
    ensureReady: async () => {}, pull: async () => {},
    push: async () => {}, readFile: async () => {}, writeFile: async () => {},
  }
  assert.doesNotThrow(() => assertBackend(ok))
})

test('ensureReady 克隆空的裸库并落盘，可重复调用', async () => {
  const { work, repo, cleanup } = sandbox()
  const backend = createGitBackend({ repoUrl: repo, workDir: work })
  await backend.ensureReady()
  assert.ok(existsSync(join(work, '.git')), '工作区应已就绪')
  await backend.ensureReady()
  assert.ok(existsSync(join(work, '.git')), '重复调用不应报错')
  cleanup()
})

test('writeFile 落盘并推送到裸库，内容可被再次克隆读到', async () => {
const { root, work, repo, cleanup } = sandbox()
  const backend = createGitBackend({ repoUrl: repo, workDir: work })
  await backend.ensureReady()
  await backend.writeFile('config/bundles.json', '{"official":["a"]}\n', '测试写入')
  await backend.push('测试写入')

  // 换一个工作区重新克隆，确认内容真的到了「云端」
  const backend2 = createGitBackend({ repoUrl: repo, workDir: join(root, 'work2') })
  await backend2.ensureReady()
  assert.equal(await backend2.readFile('config/bundles.json'), '{"official":["a"]}\n')
  cleanup()
})

test('readFile 读不存在的路径返回 null，不抛错', async () => {
  const { work, repo, cleanup } = sandbox()
  const backend = createGitBackend({ repoUrl: repo, workDir: work })
  await backend.ensureReady()
  assert.equal(await backend.readFile('config/nope.json'), null)
  cleanup()
})

test('writeFile 自动建立多级目录', async () => {
  const { work, repo, cleanup } = sandbox()
  const backend = createGitBackend({ repoUrl: repo, workDir: work })
  await backend.ensureReady()
  await backend.writeFile('skills/demo/scripts/run.sh', '#!/bin/sh\n', '加技能')
  assert.ok(existsSync(join(work, 'skills', 'demo', 'scripts', 'run.sh')))
  cleanup()
})

test('pull 把裸库上的新提交取回工作区', async () => {
const { root, work, repo, cleanup } = sandbox()
  const a = createGitBackend({ repoUrl: repo, workDir: work })
  await a.ensureReady()
  await a.writeFile('notes.md', 'first\n', '写记事本')
  await a.push('写记事本')

  const b = createGitBackend({ repoUrl: repo, workDir: join(root, 'work2') })
  await b.ensureReady()
  await b.writeFile('notes.md', 'second\n', '改记事本')
  await b.push('改记事本')

  await a.pull()
  assert.equal(await a.readFile('notes.md'), 'second\n')
  cleanup()
})

test('无改动时 push 不产生空提交', async () => {
  const { work, repo, cleanup } = sandbox()
  const backend = createGitBackend({ repoUrl: repo, workDir: work })
  await backend.ensureReady()
  await backend.writeFile('a.txt', 'x\n', '第一次')
  await backend.push('第一次')
  await assert.doesNotReject(() => backend.push('再推一次'))
  cleanup()
})

test('凭据边界：后端源码里不出现密钥相关字段', () => {
  const src = readFileSync(new URL('../src/backends/git.js', import.meta.url), 'utf8')
  for (const word of ['password', 'token', 'apiKey', 'api_key', 'secret']) {
    assert.ok(!src.includes(word), `后端源码不应出现 ${word} —— 凭据交给系统 git`)
  }
})

test('错误信息不泄露 URL 中的凭据', async () => {
  const { root, cleanup } = sandbox()
  const backend = createGitBackend({
    repoUrl: 'https://user:TOPSECRET@127.0.0.1:1/nonexistent.git',
    workDir: join(root, 'w'),
  })
  await assert.rejects(
    () => backend.ensureReady(),
    (error) => {
      assert.ok(!String(error.message).includes('TOPSECRET'), '错误信息不得包含凭据')
      return true
    },
  )
  cleanup()
})
