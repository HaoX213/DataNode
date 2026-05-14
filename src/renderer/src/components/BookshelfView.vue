<script setup lang="ts">
import { Collection, Delete, Document, EditPen, FolderAdd, Plus, Reading, Upload } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, ref, watch } from 'vue'
import KnowledgeGraphCanvas from './KnowledgeGraphCanvas.vue'
import type { ItemRow, NotebookRow } from '../../../preload/index'

const emit = defineEmits<{
  (e: 'open-node-detail', nodeId: number): void
  (e: 'new-note', payload: { notebookId: number }): void
  (e: 'edit-note', payload: { id: number; notebookId: number }): void
}>()

const shelfTab = ref<'library' | 'graph'>('library')
const tree = ref<NotebookRow[]>([])
const selectedNotebookId = ref<number | null>(null)
const items = ref<ItemRow[]>([])
const searchQuery = ref('')
const sortKey = ref<'created_desc' | 'title_asc'>('created_desc')
const graphCanvasRef = ref<InstanceType<typeof KnowledgeGraphCanvas> | null>(null)
const graphTypeFilters = ref<string[]>([])
const graphTagFilters = ref<string[]>([])

const graphRepulsion = ref(650)
const graphEdgeLength = ref(150)

const filteredItems = computed(() => {
  let list = items.value
  const q = searchQuery.value.trim().toLowerCase()
  if (q) {
    list = list.filter(
      (it) =>
        (it.title || '').toLowerCase().includes(q) ||
        (it.content_text || '').toLowerCase().includes(q) ||
        (it.source_file_path || '').toLowerCase().includes(q)
    )
  }
  const sorted = [...list]
  if (sortKey.value === 'title_asc') {
    sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
  } else {
    sorted.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  }
  return sorted
})

const treeProps = { label: 'name', children: 'children' } as const

type TreeNode = NotebookRow & { children?: TreeNode[] }

const treeData = computed<TreeNode[]>(() => {
  const rows = tree.value
  const byParent = new Map<number | null, NotebookRow[]>()
  for (const r of rows) {
    const p = r.parent_id ?? null
    if (!byParent.has(p)) byParent.set(p, [])
    byParent.get(p)!.push(r)
  }
  function build(pid: number | null): TreeNode[] {
    return (byParent.get(pid) ?? []).map((n) => ({
      ...n,
      children: build(n.id).length ? build(n.id) : undefined
    }))
  }
  return build(null)
})

async function loadTree(selectFirst = false): Promise<void> {
  const r = await window.api.listBookshelfTree()
  if (!r.success) {
    ElMessage.warning((r as { message?: string }).message || '加载文件夹失败')
    return
  }
  tree.value = r.data ?? []
  if (selectFirst || selectedNotebookId.value == null) {
    const first = tree.value[0]?.id ?? null
    selectedNotebookId.value = first
  }
}

async function loadItems(): Promise<void> {
  const nid = selectedNotebookId.value
  if (nid == null) {
    items.value = []
    return
  }
  const r = await window.api.listBookshelfItems(nid)
  if (!r.success) {
    items.value = []
    return
  }
  items.value = r.data ?? []
}

async function createFolder(): Promise<void> {
  const parentId = selectedNotebookId.value
  const res = await ElMessageBox.prompt('文件夹名称', '新建文件夹', {
    confirmButtonText: '创建',
    cancelButtonText: '取消',
    inputValue: '新建文件夹'
  }).catch(() => null)
  if (!res) return
  const r = await window.api.createBookshelfFolder(res.value.trim() || '新建文件夹', parentId ?? undefined)
  if (!r.success) {
    ElMessage.warning((r as { message?: string }).message || '创建失败')
    return
  }
  await loadTree(false)
}

async function renameFolder(data: NotebookRow): Promise<void> {
  const res = await ElMessageBox.prompt('新名称', '重命名', {
    confirmButtonText: '保存',
    inputValue: data.name
  }).catch(() => null)
  if (!res) return
  const r = await window.api.renameBookshelfFolder(data.id, res.value.trim())
  if (!r.success) {
    ElMessage.warning((r as { message?: string }).message || '重命名失败')
    return
  }
  await loadTree(false)
}

