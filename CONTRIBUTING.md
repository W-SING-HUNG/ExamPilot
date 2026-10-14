# 贡献指南

感谢你愿意为 ExamPilot 习概 做出贡献。本项目坚持轻量化：只做有实际价值的工程，不搞形式主义。

## 开发环境

- Node.js 20+
- npm 10+
- （浏览器 E2E 测试需要本机 Chrome）

```bash
git clone <your-fork>
cd ExamPilot
npm install
npm run dev
```

## 分支模型

| 分支 | 用途 |
| --- | --- |
| `main` | 稳定分支，仅接受 PR 合入，禁止直接推送与强制推送 |
| `feat/*` | 新功能 |
| `fix/*` | 缺陷修复 |
| `refactor/*` | 不改变外部行为的重构 |
| `docs/*` | 文档变更 |
| `chore/*` | 构建 / 依赖 / 配置 |

```bash
git checkout -b feat/my-feature main
```

## 提交规范（Conventional Commits）

```
<type>(<scope>): <subject>

<body>

<footer>
```

`type`：`feat` | `fix` | `refactor` | `docs` | `test` | `chore` | `perf` | `build` | `ci`

示例：

```
feat(mock): 支持按章节范围组卷

- 组卷配置新增章节多选
- 复用同一套学习记录，不新建进度系统

Closes #12
```

## 提交流程

1. 从 `main` 切出分支
2. 完成修改，确保本地全部检查通过
3. 推送分支，创建 Pull Request 并填写模板
4. CI 全绿后由维护者合入

## 本地检查（提交前必跑）

```bash
npm run typecheck     # TypeScript 类型检查
npm run lint          # ESLint
npm run format:check  # Prettier 格式
npm test              # 单元测试（公开示例题库）
npm run test:ai       # AI 代理契约测试
npm run build         # 生产构建
```

浏览器 E2E（可选，需要 dev server）：

```bash
npm run dev &
npm run test:browser
```

## 代码约定

- **题库与代码分离**：完整课程题库（`data/bank.json`、`data/local-bank.json`、`src/lib/local-bank.generated.ts`）与原始 PDF **永不提交**。公开仓库只含 `data/sample-bank.json`。
- **不伪造数据**：不得编造题库答案、掌握率或预测成绩；主观题必须保留「无标准答案」标记。
- **不覆盖题库事实**：题目、选项、答案一旦入库不得改写，只能修正解析错误并在 CHANGELOG 说明。
- **密钥只进服务端**：任何 API Key 不得出现在前端代码、构建产物或提交历史中。
- **测试要真实**：不要把没跑过的测试写成 PASS；测试命令必须对应 `package.json` 中真实存在的脚本。

## 新增题库 schema 变更

若必须改动作数据结构，请：

1. 在 `src/lib/types.ts` 更新类型
2. 同步更新 `data/sample-bank.json` 与 `tools/bank-local.mjs` 的校验逻辑
3. 在 CHANGELOG 记录破坏性变更与迁移方式

## 报告问题

请使用 Issue 模板，附上复现步骤、期望行为与实际行为。涉及安全问题请见 [SECURITY.md](SECURITY.md)，不要公开提交细节。
