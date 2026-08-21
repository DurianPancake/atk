// status.js —— atk status 纯只读状态收集（spec F16） by AI.Coding
//
// 只读契约：本模块绝不写文件（status 对只读文件系统同样可运行）。
// 输出结构即 --json 的稳定字段契约（F16/F21 AI 自助闭环第一步）。
// M2/M3 起：仅用户级——不再读取项目声明/项目本地技能，不输出项目根。

import { loadRegistry } from './config.js';
import { listSkills } from './collection.js';
import { augmentRegistryWithPersonal } from './collections.js';
import { mergeLayers } from './resolve.js';

/**
 * 收集完整状态快照（纯只读）。
 * @param {object} opts 收集参数
 * @param {string} [opts.cwd] 当前工作目录（M3 起仅作占位，不参与解析）
 * @param {string} [opts.home] 主目录（测试可注入临时 HOME）
 * @returns {Promise<object>} 状态数据（见返回值注释）
 */
export async function collectStatus({ cwd, home }) {
  // 用户级注册表（含 personal 隐式集合，不写盘）
  const registry = await augmentRegistryWithPersonal(await loadRegistry(home), home);
  const sorted = registry.collections
    .map((c, index) => ({ collection: c, index }))
    .sort((a, b) => a.collection.priority - b.collection.priority || a.index - b.index);

  // enabled 集合层：按 priority 升序（相等按登记顺序）
  const layers = [];
  const skillIndex = {}; // 集合名 → 技能名（供 remaining/registered 计算）
  const existsIndex = {}; // 集合名 → 集合根目录是否存在
  for (const { collection } of sorted) {
    const { skills, exists } = await listSkills(collection, home);
    skillIndex[collection.name] = skills;
    existsIndex[collection.name] = exists;
    if (!collection.enabled) continue; // M3：enabled = 安装（global/scoped 一视同仁）
    if (!exists) continue;
    layers.push({ source: `${collection.name}(${collection.scope})`, priority: collection.priority, skills });
  }

  // 归并（用户级唯一层）
  const { effective, conflicts, notes } = mergeLayers({
    globalLayers: layers,
    defaultsDisabled: registry.defaults?.disabled ?? [],
  });

  // 剩余可启用技能：已注册集合全部技能 − 生效集（供用户决策下一步）
  const effectiveNames = new Set(effective.map((e) => e.name));
  const remaining = [...new Set(Object.values(skillIndex).flat())]
    .filter((n) => !effectiveNames.has(n))
    .sort();

  return {
    collections: sorted.map(({ collection }) => ({
      name: collection.name,
      type: collection.type,
      scope: collection.scope,
      enabled: collection.enabled,
      tag: collection.tag ?? null,
      priority: collection.priority,
    })),
    // 全量视图（统一管理清单）：每个已注册集合 × 技能明细，无论 enabled（供 setup TUI 等外部消费）
    registered: sorted.map(({ collection }) => ({
      name: collection.name,
      type: collection.type,
      scope: collection.scope,
      enabled: collection.enabled,
      tag: collection.tag ?? null,
      priority: collection.priority,
      exists: existsIndex[collection.name] ?? false,
      skills: skillIndex[collection.name] ?? [],
    })),
    effective: effective.map((e) => ({ name: e.name, source: e.source })),
    conflicts: conflicts.map((c) => ({ name: c.name, winner: c.winner, loser: c.loser })),
    remaining,
    notes,
  };
}