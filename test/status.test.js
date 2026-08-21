// status.test.js —— atk status 纯只读状态收集单测（仅用户级） by AI.Coding
//
// 覆盖 design.md T4 验收：status 纯只读（不产生任何写入）、--json 稳定字段、
// M3 scope 语义（scoped 默认不装；enable 后参与同名解析）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectStatus } from '../lib/core/status.js';
import { registryPath, configDir } from '../lib/core/config.js';

/** 造一个本地集合目录（root/skills/<name>/SKILL.md），返回 root */
function makeCollection(root, skills) {
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  for (const name of [].concat(skills)) {
    mkdirSync(path.join(root, 'skills', name));
    writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  return root;
}

/** 写入注册表文件 */
function writeRegistry(home, collections, defaults = { disabled: [] }) {
  mkdirSync(configDir(home), { recursive: true });
  writeFileSync(registryPath(home), JSON.stringify({ version: 1, collections, defaults }, null, 2));
}

/** 造标准测试环境：official(global) 含 coding/review；personal(scoped) 含 coding/my-doc */
function makeEnv({ personalEnabled = false } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'atk-st-home-'));
  const official = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-st-col-')), ['coding', 'review']);
  const personal = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-st-col-')), ['coding', 'my-doc']);
  writeRegistry(home, [
    { name: 'ai-toolkit-official', type: 'local', path: official, scope: 'global', enabled: true, priority: 100 },
    { name: 'personal', type: 'local', path: personal, scope: 'scoped', enabled: personalEnabled, priority: 200, tag: 'personal' },
  ]);
  return { home };
}

describe('collectStatus: 只读与字段', () => {
  it('纯只读：调用后不产生任何写入（无 state.json、注册表内容不变）', async () => {
    const { home } = makeEnv();
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'atk-st-cwd-'));
    await collectStatus({ cwd, home });
    assert.equal(existsSync(path.join(configDir(home), 'state.json')), false);
    const before = readFileSync(registryPath(home), 'utf8');
    await collectStatus({ cwd, home });
    assert.equal(readFileSync(registryPath(home), 'utf8'), before); // 注册表未被改写
  });

  it('--json 稳定字段齐备（仅用户级，无项目字段）', async () => {
    const { home } = makeEnv();
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'atk-st-cwd-'));
    const s = await collectStatus({ cwd, home });
    assert.deepEqual(s.effective.map((e) => e.name).sort(), ['coding', 'review']);
    assert.ok(s.effective.every((e) => e.source.endsWith('(global)')));
    for (const key of ['collections', 'registered', 'effective', 'conflicts', 'remaining', 'notes']) {
      assert.ok(key in s, `缺少字段 ${key}`);
    }
    // M2/M3：不再输出项目根/声明字段
    for (const gone of ['projectRoot', 'profilePath', 'hasProfile', 'profile']) {
      assert.ok(!(gone in s), `不应有字段 ${gone}`);
    }
  });

  it('M3：scoped 默认不装——personal 未 enable 不进生效集，技能进 remaining', async () => {
    const { home } = makeEnv({ personalEnabled: false });
    const s = await collectStatus({ cwd: home, home });
    assert.deepEqual(s.effective.map((e) => e.name).sort(), ['coding', 'review']);
    // personal 未启用 → my-doc 与 personal 的 coding 都在 remaining
    assert.ok(s.remaining.includes('my-doc'));
    assert.deepEqual(s.conflicts, []);
  });

  it('M3：scoped enable 后参与同名解析（personal coding 取代官方 coding）', async () => {
    const { home } = makeEnv({ personalEnabled: true });
    const s = await collectStatus({ cwd: home, home });
    assert.equal(s.effective.find((e) => e.name === 'coding').source, 'personal(scoped)');
    assert.ok(s.conflicts.some((c) => c.name === 'coding' && c.winner === 'personal(scoped)' && c.loser.endsWith('(global)')));
    assert.deepEqual(s.effective.map((e) => e.name).sort(), ['coding', 'my-doc', 'review']);
  });

  it('remaining 列出存在但未生效的技能', async () => {
    const { home } = makeEnv({ personalEnabled: false });
    const s = await collectStatus({ cwd: home, home });
    assert.ok(s.remaining.includes('my-doc'));
    assert.ok(!s.remaining.includes('coding')); // coding 已生效（official）
  });

  it('defaults.disabled 停用基础层（无同名覆盖时生效集缺失）', async () => {
    const hidden = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-st-col-')), ['doc-gen']);
    const home = makeEnv().home;
    writeRegistry(home, [
      { name: 'ai-toolkit-official', type: 'local', path: hidden, scope: 'global', enabled: true, priority: 100 },
    ], { disabled: ['doc-gen'] });
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'atk-st-cwd-'));
    const s = await collectStatus({ cwd, home });
    assert.equal(s.effective.some((e) => e.name === 'doc-gen'), false);
    assert.ok(s.notes.some((n) => n.includes('defaults.disabled')));
  });
});
describe('collectStatus: registered 全量视图（统一管理清单）', () => {
  it('列出所有已注册集合 × 技能明细，无论 enabled（含停用集合）', async () => {
    const { home } = makeEnv({ personalEnabled: false }); // personal 停用
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'atk-st-cwd-'));
    const s = await collectStatus({ cwd, home });
    assert.equal(s.registered.length, 2);
    const official = s.registered.find((r) => r.name === 'ai-toolkit-official');
    assert.deepEqual(official.skills.sort(), ['coding', 'review']);
    assert.equal(official.enabled, true);
    assert.equal(official.scope, 'global');
    assert.equal(official.exists, true);
    const personal = s.registered.find((r) => r.name === 'personal');
    assert.deepEqual(personal.skills.sort(), ['coding', 'my-doc']);
    assert.equal(personal.enabled, false, '停用集合也应出现在全量视图');
    assert.equal(personal.scope, 'scoped');
  });

  it('registered 是独立视图：不影响 effective/remaining 语义', async () => {
    const { home } = makeEnv({ personalEnabled: false });
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'atk-st-cwd-'));
    const s = await collectStatus({ cwd, home });
    assert.deepEqual(s.effective.map((e) => e.name).sort(), ['coding', 'review']);
    assert.deepEqual(s.remaining.sort(), ['my-doc'], '停用集合技能计入 remaining（可启用名单）');
  });
});
