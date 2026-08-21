// resolve.js —— 用户级归并（spec F08/F09：仅用户级收敛） by AI.Coding
//
// 收敛顺序（M2/M3 起仅用户级一层）：
//   ① 所有 enabled 集合按 priority 升序（相等按注册表登记顺序）归并 → 用户基础层
//   ② registry.defaults.disabled 在单层归并后生效（用户级模型无层级重得）
// 同名 = 解析优先来源（后归并者优先）：仅安装“胜出者”，不承诺客户端只加载胜出者；
// 用户级同名冲突仍在 status 中报告。
//
// 现状对齐：项目声明（.atk.json 项目级）与项目本地技能目录 M2 起已移除。

/**
 * 把一层技能的每个名字并入生效集；同名冲突记录最后一次覆盖关系。
 * @param {Map<string,object>} effective 生效集（就地修改）
 * @param {string[]} skills 该层技能名
 * @param {string} source 来源标签（如 "official(global)"）
 * @param {Array<object>} conflicts 冲突收集（就地追加）
 */
function mergeLayer(effective, skills, source, conflicts) {
  for (const name of skills) {
    const prev = effective.get(name);
    if (prev && prev.source !== source) {
      conflicts.push({ name, winner: source, loser: prev.source });
    }
    effective.set(name, { name, source });
  }
}

/**
 * 归并用户级同名技能，返回最终生效集与冲突。
 * @param {object} [opts] 参数
 * @param {Array<{source: string, priority: number, skills: string[]}>} [opts.globalLayers] 已按 priority 升序的 enabled 集合层
 * @param {string[]} [opts.defaultsDisabled] registry.defaults.disabled
 * @returns {{effective: Array<{name: string, source: string}>, conflicts: Array<{name: string, winner: string, loser: string}>, notes: string[]}}
 */
export function mergeLayers({
  globalLayers = [],
  defaultsDisabled = [],
} = {}) {
  const conflicts = [];
  const notes = [];
  const effective = new Map();

  // ① enabled 集合逐层归并（调用方已按 priority 升序 + 登记顺序排序）
  for (const layer of globalLayers) {
    mergeLayer(effective, layer.skills, layer.source, conflicts);
  }

  // ② 全部层归并后的 defaults.disabled（按名整体停用，无层级重得）
  for (const name of defaultsDisabled) {
    if (effective.delete(name)) notes.push(`defaults.disabled 停用基础层技能 "${name}"`);
  }

  // 冲突去重（同名多次覆盖只保留最后一次覆盖关系）
  const seen = new Set();
  const deduped = conflicts.filter((c) => {
    const key = `${c.name}|${c.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { effective: [...effective.values()], conflicts: deduped, notes };
}
