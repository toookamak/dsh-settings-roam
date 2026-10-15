/**
 * 可移植配置的编辑（第四阶段）。
 *
 * 为什么做成「扁平字段」而不是让人改整段 YAML：
 *
 *   1. 用户改的绝大多数是某个值——换一个 baseURL、换一个模型名、把 apiKeyEnv
 *      指向另一个变量。为了改一个值去动整段 YAML，多出来的全是语法出错的机会。
 *   2. 手写 YAML 出错时我们只能整段拒绝，用户得自己找出错在哪一行；
 *      按字段改的话，出错的那个字段当场就能说清。
 *   3. 写回走的是同一条路径（备份 → 合并 → 写后回读），与同步完全一致。
 *
 * 代价是「新增一个供应商」需要用户自己填字段路径。这是有意为之的取舍：
 * 那条路径本来就要求用户想清楚自己要往配置里加什么，替他猜反而危险。
 */

/**
 * 把一个配置对象摊成扁平字段。
 *
 * 数组按整体看待，不下钻——配置里的数组（如 models 列表）当值整体编辑更自然，
 * 也能避免「按下标改」这种一改就错位的操作。
 *
 * @param {unknown} value
 * @param {string} [prefix]
 * @returns {{path: string, value: unknown, type: string}[]}
 */
export function flattenConfig(value, prefix = '') {
  const fields = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix !== '') fields.push({ path: prefix, value, type: typeOf(value) })
    return fields
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      fields.push(...flattenConfig(child, path))
    } else {
      fields.push({ path, value: child, type: typeOf(child) })
    }
  }
  return fields
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * 把界面上/命令行里的一串文本转回配置里的值。
 *
 * 规则是「按原来的类型解析」：原来是数字就必须是数字，原来是布尔就必须是
 * 布尔或 on/off。**刻意不做宽容解析**——把 'true' 写成一个字符串是配置里
 * 最难查的一类错：看着对，行为不对。
 *
 * @param {string} raw
 * @param {string} type - 该字段原本的类型
 * @returns {{ok: boolean, value?: unknown, error?: string}}
 */
export function parseFieldValue(raw, type) {
  if (type === 'boolean') {
    if (raw === 'true' || raw === '是' || raw === 'on') return { ok: true, value: true }
    if (raw === 'false' || raw === '否' || raw === 'off') return { ok: true, value: false }
    return { ok: false, error: `这一项要填 true 或 false，收到的是「${raw}」。` }
  }
  if (type === 'number') {
    const n = Number(raw)
    if (raw.trim() === '' || Number.isNaN(n)) {
      return { ok: false, error: `这一项要填数字，收到的是「${raw}」。` }
    }
    return { ok: true, value: n }
  }
  if (type === 'array' || type === 'object') {
    try {
      return { ok: true, value: JSON.parse(raw) }
    } catch (error) {
      return { ok: false, error: `这一项要填 JSON：${error.message}` }
    }
  }
  if (type === 'null') {
    if (raw === 'null' || raw === '') return { ok: true, value: null }
    return { ok: true, value: raw, error: undefined, typeChanged: 'string' }
  }
  // string 与未知类型都按字符串写，这是最不容易误伤的一种。
  return { ok: true, value: raw }
}

const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/

/**
 * 校验一个字段路径。
 *
 * 为什么单独校验：路径会变成配置里的键。带空格或者控制字符的键写进 YAML 之后
 * 多半解析不回来，而那时错误信息只会指向一个看不懂的位置。
 *
 * @param {string} path
 * @returns {{ok: boolean, error?: string}}
 */
export function validatePath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    return { ok: false, error: '字段路径不能是空的。' }
  }
  for (const segment of path.split('.')) {
    if (!PATH_SEGMENT.test(segment)) {
      return { ok: false, error: `字段路径「${path}」里含有不能用作配置键的字符。请只用字母、数字、下划线、点和短横线。` }
    }
  }
  return { ok: true }
}

/**
 * 不可变地按路径写值。中间层不存在时创建它。
 *
 * 创建中间层是有意的：用户填了 `providers.new.apiKeyEnv` 就是打算加一个供应商，
 * 替他拒绝没有意义。
 *
 * @param {object} target
 * @param {string} path
 * @param {unknown} value
 * @returns {object}
 */
