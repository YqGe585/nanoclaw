---
name: use-ducc-tool
description: 使用 ducc (百度 Claude Code CLI) 进行代码开发、重构、代码审查和多 Agent 协作任务。
---

# Ducc 开发助手

Ducc（百度 Claude Code CLI）是百度内部的 Claude Code 命令行工具，用于代码开发、重构和审查。

## 前置条件

使用 ducc 前确保已通过 wrapper 配置：
- Wrapper 路径：`/home/PaddleAgent/nanoclaw/bin/ducc`
- 如未配置，先运行 `/use-ducc-tool` 完成初始化

## 基础用法

### 交互式模式（默认）

不加 `--print` 时，ducc 会启动交互式会话，你可以持续对话：

```bash
# 进入交互式会话
/home/PaddleAgent/nanoclaw/bin/ducc

# 指定目录进入交互式会话
cd /path/to/project && /home/PaddleAgent/nanoclaw/bin/ducc

# 指定模型进入交互式会话
/home/PaddleAgent/nanoclaw/bin/ducc --model "Claude Opus 4.6"

# 带初始提示进入交互式会话
/home/PaddleAgent/nanoclaw/bin/ducc --permission-mode bypassPermissions '分析这个项目的代码结构'
```

**交互式模式特点：**
- 支持多轮对话，ducc 会记住上下文
- 可以连续提问、修改需求
- 适合探索性工作和复杂任务分解
- 退出后可用 `--resume` 恢复会话

### 单行命令模式（推荐用于自动化）

添加 `--print` 参数，ducc 执行完即退出：

```bash
# 基本格式
/home/PaddleAgent/nanoclaw/bin/ducc --permission-mode bypassPermissions --print '你的提示'

# 示例：代码审查
/home/PaddleAgent/nanoclaw/bin/ducc --permission-mode bypassPermissions --print '审查 src/index.ts 的代码质量，检查潜在bug和优化点'

# 示例：代码重构
/home/PaddleAgent/nanoclaw/bin/ducc --permission-mode bypassPermissions --print '将 src/utils.ts 中的回调函数重构为 async/await'

# 示例：添加功能
/home/PaddleAgent/nanoclaw/bin/ducc --permission-mode bypassPermissions --print '给 User 类添加 email 验证方法'
```

### 指定目录

```bash
# 在特定目录下执行
cd /path/to/project && /home/PaddleAgent/nanoclaw/bin/ducc --permission-mode bypassPermissions --print '分析当前目录的代码结构'
```

### 切换模型

使用 `--model` 参数指定 ducc 使用的模型：

```bash
# 基本格式（模型名包含空格需加引号）
/home/PaddleAgent/nanoclaw/bin/ducc --model "Claude Opus 4.6" --permission-mode bypassPermissions --print '你的提示'

# 示例：使用 Claude Opus 4.6 进行复杂架构设计
/home/PaddleAgent/nanoclaw/bin/ducc --model "Claude Opus 4.6" --permission-mode bypassPermissions --print '设计一个微服务架构'

# 示例：使用轻量级模型进行简单任务
/home/PaddleAgent/nanoclaw/bin/ducc --model "Claude Haiku 4.5" --permission-mode bypassPermissions --print '给变量起个更好的名字'
```

**支持的模型列表：**

| 模型 | 适用场景 |
|------|----------|
| Claude Opus 4.6 | 复杂任务、架构设计、深度分析 |
| Claude Opus 4.5 | 复杂任务、代码生成 |
| Claude Sonnet 4.6 | 平衡性能与质量 |
| Claude Haiku 4.5 | 快速响应、简单任务 |
| MiniMax-M2.5 | 中文场景优化 |
| GLM-5 | 多语言混合场景 |
| Kimi-K2.5 | 长文本处理 |

## Agent Team 模式（实验性）

使用 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 启用多 Agent 协作。

### 创建 Agent Team

在 prompt 中描述团队结构和任务分配：

```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 /home/PaddleAgent/nanoclaw/bin/ducc --permission-mode bypassPermissions --print '
创建一个开发团队来完成以下任务：

**团队结构：**
1. **feature-developer**（功能开发）
   - 职责：实现具体功能
   - 输出：完成代码编写并通过测试

2. **test-writer**（测试工程师）
   - 职责：编写单元测试和集成测试
   - 输出：测试覆盖率达到80%以上

**任务：** 为 XX 模块添加 YY 功能

**工作流程：**
1. team-lead 分析需求并分配任务
2. feature-developer 和 test-writer 并行工作
3. team-lead 审查代码和测试
4. 完成后报告结果'
```

### 适用场景

| 场景 | 建议模式 |
|------|----------|
| 简单代码修改 | 单行命令 |
| 复杂功能开发 | Agent Team |
| 代码重构 | Agent Team（重构 + 测试）|
| 代码审查 | 单行命令 |
| 多文件协调修改 | Agent Team |

## 常用开发任务模板

### 代码审查
```bash
/home/PaddleAgent/nanoclaw/bin/ducc --permission-mode bypassPermissions --print '
审查 <文件路径>，关注：
1. 潜在的bug和安全问题
2. 代码可读性和维护性
3. 性能优化机会
4. 是否符合最佳实践
输出审查报告。'
```

### 重构代码
```bash
/home/PaddleAgent/nanoclaw/bin/ducc --permission-mode bypassPermissions --print '
重构 <文件路径>：
1. 提取重复代码为通用函数
2. 优化变量和函数命名
3. 简化复杂逻辑
4. 保持原有功能不变
5. 确保重构后代码可运行'
```

### 添加测试
```bash
/home/PaddleAgent/nanoclaw/bin/ducc --permission-mode bypassPermissions --print '
为 <文件路径> 编写单元测试：
1. 覆盖主要功能路径
2. 包含边界情况测试
3. 使用 jest/vitest 框架
4. 测试文件保存到 __tests__/ 目录
5. 确保所有测试通过'
```

### 调试问题
```bash
/home/PaddleAgent/nanoclaw/bin/ducc --permission-mode bypassPermissions --print '
分析 <文件路径> 中的问题：
错误信息：<错误描述>
1. 定位根本原因
2. 提供修复方案
3. 验证修复后问题已解决'
```

## 注意事项

1. **超时处理**：复杂任务可能需要设置较长超时（默认 120 秒可能不够）
2. **工作目录**：始终在目标项目目录下执行 ducc
3. **权限模式**：自动化脚本使用 `bypassPermissions` 避免交互式确认；交互式模式可不用此参数
4. **输出重定向**：需要捕获输出时可重定向到文件（仅适用于 `--print` 模式）
5. **会话恢复**：交互式模式退出后，可用 `--resume` 或 `-c` 继续之前的会话

## 故障排除

### "failed to read user login info"
- 检查 wrapper 是否配置：`ls -la /home/PaddleAgent/nanoclaw/bin/ducc`
- 确认登录凭证存在：`ls -la /root/.comate/login`

### Agent Team 无响应
- Agent Team 模式为实验性功能，可能不稳定
- 遇到问题时改用单行命令模式分别执行
