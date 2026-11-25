# T3–T4 后端交接

## HTTP 接口

| 方法和路径 | 请求和返回 |
| --- | --- |
| `POST /api/jobs` | 保存岗位后直接返回岗位信息。关键词分析仍可经原有显式入口运行。 |
| `PATCH /api/jobs/:id` | 接收 `company`、`role`、`city`、`salary`、`department`、`jdText` 的非空字段子集，返回更新后的岗位。岗位列表按更新时间从新到旧排。 |
| `GET /api/jobs/:id/tailoring` | 返回 `{analysis, proposal}`，两项可为 null。提案只来自当前分析，两项各带实时 `stale`。切换分析后旧提案不可接受，重新选中先前分析可恢复该分析下的提案。 |
| `POST /api/jobs/:id/tailoring/analyze` | 接收 `{factIds: string[], absentRequirementIds?: string[]}`，返回 `JobRequirementAnalysis`。允许空的事实选择用于拆解 JD。 |
| `POST /api/jobs/:id/tailoring/draft` | 接收 `{analysisId, expectedInputHash, expectedRevision, pageTarget: 1｜2}`，返回 `TailoringProposal`。没有简历容器时传 revision 0，已有工作稿时传它的 revision。成功时才创建缺失容器，并返回 `resumeId` 和实际 `baseRevision`。 |
| `POST /api/resumes/:id/proposals/:proposalId/apply` | 接收 `{expectedRevision, decisions: [{bulletId, action: 'accept'｜'reject', confirmRisk?: boolean}]}`，返回 `{resume, proposal}`。接受改写后用返回的 `proposal.baseRevision` 处理其余建议。 |

相关类型及严格 Zod 契约在 `src/domain/tailoring.ts`。分析返回 `id, jobId, inputHash, jdText, facts, requirements, assessments, questions, provider, stale`。返回的 JD 范围是原文的 UTF-16 下标，事实带原文摘录、对应范围、来源 hash 和项目快照。要求的 `alternatives` 用于显示 OR 分支。对照的状态为 `direct｜transferable｜not_shown｜confirmed_absent`。最后一项只能由用户明确提交此前同一份 JD 中待确认的要求 ID 派生。每轮最多三问，其 `projectId` 可为 null。

提案返回 `id, jobId, resumeId, analysisId, inputHash, baseRevision, pageTarget, projectOrder, bullets, insufficiency, provider, stale`。每条建议带 `id, projectId, text, originalText, factIds, requirementIds, sources, reason, risks, status`。空的 `originalText` 表示新增；有旧句时接受会替换冻结稿中已核对的那一行。一次请求可以混合多条接受和拒绝，全批事务处理；重复相同决定可读取当前状态，反向重放返回 409。接受采用建议顺序排列本提案中已接受的项目，并按原有相对顺序保留其他已选项目和未选句。纯拒绝更新提案状态，工作稿修订保持原值。

错误使用 `{error, code}`，主要为 400 输入或建议风险、404 记录不存在、409 输入或版本变化、413 字数超限、499 取消、503 模型未配置/鉴权/额度/上游/无效返回、504 超时。前端只需从服务响应读取脱敏文案和 code。

## 持久化与限制

- 仅使用显式确认的事实。用户选择计划阶段或无有效项目的事实会收到可操作的 400。阶段 unknown 可用于对照和补问，生成只接收 active 或 done 的确认事实。生成会以必要条件和职责证据优先，最多推荐 3 项/6 项，每项最多 3 条/4 条，分别对应 1 页/2 页。无可用证据时返回说明和空建议。
- 冻结完整 JD、选中事实、材料引用、项目元数据、模型身份及契约版本。建议再绑定当前分析、篇幅和生成时的工作稿修订。写入前复核原输入和工作稿，取消、失效或结构失败时保留原稿。相同有效输入复用成功结果；接受后显式重新生成使用更新的修订和缓存键。带阻止风险的建议可查看和拒绝。v2 备份校验冻结的要求、对照、证据凭据、岗位归属及输入 hash，逐项状态随备份往返。
- 实际配置的兼容模型执行 JSON 任务。结构和引用验证失败可以修复一次，两次请求共享 120 秒期限；鉴权和额度失败直接返回。三个模型阶段向请求和上游 fetch 传递取消信号。fake 模式仅做离线词语匹配和事实回显，返回 `provider: 'fake'` 供界面标注。
- 护栏核对引用、数字及单位、常见指标比较词和环境限定、明显技术术语及同一事项的职责和成果范围。数值或术语检查偏保守，模型语义拆解和改写仍需人工核对。标为 `confirm` 的建议需要逐条提交 `confirmRisk: true`。标为 `blocked` 的建议不能接受。手工编辑继续使用既有简历接口。
- 接受保存证据摘录和来源范围，正常手改和拒绝不会改写事实数据或其他岗位稿。已接受建议、历史导出及备份保留当时的来源；修改来源会使相关待处理提案失效。

## 模型与测试边界

- 对照任务输出 `{requirements, assessments, questions}`。模型要求使用 `{kind, text, segmentId, endSegmentId?, alternatives}`。对照项使用 `{requirementIndex, state, factIds, reason}`，其中 state 由模型返回的范围为 `direct｜transferable｜not_shown`。补问使用 `{requirementIndex, projectId, kind, question}`，kind 为 `experience｜scope｜ownership｜outcome｜metric`。
- 生成任务输出 `{bullets: [{projectId, text, factIds, requirementIds, reason, replaceId?}]}`。服务端根据冻结文本回填范围和风险，并生成公开 ID。模型不负责计算字符下标、选择修订号和决定用户审阅状态。
- 测试可向两个异步服务的第四参数传入 `StructuredRequest`，也就是 `(prompt: string, signal: AbortSignal) => Promise<unknown>`。业务层仍运行真实的结构验证、引用解析、事务及持久化代码。模型输出中需要推断的含义仍需使用真实配置模型另行验收。

## 验证

- 首轮新增测试捕获尚不存在的服务/护栏。后续行为回归复现了定制稿选择顺序颠倒、损坏的备份载荷被接受、已完成子项的 P95 表述被误判。
- `npm test` 通过 17 个文件、59 项测试。新增用例使用真实临时 SQLite 和注入模型或 fake，覆盖 OR/AND 和 JD 原文位置、确认事实、缓存、JD/事实变更、同素材不同岗位重点、风险、局部接受、旧句替换、重放及备份往返。测试保留了 Vite 的既有 CJS 弃用提示。
- `npm run typecheck` 通过。模型请求未访问实际提供商，浏览器工作流交给 T5 集成验证。

## 首轮审阅回归

- 当前分析限定生成和接受范围，返回的分析与提案对应。回归覆盖切换分析、重新激活缓存分析、生成期间切换，以及接受后从新修订显式生成。
- 备份回归覆盖无效要求引用、被篡改的来源摘录、错误 hash、跨岗位重新绑定和已撤销事实的历史往返。
- 数值和职责回归覆盖改变上界、删除测试环境、错用其他事项的完成状态、主导职责和全量范围。保留比较词和环境范围的改写仍可经用户确认。
- 审阅修复前新增测试出现 8 处预期失败。修复后 `npm test` 通过 17 个文件、68 项测试，`npm run typecheck` 通过。
