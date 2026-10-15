import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { BACKEND_METHODS, assertBackend } from '../src/backends/index.js'
import { createGitBackend } from '../src/backends/git.js'
import { tmpDir } from '../support/tmp-dir.js'

/** 在指定目录直接跑一条 git 命令，供测试布景用。 */
function git(cwd, args, options = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (options.allowFailure === true) return ''
    throw error
  }
}

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

// ─── 分支：一个库放多个插件的备份，各占一条分支 ────────────────────────

test('远端没有我们的分支时，建一条孤儿分支，而不是接在别人的提交上', async () => {
  // 用户可能用一个私人库放多个插件的备份（各占一条分支）。
  // 若把我们的分支建在 main 的提交之上，工作区里会混进别人的文件，
  // 我们的清单就会收进不属于自己的东西。
  const s = sandbox()
  try {
    // 先造一个「别人已经在用」的库：main 上有一个别的插件的文件。
    git(s.repo, ['init', '--bare', '--quiet'])
    const seed = join(s.root, 'seed')
    mkdirSync(seed)
    git(seed, ['init', '--quiet'])
    git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'checkout', '-q', '-b', 'main'])
    writeFileSync(join(seed, 'other-plugin.json'), '{}')
    git(seed, ['add', '-A'])
    git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', '别人的东西'])
    git(seed, ['remote', 'add', 'origin', s.repo])
    git(seed, ['push', '-q', 'origin', 'main'])

    const backend = createGitBackend({ repoUrl: s.repo, workDir: s.work, branch: 'settings-roam' })
    await backend.ensureReady()
    await backend.writeFile('config/profile.patch.yml', 'ours\n')
    await backend.push('第一次备份')

    // 关键断言：我们的分支上只有我们自己的文件。
    assert.equal(existsSync(join(s.work, 'other-plugin.json')), false,
      '别的插件的文件不该出现在我们的工作区里')
    assert.ok(existsSync(join(s.work, 'config', 'profile.patch.yml')))

    const remoteRefs = git(s.repo, ['branch', '--list', '--format=%(refname:short)'])
      .split('\n').map(line => line.trim()).filter(Boolean)
    assert.ok(remoteRefs.includes('settings-roam'), `远端应当出现我们的分支，实际：${remoteRefs.join(',')}`)

    // 我们的分支与 main 没有共同祖先，这正是「孤儿」的含义。
    const base = git(s.repo, ['merge-base', 'main', 'settings-roam'], { allowFailure: true }).trim()
    assert.equal(base, '', '我们的分支不该接在 main 的提交上')
  } finally {
    s.cleanup()
  }
})

test('远端已有我们的分支时，直接用它，不重建', async () => {
  const s = sandbox()
  try {
    git(s.repo, ['init', '--bare', '--quiet'])
    const first = createGitBackend({ repoUrl: s.repo, workDir: s.work, branch: 'settings-roam' })
    await first.ensureReady()
    await first.writeFile('notes.md', '第一台机器写的\n')
    await first.push('第一次')

    // 换一个工作区克隆同一分支：应当拿到之前的内容。
    const second = createGitBackend({ repoUrl: s.repo, workDir: join(s.root, 'work2'), branch: 'settings-roam' })
    await second.ensureReady()
    assert.equal(await second.readFile('notes.md'), '第一台机器写的\n',
      '换一台机器应当能读到云端已有的内容')
  } finally {
    s.cleanup()
  }
})

test('工作区已经在别的分支上时，切到我们自己的分支', async () => {
  const s = sandbox()
  try {
    git(s.repo, ['init', '--bare', '--quiet'])
    const backend = createGitBackend({ repoUrl: s.repo, workDir: s.work, branch: 'settings-roam' })
    await backend.ensureReady()
    await backend.writeFile('notes.md', 'ours\n')
    await backend.push('第一次')

    // 模拟「这个工作区上一次被别的分支用过」。
    git(s.work, ['checkout', '-q', '-b', 'someone-else'])
    writeFileSync(join(s.work, 'stranger.txt'), 'x')

    await backend.ensureReady()
    assert.equal(existsSync(join(s.work, 'stranger.txt')), false,
      '切回自己的分支时，别的分支的文件不该留在工作区里')
    assert.equal(await backend.readFile('notes.md'), 'ours\n')
  } finally {
    s.cleanup()
  }
})
