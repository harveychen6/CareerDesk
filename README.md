# CareerDesk

本地运行的岗位简历工作台。把项目说明、周报或旧简历中的材料整理成用户确认的事实，再对照完整岗位 JD 生成可审阅、可编辑的岗位稿。材料、JD、候选建议和简历历史保存在本机 SQLite；只有主动使用 AI 功能时，相关文本才会发往配置的模型服务。

界面是中文。许可证是 MIT。

## 启动

需要 Node.js 20。

复制 `.env.example` 为 `.env.local`，然后执行：

```bash
npm install
npm run dev
```

浏览器打开 http://localhost:3000 。第一次启动是空库，可以在项目页导入虚构示例。

Windows 上如果 `better-sqlite3` 编译失败，先安装 Visual Studio Build Tools 的“使用 C++ 的桌面开发”，再重新执行 `npm install`。

## 模型

默认对接 DeepSeek 的 OpenAI 兼容接口。在 `.env.local` 中填写：

```bash
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_API_KEY=你的 DeepSeek 密钥
OPENAI_MODEL=deepseek-chat
```

`OPENAI_BASE_URL` 可以写成 `https://api.deepseek.com` 或 `https://api.deepseek.com/v1`。未填写 `OPENAI_MODEL` 时使用 `deepseek-chat`。`deepseek-chat` 会要求模型返回 JSON；`deepseek-reasoner` 不使用 JSON 模式。

其他兼容 OpenAI Chat Completions 的服务，改这三项即可。不填写密钥时，材料保存、看板、手工编辑、Markdown 导出和 PDF 打印仍然可用。AI 材料整理、JD 分析、岗位稿生成和合并候选句会提示未配置模型。

`AI_PROVIDER=fake` 使用本地假模型，不访问网络，只适合开发和测试。

## 岗位定制简历

1. 在岗位页保存公司、岗位名和完整 JD，保存本身不调用模型。
2. 选择已有项目，或新建一段经历，粘贴纯文本材料；已有项目事实也可以显式导入。
3. 提取候选事实，查看原文，修改并确认这条事实的状态。未确认内容不会用于生成；确认表示用户认可材料，不是独立真实性认证。
4. 选择确认事实，分析 JD 的职责、必要条件和优先条件。材料未说明不代表用户没有相关能力，可以继续补充材料或明确确认没有相关经历。
5. 生成岗位稿建议，在简历页查看原句、建议句和来源，逐条接受或拒绝。需要核对的改写须明确确认；被拦截的改写不能作为安全生成句接受。
6. 编辑当前稿并导出 Markdown 或经浏览器打印为 PDF。「保存已投快照」只保存历史内容，不会发送求职申请。

未保存修改的离开确认覆盖站内链接和页面卸载；使用浏览器前进/后退前请先保存，当前未提供完整的草稿恢复。页高提示是近似判断，最终分页仍需在打印预览核对。

本轮接收粘贴的纯文本，不自动扫描代码仓库，不抓取链接，不直接解析 PDF/Word。JD 最长 12,000 字符，单份材料最长 20,000 字符，单次分析的确认事实文本合计最长 30,000 字符；超限需要缩小输入，不静默截断。每个模型阶段共享 120 秒期限，结构或引用无效最多修复一次；取消或失败会保留已保存输入与原稿。

进行中的项目可以包含已经完成的真实子成果，但不能写成整个项目全量交付。护栏是保守的程序检查，无法证明全部语义准确性，也不承诺过筛概率。fake 模式只验证离线流程，不代表真实模型质量。

## 数据

数据库文件在 `DATA_DIR`（默认 `./data`）下的 `careerdesk.sqlite`。侧栏可以导出或导入全量 JSON。

新的岗位稿保存独立修订，不随项目、母版或档案静默变化；已投快照可以按当时修订查看和导出。v2 全量 JSON 备份包含材料、事实、岗位分析、建议和历史，继续兼容导入 v1。升级通过迁移保留已有投递版手工改写，不需要删库。

已有数据库需要升级时，会先在 `DATA_DIR/backups` 生成一致的 `pre-upgrade-*.sqlite` 副本；备份失败则停止升级。新库和无需升级的库跳过此步。

旧关键词匹配分及其规则仍保留用于兼容历史数据，不作为新流程的岗位胜任度或过筛率。新流程展示 JD 要求与确认事实的对照。

## 测试

```bash
npm test
```

## 文档

- [产品总需求、技术方案与实施进度](docs/requirements/product.md)
- [开源交付需求](docs/requirements/delivery.md)
- [技术方案](docs/careerdesk-mvp-design.md)
- [轻量服务器部署](docs/deploy-lighthouse.md)
- [更新记录](CHANGELOG.md)
