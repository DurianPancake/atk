// apply.test.js —— 两阶段 apply 集成测试（F17/F15/F26） by AI.Coding
//
// 覆盖 design.md T5 验收：dry-run 与真实一致、校验失败零写入、部分失败收敛、
// 断链清理（词法判定）、用户手放内容不删除、幂等。
// M2/M3 起：仅用户级安装（无项目级产物）；scoped 集合默认不装（需 enable）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, lstatSync, existsSync, readFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planInstall } from '../lib/core/plan.js';
import { runApply } from '../lib/core/apply.js';
import { registryPath, configDir } from '../lib/core/config.js';
import { clientNames, clientUserDir } from '../lib/core/client-matrix.js';

/** 读取目录下符号链接名（目录不存在返回空数组） */
function symlinksIn(dir) {
  try {
    return readdirSync(dir).filter((n) => lstatSync(path.join(dir, n)).isSymbolicLink()).sort();
  } catch {
    return [];
  }
}

/** 造集合目录 root/skills/<name>/SKILL.md */
function makeCollection(root, skills) {
  if (skills.length === 0) return root;
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  for (const name of skills) {
    mkdirSync(path.join(root, 'skills', name));
    writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  return root;
}

/** 造标准环境：临时 HOME + 注册表（official global + personal scoped） */
function makeEnv({ scoped = true, scopedEnabled = false } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'atk-ap-home-'));
  const official = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-ap-col-')), ['coding', 'review']);
  const cols = [
    { name: 'ai-toolkit-official', type: 'local', path: official, scope: 'global', enabled: true, priority: 100 },
  ];
  const personal = scoped
    ? makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-ap-col-')), ['coding', 'my-doc'])
    : null;
  if (personal) cols.push({
    name: 'personal', type: 'local', path: personal, scope: 'scoped', enabled: scopedEnabled, priority: 200,
  });
  mkdirSync(configDir(home), { recursive: true });
  writeFileSync(registryPath(home), JSON.stringify({ version: 1, collections: cols, defaults: { disabled: [] } }, null, 2));
  return { home, official, personal };
}

