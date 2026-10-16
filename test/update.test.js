import test from 'node:test'
import assert from 'node:assert/strict'
import {
  UPDATE_REASONS,
  installedCommitFromLock,
  parseGitSpec,
  planUpdate,
  readRemoteHead,
  shortCommit,
  specWithCommit,
} from '../src/update.js'

const SHA = 'ca727d9677e74db24eca3631a5d362349d0b2064'
const SHA2 = '525bf385e368830f7ec221d51ebfd32af9bfb3e9'

test('快捷前缀认得出仓库地址 —— 这是本项目装插件用的形态', () => {
  assert.deepEqual(
    parseGitSpec('github:toookamak/dsh-settings-roam'),
    {
      repoUrl: 'https://github.com/toookamak/dsh-settings-roam.git',
      host: 'github.com',
      path: 'toookamak/dsh-settings-roam',
      ref: null,
    },
  )
})

test('带提交号、带 .git、带 git+ 前缀都能认出来', () => {
  const withRef = parseGitSpec('github:toookamak/dsh-settings-roam#abc1234')
  assert.equal(withRef.ref, 'abc1234')
  assert.equal(withRef.repoUrl, 'https://github.com/toookamak/dsh-settings-roam.git')
  assert.equal(
    parseGitSpec('https://github.com/toookamak/dsh-settings-roam.git').repoUrl,
    'https://github.com/toookamak/dsh-settings-roam.git',
    '已经是 .git 结尾就不该拼成 .git.git',
  )
  assert.equal(
    parseGitSpec('git+https://github.com/o/r.git#main').repoUrl,
    'https://github.com/o/r.git',
  )
  assert.equal(parseGitSpec('git@github.com:o/r.git').repoUrl, 'https://github.com/o/r.git')
  assert.equal(parseGitSpec('gitlab:o/r').host, 'gitlab.com')
  assert.equal(parseGitSpec('gist:owner/1a2b3c').host, 'gist.github.com')
})

test('不是 Git 装法的一律返回 null —— 硬套更新会把用户的依赖写坏', () => {
  for (const spec of [
    'link:/home/tokamak/dev/repos/dsh-settings-roam',
    'file:../plugin',
    'workspace:*',
    '^1.2.3',
    'latest',
    '',
    null,
    undefined,
    'C:\\Users\\me\\plugin',
  ]) {
    assert.equal(parseGitSpec(spec), null, `${String(spec)} 不该被当成 Git 仓库`)
  }
})

test('收敛成带提交号的 spec 时，旧的 ref 要被换掉', () => {
  assert.equal(
    specWithCommit('github:toookamak/dsh-settings-roam', SHA),
    `github:toookamak/dsh-settings-roam#${SHA}`,
  )
  assert.equal(
    specWithCommit('github:toookamak/dsh-settings-roam#main', SHA),
    `github:toookamak/dsh-settings-roam#${SHA}`,
    '留着分支名下次又会回到「不知道装的是哪一版」',
  )
  assert.equal(specWithCommit('https://github.com/o/r.git#old', SHA), `https://github.com/o/r.git#${SHA}`)
})

test('从锁文件里读出实际装的是哪个提交 —— spec 没带提交号时这是唯一线索', () => {
  const lock = [
    'lockfileVersion: \'9.0\'',
    'importers:',
    '  .:',
    '    dependencies:',
    "      '@toookamak/dsh-settings-roam':",
    '        specifier: github:toookamak/dsh-settings-roam',
    `        version: https://codeload.github.com/toookamak/dsh-settings-roam/tar.gz/${SHA}(@deepseek-ai/cordis@4.0.5-alpha.1)(react@18.3.1)`,
    '      js-yaml:',
    '        specifier: ^4.3.2',
    '        version: 4.3.2',
    '',
  ].join('\n')

  assert.equal(installedCommitFromLock(lock, '@toookamak/dsh-settings-roam'), SHA)
  assert.equal(installedCommitFromLock(lock, 'js-yaml'), null, '普通版本号没有提交号可言')
  assert.equal(installedCommitFromLock(lock, '@toookamak/other'), null, '没装的包不该编一个出来')
})

test('锁文件里有这个包但形态不认识时，返回 null 而不是猜', () => {
  const lock = [
    'importers:',
    '  .:',
    '    dependencies:',
    "      '@toookamak/dsh-settings-roam':",
    '        specifier: 0.1.0',
    '        version: 0.1.0',
    '',
  ].join('\n')
  assert.equal(installedCommitFromLock(lock, '@toookamak/dsh-settings-roam'), null)
  assert.equal(installedCommitFromLock('这不是 YAML: [', '@toookamak/dsh-settings-roam'), null)
  assert.equal(installedCommitFromLock('', '@toookamak/dsh-settings-roam'), null)
})

