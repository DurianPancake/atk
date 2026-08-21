// defaults.js —— defaults.disabled 维护（spec F09） by AI.Coding
//
// defaults.disabled 语义：全局按技能名停用（M3 起仅用户级一层，global/scoped 同层归并后
// 统一生效，无层级重得——见 resolve.js）。个人库启停走集合级 collection enable/disable。
// 本模块只维护注册表 defaults.disabled 数组；解析由 resolve.mergeLayers 消费。
// 注：collection remove 不修改 defaults（F09 显式约定）。

import { loadRegistry, saveRegistry } from './config.js';

/** 技能名合法性（与 skill 目录命名一致：kebab-case） */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 启用/停用某个技能在基础层的默认状态（维护 defaults.disabled）。
 * @param {object} opts 参数
 * @param {string} opts.home 主目录
 * @param {string} opts.skill 技能名
 * @param {boolean} opts.enabled true=从 disabled 移除（可生效）；false=加入 disabled（基础层停用）
 * @returns {Promise<{ok: boolean, disabled: string[], error?: string}>} 结果与新的 disabled 列表
 */
export async function setSkillDefault({ home, skill, enabled }) {
  if (!SKILL_NAME.test(skill)) {
    return { ok: false, disabled: [], error: `技能名不合法（需 kebab-case）：${skill}` };
  }
  const registry = await loadRegistry(home);
  const disabled = new Set(registry.defaults?.disabled ?? []);
  if (enabled) disabled.delete(skill);
  else disabled.add(skill);
  registry.defaults = { ...(registry.defaults ?? {}), disabled: [...disabled] };
  await saveRegistry(home, registry);
  return { ok: true, disabled: [...disabled] };
}