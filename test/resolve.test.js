// resolve.test.js —— 用户级归并算法单测 by AI.Coding
//
// 覆盖 design.md T3 验收：同名解析优先、priority 升序+tie-break、
// defaults 顺序（含用户级同名重新获得）、M3 scope 默认不装。
// M2 起：项目声明 / 项目本地技能已移除，对应用例删除。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLayers } from '../lib/core/resolve.js';

/** 快捷构造层（priority 排序已由调用方负责，测试直接按序传入） */
const gl = (source, skills) => ({ source, priority: 1, skills });

describe('mergeLayers: 同名解析优先（方案 A：后归并者胜出）', () => {
  it('用户级 enabled 集合间同名：后优先级（调用方已升序）胜出', () => {
    const { effective, conflicts } = mergeLayers({
      globalLayers: [gl('official(global)', ['coding', 'review']), gl('team(global)', ['coding'])],
    });
    assert.deepEqual(effective, [
      { name: 'coding', source: 'team(global)' },
      { name: 'review', source: 'official(global)' },
    ]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].winner, 'team(global)');
    assert.equal(conflicts[0].loser, 'official(global)');
  });

  it('M3：scoped 集合同名可覆盖 global（scope 不参与优先级，只决定默认 enabled）', () => {
    const { effective, conflicts } = mergeLayers({
      globalLayers: [gl('official(global)', ['coding', 'review']), gl('personal(scoped)', ['coding'])],
    });
    assert.deepEqual(effective, [
      { name: 'coding', source: 'personal(scoped)' },
      { name: 'review', source: 'official(global)' },
    ]);
    assert.equal(conflicts.some((c) => c.name === 'coding' && c.winner === 'personal(scoped)'), true);
  });

  it('priority 相等时登记顺序稳定（后登记者在升序中靠后 → 同名胜出）', () => {
    const { conflicts } = mergeLayers({
      globalLayers: [
        { source: 'first-registered(global)', priority: 100, skills: ['x'] },
        { source: 'second-registered(global)', priority: 100, skills: ['x'] },
      ],
    });
    assert.equal(conflicts[0].winner, 'second-registered(global)');
    assert.equal(conflicts[0].loser, 'first-registered(global)');
  });
});

describe('mergeLayers: defaults.disabled 顺序算法（F09）', () => {
  it('M3：defaults.disabled 在用户级按名字整体停用（无层级重得——已无项目层）', () => {
    const { effective, notes } = mergeLayers({
      globalLayers: [gl('official(global)', ['coding']), gl('personal(scoped)', ['coding'])],
      defaultsDisabled: ['coding'],
    });
    assert.deepEqual(effective, []);
    assert.ok(notes.some((n) => n.includes('defaults.disabled')));
  });

  it('defaults.disabled 停用的基础层技能若无同名覆盖则消失', () => {
    const { effective } = mergeLayers({
      globalLayers: [gl('official(global)', ['coding', 'doc-gen'])],
      defaultsDisabled: ['doc-gen'],
    });
    assert.deepEqual(effective.map((e) => e.name), ['coding']);
  });

  it('新注册 global 集合的同名技能同样受 defaults.disabled 影响（基础层内按名字禁用）', () => {
    const { effective } = mergeLayers({
      globalLayers: [gl('offical-x(global)', ['coding']), gl('new-global(global)', ['coding'])],
      defaultsDisabled: ['coding'],
    });
    // 基础层 coding 被按名字整体禁用，即使多来源同名也无法出现在基础层
    assert.deepEqual(effective, []);
  });
});