/**
 * 差异计算：本机现状 与 云端快照 逐项比对，生成 DiffItem 列表。
 * 数据模型见设计 §5.2。推送与拉取共用这一份逻辑，只是参数方向不同。
 */

/**
 * 计算差异。
 * @param {{entries: object[]}} local - 本机现状清单
 * @param {{entries: object[]}} remote - 云端快照清单
 * @returns {{path: string, action: string, ownership: string, summary: string}[]}
 */
export function diffSnapshots(local, remote) {
  const localMap = new Map((local?.entries ?? []).map(e => [e.path, e]))
  const remoteMap = new Map((remote?.entries ?? []).map(e => [e.path, e]))
  const items = []

  for (const [path, remoteEntry] of remoteMap) {
    const localEntry = localMap.get(path)
    if (localEntry === undefined) {
      items.push({
        path,
        action: 'add',
        ownership: remoteEntry.kind ?? 'shared',
        summary: `${path}：本机没有，将从云端新增`,
      })
      continue
    }
    if (localEntry.hash !== remoteEntry.hash) {
      items.push({
        path,
        action: 'modify',
        ownership: remoteEntry.kind ?? 'shared',
        summary: `${path}：本机与云端内容不同`,
      })
    }
  }

  for (const [path, localEntry] of localMap) {
    if (remoteMap.has(path)) continue
    items.push({
      path,
      action: 'delete',
      ownership: localEntry.kind ?? 'shared',
      summary: `${path}：云端没有，本机存在（本次不会删除，仅供确认）`,
    })
  }

  return items.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * 汇总差异条数。
 * @param {object[]} items
 * @returns {{add: number, modify: number, delete: number, total: number}}
 */
export function summarizeDiff(items) {
  const stats = { add: 0, modify: 0, delete: 0, total: items.length }
  for (const item of items) {
    if (item.action === 'add') stats.add += 1
    else if (item.action === 'modify') stats.modify += 1
    else if (item.action === 'delete') stats.delete += 1
  }
  return stats
}
