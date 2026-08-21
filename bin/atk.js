#!/usr/bin/env node
// bin/atk.js —— atk CLI 进程入口 by AI.Coding
//
// 转交 lib/cli 执行并把退出码写回进程；被 npm bin 软链调用。
// EPIPE 守卫：下游管道提前关闭（如 `atk status --json | grep -q x`）时以 0 退出而非抛未捕获异常。

import { run } from '../lib/cli/index.js';

// 忽略 stdout/stderr 的 EPIPE（管道下游提前退出属正常使用方式）
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

// 顶层 await：等待命令完成后以退出码收尾，避免异步错误被吞
const code = await run(process.argv.slice(2));
process.exitCode = code;