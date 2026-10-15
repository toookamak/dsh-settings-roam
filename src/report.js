/**
 * 恢复报告：把机器状态翻译成人能看懂的话。
 *
 * 设计 §3.4 第 2 条：「失败即跳过并显示，不能只报一句失败」。
 * 所以这里的核心不是格式化，而是为每一类跳过原因给出一条具体、可据以行动的说明。
 *
 * 设计决策 8 另有一条产品要求：恢复后的「体验断裂」要显式提示。
 * 主题、权限、默认模型已判为本机，拉取完成后界面与默认行为和来源机器不同，
 * 用户很可能误以为恢复失败。这句话必须出现在报告里，而不是留给用户自己猜。
 */

/**
 * 跳过原因，取值见设计 §5.2 的 SkipReason，并补上本地导入特有的四类。
 *
 * 后四类与前四类性质不同：前四类发生在「要把这个插件装回去，但装不上」，
 * 后四类发生在「包里有这个东西，但我们有意不写回本机」。两者都要能说清，
 * 因为用户看到跳过时无法自己分辨是哪一种。
 */
export const SKIP_REASONS = Object.freeze([
  'local-path-source',
  'version-incompatible',
  'registry-unreachable',
  'build-blocked',
  'unreadable',
  'machine-entry',
  'excluded-entry',
  'unknown-path',
  'unknown',
])

/**
 * 为一类跳过原因给出说明。
 *
 * 导入计划里的条目自带 explanation（生成它的人最清楚为什么被拒），
 * 那种情况下原样采用——不要在这里猜一个更笼统的说法盖掉它。
 *
 * @param {{reason: string, name: string, detail?: string, explanation?: string}} item
 * @returns {string}
 */
export function explainSkip(item) {
  const { reason, name } = item
  if (typeof item.explanation === 'string' && item.explanation !== '') return item.explanation
  const detail = item.detail ?? ''
  switch (reason) {
    case 'local-path-source':
      return `${name} 来自本机的目录路径${detail === '' ? '' : `（${detail}）`}，这台机器上没有这个目录。`
        + '把它发布到 registry 或 git 之后才能同步过来。'
    case 'version-incompatible':
      return `${name} 要求的 DSH 版本与这台机器不一致，官方安装流程拒绝了安装。`
        + '这是保护而不是故障——版本不符时装上去会让 DSH 起不来。'
        + '把两台机器的 DSH 升到同一版本后重试。'
    case 'registry-unreachable':
      return `${name} 没能从 registry 取到包，可能是网络或 registry 地址不通。`
        + '确认这台机器能访问 npm registry，然后再拉取一次。'
    case 'build-blocked':
      return `${name} 的安装脚本需要批准后才能运行。`
        + '在 DSH 里批准这个插件的构建脚本，然后重新拉取。'
    case 'machine-entry':
      return `${name} 属于本机配置（监听地址、主题、默认模型这类），有意不随导入改变。`
        + '这台机器上它保留当前的值——这正是「同步配置」与「复制环境」的区别。'
    case 'excluded-entry':
      return `${name} 不在公共线范围内，有意不写回。`
        + '带密钥的凭据文件与缓存目录都属于这一类。'
    case 'unknown-path':
      return `${name} 不在导入接受的范围内，已忽略。`
        + '导入只接受公共配置、插件名单与技能文件三类内容。'
    case 'unreadable':
      return `${name} 读不出内容${detail === '' ? '' : `（${detail}）`}，已跳过。`
        + '这一项没有写进本机，其余各项不受影响。'
    default:
      return `${name} 未能恢复，原因不明。`
        + '它的配置没有被修改；可以单独重试这一个插件。'
  }
}

/**
 * 把 RestoreReport 转成界面与提示可用的视图模型。
 * @param {object} report - RestoreReport，见设计 §5.2
 * @returns {{applied: object[], skipped: object[], plugins: object[], notices: string[], empty: boolean}}
 */
export function buildReportView(report) {
  const applied = report?.applied ?? []
  const skipped = report?.skipped ?? []
  const needsCredentials = report?.needsCredentials ?? []

  const plugins = skipped
    .filter(item => item.kind === 'plugin')
    .map(item => ({
      name: item.name,
      // 设计 §3.4 第 3 条：跳过时必须能看出这个插件当前装没装。
      installed: false,
      explanation: explainSkip(item),
    }))

  if (applied.length === 0 && skipped.length === 0) {
    return { applied, skipped, plugins, notices: [], empty: true }
  }

  const notices = []
  if (applied.length > 0) {
    notices.push('本机的主题、工具权限预设与默认模型属于本机配置，不会随拉取改变，'
      + '所以界面与默认行为和来源机器可能不同。这不是恢复失败。')
  }
  if (needsCredentials.length > 0) {
    notices.push(`以下环境变量需要在每台机器上各自配置：${needsCredentials.join('、')}。`
      + '密钥本身不进云端，缺了它会一发消息就认证失败。')
  }
  if (report?.needsRestart === true) {
    notices.push('配置已写入，需要重启 DSH 后生效。')
  }

  // 双通道校验的结果：不一致不是故障，但用户有权知道哪些技能没被带走。
  // 这条必须出现在报告里，否则「交叉校验」就只是内部日志，帮不到用户。
  const check = report?.skillCheck
  if (check?.checked === true && check.consistent === false) {
    const parts = []
    if (check.onlyService.length > 0) {
      parts.push(`本机服务视图里有 ${check.onlyService.join('、')}，但目录里没有文件，`
        + '这部分不会被同步')
    }
    if (check.onlyDirect.length > 0) {
      parts.push(`${check.onlyDirect.join('、')} 在目录里但服务视图里没有，`
        + '可能来自非本机的来源')
    }
    notices.push(`技能清单两路核对不一致：${parts.join('；')}。`
      + '这不影响已经同步的内容，但建议先看一眼再继续。')
  }

  return { applied, skipped, plugins, notices, empty: false }
}
