// collection.js —— 集合根解析与技能枚举（spec F01/F10/F20 支撑） by AI.Coding
//
// 集合内容契约：<collection>/skills/<name>/SKILL.md
// - local 集合根 = 注册的 path（绝对化）
// - git 集合根 = <home>/.atk/collections/<name>（由 sync/add 克隆）

import { readdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateSchema } from './schema.js';

// 启动时一次性加载 manifest schema（与 config.js 同款式）
const MANIFEST_SCHEMA = JSON.parse(readFileSync(new URL('../../schemas/manifest.schema.json', import.meta.url), 'utf8'));

/**
 * 校验 manifest 对象是否符合 manifest schema（F20：未知 schema 按失败处理）。
 * @param {*} manifest 集合 manifest
 * @returns {string[]} 错误列表（空数组=通过）
 */
export function validateManifest(manifest) {
  return validateSchema(manifest, MANIFEST_SCHEMA);
}

/**
 * 计算集合的本地根目录（不校验存在性）。
 * @param {object} collection 注册表条目
 * @param {string} home 主目录（git 克隆位置按 home 定位）
 * @returns {string} 集合根绝对路径
 */
export function collectionRoot(collection, home = os.homedir()) {
  if (collection.type === 'local') {
    return path.resolve(collection.path);
  }
  return path.join(home, '.atk', 'collections', collection.name);
}

/**
 * 枚举集合内技能名（<root>/skills/<name>/SKILL.md）。
 * @param {object} collection 注册表条目
 * @param {string} home 主目录
 * @returns {Promise<{skills: string[], root: string, exists: boolean}>} 技能列表与集合根；目录缺失时 exists=false（调用方按"跳过/以本地旧版继续"处理）
 */
export async function listSkills(collection, home = os.homedir()) {
  const root = collectionRoot(collection, home);
  const skillsDir = path.join(root, 'skills');
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await stat(path.join(skillsDir, entry.name, 'SKILL.md'));
        names.push(entry.name);
      } catch {
        // 无 SKILL.md 的目录不是技能，跳过（结构问题交给 atk validate collection）
      }
    }
    return { skills: names, root, exists: true };
  } catch {
    return { skills: [], root, exists: false };
  }
}

/**
 * 读取集合的可选 manifest（atk.manifest.json）。
 * 查找位置：集合根优先，回退 <根>/skills/atk.manifest.json（官方集合按 design 放置于技能树根处；
 * 依赖/共享资源路径始终相对集合根，如 "skills/merge-review/SCORING.md"）。
 * @param {object} collection 注册表条目
 * @param {string} home 主目录
 * @returns {Promise<object|null>} manifest 对象；缺失返回 null，schema 非法时抛错（F20 按失败处理）
 */
export async function loadManifest(collection, home = os.homedir()) {
  const { readFile } = await import('node:fs/promises');
  const root = collectionRoot(collection, home);
  const candidates = [path.join(root, 'atk.manifest.json'), path.join(root, 'skills', 'atk.manifest.json')];
  let text = null;
  for (const file of candidates) {
    try {
      text = await readFile(file, 'utf8');
      break;
    } catch { /* 该位置无 manifest，尝试下一个 */ }
  }
  if (text === null) return null; // 无 manifest：技能按自包含处理（F20）
  return JSON.parse(text); // schema 校验由 validate.js 与 plan 阶段负责
}