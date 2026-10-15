/**
 * 恢复前的兼容性检查（第四阶段）。
 *
 * 为什么要有这一层：拉取与导入都是「把别处的状态搬到本机」。
 * 有些搬不过来的情况，写下去**不会报错**，只是不生效或者悄悄覆盖掉
 * 本机更合适的东西。等到用户发现「配置看着有、行为不对」，已经很难查了。
 *
 * 三条设计原则：
 *
 *   1. **只报告，不猜测。** 每条检查给出「哪一项、什么情况、该怎么办」，
 *      不做「我觉得应该是这样」的推断。
 *
 *   2. **能静默失效的才拦。** 只有「写下去必然不生效或必然覆盖掉别的东西」
 *      才算 block。插件没装、密钥没配这类是 warn——它们不该阻止用户
 *      先把配置落下来，很多时候用户就是打算重启后再装插件。
 *
 *   3. **纯函数。** 不碰文件系统、不碰网络，输入是已经读好的数据。
 *      这样它既能在服务层被调用，也能在测试里逐条构造边界情况。
 */

/** 检查结论的三个级别。block 会阻止写入，warn 只是提醒。 */
export const COMPAT_LEVELS = Object.freeze(['ok', 'warn', 'block'])

/**
 * 一条检查结论。
 *
 * code 是给程序看的（测试与界面分支），message 是给人看的。
 * action 写「下一步做什么」——只说「不兼容」等于没说。
 *
 * @typedef {{kind: string, name: string, level: string, code: string,
 *   message: string, action: string}} CompatItem
 */

function item(kind, name, level, code, message, action) {
  return { kind, name, level, code, message, action }
}

/**
 * 配置条目检查。
 *
 * 核心是那条实测出来的 C1 约束：目标行已存在、`name` 与本机不一致时，
 * 官方 loader 只经日志回调报 `patch: name mismatch`，**不抛错、不生效**。
 * 也就是说写下去之后界面一切正常，而配置根本没换——这正是最该拦的情况。
 *
 * @param {object[]} remoteRows - 将要写回的条目（云端或导入包里的）
 * @param {object[]} localRows - 目标 profile 当前的条目
 * @returns {CompatItem[]}
 */
export function checkPatchEntries(remoteRows = [], localRows = []) {
  const localById = new Map()
  for (const row of localRows) {
    if (row?.id !== undefined && !localById.has(row.id)) localById.set(row.id, row)
  }

  const items = []
  for (const row of remoteRows) {
    const id = row?.id
    if (id === undefined) {
      // 没有 id 的行只能靠 insert 进入组合树，写回时本来就不会碰它。
      items.push(item(
        'config', '(无 id 的条目)', 'warn', 'entry-without-id',
        '这一条没有 id，它只描述别处的加载顺序，不会作为配置写回。',
        '如果你确实需要它生效，请手工把这一行加到 profile 的 cordis.patch.yml 里。',
      ))
      continue
    }

    const local = localById.get(id)
    if (local === undefined) {
      items.push(item(
        'config', id, 'ok', 'entry-new',
        `「${id}」本机还没有，会作为新条目加上。`,
        '不需要做什么。',
      ))
      continue
    }

    // name 两边都有且不同 → loader 会静默跳过，写了等于没写。
    if (row.name !== undefined && local.name !== undefined && row.name !== local.name) {
      items.push(item(
        'config', id, 'block', 'name-mismatch',
        `「${id}」这一项在本机指向的是 ${local.name}，与要写回的 ${row.name} 不是同一个包。`,
        '直接写回不会生效（loader 只记一条日志就跳过）。请先确认要保留哪一个，' +
        '或在本机把这条 id 改掉之后再来。',
      ))
      continue
    }

    items.push(item(
      'config', id, 'ok', 'entry-update',
      `「${id}」本机已有，会用要写回的内容整条替换它的 config。`,
      '不需要做什么。替换前会自动备份。',
    ))
  }
  return items
}

