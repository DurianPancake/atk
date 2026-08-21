# atk — 技能集合管理工具（用户级安装/卸载）

`atk` 是一个独立、零运行时依赖的 CLI，做两件事：**技能集合的仓库管理** + **按 scope 模型把启用的集合安装/卸载到本机 AI 客户的用户级技能目录**。

- **集合（collection）** = git 仓库或本地目录，内容契约 `skills/<name>/SKILL.md`（可选 `atk.manifest.json` 声明依赖/共享资源）
- **scope 安装模型**：`scope` 只决定 add 时的默认值与自动安装行为——`global` 注册即装（`enabled=true`）；`scoped` 注册后默认停用（`enabled=false`，需手动 `enable` 后 `apply` 才装）
- **用户级唯一层解析**：所有 enabled 集合按 `priority` 归并，同名技能 = 高 priority 胜出（仅装胜出者）；`status` 报告被覆盖项
- **边界**：只操作**用户级**目录（无项目级安装/无项目声明 `.atk.json`/无分层解析）；不写入项目上下文（AGENTS.md 属独立方案）；不生产技能内容
- 配置为纯 JSON（`~/.config/atk/collections.json` + 用户级 `~/.config/atk/state.json`），跨机器可复制，`atk sync` 还原

## 安装

**手动安装**（推荐）：

```bash
npm install -g atk            # npm 发布后，任意目录
# 源码方式（在本仓库根目录执行）：
npm install -g .              # 或：git clone 本仓库后 npm install -g <仓库路径>
atk --version
```

要求 Node ≥ 18。atk 不依赖任何第三方包，也不读取任何其他工具的配置。

**与 ai-toolkit 集成（可选）**：在装有 ai-toolkit 的机器上执行 `node setup.js --install-atk`，可自动注册官方集合、迁移旧配置并托管（详见 ai-toolkit 仓库）。

## 快速上手

**第 1 步：注册集合**（git 地址或本地目录均可）

```bash
atk collection add ~/my-skills --name my-skills --scope global      # global：注册即装
atk collection add https://github.com/your/skills.git --name team-x # 缺省 scoped：需 enable 才装
```

> `~/.atk/personal/` 若存在会自动作为名为 `personal` 的 scoped 集合参与（隐式，不写注册表），也需要 enable 才装。

**第 2 步：查看**

```bash
atk collection list
atk status          # 纯只读：已注册集合 / 生效集 / 可启用 / 同名冲突 / 全量视图
atk status --json   # 供脚本/AI 使用；含 registered 全量视图（每个已注册集合 × 技能明细，无论是否启用）
```

**第 3 步：启用 / 停用（= 安装 / 卸载）**

```bash
atk collection enable team-x      # 标记启用（下次 apply 生效）
atk collection disable team-x     # 标记停用（apply 时按安全规则清理链接）
```

**第 4 步：应用**（真正写盘；enable/disable 后需要这一步才生效）

```bash
atk apply --dry-run   # 先预览将要创建的软链与清理项（零写入）
atk apply             # 正式应用：生效集软链到 5 个客户端的用户级目录
```

应用后回到你的 AI 客户端即可生效（详见「客户端矩阵」）。

## 统一管理（TUI，推荐日常使用）

安装了 ai-toolkit（`node setup.js --install-atk` 后，或在装有 ai-toolkit 的机器上）时，`node setup.js --skills` 是图形化统一管理入口，覆盖上述全部启停操作：

1. **编码规范**：单选 V5 / V8 / Comi（ai-toolkit 侧逻辑，atk 不管 bestPractices）；
2. **集合面板**：所有**已注册集合**（官方/个人/任意 scope，含停用集合）一键 enable/disable；个人库 `~/.atk/personal/` 也在此开关；行内标注 scope/技能数/目录缺失；
3. **技能面板**：Enter 时光标所在集合 → **自动聚焦该集合**的技能（过滤词 = 集合名，Backspace 清空看全量）；取消勾选 = 全局停用（与 `atk defaults disable` 同语义），保存后自动 `atk apply`。

级联关系：集合级开关 = `atk collection enable/disable`（生效=整集合安装/卸载）；技能级 = `atk defaults disable/enable`（生效=精确停用单个技能名）。非 TTY（CI/脚本/未安装 atk）自动降级为纯委托，无交互不卡住。

## 典型业务场景

**场景 1：官方基线 + 团队/个人集合**

```bash
atk collection add <官方仓库> --scope global --name official-skills   # 全员基线，注册即装
atk collection add <团队仓库> --scope scoped --name team-skills       # 按需 enable
atk collection add ~/my-skills --scope scoped --name personal         # 个人技能（~/.atk/personal/ 亦可自动识别）
atk collection enable team-skills && atk collection enable personal
atk status                                                             # 查看解析来源与冲突
```

