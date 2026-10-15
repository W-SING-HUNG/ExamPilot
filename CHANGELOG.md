# 变更记录

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。当前处于 **Beta 阶段**：核心功能已实现并通过测试，但尚未经过大规模真实使用验证。

## [Unreleased] — v0.2.0 阶段 1：可靠性修复

针对独立源码审查确认的缺陷进行定向修复。未改动产品外观，未重设计复习算法。

### Fixed — 学习数据可靠性

- **备份恢复不完整**：`DataIO` 导入此前只写入 `records`，`history` / `mocks` / `aiReviews` / `settings` 被静默丢弃。现改为**同一 IndexedDB 事务内恢复全部五类数据**，任一步失败整体回滚。
- **静默丢弃无效数据**：导入现在先做完整校验（JSON、schema、四类集合的数组性与主键唯一性），并在导入前展示计划摘要；被丢弃的条目会逐条列出，不再悄然忽略。
- **无题库身份校验**：备份新增 `bankFingerprint`，导入时与当前题库比对，不一致会明确警告。
- **恢复策略不明确**：新增「替换 / 合并」两种显式策略，UI 上可选择并在结果中说明实际采用哪种。
- **模拟考试未作答被当作答错**：空白客观题此前计入已练、答错并进入错题本。现标记为独立的 `unanswered` 状态，`isCorrect = null`，**不写入学习记录、历史与错题本**。
- **分值混算**：模拟考试结果现在区分「客观题已判分得分 / 主观题未评分分值」，并明确声明部分得分率不代表完整试卷成绩。

### Fixed — 模拟考试

- **主观题非随机抽取**：`buildPaper()` 此前用 `slice(0, n)` 固定取前几道主观题，现改为与客观题一致的等概率随机抽取，并可在简答题与材料题之间随机。
- **题量不足时无限循环**：此前在主观题不足时会进入 `while (need > 0)` 死循环且可能重复出题。现改为**组卷前先校验各题型可用量**，不足时返回可解释错误（含具体缺口），不缩减题量、不重复、不卡死。
- **交卷过程失败无提示**：交卷改为一处集中处理并捕获持久化异常，失败时保留考试现场供重试，且不会重复累计学习数据。

### Fixed — AI 可靠性

- **伪造 0 分**：AI 返回无法解析的 JSON 或字段不完整时，此前会返回 `ok: true` 与 `score: 0`。现改为**明确失败**（`ok: false` + `code: BAD_GRADE_FORMAT` + 具体原因），并严格校验 `score` 类型与 0–100 范围、四个数组字段与 `structureNote`。
- **AI 评阅未持久化**：主观题 AI 评阅结果此前不落库。现保存原作答、provider、model、评阅时间与完整评阅结果，并在 UI 上确认「已保存」。

### Security

- AI 代理 CORS 由 `Access-Control-Allow-Origin: *` 收紧为**仅允许本地开发来源**，其他来源不返回 CORS 头。
- `/api/ai/config` 增加来源校验：远程网页无法改写代理配置（返回 403）。
- 新增测试断言 API Key 绝不出现在任何响应体中。

### Tests

- 新增真实 IndexedDB 往返测试（`fake-indexeddb`，独立数据库，不触碰用户数据）：导出 → 清空 → 导入 → 逐字段比对 records / history / mocks / aiReviews / settings，并验证事务失败后整体回滚。
- 新增组卷回归测试：随机性、无重复、题量不足报错、缺失题型不死循环、章节过滤。
- 新增模拟考试判分回归测试：未作答与答错区分、未作答不持久化、分值区分、多选严格集合。
- 新增 AI 契约失败路径测试：非 JSON、字段缺失、score 非数字、score 越界、CORS 允许/拒绝、配置来源限制、密钥不外泄。
- 新增浏览器 E2E：未作答不计错、分值区分展示、组卷不足报错、全量数据恢复、非法备份拒绝写入。

> 上述每个用例均针对一个已确认缺陷，且在修复前会失败、修复后通过。

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
- main CI（workflow `CI`，event `push`，head_sha `0974cd5`，3 个 Job 全部 success）：
  <https://github.com/W-SING-HUNG/ExamPilot/actions/runs/38677155419>

> 注 1：公开 CI 使用示例题库；1000 道本地完整题库的校验在本地单独执行，两者覆盖范围不同，未混为一谈。
>
> 注 2：Dependabot 会在同一 commit 上触发 `dynamic` event 的运行（workflow 名形如
> `npm_and_yarn in / for <pkg> - Update #...`，actor 为 `dependabot[bot]`）。
> 这类运行**不是**主分支 CI，引用发布证据时不得混用，核验规则见
> [CONTRIBUTING.md](CONTRIBUTING.md#发布证据核验规则)。

## 发布流程

1. 更新本文件
2. `npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:ai && npm run build`
3. 打 tag：`git tag -a v0.1.0-beta -m "v0.1.0-beta"`
4. 推送 tag 并在 GitHub 创建 Pre-release
5. 按 [CONTRIBUTING.md 发布证据核验规则](CONTRIBUTING.md#发布证据核验规则) 核实 CI 证据后再对外报告
