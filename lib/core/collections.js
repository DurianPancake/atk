// collections.js —— 集合注册/启停/移除/导出 与 personal 隐式集合（spec F01/F02/F03/F05/F12） by AI.Coding
//
// 模型注记：
// - personal 目录（~/.atk/personal/）采用「隐式虚拟集合」：存在即生效（scoped），不写注册表
//   （保证 status 纯只读、plan 阶段零写入，F05/F16/F17 三者不冲突）；
//   用户显式 enable/disable personal 时以注册表条目为准（显式条目覆盖隐式行为）。
// - 集合名唯一；priority 缺省 = 当前最大 + 1；数组顺序 = tie-break 稳定序列。

import { mkdir, copyFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadRegistry, saveRegistry } from './config.js';
import { loadState, saveState, removeEntries, isSafeToRemove } from './state.js';

const execFileP = promisify(execFile);

/** personal 目录相对 home 的路径（~/.atk/personal/） */
export function personalDir(home = os.homedir()) {
  return path.join(home, '.atk', 'personal');
}

/**
 * 检测 personal 目录是否存在。
 * @param {string} home 主目录
 * @returns {Promise<{dir: string, exists: boolean}>} 目录与存在性
 */
export async function detectPersonal(home = os.homedir()) {
  const dir = personalDir(home);
  try {
    await stat(dir);
    return { dir, exists: true };
  } catch {
    return { dir, exists: false };
  }
}

/**
 * 把 personal 隐式集合并入注册表副本（不写盘；供 plan/status 复用）。
 * 显式 personal 条目（注册表内 name=personal 且 tag=personal）优先于隐式。
 * @param {object} registry 注册表
 * @param {string} home 主目录
 * @returns {Promise<object>} 带 personal 条目的注册表副本
 */
export async function augmentRegistryWithPersonal(registry, home = os.homedir()) {
  const { exists } = await detectPersonal(home);
  const explicit = registry.collections.find((c) => c.name === 'personal' && c.tag === 'personal');
  if (explicit) return registry; // 显式条目已在注册表中
  if (!exists) return registry; // 目录不存在 → 不注册不创建
  const maxPriority = registry.collections.reduce((m, c) => Math.max(m, c.priority), 0);
  return {
    ...registry,
    collections: [
      ...registry.collections,
      { name: 'personal', type: 'local', path: personalDir(home), scope: 'scoped', tag: 'personal', enabled: false, priority: maxPriority + 1 }, // M3：隐式 scoped 默认停用（需 enable 才装）
    ],
  };
}

/**
 * 校验集合名合法性（与 schema pattern 一致：kebab-case）。
 * @param {string} name 候选名
 * @returns {boolean} 是否合法
 */
