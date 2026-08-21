// review-fixes.test.js —— review FAIL 修复验证（C1–C4 + W2/W5） by AI.Coding
//
// 覆盖 review 轮整改：
//   C1  collection enable/disable --dry-run 零写入预览
//   C2  sync 进程锁互斥（F19 ①）
//   C3  同名接管：disable 高优先级 global 后，链接重指新胜出者（F03）
//   W2  已禁用集合损坏 manifest 不阻塞 apply（F03 失败表）
//   C4  官方集合 manifest 生效：validate 无 manifest/依赖错误
//   W5  profileHash 随参与集合变化（而非恒同）

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readlinkSync, existsSync, readFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planInstall } from '../lib/core/plan.js';
import { runApply } from '../lib/core/apply.js';
import { registryPath, configDir } from '../lib/core/config.js';
import { syncCollections } from '../lib/core/sync.js';
import { validateCollection } from '../lib/core/validate.js';
import { clientUserDir } from '../lib/core/client-matrix.js';
import { run } from '../lib/cli/index.js';

/** 造集合目录 root/skills/<name>/SKILL.md */
function makeCollection(root, skills = []) {
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  for (const name of skills) {
    mkdirSync(path.join(root, 'skills', name));
    writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  return root;
}

/** 写入注册表（直接构造，绕开 git clone 依赖） */
function writeRegistry(home, collections, defaults = undefined) {
  mkdirSync(configDir(home), { recursive: true });
  writeFileSync(registryPath(home), JSON.stringify({ version: 1, defaults: defaults ?? { disabled: [] }, collections }));
}

/** 内存 IO（cli 注入用） */
function makeIo() {
  return { stdout: { write() {} }, stderr: { write() {} } };
}

/** 读取注册表集合数组（home 下） */
function registryCollections(home) {
  return JSON.parse(readFileSync(registryPath(home), 'utf8')).collections;
}

describe('C1 collection enable/disable --dry-run 零写入', () => {
  it('disable --dry-run 输出预览且注册表 enabled 不变', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-c1-'));
    writeRegistry(home, [{ name: 'a', type: 'local', path: home, scope: 'global', enabled: true, priority: 1 }]);
    const io = makeIo();
    const out = [];
    io.stdout.write = (s) => out.push(s);
    // cli 的 home 取 process.env.HOME：临时指向隔离 home（跑完恢复）
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      // 若 dry-run 被误当写入，这里会抛/改状态
      const code = await run(['collection', 'disable', 'a', '--dry-run'], io);
      assert.equal(code, 0);
    } finally {
      process.env.HOME = prevHome;
    }
    assert.ok(out.join('').includes('dry-run'), `应提示 dry-run: ${out.join('')}`);
    // 注册表未被修改
    const cols = registryCollections(home);
    assert.equal(cols.find((c) => c.name === 'a').enabled, true);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('C2 sync 进程锁', () => {
  it('已持锁时返回 locked 且 exitCode 1（不碰 git）', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-c2-'));
    // 造一把"活锁"（pid=本进程，startedAt=现在 → 非 stale）
    mkdirSync(configDir(home), { recursive: true });
    writeFileSync(
      path.join(configDir(home), 'sync.lock'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() })
    );
    const res = await syncCollections({ cwd: home, home });
    assert.equal(res.collections.length, 1);
    assert.equal(res.collections[0].status, 'locked');
    assert.equal(res.exitCode, 1);
    rmSync(home, { recursive: true, force: true });
  });

  it('活进程持有超龄锁不被抢占（pid 存活优先于年龄）', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-c2c-'));
    mkdirSync(configDir(home), { recursive: true });
    // 活进程（本进程 pid）+ 超过 10 分钟年龄 → 仍应视为持有中，不可抢占
    writeFileSync(
      path.join(configDir(home), 'sync.lock'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - 11 * 60 * 1000 })
    );
    const res = await syncCollections({ cwd: home, home });
    assert.equal(res.collections[0]?.status, 'locked', '活进程的锁即使超龄也不得抢占');
    assert.equal(res.exitCode, 1);
    rmSync(home, { recursive: true, force: true });
  });

  it('stale 锁可抢占（崩溃残留不永久阻塞）', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-c2b-'));
    mkdirSync(configDir(home), { recursive: true });
    // 已死进程 + 过期时间戳 → stale
    writeFileSync(
      path.join(configDir(home), 'sync.lock'),
      JSON.stringify({ pid: 999999, startedAt: Date.now() - 11 * 60 * 1000 })
    );
    const res = await syncCollections({ cwd: mkdtempSync(path.join(os.tmpdir(), 'atk-c2c-')), home });
    assert.notEqual(res.collections[0]?.status, 'locked', 'stale 锁应被抢占');
    rmSync(home, { recursive: true, force: true });
  });
});