/**
 * 插件名单检查。
 *
 * 名单里的第三方插件在本机没装时，配置写得再对也用不上——
 * 但**这不是阻止写入的理由**：用户常常就是先把配置弄回来，再逐个装插件。
 * 所以是 warn，且必须说清「装插件本程序现在不做」。
 *
 * @param {{official?: string[], thirdParty?: string[]}|null} bundleNames
 * @param {{official?: string[], thirdParty?: string[]}|null} installed
 * @returns {CompatItem[]}
 */
export function checkPlugins(bundleNames, installed) {
  if (bundleNames === null || bundleNames === undefined) return []

  const known = new Set([
    ...(installed?.official ?? []),
    ...(installed?.thirdParty ?? []),
  ])
  // 本机名单取不到时（没有 pluginManager 服务）不做判断，也就不会误报。
  const canJudge = installed !== null && installed !== undefined

  const items = []
  for (const name of bundleNames.thirdParty ?? []) {
    if (!canJudge) break
    if (known.has(name)) {
      items.push(item('plugin', name, 'ok', 'plugin-installed', `插件「${name}」本机已经装了。`, '不需要做什么。'))
    } else {
      items.push(item(
        'plugin', name, 'warn', 'plugin-missing',
        `插件「${name}」本机没有装。配置会照常写回，但它要等插件装上之后才有用。`,
        `先按你原来的方式把这个插件装上（本程序目前不替你安装插件），再重启 DSH。`,
      ))
    }
  }
  return items
}

/**
 * 环境变量检查。
 *
 * 密钥本身不进云端（设计决策：只存变量名）。所以换台机器之后
 * 「配置看着都对、一发消息就认证失败」是必然会发生的一幕——
 * 提前把它说出来，比让用户自己去猜要省事得多。
 *
 * @param {string[]} refs - 配置里引用到的环境变量名
 * @param {Record<string, string|undefined>} env
 * @returns {CompatItem[]}
 */
export function checkEnvRefs(refs = [], env = {}) {
  const items = []
  for (const name of refs) {
    const value = env?.[name]
    if (typeof value === 'string' && value.trim() !== '') {
      items.push(item('env', name, 'ok', 'env-set', `环境变量 ${name} 本机已经设了。`, '不需要做什么。'))
    } else {
      items.push(item(
        'env', name, 'warn', 'env-missing',
        `配置引用了环境变量 ${name}，本机没有设。密钥本身不进云端，必须在每台机器上各自配。`,
        `在启动 DSH 的环境里设好 ${name} 再重启。缺了它，配好的模型一发消息就会认证失败。`,
      ))
    }
  }
  return items
}

/**
 * 技能文件检查。
 *
 * 覆盖同名技能是本阶段最容易造成「无痕替换」的动作：本机可能有
 * 一个自己改过的同名技能，写回就把它换掉了。备份能救回来，
 * 但用户应当事先知道会覆盖哪些。
 *
 * @param {{path: string}[]} skillFiles - 将要写入的技能文件
 * @param {(path: string) => boolean} exists - 目标路径是否已存在（由调用方查盘）
 * @returns {CompatItem[]}
 */
export function checkSkills(skillFiles = [], exists = () => false) {
  const items = []
  for (const file of skillFiles) {
    if (exists(file.path)) {
      items.push(item(
        'skill', file.path, 'warn', 'skill-overwrite',
        `「${file.path}」本机已有同名文件，会被云端的内容替换。`,
        '替换前会自动备份；报告里会给出备份路径。要保留本机的版本的话，先自己复制一份。',
      ))
    } else {
      items.push(item('skill', file.path, 'ok', 'skill-new', `「${file.path}」本机没有，会新增。`, '不需要做什么。'))
    }
  }
  return items
}

/**
 * 汇总。界面与命令行都靠这个决定「能不能点下去」。
 *
 * @param {CompatItem[]} items
 * @returns {{blocked: boolean, counts: {ok: number, warn: number, block: number}, items: CompatItem[]}}
 */
export function summarizeCompat(items = []) {
  const counts = { ok: 0, warn: 0, block: 0 }
  for (const entry of items) {
    if (counts[entry.level] !== undefined) counts[entry.level] += 1
  }
  return { blocked: counts.block > 0, counts, items }
}
