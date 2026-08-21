// schema.js —— 零依赖迷你 JSON Schema 校验器 by AI.Coding
//
// 覆盖本项目 3 个 schema（collections/state/manifest；atk-project 已随 M2 删除）实际用到的关键字：
// type（含联合类型数组）、required、properties、additionalProperties、items、enum、const、pattern。
// 其余 JSON Schema 关键字未实现；若未来 schema 使用新关键字需同步扩展本校验器。

/**
 * 校验单个值是否满足 schema 片段。
 * @param {unknown} value 被校验的值
 * @param {object} schema 当前层的 schema 片段
 * @param {string} pointer 错误定位路径（如 "$.collections[0].scope"）
 * @param {string[]} errors 错误收集数组（就地 push）
 */
function validateNode(value, schema, pointer, errors) {
  // additionalProperties 说明：未知键报错，保持配置严格，避免拼写错误静默
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${pointer}: 期望类型 ${JSON.stringify(schema.type)}，实际 ${describeType(value)}`);
    return; // 类型已错，不再深入检查子结构，避免级联噪音
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pointer}: 必须等于 ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${pointer}: 取值必须是 ${JSON.stringify(schema.enum)} 之一，实际 ${JSON.stringify(value)}`);
  }
  // pattern 属于标量约束，必须在对象守卫（提前 return）之前检查
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${pointer}: 不符合 pattern ${schema.pattern}`);
  }
  if (typeof value !== 'object' || value === null) return; // 原类型检查已覆盖

  if (Array.isArray(value)) {
    if (schema.items) {
      // 数组元素逐一校验，索引进入定位路径
      value.forEach((item, index) => validateNode(item, schema.items, `${pointer}[${index}]`, errors));
    }
    return;
  }
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) validateNode(value[key], sub, `${pointer}.${key}`, errors);
    }
  }
  if (schema.additionalProperties === false) {
    // 未知键：提示候选，帮助用户快速修正拼写
    for (const key of Object.keys(value)) {
      if (!schema.properties || !(key in schema.properties)) {
        errors.push(`${pointer}: 未知字段 "${key}"（additionalProperties=false）`);
      }
    }
  }
  if (schema.required) {
    for (const key of schema.required) {
      if (!(key in value)) errors.push(`${pointer}: 缺少必需字段 "${key}"`);
    }
  }
}

/**
 * 判断值是否匹配 schema 的 type 声明（支持 "string" 或 ["string","null"]）。
 * @param {unknown} value 被判断的值
 * @param {string|string[]} type schema type 声明
 * @returns {boolean} 是否匹配
 */
function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    if (t === 'string') return typeof value === 'string';
    if (t === 'integer') return Number.isInteger(value);
    if (t === 'boolean') return typeof value === 'boolean';
    if (t === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
    if (t === 'array') return Array.isArray(value);
    if (t === 'null') return value === null;
    return false;
  });
}

/**
 * 描述值的实际类型（用于错误消息）。
 * @param {*} value 原始值
 * @returns {string} 人类可读类型描述
 */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 按 schema 校验整个对象。
 * @param {*} value 待校验的数据
 * @param {object} schema 目标 schema
 * @returns {string[]} 错误列表（空数组=通过）
 */
export function validateSchema(value, schema, root = '$.') {
  const errors = [];
  validateNode(value, schema, root, errors);
  return errors;
}