describe('C3 同名接管重指', () => {
  it('disable 高优先级 global 后链接重指到新胜者', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-c3-'));
    const a = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-c3a-')), ['coding']);
    const b = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-c3b-')), ['coding']);
    writeRegistry(home, [
      { name: 'a', type: 'local', path: a, scope: 'global', enabled: true, priority: 200 },
      { name: 'b', type: 'local', path: b, scope: 'global', enabled: true, priority: 100 },
    ]);
    // 首轮 apply：priority 大者优先（a=200 胜出 b=100），链接指向 a
    let plan = await planInstall({ cwd: home, home });
    await runApply(plan);
    const target = path.join(clientUserDir('dsh', home), 'coding');
    assert.equal(readlinkSync(target), path.join(a, 'skills', 'coding'));
    // 接管场景（F03）：禁用高优先级 a → 胜者变为 b → 链接应重指 b（而非保留指向 a）
    writeRegistry(home, [
      { name: 'a', type: 'local', path: a, scope: 'global', enabled: false, priority: 200 },
      { name: 'b', type: 'local', path: b, scope: 'global', enabled: true, priority: 100 },
    ]);
    plan = await planInstall({ cwd: home, home });
    const res = await runApply(plan);
    assert.equal(readlinkSync(target), path.join(b, 'skills', 'coding'), res.skipped.map((s) => s.reason).join(';'));
    rmSync(home, { recursive: true, force: true });
  });
});

describe('W2 禁用集合损坏 manifest 不阻塞', () => {
  it('planInstall 对 disabled 集合的非法 manifest 不报错', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-w2-'));
    const good = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-w2g-')), ['x']);
    const bad = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-w2b-')), ['y']);
    writeFileSync(path.join(bad, 'atk.manifest.json'), '{ not json');
    writeRegistry(home, [
      { name: 'good', type: 'local', path: good, scope: 'global', enabled: true, priority: 1 },
      { name: 'bad', type: 'local', path: bad, scope: 'global', enabled: false, priority: 2 },
    ]);
    const plan = await planInstall({ cwd: home, home });
    assert.deepEqual(plan.errors, []);
    rmSync(home, { recursive: true, force: true });
  });

  it('启用集合的非法 manifest 按规划失败处理（非抛错）', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-w2c-'));
    const bad = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-w2d-')), ['y']);
    writeFileSync(path.join(bad, 'atk.manifest.json'), '{ not json');
    writeRegistry(home, [
      { name: 'bad', type: 'local', path: bad, scope: 'global', enabled: true, priority: 2 },
    ]);
    const plan = await planInstall({ cwd: home, home });
    assert.equal(plan.errors.length, 1);
    assert.match(plan.errors[0], /atk.manifest.json 非法/);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('C4 官方集合 manifest（ai-toolkit skills/ 根）', () => {
  // 直接用真实仓库根作为 local 集合：validate 无 manifest/依赖类错误，plan 可安装
  it('validate 官方集合无 manifest/依赖错误；注册后 plan 无 error', async () => {
    const repo = path.join(import.meta.dirname, '..', '..', '..'); // 仓库根（含 skills/ 子目录）
    const vres = await validateCollection(repo);
    // manifest 效力：不应再出现「无 manifest」「必需依赖缺失」类错误（仓库历史遗留目录/占位引用不在本次断言范围）
    const manifestRelated = vres.errors.filter((e) => e.includes('manifest') || e.includes('依赖'));
    assert.deepEqual(manifestRelated, []);
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-c4-'));
    writeRegistry(home, [
      { name: 'ai-toolkit-official', type: 'local', path: repo, scope: 'global', enabled: true, priority: 1 },
    ]);
    // 官方集合注册 + apply：manifest 依赖闭包不影响用户级安装
    const plan = await planInstall({ cwd: home, home });
    assert.deepEqual(plan.errors, []);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('W5 profileHash 随参与集合变化', () => {
  it('不同参与集合 → 不同 profileHash（state 指纹非恒同）', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-w5-'));
    const a = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-w5a-')), ['x']);
    writeRegistry(home, [
      { name: 'a', type: 'local', path: a, scope: 'global', enabled: true, priority: 1 },
    ]);
    const p1 = await planInstall({ cwd: home, home });
    // 再加一个集合 → hash 应变
    const b = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-w5b-')), ['y']);
    writeRegistry(home, [
      { name: 'a', type: 'local', path: a, scope: 'global', enabled: true, priority: 1 },
      { name: 'b', type: 'local', path: b, scope: 'global', enabled: true, priority: 2 },
    ]);
    const p2 = await planInstall({ cwd: home, home });
    assert.notEqual(p1.userLinks[0].profileHash, p2.userLinks[0].profileHash);
    rmSync(home, { recursive: true, force: true });
  });
});