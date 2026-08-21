// config.test.js —— 注册表读写与 schema 校验单测 by AI.Coding
//
// 覆盖 design.md T2 验收：注册表字段全、原子写、schema 非法拒绝。
// M2 起：项目声明（.atk.json）已移除，对应用例删除。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  defaultRegistry, loadRegistry, saveRegistry, validateRegistry,
  registryPath, configDir,
} from '../lib/core/config.js';

/**
 * 造一个临时 HOME 并返回其路径（每个用例独立，互不污染）。
 * @returns {string} 临时主目录
 */
function tempHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'atk-test-'));
}

describe('config: 注册表', () => {
  it('文件不存在时返回默认注册表', async () => {
    const home = tempHome();
    const reg = await loadRegistry(home);
    assert.deepEqual(reg, defaultRegistry());
  });

  it('保存后可读回且内容一致（原子写）', async () => {
    const home = tempHome();
    const reg = defaultRegistry();
    reg.collections.push({
      name: 'team-x', type: 'git', url: 'git@example.com:team/skills.git',
      scope: 'scoped', enabled: true, priority: 100, branch: 'main', registeredAt: '2026-08-20T00:00:00Z',
    });
    const file = await saveRegistry(home, reg);
    assert.equal(file, registryPath(home));
    assert.deepEqual(await loadRegistry(home), reg);
    // 原子写入后不应残留临时文件
    const leftovers = readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('校验失败的注册表拒绝写入且不落盘', async () => {
    const home = tempHome();
    const bad = { version: 1, collections: [{ name: 'x' }] }; // 缺 type/scope/enabled/priority
    await assert.rejects(() => saveRegistry(home, bad), /校验失败/);
    assert.equal(existsSync(registryPath(home)), false);
  });

  it('已存在但 JSON 非法的注册表抛出解析错误', async () => {
    const home = tempHome();
    // 先建配置目录再写入畸形 JSON（模拟已存在的损坏注册表）
    mkdirSync(path.dirname(registryPath(home)), { recursive: true });
    writeFileSync(registryPath(home), '{ not json');
    await assert.rejects(() => loadRegistry(home), /解析失败/);
  });

  it('schema 校验：枚举/必填/未知键逐项拦截', () => {
    const ok = defaultRegistry();
    assert.deepEqual(validateRegistry(ok), []);
    // scope 非法枚举
    const badScope = { ...ok, collections: [{ name: 'a', type: 'local', path: '/x', scope: 'everywhere', enabled: true, priority: 1 }] };
    assert.match(validateRegistry(badScope).join('\n'), /scope/);
    // 未知键（拼写错误防护）
    const badKey = { ...ok, version: 1, collections: [{ name: 'a', type: 'local', path: '/x', scope: 'scoped', enabled: true, priority: 1, priotiry: 9 }] };
    assert.match(validateRegistry(badKey).join('\n'), /未知字段 "priotiry"/);
    // name pattern（kebab-case）
    const badName = { ...ok, collections: [{ name: 'Bad Name', type: 'local', path: '/x', scope: 'scoped', enabled: true, priority: 1 }] };
    assert.match(validateRegistry(badName).join('\n'), /pattern/);
  });
});

describe('config: 路径约定', () => {
  it('配置目录与注册表路径符合 spec', () => {
    assert.equal(configDir('/u'), path.join('/u', '.config', 'atk'));
    assert.equal(registryPath('/u'), path.join('/u', '.config', 'atk', 'collections.json'));
  });
});