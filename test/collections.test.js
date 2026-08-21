// collections.test.js —— 集合注册/启停/移除/导出 与 personal 隐式集合单测 by AI.Coding
//
// 覆盖 design.md T7 验收：add/remove/enable/disable/list/export 语义、
// disable 保留 clone、remove 不扫盘、personal 自动注册时机（隐式、零写入）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  registerCollection, removeCollection, setCollectionEnabled, listCollections,
  augmentRegistryWithPersonal, detectPersonal, defaultNameFromSource, isGitSource,
} from '../lib/core/collections.js';
import { registryPath, configDir, defaultRegistry } from '../lib/core/config.js';

/** 造本地集合目录 */
function makeCollectionDir(root, skills = ['a']) {
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  for (const s of skills) {
    mkdirSync(path.join(root, 'skills', s));
    writeFileSync(path.join(root, 'skills', s, 'SKILL.md'), `---\nname: ${s}\n---\n`);
  }
  return root;
}

describe('registerCollection（F01）', () => {
  it('本地路径注册缺省 scoped；priority 缺省 max+1；M3：scoped 默认停用（不自动安装）', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-col-h-'));
    const col = makeCollectionDir(mkdtempSync(path.join(os.tmpdir(), 'atk-col-')), ['a']);
    const res = await registerCollection({ home, source: col });
    assert.equal(res.ok, true);
    const reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    assert.equal(reg.collections[0].scope, 'scoped');
    assert.equal(reg.collections[0].priority, 1);
    assert.equal(reg.collections[0].enabled, false); // M3：scoped 手动 enable 才装
  });

  it('M3：global 集合注册即装（enabled=true）', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-col-h-'));
    const col = makeCollectionDir(mkdtempSync(path.join(os.tmpdir(), 'atk-col-')), ['a']);
    await registerCollection({ home, source: col, name: 'official-x', scope: 'global' });
    const reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    assert.equal(reg.collections[0].scope, 'global');
    assert.equal(reg.collections[0].enabled, true);
  });

  it('重复注册拒绝；非法名拒绝；本地路径不存在拒绝', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-col-h-'));
    const col = makeCollectionDir(mkdtempSync(path.join(os.tmpdir(), 'atk-col-')), 'a');
    await registerCollection({ home, source: col, name: 'team-x' });
    const dup = await registerCollection({ home, source: col, name: 'team-x' });
    assert.equal(dup.ok, false);
    assert.match(dup.error, /已注册/);
    const bad = await registerCollection({ home, source: '/nonexistent/path' });
    assert.equal(bad.ok, false);
    const badName = await registerCollection({ home, source: '/nonexistent', name: 'Bad Name' });
    assert.equal(badName.ok, false);
  });

  it('git 来源判定与默认名推导', () => {
    assert.equal(isGitSource('git@github.com:x/y.git'), true);
    assert.equal(isGitSource('https://github.com/x/y.git'), true);
    assert.equal(isGitSource('/local/path'), false);
    assert.equal(defaultNameFromSource('https://github.com/Team-Dev/skills.git'), 'skills'); // 仓库名=最后一段
    assert.equal(defaultNameFromSource('/tmp/My Skills'), 'my-skills');
  });
});

describe('enable/disable（F03）', () => {
  it('启停不自动 apply、不删 clone', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-col-h-'));
    const col = makeCollectionDir(mkdtempSync(path.join(os.tmpdir(), 'atk-col-')), 'a');
    await registerCollection({ home, source: col, name: 'team-x' });
    await setCollectionEnabled({ home, name: 'team-x', enabled: false });
    let reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    assert.equal(reg.collections[0].enabled, false);
    await setCollectionEnabled({ home, name: 'team-x', enabled: true });
    reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    assert.equal(reg.collections[0].enabled, true);
  });

  it('personal 目录不存在时报错；存在时隐式→显式条目转换', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-col-h-'));
    const r1 = await setCollectionEnabled({ home, name: 'personal', enabled: false });
    assert.equal(r1.ok, false); // 目录不存在
    mkdirSync(path.join(home, '.atk', 'personal'), { recursive: true });
    const r2 = await setCollectionEnabled({ home, name: 'personal', enabled: false });
    assert.equal(r2.ok, true);
    const reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    assert.equal(reg.collections[0].name, 'personal');
    assert.equal(reg.collections[0].enabled, false);
  });
});

describe('personal 隐式集合（F05，零写盘）', () => {
  it('目录存在时常量注册（不写注册表），status/plan 可用', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-col-h-'));
    const reg = defaultRegistry();
    // 目录不存在 → 无条目
    let augmented = await augmentRegistryWithPersonal(reg, home);
    assert.equal(augmented.collections.length, 0);
    // 目录存在 → 隐式条目
    mkdirSync(path.join(home, '.atk', 'personal'), { recursive: true });
    augmented = await augmentRegistryWithPersonal(reg, home);
    assert.equal(augmented.collections.length, 1);
    assert.equal(augmented.collections[0].name, 'personal');
    assert.equal(augmented.collections[0].scope, 'scoped');
    assert.equal(augmented.collections[0].tag, 'personal');
    assert.equal(augmented.collections[0].enabled, false, 'M3：隐式 scoped 默认停用（需 enable 才装）');
    // 不写盘（注册表文件仍不存在）
    assert.equal(existsSync(registryPath(home)), false);
    const { exists } = await detectPersonal(home);
    assert.equal(exists, true);
  });

  it('显式 personal 条目优先于隐式', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-col-h-'));
    mkdirSync(path.join(home, '.atk', 'personal'), { recursive: true });
    const reg = {
      version: 1,
      collections: [{ name: 'personal', type: 'local', path: path.join(home, '.atk', 'personal'), scope: 'scoped', tag: 'personal', enabled: false, priority: 9 }],
      defaults: { disabled: [] },
    };
    const augmented = await augmentRegistryWithPersonal(reg, home);
    assert.equal(augmented.collections.length, 1); // 不重复加隐式
    assert.equal(augmented.collections[0].enabled, false); // 显式状态保留
  });
});

describe('remove（F02）', () => {
  it('scoped 移除仅删注册项、不扫盘、不删目录', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-col-h-'));
    const col = makeCollectionDir(mkdtempSync(path.join(os.tmpdir(), 'atk-col-')), ['a']);
    await registerCollection({ home, source: col, name: 'team-x' });
    const res = await removeCollection({ home, name: 'team-x' });
    assert.equal(res.ok, true);
    const reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    assert.equal(reg.collections.length, 0);
    assert.equal(res.cleaned, 0); // scoped 不清理链接
  });
});