export function isValidCollectionName(name) {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

/**
 * 从 git url / 本地路径推导默认集合名（basename 转 kebab-case）。
 * @param {string} source git url 或路径
 * @returns {string} 推导名
 */
export function defaultNameFromSource(source) {
  const base = source.split(/[/\\]/).pop() || 'collection';
  return base.replace(/\.git$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'collection';
}

/**
 * 判断来源是否为 git 型集合（url 形态）。
 * @param {string} source 来源
 * @returns {boolean} 是否 git 型
 */
export function isGitSource(source) {
  return /^(https?|ssh|git):\/\//.test(source) || /^git@/.test(source) || /\.git(\/|$)/.test(source);
}

/**
 * 克隆 git 集合到托管目录 <home>/.atk/collections/<name>。
 * @param {string} url git 地址
 * @param {string} name 集合名
 * @param {string} home 主目录
 * @returns {Promise<string>} 克隆目录
 */
async function cloneGitCollection(url, name, home) {
  const dir = path.join(home, '.atk', 'collections', name);
  await mkdir(path.dirname(dir), { recursive: true });
  // 与 sync（F19①）一致：非交互（不等待凭据输入）+ 超时保护；ATK_NO_HOOK 防递归
  await execFileP('git', ['clone', '--quiet', url, dir], {
    env: { ...process.env, ATK_NO_HOOK: '1', GIT_TERMINAL_PROMPT: '0' },
    timeout: 60_000,
  });
  return dir;
}

/**
 * 注册集合（F01）。
 * @param {object} opts 参数
 * @param {string} opts.home 主目录
 * @param {string} opts.source git url 或本地路径
 * @param {string} [opts.name] 集合名（缺省由来源推导）
 * @param {string} [opts.scope] global|scoped（缺省 scoped）
 * @param {string} [opts.tag] team|personal（仅展示）
 * @param {number} [opts.priority] 显式优先级（缺省当前最大+1）
 * @param {string} [opts.branch] git 分支（记录）
 * @returns {Promise<{ok: boolean, name: string, error?: string}>} 结果
 */
export async function registerCollection({ home, source, name, scope = 'scoped', tag, priority, branch }) {
  const registry = await loadRegistry(home);
  const finalName = name ?? defaultNameFromSource(source);
  if (!isValidCollectionName(finalName)) {
    return { ok: false, name: finalName, error: `集合名不合法（需 kebab-case）：${finalName}` };
  }
  if (registry.collections.some((c) => c.name === finalName)) {
    return { ok: false, name: finalName, error: `集合 "${finalName}" 已注册` };
  }
  if (scope !== 'global' && scope !== 'scoped') {
    return { ok: false, name: finalName, error: `scope 必须是 global 或 scoped：${scope}` };
  }
  if (tag !== undefined && tag !== 'team' && tag !== 'personal') {
    return { ok: false, name: finalName, error: `tag 必须是 team 或 personal：${tag}` };
  }
  const git = isGitSource(source);
  const maxPriority = registry.collections.reduce((m, c) => Math.max(m, c.priority), 0);
  const base = {
    name: finalName,
    type: git ? 'git' : 'local',
    scope,
    // M3：scope 决定默认安装策略——global 注册即装；scoped 默认停用（需手动 enable 后才安装到用户级）
    enabled: scope === 'global',
    priority: priority ?? maxPriority + 1,
    registeredAt: new Date().toISOString(),
  };
  let entry;
  if (git) {
    // git 型：先克隆成功再写入注册表（F01：克隆失败不写注册表）
    try {
      await cloneGitCollection(source, finalName, home);
      entry = { ...base, url: source, ...(branch ? { branch } : {}) };
    } catch (err) {
      return { ok: false, name: finalName, error: `git clone 失败：${err.message}` };
    }
  } else {
    const abs = path.resolve(source);
    try {
      await stat(abs); // 本地路径必须存在
    } catch {
      return { ok: false, name: finalName, error: `本地路径不存在：${abs}` };
    }
    entry = { ...base, path: abs };
  }
  registry.collections.push(entry);
  await saveRegistry(home, registry);
  return { ok: true, name: finalName, collection: entry };
}

/**
 * 移除集合（F02）：global → 按用户级 state 清理其链接（F26 判定）；scoped → 仅删注册项不扫盘。
 * @param {object} opts 参数
 * @param {string} opts.home 主目录
 * @param {string} opts.name 集合名
 * @returns {Promise<{ok: boolean, cleaned: number, warnings: string[], error?: string}>} 结果
 */
export async function removeCollection({ home, name }) {
  const registry = await loadRegistry(home);
  const idx = registry.collections.findIndex((c) => c.name === name);
  if (idx < 0) return { ok: false, cleaned: 0, warnings: [], error: `集合 "${name}" 未注册` };
  const entry = registry.collections[idx];
  const warnings = [];
  let cleaned = 0;
  if (entry.scope === 'global') {
    // global 移除：按用户级 state 清理其技能链接（历史项目链接由下次 apply 按状态清理）
    const userStateFile = path.join(home, '.config', 'atk', 'state.json');
    const state = await loadState(userStateFile);
    const target = removeEntries(state, (e) => e.collection === name);
    for (const record of target) {
      const { safe, reason } = await isSafeToRemove(record, record.targetPath);
      if (!safe) {
        warnings.push(`保留 ${record.targetPath}：${reason}`);
        // 放回 state（未删除的链接仍是托管状态）
        state.links.push(record);
        continue;
      }
      try {
        await unlink(record.targetPath);
        cleaned += 1;
      } catch (err) {
        warnings.push(`删除 ${record.targetPath} 失败：${err.message}`);
        state.links.push(record);
      }
    }
    await saveState(userStateFile, state);
  }
  registry.collections.splice(idx, 1);
  await saveRegistry(home, registry);
  return { ok: true, cleaned, warnings };
}

/**
 * 启用/停用集合（F03）：不自动 apply（避免隐式副作用），不删除 clone。
 * personal 特殊：无显式条目时写入显式条目以覆盖隐式状态。
 * @param {object} opts 参数
 * @param {string} opts.home 主目录
 * @param {string} opts.name 集合名
 * @param {boolean} opts.enabled 目标启用状态
 * @returns {Promise<{ok: boolean, error?: string}>} 结果
 */
export async function setCollectionEnabled({ home, name, enabled }) {
  const registry = await loadRegistry(home);
  const entry = registry.collections.find((c) => c.name === name);
  // personal 特殊分支（W6）：仅当条目本身就是隐式机制（tag=personal）或名字未占用（隐式待建）时走；
  // 用户注册的普通集合恰好叫 personal（tag 非 personal）→ 走普通分支，避免重复 push 造成注册表重名。
  if ((entry && entry.tag === 'personal') || (!entry && name === 'personal')) {
    // personal：目录存在时允许按显式条目启停；目录不存在则报错
    const { exists } = await detectPersonal(home);
    if (!exists) return { ok: false, error: 'personal 目录不存在（~/.atk/personal/），无需启停' };
    if (entry) {
      entry.enabled = enabled;
    } else {
      // 隐式 personal → 创建显式条目（enable=true 时回退化显式条目亦可）
      registry.collections.push({
        name: 'personal', type: 'local', path: personalDir(home), scope: 'scoped', tag: 'personal',
        enabled, priority: registry.collections.reduce((m, c) => Math.max(m, c.priority), 0) + 1,
      });
    }
    await saveRegistry(home, registry);
    return { ok: true };
  }
  if (!entry) return { ok: false, error: `集合 "${name}" 未注册` };
  entry.enabled = enabled;
  await saveRegistry(home, registry);
  return { ok: true };
}

/**
 * 集合清单（list 命令数据，含 personal 隐式条目标注）。
 * @param {string} home 主目录
 * @returns {Promise<Array<object>>} 集合行
 */
export async function listCollections(home = os.homedir()) {
  const registry = await loadRegistry(home);
  const augmented = await augmentRegistryWithPersonal(registry, home);
  const explicitNames = new Set(registry.collections.map((c) => c.name));
  return augmented.collections.map((c) => ({
    ...c,
    implicit: !explicitNames.has(c.name), // personal 隐式条目标记（供展示层区分）
    source: c.type === 'git' ? c.url : c.path,
  }));
}

/**
 * 导出技能到目标集合目录（F12）：复制技能目录 + manifest 依赖闭包。
 * @param {object} opts 参数
 * @param {string} opts.home 主目录
 * @param {string} opts.collection 源集合名
 * @param {string} opts.skill 技能名
 * @param {string} opts.dest 目标集合根目录（不存在则创建）
 * @returns {Promise<{ok: boolean, files: string[], error?: string}>} 结果
 */
export async function exportSkill({ home, collection: collectionName, skill, dest }) {
  const registry = await loadRegistry(home);
  const entry = registry.collections.find((c) => c.name === collectionName);
  if (!entry) return { ok: false, files: [], error: `集合 "${collectionName}" 未注册` };
  const { collectionRoot, listSkills, loadManifest } = await import('./collection.js');
  const { skills } = await listSkills(entry, home);
  if (!skills.includes(skill)) return { ok: false, files: [], error: `集合 "${collectionName}" 中无技能 "${skill}"` };
  const srcDir = path.join(collectionRoot(entry, home), 'skills', skill);
  const dstDir = path.join(dest, 'skills', skill);
  const copied = await copyTree(srcDir, dstDir);
  // 依赖闭包（manifest dependencies[skill]）
  const manifest = await loadManifest(entry, home);
  for (const dep of manifest?.dependencies?.[skill] ?? []) {
    const s = path.join(collectionRoot(entry, home), dep);
    const d = path.join(dest, dep);
    copied.push(...(await copyTree(s, d)));
  }
  return { ok: true, files: copied };
}

/**
 * 递归复制目录树（export 复制用；也支持复制单个文件）。
 * @param {string} src 源路径（文件或目录）
 * @param {string} dst 目标路径
 * @returns {Promise<string[]>} 复制文件列表
 */
export async function copyTree(src, dst) {
  let st;
  try {
    st = await stat(src);
  } catch {
    return [];
  }
  if (st.isFile()) {
    await mkdir(path.dirname(dst), { recursive: true });
    await copyFile(src, dst);
    return [dst];
  }
  const copied = [];
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dst, { recursive: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      copied.push(...(await copyTree(s, d)));
    } else {
      await copyFile(s, d);
      copied.push(d);
    }
  }
  return copied;
}