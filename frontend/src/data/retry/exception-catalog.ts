/**
 * 异常分类口径（领域：失败重试）
 *
 * 口径约定（需求：可重试与不可重试冲突时，以已知异常清单为准）：
 * 1. 同时出现在两张清单里的异常码，视为「冲突」，统一按不可重试处理并写明原因；
 * 2. 只命中一张清单的，按该清单归类；
 * 3. 两张清单都没登记的未知异常，默认不可重试（保守口径，避免无限重试堆积转存）；
 * 4. 失败记录自带的 retryable 标记与清单冲突时，仍以清单为准（清单优先）。
 *
 * 存量兼容：老的失败记录可能只有文字异常名、没有编码，这里同时支持按名称匹配。
 */

export type ExceptionKind = 'retryable' | 'non-retryable'

export type Classification = {
  kind: ExceptionKind
  /** 判定依据，直接展示给值班人员，保证空态/异常可解释 */
  reason: string
  /** 命中清单时的标准名称，未命中则回退为入参原文 */
  matchedName: string
  /** 清单里没有登记、按保守口径兜底的标记 */
  unknown: boolean
}

export const RETRYABLE_EXCEPTIONS: Record<string, string> = {
  NETWORK_TIMEOUT: '网络连接超时',
  TARGET_UNAVAILABLE: '目标站点暂不可用',
  RATE_LIMITED: '触发限流(HTTP 429)',
  PROXY_FAILURE: '代理节点失效',
  SERVICE_BUSY: '识别服务繁忙',
  CONNECTION_RESET: '连接被重置',
}

export const NON_RETRYABLE_EXCEPTIONS: Record<string, string> = {
  INVALID_PARAM: '请求参数非法',
  AUTH_FAILED: '登录鉴权失败',
  TEMPLATE_PARSE_ERROR: '抽取模板解析失败',
  DATA_VALIDATION_FAILED: '结果校验未通过',
  PERMISSION_DENIED: '权限不足',
  CONTENT_GONE: '目标内容已删除(HTTP 404/410)',
  RECOGNITION_SERVICE_DOWN: '识别服务中断',
}

const RETRYABLE_NAMES = new Set(Object.values(RETRYABLE_EXCEPTIONS))
const NON_RETRYABLE_NAMES = new Set(Object.values(NON_RETRYABLE_EXCEPTIONS))

function matchByCode(code: string): { list: ExceptionKind | 'both' | 'none'; name: string } {
  const inRetryable = Object.prototype.hasOwnProperty.call(RETRYABLE_EXCEPTIONS, code)
  const inNonRetryable = Object.prototype.hasOwnProperty.call(NON_RETRYABLE_EXCEPTIONS, code)
  if (inRetryable && inNonRetryable) {
    return { list: 'both', name: RETRYABLE_EXCEPTIONS[code] }
  }
  if (inRetryable) {
    return { list: 'retryable', name: RETRYABLE_EXCEPTIONS[code] }
  }
  if (inNonRetryable) {
    return { list: 'non-retryable', name: NON_RETRYABLE_EXCEPTIONS[code] }
  }
  return { list: 'none', name: code }
}

function matchByName(name: string): ExceptionKind | 'both' | 'none' {
  const inRetryable = RETRYABLE_NAMES.has(name)
  const inNonRetryable = NON_RETRYABLE_NAMES.has(name)
  if (inRetryable && inNonRetryable) {
    return 'both'
  }
  if (inRetryable) {
    return 'retryable'
  }
  if (inNonRetryable) {
    return 'non-retryable'
  }
  return 'none'
}

/**
 * 判定一个异常是否可重试。
 * @param code 异常码（老数据可能直接传中文名）
 * @param legacyRetryable 老失败记录上自带的可重试标记，仅作参考，清单优先
 */
export function classifyException(
  code: string,
  legacyRetryable?: boolean,
): Classification {
  const normalized = String(code ?? '').trim()
  if (!normalized) {
    return {
      kind: 'non-retryable',
      reason: '异常编码为空，无法匹配已知清单，按不可重试兜底',
      matchedName: '未登记异常',
      unknown: true,
    }
  }

  const byCode = matchByCode(normalized)
  const list: ExceptionKind | 'both' | 'none' =
    byCode.list !== 'none' ? byCode.list : matchByName(normalized)
  const matchedName = byCode.list !== 'none' ? byCode.name : normalized

  switch (list) {
    case 'both':
      return {
        kind: 'non-retryable',
        reason: `异常「${matchedName}」同时登记在可重试与不可重试清单，冲突时以不可重试为准`,
        matchedName,
        unknown: false,
      }
    case 'retryable':
      return {
        kind: 'retryable',
        reason: `异常「${matchedName}」命中可重试异常清单`,
        matchedName,
        unknown: false,
      }
    case 'non-retryable':
      return {
        kind: 'non-retryable',
        reason: `异常「${matchedName}」命中不可重试异常清单`,
        matchedName,
        unknown: false,
      }
    default: {
      const hint =
        typeof legacyRetryable === 'boolean'
          ? `；老记录标记为${legacyRetryable ? '可重试' : '不可重试'}，但清单未登记，标记不参与判定`
          : ''
      return {
        kind: 'non-retryable',
        reason: `异常「${matchedName}」未登记在已知异常清单，按保守口径视为不可重试${hint}`,
        matchedName,
        unknown: true,
      }
    }
  }
}

/** 供页面渲染异常清单口径说明 */
export function exceptionCatalogSnapshot(): {
  retryable: { code: string; name: string }[]
  nonRetryable: { code: string; name: string }[]
} {
  return {
    retryable: Object.entries(RETRYABLE_EXCEPTIONS).map(([code, name]) => ({ code, name })),
    nonRetryable: Object.entries(NON_RETRYABLE_EXCEPTIONS).map(([code, name]) => ({ code, name })),
  }
}
