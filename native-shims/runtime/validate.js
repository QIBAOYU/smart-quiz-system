/**
 * stub 参数形状校验的公共工具
 *
 * 只做形状校验，规则本身内联写在各 stub 的显式导出旁边——校验规则和它守护的
 * API 放在一起才好维护。这里只提供拼装能力，不做集中式 schema DSL。
 */

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export const ok = { ok: true };

export function fail(message) {
  return { ok: false, message };
}

/** 校验第 index 个参数的类型；required=false 时允许缺省。 */
export function expectArg(args, index, expectedType, name, required) {
  const value = args[index];
  if (value === undefined || value === null) {
    if (required) return fail(`缺少必填参数 ${name}`);
    return ok;
  }
  const actual = typeOf(value);
  if (actual !== expectedType) {
    return fail(`参数 ${name} 应为 ${expectedType}，实际是 ${actual}`);
  }
  return ok;
}

/** 校验对象参数的某个字段取值必须落在枚举内。 */
export function expectEnum(value, allowed, name) {
  if (value === undefined || value === null) return ok;
  if (allowed.indexOf(value) === -1) {
    return fail(`参数 ${name} 取值应为 ${allowed.join(' | ')} 之一，实际是 ${JSON.stringify(value)}`);
  }
  return ok;
}

/** 顺序执行多条规则，返回第一条失败结果。 */
export function all(results) {
  for (const result of results) {
    if (result && result.ok === false) return result;
  }
  return ok;
}
