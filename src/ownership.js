/**
 * 归属表：把每个配置项标为 公共 / 本机 / 不同步。
 * 这是本插件的中心数据结构——公共线不是「复制文件」，而是「按本表从文件里抽取公共项」。
 * 依据：设计文档 §4.2 归属表内容、§4.6 抽取粒度实测。
 */

export const OWNERSHIP = Object.freeze({
  SHARED: 'shared',
  MACHINE: 'machine',
  EXCLUDED: 'excluded',
})

/** cordis.patch.yml 中进公共线的顶层条目 id。实测 9 项中仅此 1 项。 */
export const SHARED_PATCH_IDS = Object.freeze(['llm-pi-ai'])

/** cordis.patch.yml 中判为本机的顶层条目 id（各机器各自配置，见设计决策 20/21）。 */
export const MACHINE_PATCH_IDS = Object.freeze([
  'webserver',
  'dsh-auth-gate',
  'ui-settings-general',
  'agent-default-model',
  'typert-gateway',
  'ui-theme',
  'permission',
  'session-log-deepseek',
])

/** 永远不进云端的文件：密钥、账号、会话、缓存、依赖。 */
const EXCLUDED_FILES = Object.freeze([
  '.credentials.yaml',
  'auth/users.yaml',
  'storages/dsh_auth_sessions.json',
  'storages/session_projcache/',
  'skills-manager/repository-cache/',
  'skills-manager/repositories.json',
  'node_modules/',
])

/** 判为「本机」但不在 patch 里的文件。 */
const MACHINE_FILES = Object.freeze(['storages/workspace.json'])

export function isSharedPatchId(id) {
  return SHARED_PATCH_IDS.includes(id)
}

export function isMachinePatchId(id) {
  return MACHINE_PATCH_IDS.includes(id)
}

/**
 * 查一个配置项的归属。
 * 未知项一律返回 EXCLUDED —— 保守失败：宁可不同步，也不要把不知道是什么的东西推上云端。
 * @param {'patch'|'file'|'skills'|'bundles'} kind
 * @param {string} name
 * @returns {'shared'|'machine'|'excluded'}
 */
export function ownershipOf(kind, name) {
  switch (kind) {
    case 'patch':
      if (isSharedPatchId(name)) return OWNERSHIP.SHARED
      if (isMachinePatchId(name)) return OWNERSHIP.MACHINE
      return OWNERSHIP.EXCLUDED
    case 'file':
      if (EXCLUDED_FILES.includes(name)) return OWNERSHIP.EXCLUDED
      if (MACHINE_FILES.includes(name)) return OWNERSHIP.MACHINE
      return OWNERSHIP.EXCLUDED
    case 'skills':
      return OWNERSHIP.SHARED
    case 'bundles':
      return OWNERSHIP.SHARED
    default:
      return OWNERSHIP.EXCLUDED
  }
}
