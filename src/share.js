const FIELDS = Object.freeze({
  cache: ['cache-size', 'cache-block', 'cache-ways', 'cache-policy', 'cache-addresses'],
  paging: ['paging-bits', 'paging-size', 'paging-addresses'],
  reno: ['reno-window', 'reno-threshold', 'reno-rounds', 'reno-duplicate', 'reno-timeouts'],
});
export { FIELDS };

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

// 这里只校验传输格式，领域取值仍交给原有表单解析和三个计算模型。
function validateSnapshot(value) {
  if (!exactKeys(value, ['version', 'active', 'fields']) || value.version !== 1) {
    throw new TypeError('分享链接格式无效或版本不受支持。');
  }
  if (!Object.hasOwn(FIELDS, value.active) || !exactKeys(value.fields, Object.values(FIELDS).flat())) {
    throw new TypeError('分享链接缺少实验或完整参数。');
  }
  if (Object.values(value.fields).some((field) => typeof field !== 'string')) {
    throw new TypeError('分享参数必须使用文本格式。');
  }
  return value;
}

export function serializeSnapshot(active, fields) {
  return JSON.stringify(validateSnapshot({ version: 1, active, fields }));
}

export function deserializeSnapshot(value) {
  return validateSnapshot(JSON.parse(value));
}