async function removeFolder(data: NotebookRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除文件夹「${data.name}」？（仅删除书柜内未绑定项目的条目）`, '删除', {
      type: 'warning'
    })
  } catch {
    return
  }
  const r = await window.api.deleteBookshelfFolder(data.id)
  if (!r.success) {
    ElMessage.warning((r as { message?: string }).message || '删除失败')
    return
  }
  selectedNotebookId.value = null
  await loadTree(true)
}

function onTreeSelect(node: NotebookRow): void {
  selectedNotebookId.value = node.id
}

function newNote(): void {
  const nid = selectedNotebookId.value
  if (nid == null) {
    ElMessage.warning('请先选择文件夹')
    return
  }
  emit('new-note', { notebookId: nid })
}

async function importDocument(): Promise<void> {
  const nid = selectedNotebookId.value
  if (nid == null) {
    ElMessage.warning('请先选择文件夹')
    return
  }
  const picked = await window.api.pickImportFile()
  if (!picked.success || !picked.filePath) {
    if (picked.message) ElMessage.info(picked.message)
    return
  }
  const r = await window.api.importFileIntoBookshelf(nid, picked.filePath)
  if (!r.success) {
    ElMessage.warning(r.message)
    return
  }
  ElMessage.success(r.message)
  await loadItems()
  await graphCanvasRef.value?.refresh()
}

function openItem(it: ItemRow): void {
  if (it.type === 'note') {
    const nb = selectedNotebookId.value
    if (nb == null) return
    emit('edit-note', { id: it.id, notebookId: nb })
    return
  }
  const path = it.source_file_path?.trim()
  if (path) void window.api.openPathWithShell(path)
}

function cardTitle(it: ItemRow): string {
  if (it.title?.trim()) return it.title
  if (it.source_file_path) return it.source_file_path.split(/[/\\]/).pop() || '文件'
  return `${it.type} #${it.id}`
}

async function onLayoutSave(positions: Array<{ id: number; x: number; y: number }>): Promise<void> {
  await window.api.updateNodePositions(positions)
}

watch(selectedNotebookId, () => {
  void loadItems()
})

watch(shelfTab, (t) => {
  if (t === 'graph') {
    void graphCanvasRef.value?.refresh()
  }
})

onMounted(() => {
  void loadTree(true).then(() => loadItems())
})

defineExpose({ refreshLibrary: async () => {
  await loadTree(false)
  await loadItems()
  await graphCanvasRef.value?.refresh()
} })
</script>

