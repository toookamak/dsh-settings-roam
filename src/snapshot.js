/**
 * 快照模型：推送到云端的那一份内容的清单。
 * 数据模型见设计 §5.2。entries 逐文件记摘要，用于快速比对而不必读全部内容。
 */

import { createHash } from 'node:crypto'

/** 快照格式版本。云端是跨机器共享的，读不懂的版本必须明确拒绝而不是猜。 */
export const SCHEMA_VERSION = 1

/**
 * 文本文件按 LF 计算摘要，避免 Git 在 Windows 检出时的 CRLF 转换造成误报。
 * Buffer 表示二进制文件，必须按原始字节计算，不能做换行归一化。
 */
export function hashSnapshotContent(content) {
  const normalized = typeof content === 'string' ? content.replace(/\r\n?/g, '\n') : content
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/**
 * 组装快照清单。
 * @param {{generatedBy: string, generatedAt: string, files: {path: string, kind: string, content: string|Buffer}[]}} input
 * @returns {object}
 */
export function buildSnapshot(input) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    generatedBy: input.generatedBy,
    entries: input.files.map(f => ({
      path: f.path,
      kind: f.kind,
      hash: hashSnapshotContent(f.content),
      ...(f.executable === true ? { executable: true } : {}),
    })),
  }
}

export function serializeSnapshot(snapshot) {
  return JSON.stringify(snapshot, null, 2) + '\n'
}

/**
 * 解析云端取回的快照清单。
 * 版本不符时明确拒绝——不能拿不懂的格式去写用户的配置。
 * @param {string} text
 * @returns {object}
 */
export function parseSnapshot(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`快照清单不是合法 JSON：${String(error.message)}`)
  }
  if (parsed?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`快照清单 schema 版本不受支持：期望 ${SCHEMA_VERSION}，实际 ${parsed?.schemaVersion}`)
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error('快照清单缺少 entries 数组')
  }
  return parsed
}
