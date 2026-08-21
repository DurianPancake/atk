// validate.js —— atk validate collection（spec F20） by AI.Coding
//
// 检测项（按级别输出，退出码表示是否干净）：
//   [error]   结构错误：skills/<name>/SKILL.md 缺失、技能名非法、重复 skill name
//   [error]   断开的相对引用：技能目录内文件引用相对路径不存在
//   [error]   manifest 必需依赖缺失（dependencies[skill] 相对集合根）
//   [error]   manifest schema 未知/校验失败
//   [warning] 可选共享资源缺失（sharedResources）
//   [note]    无 manifest（技能按自包含处理）
// 退出码：0 = 无 error；1 = 存在 error（warning/note 不影响退出码）。

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 校验单个集合目录。
 * @param {string} root 集合根目录
 * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], notes: string[]}>} 结果
 */
export async function validateCollection(root) {
  const errors = [];
  const warnings = [];
  const notes = [];
  let skillsDir;
  try {
    await stat(path.join(root, 'skills'));
    skillsDir = path.join(root, 'skills');
  } catch {
    return { ok: false, errors: [`缺少 skills/ 目录：${root}`], warnings, notes };
  }

  // ① 结构 + 重复名
  const seen = new Set();
  const entries = await readdir(skillsDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue; // 非目录文件不属于技能
    const name = e.name;
    if (!SKILL_NAME.test(name)) {
      errors.push(`技能目录名非法（需 kebab-case）：${name}`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`重复 skill name：${name}`);
      continue;
    }
    seen.add(name);
    const skillDir = path.join(skillsDir, name);
    try {
      await stat(path.join(skillDir, 'SKILL.md'));
    } catch {
      errors.push(`结构错误：${name}/SKILL.md 缺失`);
    }
    // ② 断开的相对引用（Markdown 相对链接/图片）
    const refs = await collectRelativeRefs(skillDir);
    for (const { file, target } of refs) {
      const abs = path.resolve(path.dirname(file), target);
      try {
        await stat(abs);
      } catch {
        errors.push(`断开的相对引用：${path.relative(root, file)} -> ${target}`);
      }
    }
  }

  // ③④ manifest：schema 校验 + 必需依赖/可选共享资源
  // 查找位置与 loadManifest 一致：集合根优先，回退 <根>/skills/atk.manifest.json（官方集合形态）
  const manifestCandidates = [path.join(root, 'atk.manifest.json'), path.join(root, 'skills', 'atk.manifest.json')];
  let manifest = null;
  let manifestFound = false;
  for (const manifestFile of manifestCandidates) {
    try {
      await stat(manifestFile);
      manifestFound = true;
      try {
        manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      } catch (err) {
        errors.push(`manifest JSON 解析失败：${err.message}`);
        manifest = null;
      }
      break;
    } catch { /* 该位置无 manifest，尝试下一个 */ }
  }
  if (!manifestFound) {
    notes.push('无 manifest（技能按自包含处理）');
    manifest = null;
  }
  if (manifest) {
    const { validateManifest } = await import('./collection.js');
    const schemaErrors = validateManifest(manifest);
    if (schemaErrors.length > 0) {
      errors.push(`manifest schema 校验失败：\n${schemaErrors.join('\n')}`);
    }
    for (const [skill, deps] of Object.entries(manifest.dependencies ?? {})) {
      for (const dep of deps) {
        const abs = path.resolve(root, dep);
        try {
          await stat(abs);
        } catch {
          errors.push(`必需依赖缺失：${skill} -> ${dep}（相对集合根）`);
        }
      }
    }
    for (const res of manifest.sharedResources ?? []) {
      const abs = path.resolve(root, res.path);
      try {
        await stat(abs);
      } catch {
        warnings.push(`可选共享资源缺失：${res.name}（${res.path}）`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, notes };
}

/**
 * 收集技能目录内 Markdown 相对引用（链接/图片）。
 * @param {string} dir 技能目录
 * @param {string} name 技能名（用于相对定位输出）
 * @returns {Promise<Array<{file: string, target: string}>>} 相对引用列表
 */
async function collectRelativeRefs(dir) {
  const out = [];
  const walk = async (d) => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (/\.(md|markdown)$/i.test(e.name)) {
        const text = await readFile(full, 'utf8');
        // 匹配 [text](target) 与 ![alt](target)；过滤 http/https/mailto/锚点
        for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
          const target = m[1].trim();
          if (/^(https?:|mailto:|#|\/)/.test(target)) continue;
          out.push({ file: full, target });
        }
      }
    }
  };
  await walk(dir);
  return out;
}