export function setAtPath(target, path, value) {
  const segments = path.split('.')
  const copy = Array.isArray(target) ? [...target] : { ...(target ?? {}) }
  let cursor = copy
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i]
    const child = cursor[key]
    const next = child !== null && typeof child === 'object' ? child : {}
    cursor[key] = Array.isArray(next) ? [...next] : { ...next }
    cursor = cursor[key]
  }
  cursor[segments[segments.length - 1]] = value
  return copy
}

/**
 * 不可变地删掉一个路径上的值。中间层不存在时原样返回。
 *
 * 只删这一个键，不顺手清理空掉的父对象：父对象是不是该留，
 * 取决于配置 schema，我们不该替它决定。
 *
 * @param {object} target
 * @param {string} path
 * @returns {object}
 */
export function unsetAtPath(target, path) {
  const segments = path.split('.')
  const copy = Array.isArray(target) ? [...target] : { ...(target ?? {}) }
  let cursor = copy
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i]
    const child = cursor[key]
    if (child === null || typeof child !== 'object') return copy
    cursor[key] = Array.isArray(child) ? [...child] : { ...child }
    cursor = cursor[key]
  }
  delete cursor[segments[segments.length - 1]]
  return copy
}

/**
 * 把一组编辑应用到某个条目上。
 *
 * @param {{id: string, name?: string, config?: object}} entry - 本机的那一条
 * @param {{path: string, value?: unknown, remove?: boolean}[]} edits
 * @returns {{ok: boolean, entry?: object, errors: {path: string, error: string}[]}}
 */
export function applyEdits(entry, edits = []) {
  const errors = []
  let config = entry?.config ?? {}

  for (const edit of edits) {
    const pathCheck = validatePath(edit?.path)
    if (!pathCheck.ok) {
      errors.push({ path: String(edit?.path ?? ''), error: pathCheck.error })
      continue
    }
    if (edit.remove === true) {
      config = unsetAtPath(config, edit.path)
    } else {
      config = setAtPath(config, edit.path, edit.value)
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  // 空 config 就不带这个键：官方 patch 里 config 为空对象与不带 config 不等价
  // （config 是整条替换的），带上一个空对象会把原有的配置清空。
  const next = { ...entry }
  if (config === null || (typeof config === 'object' && Object.keys(config).length === 0)) {
    next.config = {}
  } else {
    next.config = config
  }
  return { ok: true, entry: next, errors: [] }
}

/**
 * 从一组文本输入构造出编辑列表。命令行与界面共用。
 *
 * @param {{set?: Record<string, string>, unset?: string[], types?: Record<string, string>} } input
 * @returns {{ok: boolean, edits?: object[], errors: {path: string, error: string}[]}}
 */
export function buildEdits(input = {}) {
  const errors = []
  const edits = []
  const types = input.types ?? {}

  for (const [path, raw] of Object.entries(input.set ?? {})) {
    const pathCheck = validatePath(path)
    if (!pathCheck.ok) {
      errors.push({ path, error: pathCheck.error })
      continue
    }
    const parsed = parseFieldValue(String(raw), types[path] ?? 'string')
    if (!parsed.ok) {
      errors.push({ path, error: parsed.error })
      continue
    }
    edits.push({ path, value: parsed.value })
  }

  for (const path of input.unset ?? []) {
    const pathCheck = validatePath(path)
    if (!pathCheck.ok) {
      errors.push({ path, error: pathCheck.error })
      continue
    }
    edits.push({ path, remove: true })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, edits, errors: [] }
}

/**
 * 两个配置的差异，只说到字段这一层。用在「确认前给你看改了什么」。
 *
 * @param {object} before
 * @param {object} after
 * @returns {{path: string, from: unknown, to: unknown, action: 'set'|'remove'}[]}
 */
export function diffConfig(before, after) {
  const beforeFields = new Map(flattenConfig(before ?? {}).map(f => [f.path, f.value]))
  const afterFields = new Map(flattenConfig(after ?? {}).map(f => [f.path, f.value]))
  const items = []

  for (const [path, value] of afterFields) {
    if (!beforeFields.has(path)) {
      items.push({ path, from: undefined, to: value, action: 'set' })
    } else if (JSON.stringify(beforeFields.get(path)) !== JSON.stringify(value)) {
      items.push({ path, from: beforeFields.get(path), to: value, action: 'set' })
    }
  }
  for (const [path, value] of beforeFields) {
    if (!afterFields.has(path)) items.push({ path, from: value, to: undefined, action: 'remove' })
  }
  return items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
