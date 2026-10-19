/**
 * 后端抽象：云端介质的最小接口。
 *
 * 设计 §5.1 说云端是一份 git 仓库或 WebDAV 目录。这里有两点刻意的克制：
 *
 *   1. 只约定 5 个动作。接口越窄，第二期加介质时改动面越小。
 *   2. 不认识「分支」「远端」「暂存区」这些 git 概念。服务层不该知道介质是什么。
 *
 * 凭据边界（设计 §6.2）：接口里没有任何与认证相关的参数。
 * 认证属于只能由人配置的系统级设置，交给系统 git 的 credential helper。
 */

/** 后端必须实现的方法。顺序即典型调用顺序。 */
export const BACKEND_METHODS = Object.freeze([
  'ensureReady',
  'pull',
  'push',
  'readFile',
  'writeFile',
])

/**
 * 校验一个对象是否满足后端接口。
 * 缺少方法时立即失败——与其在同步中途报「undefined is not a function」，
 * 不如在装配时就挡住。
 * @param {object} backend
 */
export function assertBackend(backend) {
  const missing = BACKEND_METHODS.filter(m => typeof backend?.[m] !== 'function')
  if (missing.length > 0) {
    throw new Error(`后端缺少方法：${missing.join(', ')}`)
  }
}
