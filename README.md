<p align="center">
  <strong>ExamPilot 习概</strong><br/>
  《习近平新时代中国特色社会主义思想概论》期末智能复习系统
</p>

<p align="center">
  <em>Open-source study cockpit for the "Introduction to Xi Jinping Thought on Socialism with Chinese Characteristics for a New Era" final exam.</em>
</p>

---

ExamPilot 是一个开源、本地优先的期末复习应用：解析课程题库、按章节与题型组织训练、用间隔复习与错题再测提高覆盖率和正确率，并可选接入你自己的 LLM 网关做题目答疑与主观题参考评阅。

**题库不随仓库分发。** 公开仓库只包含一份自行编写的示例题库（17 题），用于演示与 CI；完整课程题库由你本地提供（见[题库导入](#题库导入)）。

## 特性

- **学习总览** — 覆盖率、正确率、掌握数、待复习量、近 7 天学习曲线、薄弱点排序
- **分章练习** — 按章节与题型组题，选题优先「到期复习 → 错题 → 未做」，避免只刷错题
- **专项训练** — 单选 / 多选 / 判断，可限定章节
- **主观题训练** — 简答与材料分析题，提供答题结构参考，可提交 AI 参考评阅
- **错题本** — 只收录真实答错过的题，支持按章节与状态筛选复刷
- **智能复习计划** — 间隔复习 + 错题再测 + 覆盖均衡合成当日任务
- **全真模拟考试** — 题量 / 题型 / 分值 / 时长 / 章节全可配置，倒计时自动交卷，逐题复盘
- **学习诊断** — 按章节 / 题型 / 活动三视图，高频错误 TOP15，下一步建议
- **练习历史** — 全部真实作答记录，可筛选、可导出 CSV
- **题库查阅** — 全文检索，含来源页码与数据校验标记
- **导入导出** — 学习数据 JSON 备份与恢复
- **AI 助手**（可选）— 题目答疑 + 主观题参考评阅，密钥仅存服务端

评分与统计严格基于真实作答：未作答不计为已练或已掌握；多选题必须选项集合完全一致；系统不生成预测分数。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器 → http://localhost:5173
npm run dev
```

此时应用使用内置示例题库，全部功能可用。

### 启用完整课程题库（本地）

```bash
# 将完整题库放到 data/bank.json（schema 与 data/sample-bank.json 相同）
npm run bank:local   # 校验并安装到本地构建
npm run dev          # 重新启动
```

> `data/bank.json`、`data/local-bank.json` 与 `src/lib/local-bank.generated.ts` 均被 `.gitignore` 忽略，**永不提交**。

### AI 助手（可选）

```bash
cp .env.example .env    # 填写 AI_BASE_URL / AI_API_KEY / AI_MODEL
npm run server          # 启动 AI 代理 → http://127.0.0.1:8787
```

也可以在应用内「AI 助手」页面填写，配置写入 `server/ai-config.json`（同样被忽略）。

协议：OpenAI 兼容 `POST {baseUrl}/chat/completions`。**不配置也能正常使用**——刷题、评分、本地记录完全不受影响。

## 测试

```bash
npm test              # 单元测试（评分 / 调度 / 统计 / 导入导出 / 题库完整性）
npm run test:ai       # AI 代理契约测试（模拟网关，无需真实 Key）
npm run test:browser  # 浏览器 E2E（需先 npm run dev）
npm run typecheck     # TypeScript 类型检查
npm run lint          # ESLint
npm run format:check  # Prettier
```

CI 在 PR 与 `main` 更新时自动执行以上全部检查（见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)），**不依赖私人题库或真实 API Key**。

## 构建

```bash
npm run build     # → dist/
npm run preview   # 本地预览生产构建
```

## 技术栈

React 18 · TypeScript · Vite · Dexie（IndexedDB）· Node 内置 http（AI 代理，零运行时依赖）

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 分层架构与数据流 |
| [docs/study-strategy.md](docs/study-strategy.md) | 复习算法、学习科学依据、参数与限制 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 提交规范、开发流程、如何测试 |
| [SECURITY.md](SECURITY.md) | 漏洞报告、密钥处理、AI 网关安全 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

## 项目结构

```
src/
  lib/          types, scoring, scheduler, analysis, io, ai, bank, meta   ← 纯逻辑，可单测
  db/           Dexie schema
  store/        StoreContext（统一学习记录）+ hash 路由
  components/   QuestionCard / QuestionRunner / AiQaPanel / ui / ErrorBoundary
  pages/        13 个页面
server/         AI 服务端代理（零依赖）
tests/          AI 契约测试 + 浏览器 E2E
tools/          题库解析与本地题库安装脚本
data/           sample-bank.json（公开）· bank.json（本地，忽略）
docs/           架构与复习策略文档
```

## 当前限制

- **考试要求未知**：模拟考试默认配置只是模板，请按真实考纲调整
- **主观题无标准答案**：题库仅提供题干；AI 评阅为参考评阅，非官方分数
- **数据仅在本地**：无云端同步，换设备请用「导入导出」备份恢复
- **AI 网关未内置**：需你自行提供 OpenAI 兼容网关

## 免责声明

本项目为学习辅助工具。客观题答案以你导入的题库为准；AI 生成内容仅供参考，不构成官方答案或分数。请遵守课程与考试的相关规定。

## License

[MIT](LICENSE) — 详见仓库根目录 `LICENSE` 文件。
