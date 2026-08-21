// plan.js —— 阶段一：完整规划（零写入，spec F17） by AI.Coding
//
// 规划输入：用户级注册表（含 personal 隐式集合，不写盘）。
// 规划输出：目标用户级链接集合 + 待清理链接（对照用户级 state）+ 校验错误/警告/提示。
// M2/M3 起：仅用户级（无项目级产物、无项目声明）；enabled 集合才参与安装，
// scoped 集合需手动 enable（= 安装）后才会被规划；
// manifest 契约（dependencies/sharedResources）保留：缺失必需依赖 → 规划失败（F17 零写入）。

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { loadRegistry } from './config.js';
import { mergeLayers } from './resolve.js';
import { clientNames, clientUserDir } from './client-matrix.js';
import { listSkills, collectionRoot, loadManifest, validateManifest } from './collection.js';
import { augmentRegistryWithPersonal } from './collections.js';
import { loadState } from './state.js';

/**
 * 计算一次 closure 的参与指纹（state 条目记录用）。
 * @param {object} registry 用户级注册表
 * @returns {string} 指纹
 */
function closureHash(registry) {
  const relevant = {
    collections: registry.collections
      .filter((c) => c.enabled)
      .map((c) => ({ name: c.name, scope: c.scope, priority: c.priority, path: c.path ?? c.url })),
    defaults: registry.defaults ?? {},
  };
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

/**
 * 校验一个集合的 manifest：非法 JSON / schema / 必需依赖缺失 → 收集到 errors。
 * @param {object} collection 注册表条目
 * @param {string} home 主目录
 * @param {string[]} errors 错误收集（就地追加）
 */
async function validateCollectionManifest(collection, home, errors) {
  let manifest;
  try {
    manifest = await loadManifest(collection, home);
  } catch {
    errors.push(`集合 "${collection.name}" 的 atk.manifest.json 非法（JSON 解析失败），取消安装`);
    return;
  }
  if (!manifest) return;
  const schemaErrors = validateManifest(manifest);
  if (schemaErrors.length > 0) {
    errors.push(`集合 "${collection.name}" 的 atk.manifest.json schema 校验失败：${schemaErrors[0]}`);
    return;
  }
  // 必需依赖：相对集合根的文件必须存在
  const root = collectionRoot(collection, home);
  for (const [skill, files] of Object.entries(manifest.dependencies ?? {})) {
    for (const rel of files) {
      try {
        await stat(path.join(root, rel));
      } catch {
        errors.push(`集合 "${collection.name}" 依赖缺失：${skill} 需要 ${rel}`);
      }
    }
  }
}

/**
 * 规划一次 apply（零写入）。
 * @param {object} opts 参数
 * @param {string} [opts.cwd] 当前工作目录（M3 起不参与技能解析；W7 用于定位存量项目级 state 做一次性清理）
 * @param {string} [opts.home] 主目录（测试可注入临时 HOME）
 * @returns {Promise<object>} 计划（errors/warnings/notes/userLinks/unlinks/userStateFile/legacyCleanup）
 */
export async function planInstall({ cwd, home }) {
  const registry = await augmentRegistryWithPersonal(await loadRegistry(home), home);
  const userStateFile = path.join(home, '.config', 'atk', 'state.json');
  const userState = await loadState(userStateFile);

  const errors = [];
  const warnings = [];
  const notes = [];
  const expected = new Map(); // targetPath → link（幂等/清理判定）
  const rootBySource = new Map(); // 来源标签 → 集合根目录（按 layer.source 精确对应）
  const nameBySource = new Map(); // 来源标签 → 集合名（state.collection 用裸集合名，removeCollection 按名匹配清理）

  // enabled 集合按 priority 升序（相等按登记顺序）收集层
  const sorted = registry.collections
    .map((c, index) => ({ collection: c, index }))
    .sort((a, b) => a.collection.priority - b.collection.priority || a.index - b.index);

  const layers = [];
  for (const { collection } of sorted) {
    if (!collection.enabled) continue; // M3：enabled = 安装（global/scoped 一视同仁）
    const { skills, exists } = await listSkills(collection, home);
    if (!exists) {
      warnings.push(`集合 "${collection.name}" 目录不存在，已跳过（可先 sync 或重新 add）`);
      continue;
    }
    await validateCollectionManifest(collection, home, errors);
    if (errors.length > 0) break; // 任一集合 manifest 非法 → 整体规划失败（F17 零写入）
    const source = `${collection.name}(${collection.scope})`;
    rootBySource.set(source, collectionRoot(collection, home));
    nameBySource.set(source, collection.name);
    layers.push({ source, priority: collection.priority, skills });
  }

  // 归并 → 最终生效集（同名高 priority 胜出，仅装胜出者）
  const mergeResult = mergeLayers({
    globalLayers: layers,
    defaultsDisabled: registry.defaults?.disabled ?? [],
  });
  notes.push(...mergeResult.notes);
  const conflicts = mergeResult.conflicts;
  for (const c of conflicts) {
    notes.push(`同名冲突：${c.winner} 覆盖 ${c.loser} 的 "${c.name}"（仅装胜出者）`);
  }

  // 目标用户级链接：5 客户端 × 生效技能
  const userLinks = [];
  for (const client of clientNames()) {
    for (const skill of mergeResult.effective) {
      const sourceRoot = rootBySource.get(skill.source);
      if (!sourceRoot) {
        errors.push(`技能 "${skill.name}"（${skill.source}）来源集合缺失`);
        continue;
      }
      const sourcePath = path.join(sourceRoot, 'skills', skill.name);
      const targetPath = path.join(clientUserDir(client, home), skill.name);
      const link = {
        client,
        kind: 'skill',
        targetPath,
        sourcePath,
        collection: nameBySource.get(skill.source) ?? skill.source,
        ownerSkill: skill.name,
        profileHash: closureHash(registry),
      };
      userLinks.push(link);
      expected.set(targetPath, link);
    }
  }

  // 待清理：state 中不再期望存在的链接（含断链，unlink 时按 F26 判定）
  const unlinks = [];
  for (const record of userState.links) {
    if (!expected.has(record.targetPath)) {
      unlinks.push({ ...record, stateFile: userStateFile });
    }
  }

  // W7（design §7）：存量项目级产物一次性清理——apply 时若 cwd 存在旧版项目级 state
  // （atk 旧版项目级安装产生，record 中 targetPath/sourcePath 齐全），按 F26 安全清理其中链接，
  // 随后删除 state 文件与空 .atk 目录；以后不再生成/不再建新。
  let legacyCleanup = null;
  const legacyStateFile = path.join(cwd, '.atk', 'state.json');
  if (existsSync(legacyStateFile)) {
    try {
      const legacy = JSON.parse(readFileSync(legacyStateFile, 'utf8'));
      for (const entry of Array.isArray(legacy.links) ? legacy.links : []) {
        if (entry && entry.targetPath && entry.sourcePath) {
          unlinks.push({ ...entry, legacyProject: true });
        }
      }
      legacyCleanup = { stateFile: legacyStateFile, atkDir: path.join(cwd, '.atk') };
    } catch {
      warnings.push(`项目级旧 state（${legacyStateFile}）解析失败，跳过自动清理（可人工删除）`);
    }
  }

  return {
    errors,
    warnings,
    notes,
    userLinks,
    unlinks,
    userStateFile,
    legacyCleanup, // W7：仅当 cwd 存在旧项目级 state 时非空
  };
}