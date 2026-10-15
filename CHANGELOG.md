# 变更记录

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。当前处于 **Beta 阶段**：核心功能已实现并通过测试，但尚未经过大规模真实使用验证。

## [0.1.0-beta] - 2026-10-15

首个公开 Beta 版本。

### Added

- 题库解析管线 `tools/parse_bank.py`：从课程 PDF 抽取结构化题库，保留原题干、选项、答案、章节与题号，并记录 PDF 页码来源
- 题库绑定校验：题干—选项—答案严格校验；主观题标记「无官方标准答案」，不伪造答案
- 学习系统 13 个页面：学习总览、分章练习、专项训练、主观题训练、错题本、智能复习计划、全真模拟考试、学习诊断、练习历史、题库查阅、导入导出、AI 助手、偏好设置
- 评分引擎：单选严格匹配、多选**集合完全一致**判定、判断题布尔判定；未作答不计为已练或已掌握
- 复习调度：间隔复习（1→2→4 天）+ 错题再测 + 覆盖均衡选题，避免只刷错题
- 全真模拟：题量 / 题型 / 分值 / 时长 / 章节可配置，倒计时自动交卷，逐题复盘；与练习共用同一套学习记录
- AI 服务端代理 `server/index.mjs`（零运行时依赖）：接入 OpenAI 兼容网关，提供题目答疑与主观题参考评阅；密钥仅存服务端
- 深浅色主题、移动端自适应、错误边界
- 公开示例题库 `data/sample-bank.json`：17 道自行编写的演示题（含全部 5 种题型），供公开演示与 CI 使用
- 本地题库安装 `npm run bank:local`：完整课程题库仅存本地，全部相关文件 git-ignored
- 测试：单元测试（评分 / 调度 / 统计 / 导入导出 / 题库完整性）、AI 代理契约测试（模拟网关）、浏览器 E2E
- CI：`.github/workflows/ci.yml`，在 PR 与 main 上执行类型检查 / Lint / 格式 / 单元测试 / AI 契约测试 / 生产构建 / 浏览器 E2E
- 文档：README、CONTRIBUTING、SECURITY、docs/architecture、docs/study-strategy；Issue 与 PR 模板；`.env.example`

### Changed

- 示例题库 4 道题（S003 / S004 / M004 / Q002）改为完全自行编写，避免与课程题库表述重合

### Known limitations（Beta 阶段已知限制）

- 正式考试的题型配比、题量、分值与时长未知；模拟考试默认值只是模板
- 简答与材料题在题库中只有题干、没有标准答案；AI 评阅仅为参考评阅，非官方分数
- 学习数据仅存浏览器本地，无云端同步；换设备需用「导入导出」备份恢复
- AI 网关需用户自行提供，项目不内置任何凭据
- 浏览器 E2E 依赖本机 Chrome（CI 使用 google-chrome-stable）

### 测试状态

- 单元测试：公开示例题库下 30 项通过；本地完整题库下额外 6 项校验通过
- AI 代理契约测试：6 项通过（含未配置 / 网关错误 / 非 JSON / 超时）
- 浏览器 E2E：公开示例题库下 14 项通过
- 以上结果在干净检出环境（无私人题库、无真实 API Key）复现

> 注：公开 CI 使用示例题库；1000 道本地完整题库的校验在本地单独执行，两者覆盖范围不同，未混为一谈。

## 发布流程

1. 更新本文件
2. `npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:ai && npm run build`
3. 打 tag：`git tag -a v0.1.0-beta -m "v0.1.0-beta"`
4. 推送 tag 并在 GitHub 创建 Pre-release