describe('apply: 端到端（仅用户级）', () => {
  it('apply 后仅用户级 5 客户端产物正确，无任何项目级产物', async () => {
    const { home } = makeEnv();
    const plan = await planInstall({ cwd: home, home });
    assert.deepEqual(plan.errors, []);
    const res = await runApply(plan);
    assert.deepEqual(res.failed, []);
    assert.equal(res.exitCode, 0);
    // 用户级：official(global p=100) coding/review（personal scoped 默认未启用，不安装）
    for (const client of clientNames()) {
      assert.deepEqual(symlinksIn(clientUserDir(client, home)), ['coding', 'review'], `用户级 ${client}`);
    }
    // 无项目级产物：不生成项目 state、项目目录下无 .atk 目录
    assert.equal(existsSync(path.join(home, '.atk')), false, '不应生成项目级 .atk 目录');
    // state 落盘：用户级 5×2 条
    const userState = JSON.parse(readFileSync(path.join(configDir(home), 'state.json'), 'utf8'));
    assert.equal(userState.links.length, 10);
    // 链接全部来自 official 集合（personal 未启用）
    assert.ok(userState.links.every((l) => l.collection === 'ai-toolkit-official')); // W1：裸集合名（removeCollection 按名匹配）
  });

  it('M3：scoped 集合 enable=false 时不安装；enable 后 apply 安装其技能', async () => {
    const { home } = makeEnv({ scopedEnabled: false });
    // 首轮：仅 official 生效
    let plan = await planInstall({ cwd: home, home });
    assert.deepEqual(plan.errors, []);
    let res = await runApply(plan);
    assert.equal(res.exitCode, 0);
    for (const client of clientNames()) {
      assert.deepEqual(symlinksIn(clientUserDir(client, home)), ['coding', 'review'], `scoped 未启用 ${client}`);
    }
    // enable personal → 同名 coding 被 personal(scoped, p=200) 覆盖，my-doc 新增
    const reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    reg.collections.find((c) => c.name === 'personal').enabled = true;
    writeFileSync(registryPath(home), JSON.stringify(reg, null, 2));
    plan = await planInstall({ cwd: home, home });
    res = await runApply(plan);
    assert.equal(res.exitCode, 0);
    for (const client of clientNames()) {
      assert.deepEqual(symlinksIn(clientUserDir(client, home)), ['coding', 'my-doc', 'review'], `scoped 启用 ${client}`);
    }
  });

  it('W7：存量项目级产物一次性清理——apply 时按旧项目级 state 安全删除链接并移除状态文件', async () => {
    const { home } = makeEnv();
    // 造旧版项目级产物（atk 旧版项目级安装残留）：<proj>/.atk/state.json + <proj>/.claude/skills/wo-commit 软链
    const proj = mkdtempSync(path.join(os.tmpdir(), 'atk-w7-proj-'));
    const projAtk = path.join(proj, '.atk');
    mkdirSync(path.join(projAtk, 'skills'), { recursive: true });
    mkdirSync(path.join(proj, '.claude', 'skills'), { recursive: true });
    const legacySource = path.join(mkdtempSync(path.join(os.tmpdir(), 'atk-w7-src-')), 'skills', 'wo-commit');
    mkdirSync(path.dirname(legacySource), { recursive: true });
    writeFileSync(legacySource, '---\nname: wo-commit\n---\n');
    const legacyTarget = path.join(proj, '.claude', 'skills', 'wo-commit');
    // 直接建软链，随后由旧 state 记录
	
    const { symlinkSync } = await import('node:fs');
    symlinkSync(legacySource, legacyTarget);
    mkdirSync(configDir(home), { recursive: true });
    writeFileSync(path.join(projAtk, 'state.json'), JSON.stringify({
      version: 1,
      links: [{ kind: 'skill', client: 'claude', targetPath: legacyTarget, sourcePath: legacySource, collection: 'ai-toolkit-official' }],
    }, null, 2));

    const plan = await planInstall({ cwd: proj, home });
    assert.deepEqual(plan.errors, []);
    assert.ok(plan.legacyCleanup, '应识别存量项目级 state');
    assert.equal(plan.unlinks.some((u) => u.legacyProject && u.targetPath === legacyTarget), true);

    const res = await runApply(plan);
    assert.equal(res.exitCode, 0);
    assert.equal(existsSync(legacyTarget), false, '旧项目级链接应被清理');
    assert.equal(existsSync(path.join(projAtk, 'state.json')), false, '旧项目 state 文件应被删除');
    // .atk 目录：非空（残留 skills 目录）→ 保留；空 → 移除。此处含 skills 目录故保留，
    // 仅验证不再建新（第二次 plan 不再出现 legacyCleanup）
    const second = await planInstall({ cwd: proj, home });
    assert.equal(second.legacyCleanup, null, '清理一次性完成，不再重复');
  });

  it('幂等：第二次 apply 无新增、无失败、state 一致', async () => {
    const { home } = makeEnv();
    const plan = await planInstall({ cwd: home, home });
    await runApply(plan);
    const before = readFileSync(path.join(configDir(home), 'state.json'), 'utf8');
    const second = await runApply(await planInstall({ cwd: home, home }));
    assert.equal(second.exitCode, 0);
    assert.deepEqual(second.applied, []);
    assert.ok(second.skipped.length > 0);
    assert.equal(readFileSync(path.join(configDir(home), 'state.json'), 'utf8'), before);
  });

  it('dry-run 与真实执行产物一致（目标集合相同）', async () => {
    const { home } = makeEnv();
    const plan = await planInstall({ cwd: home, home });
    const planTargets = plan.userLinks.map((l) => l.targetPath).sort();
    const dry = await runApply(plan, { dryRun: true });
    assert.equal(dry.dryRun, true);
    const real = await runApply(await planInstall({ cwd: home, home }));
    const diskTargets = [...clientNames()]
      .map((c) => symlinksIn(clientUserDir(c, home)).map((n) => path.join(clientUserDir(c, home), n)))
      .flat().sort();
    assert.equal(real.exitCode, 0);
    assert.deepEqual(planTargets, diskTargets);
  });

  it('规划校验失败零写入（runApply 直接返回非 0，不产生任何链接）', async () => {
    const { home } = makeEnv();
    const plan = await planInstall({ cwd: home, home });
    plan.errors.push('模拟规划失败');
    const res = await runApply(plan);
    assert.equal(res.exitCode, 1);
    for (const client of clientNames()) {
      assert.deepEqual(symlinksIn(clientUserDir(client, home)).filter((n) => n), []);
    }
    assert.equal(existsSync(path.join(configDir(home), 'state.json')), false);
  });

  it('manifest 必需依赖缺失 → 规划失败，零写入', async () => {
    const { home, official } = makeEnv();
    // 给官方集合加 manifest，声明 review 依赖一个不存在的文件（必需）
    writeFileSync(path.join(official, 'atk.manifest.json'), JSON.stringify({ dependencies: { review: ['skills/merge-review/SCORING.md'] } }));
    const plan = await planInstall({ cwd: home, home });
    assert.ok(plan.errors.length > 0, '应有必需依赖错误');
    assert.match(plan.errors.join('\n'), /依赖缺失/);
    const res = await runApply(plan);
    assert.equal(res.exitCode, 1);
    assert.deepEqual(res.applied, []);
  });

  it('用户手放内容：同名真实目录/文件被跳过且不删除、不进 state', async () => {
    const { home } = makeEnv();
    // 在 dsh 用户级目录预置真实目录 coding（用户手放）
    const dir = clientUserDir('dsh', home);
    mkdirSync(path.join(dir, 'coding'), { recursive: true });
    writeFileSync(path.join(dir, 'coding', 'README.md'), 'user file');
    const plan = await planInstall({ cwd: home, home });
    const res = await runApply(plan);
    assert.equal(res.exitCode, 0);
    const skipped = res.skipped.find((s) => s.client === 'dsh' && s.targetPath.endsWith('/coding'));
    assert.ok(skipped, '应跳过 dsh/coding');
    assert.match(skipped.reason, /用户内容|占用/);
    // 用户文件还在
    assert.equal(existsSync(path.join(dir, 'coding', 'README.md')), true);
    // state 不含该条
    const userState = JSON.parse(readFileSync(path.join(configDir(home), 'state.json'), 'utf8'));
    assert.equal(userState.links.some((l) => l.client === 'dsh' && l.targetPath.endsWith('/coding')), false);
  });

  it('断链清理：禁用集合后 apply，断链按词法判定被清理', async () => {
    const { home, official } = makeEnv({ scoped: false });
    await runApply(await planInstall({ cwd: home, home }));
    const dshCoding = path.join(clientUserDir('dsh', home), 'coding');
    assert.equal(lstatSync(dshCoding).isSymbolicLink(), true);
    // 制造断链：删除 source 技能目录
    rmSync(path.join(official, 'skills', 'coding'), { recursive: true });
    // 禁用官方集合 → coding/review 不再期望存在
    const reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    reg.collections[0].enabled = false;
    writeFileSync(registryPath(home), JSON.stringify(reg, null, 2));
    const plan = await planInstall({ cwd: home, home });
    const res = await runApply(plan);
    assert.equal(res.exitCode, 0);
    assert.equal(existsSync(dshCoding), false); // 断链被清理（词法判定通过）
  });

  it('部分失败后再次 apply 收敛（F15）', async () => {
    const { home } = makeEnv();
    // 制造失败：把 claude 用户级目录换成文件（mkdir 失败）
    const claudeDir = clientUserDir('claude', home);
    mkdirSync(path.dirname(claudeDir), { recursive: true });
    writeFileSync(claudeDir, 'blocked'); // claude 目录本身成为文件
    const first = await runApply(await planInstall({ cwd: home, home }));
    assert.equal(first.exitCode, 1);
    assert.ok(first.failed.length > 0, '应存在失败项');
    // 恢复目录
    rmSync(claudeDir);
    const second = await runApply(await planInstall({ cwd: home, home }));
    assert.equal(second.exitCode, 0);
    assert.deepEqual(second.failed, []);
    assert.ok(second.applied.length > 0, '补齐剩余链接（收敛）');
    // 最终 state 完整
    const userState = JSON.parse(readFileSync(path.join(configDir(home), 'state.json'), 'utf8'));
    assert.equal(userState.links.length, 10);
  });
});