**场景 2：同名技能接管（优先级控制）**

两个 enabled 集合都含 `coding` 时，高 `priority` 者胜出并安装；`status` 会报告被覆盖项。禁用高优先级集合后，`apply` 会把链接重指到新胜出者：

```bash
atk collection add A --scope global --priority 100   # A 的 coding 胜出
atk collection add B --scope global --priority 200   # B 的 coding 胜过 A
atk collection disable B && atk apply                # 链接重指回 A 的 coding
```

**场景 3：新成员/新机器一键还原**

```bash
npm install -g atk
cp ~/.config/atk/collections.json <新机对应位置>   # 纯 JSON，复制即还原注册表
atk sync                                          # git 集合自动克隆 + 应用，技能布局一键还原
```

**场景 4：团队技能持续更新自动生效**

```bash
atk sync    # fetch + ff-only 拉取全部 git 集合并重新应用；dirty 工作区自动跳过、断网用本地旧版兜底
```

## 命令一览

| 命令 | 说明 |
|------|------|
| `atk status [--json]` | 状态快照（纯只读；`--json` 供脚本/AI 使用，`registered` 字段为**全量视图**：每个已注册集合 × 技能明细 × 启停/scope，无论集合是否启用） |
| `atk apply [--dry-run]` | 两阶段应用:先规划校验（零写入），再执行（幂等、部分失败可收敛） |
| `atk sync [--no-apply]` | 拉取全部 git 集合（fetch + ff-only；dirty/detached 跳过）并重新应用 |
| `atk collection add <git-url\|路径> [--scope] [--name] [--priority] [--branch]` | 注册集合（git 型克隆到 `~/.atk/collections/<name>/`；global 注册即装，scoped 默认停用） |
| `atk collection remove/enable/disable/list/export` | 集合生命周期管理（启停支持 `--dry-run` 预览；enable=安装、disable=卸载） |
| `atk defaults disable\|enable <技能>` | **全局按名停用/启用**：在全部 enabled 集合归并后按技能名删除/恢复，与来源无关（官方与个人库同名技能会一并停用）；集合整体开关用 `atk collection enable/disable` |
| `atk validate collection <目录>` | 集合健康检查：结构/断链/必需依赖/未知 schema，按级别输出 |

## 客户端矩阵（仅用户级）

| 客户端 | 用户级目录 |
|--------|-----------|
| Claude Code | `~/.claude/skills` |
| OpenCode | `~/.config/opencode/skill` |
| CC Switch | `~/.cc-switch/skills` |
| Codex | `~/.agents/skills` |
| DSH | `~/.dsh/skills` |

同名技能按「高 priority 胜出」解析：每个目录只装解析胜出者的链接；atk 不承诺客户端去重（各客户端以自身加载行为为准）。

## 集合内容契约

```
my-skills/
├── skills/
│   ├── alpha/SKILL.md            # 技能：frontmatter 需含 name
│   └── beta/SKILL.md
└── atk.manifest.json             # 可选：依赖与共享资源声明
```

```json
{
  "sharedResources": [{ "name": "workflow", "path": "skills/WORKFLOW.md" }],
  "dependencies": { "review": ["skills/merge-review/SCORING.md"] }
}
```

- `dependencies` 缺失 = 必需依赖缺失 → apply 规划失败（零写入）
- `sharedResources` 缺失 = 可选 → 警告继续

## 安全

- 只删除 atk 自己创建的软链：state 记录 + `readlink` 词法判定（目标存在时 realpath 复核，断链可清理）；用户手放内容永不删除
- apply 两阶段：规划校验失败零写入；执行部分失败只记录已完成，再次 apply 收敛
- 注册表/state 写入：临时文件 + rename 原子替换
- sync 非交互（不等待凭据输入）、60s 超时、进程锁防并发

## 常见问题

- **scoped 集合 add 后没生效**：M3 起 scoped 注册是「停用」状态，需 `atk collection enable <name>` 再 `atk apply`。
- **想只停官方某个技能、保留个人库同名技能**：停用是全局按名的（`defaults disable` 会连 personal 版一起停，`collection disable` 会整集合停）。同名时由 priority 控制谁生效：个人库 priority 高于官方（默认 p2 > p1），官方版自动让位，无需停用。
- **技能被上游删除成断链**：disable/remove 该集合时按词法判定清理，不会因链接失效卡死。
- **同名技能装哪个**：所有 enabled 集合按 priority 归并，高 priority 者胜出（只装胜出者）；`atk status` 可查看解析来源与冲突。