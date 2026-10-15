import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSkills, copySkills, listSkillNames } from '../src/skills.js'

function makeSkillDir() {
  const root = mkdtempSync(join(tmpdir(), 'roam-skills-'))
  const a = join(root, 'agent-browser')
  mkdirSync(join(a, 'templates'), { recursive: true })
  writeFileSync(join(a, 'SKILL.md'), '# agent-browser\n')
  writeFileSync(join(a, 'templates', 'run.sh'), '#!/bin/sh\necho hi\n')
  chmodSync(join(a, 'templates', 'run.sh'), 0o755)
  const b = join(root, 'writing-plans')
  mkdirSync(b, { recursive: true })
  writeFileSync(join(b, 'SKILL.md'), '# writing-plans\n')
  return root
}

test('扫描技能目录，列出技能名', () => {
  const root = makeSkillDir()
  const names = listSkillNames(root)
  assert.deepEqual(names.sort(), ['agent-browser', 'writing-plans'])
  rmSync(root, { recursive: true })
})

test('扫描记录每个文件的模式，尤其是可执行位', () => {
  const root = makeSkillDir()
  const scanned = scanSkills(root)
  const sh = scanned.find(f => f.relPath === 'agent-browser/templates/run.sh')
  assert.ok(sh, '应扫描到模板脚本')
  assert.equal(sh.executable, true, '可执行位必须被记录')
  const md = scanned.find(f => f.relPath === 'agent-browser/SKILL.md')
  assert.equal(md.executable, false)
  rmSync(root, { recursive: true })
})

test('复制技能保留可执行位', () => {
  const root = makeSkillDir()
  const dest = mkdtempSync(join(tmpdir(), 'roam-dest-'))
  copySkills(root, ['agent-browser'], dest)
  const copied = join(dest, 'agent-browser', 'templates', 'run.sh')
  const mode = statSync(copied).mode & 0o777
  assert.equal(mode & 0o100, 0o100, '复制后仍应可执行')
  rmSync(root, { recursive: true })
  rmSync(dest, { recursive: true })
})

test('技能含二进制资源时不破坏内容', () => {
  const root = mkdtempSync(join(tmpdir(), 'roam-bin-'))
  const s = join(root, 'screenshot')
  mkdirSync(join(s, 'assets'), { recursive: true })
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe])
  writeFileSync(join(s, 'assets', 'shot.png'), bytes)
  const dest = mkdtempSync(join(tmpdir(), 'roam-dest2-'))
  copySkills(root, ['screenshot'], dest)
  const after = statSync(join(dest, 'screenshot', 'assets', 'shot.png'))
  assert.equal(after.size, bytes.length, '二进制长度不变')
  rmSync(root, { recursive: true })
  rmSync(dest, { recursive: true })
})
