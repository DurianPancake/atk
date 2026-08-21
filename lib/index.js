// index.js —— atk 包公共出口 by AI.Coding
//
// 对外暴露 core 能力（供测试与脚本化调用）；CLI bin 直接引用 lib/cli。

export * as config from './core/config.js';
export * as schema from './core/schema.js';

// 当前包版本（供 --version 与将来发布检查使用）
export const VERSION = '0.1.0';