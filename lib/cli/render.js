// render.js —— CLI 人类可读输出（--json 输出原始数据） by AI.Coding

/**
 * 渲染 apply 计划（--dry-run，零写入预览）。
 * @param {object} plan planInstall 的计划
 * @returns {string} 渲染文本
 */
export function renderPlan(plan) {
  const lines = [];
  if (plan.errors.length > 0) {
    lines.push('');
    lines.push('规划校验失败（不会执行任何写入）:');
    for (const e of plan.errors) lines.push(`  ✗ ${e}`);
    return lines.join('\n');
  }
  lines.push('');
  lines.push(`用户级链接（${plan.userLinks.length}）:`);
  for (const l of plan.userLinks) lines.push(`  + ${l.targetPath} -> ${l.sourcePath}（${l.collection}）`);
  // M3：项目级链接已移除（atk 仅用户级安装）
  if (plan.unlinks.length > 0) {
    lines.push('');
    lines.push(`待清理（${plan.unlinks.length}，执行时按 F26 安全判定）:`);
    for (const u of plan.unlinks) lines.push(`  - ${u.targetPath}`);
  }
  for (const w of plan.warnings) lines.push(`  ! ${w}`);
  for (const n of plan.notes) lines.push(`  · ${n}`);
  return lines.join('\n');
}

/**
 * 渲染 apply 执行结果。
 * @param {object} res runApply 的结果
 * @returns {string} 渲染文本
 */
export function renderApplyResult(res) {
  if (res.dryRun) return '<dry-run 未执行>\n';
  const lines = [];
  lines.push(`已应用: ${res.applied.length}`);
  for (const a of res.applied) lines.push(`  ${a.action === 'unlink' ? '-' : '+'} ${a.targetPath}`);
  for (const s of res.skipped) lines.push(`  = ${s.targetPath}（${s.reason}）`);
  for (const f of res.failed) lines.push(`  ✗ ${f.op.targetPath ?? f.op.action}: ${f.reason}`);
  if (res.failed.length > 0) lines.push('提示: 修复原因后再次 apply 可收敛到期望状态');
  return lines.join('\n');
}

/**
 * 显示宽度：中文字符（码点 > 0xFF）按 2 列计算，保证全角/半角混合对齐。
 * @param {string} s 输入串（无 ANSI 转义）
 * @returns {number} 显示宽度
 */
function dispWidth(s) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0xff ? 2 : 1;
  return w;
}

/** 按显示宽度补齐到指定列宽。 */
function padDisp(s, width) {
  return s + ' '.repeat(Math.max(0, width - dispWidth(s)));
}

/**
 * 渲染集合清单（列按显示宽度对齐，中文名/路径不串列）。
 * @param {Array<object>} rows listCollections 的结果
 * @returns {string} 渲染文本
 */
export function renderCollectionList(rows) {
  const lines = [padDisp('名称', 26) + padDisp('类型', 8) + padDisp('scope', 9) + padDisp('优先', 6) + padDisp('状态', 8) + '来源'];
  for (const r of rows) {
    const state = r.enabled ? '启用' : '停用';
    const implicit = r.implicit ? '（personal 隐式）' : '';
    lines.push(
      padDisp(r.name, 26) + padDisp(r.type, 8) + padDisp(r.scope, 9) + padDisp(String(r.priority), 6)
        + padDisp(state, 8) + `${r.source}${implicit}`,
    );
  }
  return lines.join('\n');
}

/**
 * 渲染 atk status 结果。
 * @param {object} s collectStatus 返回的数据对象
 * @param {object} opts 渲染选项
 * @param {boolean} [opts.json] 输出 JSON（稳定字段，供 AI 自助闭环）
 * @returns {string} 渲染文本
 */
export function renderStatus(s, { json = false } = {}) {
  if (json) return JSON.stringify(s, null, 2);

  const lines = [];
  // M3：已移除 项目根/项目声明 —— atk 状态仅用户级
  lines.push('已注册集合:');
  if (s.collections.length === 0) lines.push('  （无）');
  for (const c of s.collections) {
    lines.push(`  ${c.name}  [${c.scope}] p=${c.priority} ${c.enabled ? '启用' : '停用'}${c.tag ? ` (${c.tag})` : ''}`);
    const reg = (s.registered || []).find((r) => r.name === c.name);
    if (reg) {
      const names = reg.skills || [];
      const shown = names.length > 8 ? `${names.slice(0, 8).join(', ')}, …共 ${names.length} 个` : (names.length ? names.join(', ') : '（空）');
      lines.push(`      ↳ ${shown}`);
    }
  }
  lines.push('');
  lines.push('生效技能:');
  if (s.effective.length === 0) lines.push('  （无）');
  for (const e of s.effective) lines.push(`  ${e.name}  ← ${e.source}`);
  if (s.conflicts.length > 0) {
    lines.push('');
    lines.push('同名冲突（解析优先来源）:');
    for (const c of s.conflicts) lines.push(`  ${c.name}: ${c.winner} 覆盖 ${c.loser}`);
  }
  if (s.remaining.length > 0) {
    lines.push('');
    lines.push(`剩余可启用: ${s.remaining.join(', ')}`);
  }
  if (s.notes.length > 0) {
    lines.push('');
    lines.push('提示:');
    for (const n of s.notes) lines.push(`  - ${n}`);
  }
  return lines.join('\n');
}