test('锁文件兜底路径：packages 段的「包名@git 地址」键里也有提交号', () => {
  const lock = [
    'lockfileVersion: \'9.0\'',
    'packages:',
    `  '@toookamak/dsh-settings-roam@https://codeload.github.com/toookamak/dsh-settings-roam/tar.gz/${SHA}':`,
    '    resolution: {integrity: sha512-xxx}',
    '    version: 0.1.0',
    '',
  ].join('\n')
  assert.equal(installedCommitFromLock(lock, '@toookamak/dsh-settings-roam'), SHA)
})

test('本地链接安装没有「最新提交」可言 —— 开发时用的就是这种形态', () => {
  const plan = planUpdate({ spec: 'link:/home/tokamak/dev/repos/dsh-settings-roam', remoteCommit: SHA })
  assert.equal(plan.needsUpdate, false)
  assert.equal(plan.reason, 'not-git')
  assert.equal(plan.repoUrl, null)
})

test('问不到远端时说「问不到」，不谎称已是最新', () => {
  const plan = planUpdate({ spec: 'github:o/r', installedCommit: SHA, remoteCommit: null })
  assert.equal(plan.needsUpdate, false, '问不到的时候不该给一个「可以更新」的按钮')
  assert.equal(plan.reason, 'unreachable')
})

test('装的是哪一版读不出来时，仍然允许更新到最新，但如实说明', () => {
  const plan = planUpdate({ spec: 'github:o/r', installedCommit: null, remoteCommit: SHA })
  assert.equal(plan.needsUpdate, true)
  assert.equal(plan.reason, 'unknown-version')
})

test('提交号一样就是已是最新，不一样才是可更新', () => {
  assert.deepEqual(planUpdate({ spec: 'github:o/r', installedCommit: SHA, remoteCommit: SHA }), {
    spec: 'github:o/r',
    repoUrl: 'https://github.com/o/r.git',
    installedCommit: SHA,
    remoteCommit: SHA,
    needsUpdate: false,
    reason: 'up-to-date',
  })
  const newer = planUpdate({ spec: 'github:o/r', installedCommit: SHA2, remoteCommit: SHA })
  assert.equal(newer.needsUpdate, true)
  assert.equal(newer.reason, 'update-available')
})

test('短 sha 不算数 —— 实测 pnpm 解析不了短 sha，必须拿完整的 40 位', () => {
  const plan = planUpdate({ spec: 'github:o/r', installedCommit: '525bf38', remoteCommit: SHA })
  assert.equal(plan.installedCommit, null)
  assert.equal(plan.reason, 'unknown-version')
})

test('每种判断结果都在约定的枚举里 —— 界面按它分支说话', () => {
  const reasons = new Set([
    planUpdate({ spec: 'github:o/r', installedCommit: SHA, remoteCommit: SHA }).reason,
    planUpdate({ spec: 'github:o/r', installedCommit: SHA2, remoteCommit: SHA }).reason,
    planUpdate({ spec: 'github:o/r', installedCommit: null, remoteCommit: SHA }).reason,
    planUpdate({ spec: 'link:/x', remoteCommit: SHA }).reason,
    planUpdate({ spec: 'github:o/r', remoteCommit: null }).reason,
  ])
  for (const reason of reasons) {
    assert.ok(UPDATE_REASONS.includes(reason), `${reason} 必须在枚举里`)
  }
  // unchecked 刻意**不**由 planUpdate 产生：它是纯函数，只能看到「远端提交是空的」，
  // 分不清「这一趟没问」与「问了没问到」。那一层区分由 service.describeUpdate 做
  // （状态接口刻意不联网，所以它必须能把这两件事分开说）。
  assert.equal(reasons.has('unchecked'), false, 'planUpdate 不该自己编出「没问过」')
  assert.ok(UPDATE_REASONS.includes('unchecked'), 'unchecked 仍然是合法的表态')
})

test('问远端用 HEAD —— 快捷写法装的就是默认分支的当前提交', async () => {
  const calls = []
  const head = await readRemoteHead('https://github.com/o/r.git', {
    runGit: async (args, options) => {
      calls.push({ args, options })
      return { stdout: `${SHA}\tHEAD\n` }
    },
  })
  assert.equal(head, SHA)
  assert.deepEqual(calls[0].args, ['ls-remote', 'https://github.com/o/r.git', 'HEAD'])
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0', '没有终端可问密码，不能卡在认证提示上')
})

test('远端出错一律吞成 null —— 别把 git 的原始报错甩给用户', async () => {
  const boom = async () => { throw new Error('fatal: could not read Username') }
  assert.equal(await readRemoteHead('https://github.com/o/r.git', { runGit: boom }), null)
  assert.equal(
    await readRemoteHead('https://github.com/o/r.git', { runGit: async () => ({ stdout: 'not a sha' }) }),
    null,
  )
  assert.equal(await readRemoteHead('', { runGit: boom }), null)
})

test('短号只用于显示', () => {
  assert.equal(shortCommit(SHA), 'ca727d9')
  assert.equal(shortCommit(null), '')
  assert.equal(shortCommit('abc'), '')
})
