// apply.js —— 阶段二：执行（可部分失败，安全可恢复，spec F17/F15/F26） by AI.Coding
//
// 语义：
// - 规划校验失败（plan.errors 非空）→ 零写入直接返回非 0（F17）
// - 执行逐项进行：每个操作成功后更新内存 state，全部结束后按 state 文件原子落盘；
//   期间失败项明确记录，返回非 0；再次 apply 可收敛到期望状态（F15 幂等收敛）
// - unlink 前按 F26 安全判定（词法为主、realpath 加强、断链可清）；不满足 → 保留 + 警告
// - 用户手放内容（目标存在但非我方链接）→ 跳过 + 警告，绝不删除（F10）

import { lstat, mkdir, symlink, unlink, readlink, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { loadState, saveState, findEntry, removeEntries, isSafeToRemove } from './state.js';

/**
 * 幂等写入状态条目：先按 targetPath 去旧再追加（改指向时不留旧记录）。
 * @param {object} state 状态对象（就地修改）
 * @param {object} entry 新条目
 */
function upsertEntry(state, entry) {
  removeEntries(state, (e) => path.resolve(e.targetPath) === path.resolve(entry.targetPath));
  state.links.push(entry);
}

/**
 * 按 targetPath 移除状态条目。
 * @param {object} state 状态对象（就地修改）
 * @param {string} targetPath 目标路径
 */
function removeEntryByTarget(state, targetPath) {
  removeEntries(state, (e) => path.resolve(e.targetPath) === path.resolve(targetPath));
}

/**
 * 判断目标位置现状（是否存在、是否软链、词法目标），供幂等与人手内容判定。
 * @param {string} targetPath 目标路径
 * @returns {Promise<{absent: boolean, symbolic: boolean, resolved: string|null}>} 现状
 */
async function probeTarget(targetPath) {
  try {
    const st = await lstat(targetPath);
    if (st.isSymbolicLink()) {
      const raw = await readlink(targetPath);
      return { absent: false, symbolic: true, resolved: path.resolve(path.dirname(targetPath), raw) };
    }
    return { absent: false, symbolic: false, resolved: null };
  } catch {
    return { absent: true, symbolic: false, resolved: null };
  }
}

/**
 * 幂等创建软链：已就位跳过；目标被用户内容占用时不覆盖。
 * @param {object} link 链接规划条目
 * @param {object} state 对应层级 state（就地更新）
 * @param {object} results 结果收集
 */
async function ensureLink(link, state, results) {
  const probe = await probeTarget(link.targetPath);
  if (!probe.absent) {
    if (probe.symbolic && probe.resolved === path.resolve(link.sourcePath)) {
      // 已是我方链接且指向正确源：刷新 state 条目（幂等，profile 变更时更新指纹）
      upsertEntry(state, link);
      results.skipped.push({ ...link, reason: '已就位' });
      return;
    }
    if (probe.symbolic) {
      // 软链指向别处：若 state 记录过且词法目标与旧 source 一致（atk 自建链接、源已变更，
      // 如 global 禁用后被其他集合接管 F03）→ 按 F26 判定安全后重链，而非保留旧源
      const record = findEntry(state, link.targetPath);
      if (record && path.resolve(record.sourcePath) === probe.resolved) {
        const { safe } = await isSafeToRemove(record, link.targetPath);
        if (safe) {
          await unlink(link.targetPath);
          removeEntryByTarget(state, link.targetPath);
          await mkdir(path.dirname(link.targetPath), { recursive: true });
          await symlink(link.sourcePath, link.targetPath);
          upsertEntry(state, link);
          results.applied.push({ ...link, action: 'relink' });
          return;
        }
      }
      // 未知软链：保留 + 警告（不覆盖未知链接；F26 一致性优先）
      results.skipped.push({ ...link, reason: `目标被其他软链占用：${probe.resolved}，保留不覆盖` });
      return;
    }
    // 真实目录/文件 = 用户手放内容：不删除不覆盖（F10），也不写入 state 所有权
    results.skipped.push({ ...link, reason: '目标已存在（用户内容），跳过不覆盖' });
    return;
  }
  try {
    await mkdir(path.dirname(link.targetPath), { recursive: true });
    await symlink(link.sourcePath, link.targetPath);
    upsertEntry(state, link);
    results.applied.push(link);
  } catch (err) {
    results.failed.push({ op: link, reason: err.message });
  }
}

/**
 * 执行一次 unlink：state 有记录且 F26 判定安全才删除；断链也允许清理。
 * @param {object} unlink 清理条目（含 stateFile）
 * @param {object} state 层级 state（就地更新）
 * @param {object} results 执行收集
 */
async function unlinkOne(entry, state, results) {
  const record = findEntry(state, entry.targetPath);
  if (!record) {
    results.skipped.push({ ...entry, reason: 'state 无记录（非 atk 托管链接），不动' });
    return;
  }
  const { safe, reason } = await isSafeToRemove(record, entry.targetPath);
  if (!safe) {
    results.skipped.push({ ...entry, reason });
    return;
  }
  try {
    await unlink(entry.targetPath);
    removeEntryByTarget(state, entry.targetPath);
    results.applied.push({ ...entry, action: 'unlink' });
  } catch (err) {
    results.failed.push({ op: entry, reason: err.message });
  }
}

/**
 * W7（design §7）：清理旧项目级 state 记录的链接（record 本身即 ownership 凭证，F26 判定后删除）。
 * 项目级旧链接不在用户级 state 中，删除后无需写用户级 state（状态文件随后整体移除）。
 * @param {object} entry 旧项目级 state 条目（含 targetPath/sourcePath）
 * @param {object} results 执行收集
 */
async function unlinkLegacy(entry, results) {
  const { safe, reason } = await isSafeToRemove(entry, entry.targetPath);
  if (!safe) {
    results.skipped.push({ ...entry, reason });
    return;
  }
  try {
    await unlink(entry.targetPath);
    results.applied.push({ ...entry, action: 'unlink' });
  } catch (err) {
    results.failed.push({ op: { ...entry, legacyProject: true }, reason: err.message });
  }
}

/**
 * 执行一次 apply。
 * @param {object} plan planInstall 的计划
 * @param {object} [opts] 选项
 * @param {boolean} [opts.dryRun] 只出计划不执行（plan 校验失败时同样零写入）
 * @returns {Promise<object>} 执行结果（applied/skipped/failed/exitCode）
 */
export async function runApply(plan, { dryRun = false } = {}) {
  const results = { applied: [], skipped: [], failed: [], warnings: plan.warnings, notes: plan.notes, exitCode: 0 };

  // F17：规划校验失败 → 零写入，返回非 0（连 state 都不动）
  if (plan.errors.length > 0) {
    results.failed.push(...plan.errors.map((e) => ({ op: { action: 'validation' }, reason: e })));
    results.exitCode = 1;
    return results;
  }
  if (dryRun) {
    results.dryRun = true;
    return results;
  }

  const userState = await loadState(plan.userStateFile);

  for (const link of plan.userLinks) await ensureLink(link, userState, results);
  // 清理：用户级 state 中的待清理项 + W7 旧项目级条目（均按 F26 判定）
  const userUnlinks = plan.unlinks.filter((u) => u.stateFile === plan.userStateFile);
  for (const entry of userUnlinks) await unlinkOne(entry, userState, results);
  const legacyOps = plan.unlinks.filter((u) => u.legacyProject);
  for (const entry of legacyOps) await unlinkLegacy(entry, results);

  // 只落盘“真正完成”的操作：state 即便部分失败也保存已完成部分（下次 apply 收敛）
  await saveState(plan.userStateFile, userState);

  // W7：遗留项目级 state 记录项全部处理完（无失败）→ 删除 state 文件与空 .atk 目录（不再建新）
  if (plan.legacyCleanup && results.failed.every((f) => !f.op || !f.op.legacyProject)) {
    try { await rm(plan.legacyCleanup.stateFile, { force: true }); } catch { /* 幂等 */ }
    try { await rmdir(plan.legacyCleanup.atkDir); } catch { /* .atk 非空（含 .atk/skills 或用户内容）则保留 */ }
  }

  if (results.failed.length > 0) results.exitCode = 1;
  return results;
}