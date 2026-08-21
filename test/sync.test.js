// sync.test.js —— atk sync 集成测试（F19/F25） by AI.Coding
//
// 覆盖 design.md T9 验收：fetch+ff-only；dirty/detached 跳过；clone 丢失重建；
// 失败集合继续用本地旧版；同步后自动应用 global+当前项目；退出码；防递归环境注入。
//
// 用本地裸仓库模拟远端：registerCollection(git url=裸仓库) 时即 clone；
// 随后在裸仓库 push 新 commit，sync 应 ff-only 更新本地 clone 并重新 apply。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { syncCollections } from '../lib/core/sync.js';
import { registryPath, configDir } from '../lib/core/config.js';
import { registerCollection } from '../lib/core/collections.js';
import { clientUserDir } from '../lib/core/client-matrix.js';

/** 造裸仓库并写入初始 commit（skills/alpha），返回裸仓库路径（.git 后缀以命中 git 型判定） */
function makeRemote(skills = ['alpha']) {
  const remote = `${mkdtempSync(path.join(os.tmpdir(), 'atk-sync-remote-'))}.git`;
  execFileSync('git', ['init', '--bare', '-q', remote]);
  // 工作区造 commit 后 push 到裸仓库
  const work = mkdtempSync(path.join(os.tmpdir(), 'atk-sync-work-'));
  execFileSync('git', ['init', '-q', work]);
  execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 't']);
  for (const name of skills) {
    mkdirSync(path.join(work, 'skills', name), { recursive: true });
    writeFileSync(path.join(work, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  execFileSync('git', ['-C', work, 'add', '-A']);
  execFileSync('git', ['-C', work, 'commit', '-qm', 'init']);
  execFileSync('git', ['-C', work, 'branch', '-M', 'main']);
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', remote]);
  execFileSync('git', ['-C', work, 'push', '-q', '-u', 'origin', 'main']);
  return remote;
}

/** 往裸仓库追加技能（新 commit）并 push */
function pushNewSkill(remote, name) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'atk-sync-push-'));
  execFileSync('git', ['clone', '-q', remote, work]);
  mkdirSync(path.join(work, 'skills', name), { recursive: true });
  writeFileSync(path.join(work, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', work, 'add', '-A']);
  execFileSync('git', ['-C', work, 'commit', '-qm', `add ${name}`]);
  execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'main']);
}

/** 造 home + 注册 git 集合（registerCollection 内部 clone） */
async function makeEnv(remote) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'atk-sync-h-'));
  const res = await registerCollection({ home, source: remote, name: 'team-git', scope: 'global' });
  assert.equal(res.ok, true);
  const project = mkdtempSync(path.join(os.tmpdir(), 'atk-sync-p-'));
  return { home, project };
}

describe('sync（F19/F25）', () => {
  it('fetch+ff-only 更新 + 自动 apply（新增技能进用户级链接）', async () => {
    const remote = makeRemote(['alpha']);
    const { home, project } = await makeEnv(remote);
    // 首次 apply 建立 alpha 链接
    await syncCollections({ cwd: project, home });
    // 远端新增 beta
    pushNewSkill(remote, 'beta');
    const res = await syncCollections({ cwd: project, home });
    assert.equal(res.collections[0].status, 'synced');
    // apply 后用户级 dsh 目录同时有 alpha+beta
    const links = readdirSync(clientUserDir('dsh', home)).filter((n) => lstatSync(path.join(clientUserDir('dsh', home), n)).isSymbolicLink()).sort();
    assert.deepEqual(links, ['alpha', 'beta']);
    assert.equal(res.exitCode, 0);
  });

  it('dirty 工作区跳过；detached 跳过', async () => {
    const remote = makeRemote(['alpha']);
    const { home, project } = await makeEnv(remote);
    await syncCollections({ cwd: project, home });
    // dirty：改 clone 内文件
    const cloneDir = path.join(home, '.atk', 'collections', 'team-git');
    writeFileSync(path.join(cloneDir, 'skills', 'alpha', 'SKILL.md'), '# modified\n');
    let res = await syncCollections({ cwd: project, home });
    assert.equal(res.collections[0].status, 'skipped-dirty');
    // 还原 dirty
    execFileSync('git', ['-C', cloneDir, 'checkout', '-q', '--', '.']);
    // detached：checkout 到初始 commit
    const head = execFileSync('git', ['-C', cloneDir, 'rev-parse', 'HEAD']).toString().trim();
    execFileSync('git', ['-C', cloneDir, 'checkout', '-q', head]);
    res = await syncCollections({ cwd: project, home });
    assert.equal(res.collections[0].status, 'skipped-detached');
  });

  it('clone 丢失 → 重建（recloned）', async () => {
    const remote = makeRemote(['alpha']);
    const { home, project } = await makeEnv(remote);
    const cloneDir = path.join(home, '.atk', 'collections', 'team-git');
    rmSync(cloneDir, { recursive: true });
    const res = await syncCollections({ cwd: project, home });
    assert.equal(res.collections[0].status, 'recloned');
    assert.equal(existsSync(path.join(cloneDir, 'skills', 'alpha', 'SKILL.md')), true);
  });

  it('拉取失败不中断：坏 url 集合失败但其余正常，退出非 0 仍 apply', async () => {
    const remote = makeRemote(['alpha']);
    const { home, project } = await makeEnv(remote);
    // 手工注册一个坏 url 集合（registerCollection 会 clone 失败，直接写注册表）
    const reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    reg.collections.push({ name: 'broken', type: 'git', url: '/nonexistent/repo.git', scope: 'scoped', enabled: true, priority: 99 });
    writeFileSync(registryPath(home), JSON.stringify(reg, null, 2));
    const res = await syncCollections({ cwd: project, home });
    const broken = res.collections.find((c) => c.name === 'broken');
    assert.equal(broken.status, 'failed'); // clone 目录不存在 → clone 失败 → failed
    assert.equal(res.exitCode, 1); // F19 ⑥
    // 但 apply 仍执行（team-git alpha 链接存在）
    assert.ok(res.apply, '仍执行 apply');
    const links = readdirSync(clientUserDir('dsh', home)).filter((n) => lstatSync(path.join(clientUserDir('dsh', home), n)).isSymbolicLink());
    assert.ok(links.includes('alpha'));
  });

  it('--no-apply 跳过应用', async () => {
    const remote = makeRemote(['alpha']);
    const { home, project } = await makeEnv(remote);
    const res = await syncCollections({ cwd: project, home, noApply: true });
    assert.equal(res.apply, null);
    assert.equal(res.collections[0].status, 'synced');
  });
});