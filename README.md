# datanode

An Electron application with Vue and TypeScript

## AI 与知识存储说明

DataNode **不实现**「LLM Wiki」或独立向量库 RAG：当前迭代不使用向量索引做检索增强。

AI 所依据的内容来源包括：

1. **基础大模型**的通用知识（由你在设置中配置的模型提供）。
2. **当前对话**中的用户与助手消息（上下文窗口内）。
3. 通过 IPC 调用主进程 **统计引擎**，对 **本地 SQLite 中各项目的结构化行（excel_row 等）** 做的**实时汇总**（含单项目或全局 AI 下多项目合并摘要）；**不**把全量明细表塞进模型，而是以程序预计算的统计块为主。
4. **持久化在本地数据库**中的对话历史：项目 AI（按项目分支）与全局 AI（独立表及设置项，如当前分支、关联项目 ID 列表等）。

业务数据与对话记录均保存在本机数据库文件中（见首次启动时选择的数据目录）。

## 数据导入格式

- **结构化表格（推荐）**：**Excel**（`.xlsx` / `.xls`）、**CSV**、**JSON**（表格型对象数组）。导入后写入 SQLite 中的 `excel_row` 等记录，供统计仪表盘与 AI 统计摘要使用。
- **其他**：纯文本（`.txt`）、Word（`.docx`）等可在文件菜单中选择导入；部分格式需结合项目内 AI 解析或使用「应用 JSON 入库」，不属于一键表格导入。

## 书柜（v1.2）

- 启动后默认进入 **书柜**：左侧为文件夹树，中间为当前文件夹下的全局笔记与导入的文档（`project_id` 为空的条目）；**知识图谱**仅在书柜中展示上述全局条目之间的关联。
- **项目工作区**：点击左侧项目列表进入；包含「统计与洞察」「原始数据」「项目笔记」。项目内 **不再** 嵌入知识图谱画布。
- **导入到项目**：在项目中选择「文件 → 导入表格数据」时，可选择 **从本地电脑** 或 **从书柜**（已收录的 Excel / CSV / JSON）导入。

## 后续规划（自建 Notebook）

当前版本**不提供**类 Jupyter 的「自建 Notebook」（在应用内编写 Python 等代码做自定义分析）。该能力已列为后续迭代的重要方向；后续接入时可在主进程侧预留安全的运行时或与外部内核通信，而不改变现有「统计引擎 + 本地库」数据路径。

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
