globalThis.YUEQIAN_EXTERNAL_CATALOG = {
  "schemaVersion": 2,
  "sources": [
    {
      "id": "microsoft-genai",
      "publisher": "Microsoft",
      "repository": "microsoft/generative-ai-for-beginners",
      "branch": "main",
      "licensePath": "LICENSE"
    },
    {
      "id": "microsoft-agents",
      "publisher": "Microsoft",
      "repository": "microsoft/ai-agents-for-beginners",
      "branch": "main",
      "licensePath": "LICENSE"
    },
    {
      "id": "didilili-agents",
      "publisher": "didilili",
      "repository": "didilili/ai-agents-from-zero",
      "branch": "main",
      "licensePath": "LICENSE"
    },
    {
      "id": "eosphoros-text2sql",
      "publisher": "Eosphoros AI",
      "repository": "eosphoros-ai/Awesome-Text2SQL",
      "branch": "main",
      "licensePath": "LICENSE"
    }
  ],
  "articles": [
    { "id": "ms-introduction", "title": "生成式 AI 与大型语言模型入门", "sourceID": "microsoft-genai", "path": "translations/zh-CN/01-introduction-to-genai/README.md", "lessonIDs": ["w1.0", "w1.2", "w3.2"] },
    { "id": "ms-models", "title": "探索和比较不同的大型语言模型", "sourceID": "microsoft-genai", "path": "translations/zh-CN/02-exploring-and-comparing-different-llms/README.md", "lessonIDs": ["w1.0", "w2.0", "w2.2", "ref.compete"] },
    { "id": "ms-responsible", "title": "负责任地使用生成式 AI", "sourceID": "microsoft-genai", "path": "translations/zh-CN/03-using-generative-ai-responsibly/README.md", "lessonIDs": ["w2.2", "w5.2", "p1.2"] },
    { "id": "ms-prompts", "title": "提示工程基础", "sourceID": "microsoft-genai", "path": "translations/zh-CN/04-prompt-engineering-fundamentals/README.md", "lessonIDs": ["w1.1", "w2.3", "w5.0", "p1.0"] },
    { "id": "ms-search", "title": "构建搜索应用", "sourceID": "microsoft-genai", "path": "translations/zh-CN/08-building-search-applications/README.md", "lessonIDs": ["w2.0", "w2.1", "w5.0", "p1.0", "ref.prep"] },
    { "id": "ms-functions", "title": "集成函数调用", "sourceID": "microsoft-genai", "path": "translations/zh-CN/11-integrating-with-function-calling/README.md", "lessonIDs": ["ref.agent", "w2.1", "w5.0", "p1.0"] },
    { "id": "ms-ux", "title": "为 AI 应用设计用户体验", "sourceID": "microsoft-genai", "path": "translations/zh-CN/12-designing-ux-for-ai-applications/README.md", "lessonIDs": ["w3.0", "w5.0", "w9.1", "p1.0", "p1.3"] },
    { "id": "ms-rag", "title": "RAG 与向量数据库", "sourceID": "microsoft-genai", "path": "translations/zh-CN/15-rag-and-vector-databases/README.md", "lessonIDs": ["w2.0", "w2.3", "w5.0", "w5.2", "p1.0", "ref.prep"] },
    { "id": "ms-agents", "title": "AI 代理", "sourceID": "microsoft-genai", "path": "translations/zh-CN/17-ai-agents/README.md", "lessonIDs": ["ref.agent", "w2.3", "w5.0", "p1.0"] },
    { "id": "ms-finetuning", "title": "微调大型语言模型", "sourceID": "microsoft-genai", "path": "translations/zh-CN/18-fine-tuning/README.md", "lessonIDs": ["w2.0", "w1.0"] },
    { "id": "ma-context-engineering", "title": "AI 智能体的上下文工程", "sourceID": "microsoft-agents", "path": "translations/zh-CN/12-context-engineering/README.md", "lessonIDs": ["ref.agent", "w2.1", "w2.3"] },
    { "id": "ma-agent-memory", "title": "AI 智能体的记忆", "sourceID": "microsoft-agents", "path": "translations/zh-CN/13-agent-memory/README.md", "lessonIDs": ["ref.agent", "w2.0", "w2.3"] },
    { "id": "ma-agentic-rag", "title": "Agentic RAG：智能体化检索增强", "sourceID": "microsoft-agents", "path": "translations/zh-CN/05-agentic-rag/README.md", "lessonIDs": ["ref.agent", "w2.0", "w2.1"] },
    { "id": "ma-multi-agent", "title": "多智能体设计模式", "sourceID": "microsoft-agents", "path": "translations/zh-CN/08-multi-agent/README.md", "lessonIDs": ["ref.agent", "w2.1"] },
    { "id": "ma-tool-use", "title": "工具使用：让 AI 智能体调用工具", "sourceID": "microsoft-agents", "path": "translations/zh-CN/04-tool-use/README.md", "lessonIDs": ["ref.agent", "w2.1", "p1.0"] },
    { "id": "dz-preface", "title": "电商问数：从业务问题到问数智能体", "sourceID": "didilili-agents", "path": "实战项目-电商问数/0-前言.md", "lessonIDs": ["w2.0", "w2.1"] },
    { "id": "dz-metadata", "title": "电商问数：元数据知识库总览与构建入口", "sourceID": "didilili-agents", "path": "实战项目-电商问数/7-元数据知识库总览与构建入口.md", "lessonIDs": ["w2.1"] },
    { "id": "dz-retrieval", "title": "电商问数：字段与指标检索能力构建", "sourceID": "didilili-agents", "path": "实战项目-电商问数/9-字段与指标检索能力构建.md", "lessonIDs": ["w2.1"] },
    { "id": "dz-context-filter", "title": "电商问数：SQL 生成前的信息过滤与补全", "sourceID": "didilili-agents", "path": "实战项目-电商问数/13-SQL生成前的信息过滤与补全.md", "lessonIDs": ["w2.1"] },
    { "id": "dz-sql-loop", "title": "电商问数：SQL 生成与执行闭环", "sourceID": "didilili-agents", "path": "实战项目-电商问数/14-SQL生成与执行闭环.md", "lessonIDs": ["w2.1"] },
    { "id": "at-text2sql", "title": "Awesome Text2SQL：NL2SQL 全景与资源地图", "sourceID": "eosphoros-text2sql", "path": "README.zh.md", "lessonIDs": ["w2.0", "w2.1"] }
  ]
};
