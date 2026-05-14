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
