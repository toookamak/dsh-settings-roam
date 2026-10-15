/**
 * 插件名单的读取与官方/第三方判定。
 *
 * 判定口径（设计 §2.6，三条来源取并集）：
 *   official === true || availability === 'installation'
 *
 * 为什么需要并集：源码 plugin-manager/src/index.ts:299 的 official 计算式
 * `optional || offered !== undefined` 只覆盖官方可选包（OPTIONAL_BUNDLES，11 条）
 * 与官方按需包（OFFICIAL_ON_DEMAND_CATALOG，2 条），漏掉了随 DSH 安装本体发布的
 * 那批插件（shipped）。而 availability 恰好由 shipped 决定，补上这个缺口。
 *
 * 为什么不用包名前缀 @deepseek-ai/ 判定：前缀是 npm scope，不是所有权凭证。
 * 实践中目前与官方判定等价，但会在「官方发布非该前缀首方包」或「用户从别的
 * registry 装同名包」两种情况下失效。前缀只作界面上的可读辅助。
 */

/**
 * 判定单个包是否官方。
 * @param {{official?: boolean, availability?: string}} info - BundleInfo 的子集
 * @returns {boolean}
 */
export function isOfficialBundle(info) {
  return info?.official === true || info?.availability === 'installation'
}

/**
 * 把 listBundles() 的结果分成官方与第三方两列。
 * @param {object[]} rows - BundleInfo 数组
 * @returns {{official: object[], thirdParty: object[]}}
 */
export function classifyBundles(rows) {
  const official = []
  const thirdParty = []
  for (const row of rows) {
    if (isOfficialBundle(row)) official.push(row)
    else thirdParty.push(row)
  }
  return { official, thirdParty }
}

/**
 * 从 BundleInfo 数组抽出只含名字的名单。
 * 设计决策 8：插件只记名字，不记启用状态、不记插件内设置。
 * 「已启用 bundle」名单是动态的（本机就有先后关闭的可选包），
 * 所以每次推送都必须重新读取，不能当固定快照。
 * @param {object[]} rows
 * @returns {{official: string[], thirdParty: string[]}}
 */
export function readBundleNames(rows) {
  const { official, thirdParty } = classifyBundles(rows)
  return {
    official: official.map(b => b.name),
    thirdParty: thirdParty.map(b => b.name),
  }
}

/**
 * 从 ctx.pluginManager 读取插件名单。
 * @param {object} pluginManager - ctx.pluginManager 服务
 * @returns {Promise<{official: string[], thirdParty: string[], raw: object[]}>}
 */
export async function collectBundles(pluginManager) {
  const raw = await pluginManager.listBundles()
  const names = readBundleNames(raw)
  return { ...names, raw }
}