<template>
  <div class="bookshelf-root">
    <div class="bookshelf-top-tabs">
      <el-radio-group v-model="shelfTab" size="small">
        <el-radio-button value="library">资料</el-radio-button>
        <el-radio-button value="graph">知识图谱</el-radio-button>
      </el-radio-group>
    </div>

    <div v-show="shelfTab === 'library'" class="bookshelf-body">
      <aside class="bookshelf-aside">
        <div class="aside-actions">
          <el-button type="primary" size="small" :icon="FolderAdd" @click="createFolder">新建文件夹</el-button>
        </div>
        <el-scrollbar class="tree-wrap">
          <el-tree
            v-if="treeData.length"
            :data="treeData"
            :props="treeProps"
            node-key="id"
            highlight-current
            default-expand-all
            @node-click="onTreeSelect"
          >
            <template #default="{ data }">
              <span class="tree-node-row">
                <span class="tree-node-label">{{ data.name }}</span>
                <span class="tree-node-actions">
                  <el-button text circle size="small" :icon="EditPen" @click.stop="renameFolder(data)" />
                  <el-button text circle size="small" type="danger" :icon="Delete" @click.stop="removeFolder(data)" />
                </span>
              </span>
            </template>
          </el-tree>
          <el-empty v-else description="尚无文件夹" :image-size="64" />
        </el-scrollbar>
      </aside>

      <main class="bookshelf-main">
        <header class="bookshelf-toolbar">
          <el-button type="primary" :icon="Plus" :disabled="selectedNotebookId == null" @click="newNote">
            新建笔记
          </el-button>
          <el-button :icon="Upload" :disabled="selectedNotebookId == null" @click="importDocument">导入文档</el-button>
          <el-input
            v-model="searchQuery"
            placeholder="搜索标题 / 正文 / 路径"
            clearable
            class="shelf-search"
          />
          <el-select v-model="sortKey" style="width: 140px" size="small">
            <el-option label="最新优先" value="created_desc" />
            <el-option label="标题 A-Z" value="title_asc" />
          </el-select>
        </header>

        <el-scrollbar class="card-scroll">
          <div v-if="!selectedNotebookId" class="empty-select">
            <el-empty description="请选择左侧文件夹" />
          </div>
          <div v-else class="card-grid">
            <el-card
              v-for="it in filteredItems"
              :key="it.id"
              class="shelf-card"
              shadow="hover"
              @click="openItem(it)"
            >
              <div class="shelf-card-head">
                <el-icon v-if="it.type === 'note'" class="shelf-card-icon"><Reading /></el-icon>
                <el-icon v-else-if="it.type === 'file'" class="shelf-card-icon"><Document /></el-icon>
                <el-icon v-else class="shelf-card-icon"><Collection /></el-icon>
                <span class="shelf-card-title">{{ cardTitle(it) }}</span>
              </div>
              <div class="shelf-card-meta">{{ it.type }} · {{ it.created_at?.slice(0, 16) }}</div>
              <p v-if="it.type === 'note'" class="shelf-card-snippet">{{ (it.content_text || '').replace(/<[^>]+>/g, '').slice(0, 120) }}</p>
            </el-card>
            <el-empty v-if="!filteredItems.length" description="该文件夹暂无条目" />
          </div>
        </el-scrollbar>
      </main>
    </div>

    <div v-show="shelfTab === 'graph'" class="bookshelf-graph-pane">
      <div class="graph-toolbar">
        <span class="graph-hint">展示书柜中未绑定项目的笔记与文档及其关联关系</span>
      </div>
      <KnowledgeGraphCanvas
        ref="graphCanvasRef"
        :bookshelf-only="true"
        :type-filters="graphTypeFilters"
        :tag-filters="graphTagFilters"
        :repulsion="graphRepulsion"
        :edge-length="graphEdgeLength"
        @node-click="emit('open-node-detail', $event)"
        @layout-save="onLayoutSave"
      />
    </div>
  </div>
</template>

<style scoped>
.bookshelf-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #f8fafc;
}
.bookshelf-top-tabs {
  padding: 10px 16px 0;
  border-bottom: 1px solid #e2e8f0;
  background: #fff;
}
.bookshelf-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.bookshelf-aside {
  width: 260px;
  border-right: 1px solid #e2e8f0;
  background: #fff;
  display: flex;
  flex-direction: column;
}
.aside-actions {
  padding: 10px;
}
.tree-wrap {
  flex: 1;
  padding: 0 8px 12px;
}
.tree-node-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}
.tree-node-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tree-node-actions {
  display: flex;
  opacity: 0;
  transition: opacity 0.15s;
}
.tree-node-row:hover .tree-node-actions {
  opacity: 1;
}
.bookshelf-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.bookshelf-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 12px 16px;
  background: #fff;
  border-bottom: 1px solid #e2e8f0;
}
.shelf-search {
  flex: 1;
  min-width: 200px;
  max-width: 360px;
}
.card-scroll {
  flex: 1;
  padding: 16px;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}
.shelf-card {
  cursor: pointer;
  border-radius: 12px;
}
.shelf-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #0f172a;
}
.shelf-card-icon {
  font-size: 20px;
  color: #64748b;
}
.shelf-card-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shelf-card-meta {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 6px;
}
.shelf-card-snippet {
  margin: 8px 0 0;
  font-size: 13px;
  color: #64748b;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.empty-select {
  padding: 48px;
}
.bookshelf-graph-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #fff;
}
.graph-toolbar {
  padding: 8px 16px;
  border-bottom: 1px solid #e2e8f0;
  font-size: 13px;
  color: #64748b;
}
.graph-hint {
  display: inline-block;
}
.bookshelf-graph-pane :deep(.kg-canvas) {
  flex: 1;
  min-height: 480px;
}
</style>
