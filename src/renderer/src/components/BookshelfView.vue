<script setup lang="ts">
import { Collection, Delete, Document, EditPen, FolderAdd, FolderOpened, Picture, Plus, Reading, Upload } from '@element-plus/icons-vue'
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

const PRESET_COVERS: { key: string; label: string; css: string }[] = [
  { key: 'dawn', label: '粉紫', css: 'linear-gradient(145deg, #fce7f3 0%, #e9d5ff 100%)' },
  { key: 'sea', label: '海天', css: 'linear-gradient(145deg, #e0f2fe 0%, #ddd6fe 100%)' },
  { key: 'forest', label: '森绿', css: 'linear-gradient(145deg, #d1fae5 0%, #fef3c7 100%)' },
  { key: 'night', label: '夜读', css: 'linear-gradient(145deg, #1e293b 0%, #334155 100%)' },
  { key: 'paper', label: '纸纹', css: 'linear-gradient(145deg, #fffef7 0%, #f1f5f9 100%)' }
]

function parseDnCover(json: string): string | null {
  try {
    const o = JSON.parse(json || '{}') as { dnCover?: string }
    return typeof o.dnCover === 'string' && o.dnCover.trim() ? o.dnCover.trim() : null
  } catch {
    return null
  }
}

function noteCoverStyle(contentJson: string): Record<string, string> {
  const c = parseDnCover(contentJson)
  if (!c) return { background: PRESET_COVERS[4].css }
  if (c.startsWith('preset:')) {
    const key = c.slice('preset:'.length)
    const hit = PRESET_COVERS.find((p) => p.key === key)
    return { background: hit?.css ?? PRESET_COVERS[0].css }
  }
  return {
    backgroundImage: `url(${c})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center'
  }
}

const childFolderNodes = computed<TreeNode[]>(() => {
  const sel = selectedNotebookId.value
  const roots = treeData.value
  if (sel == null) return []
  function find(nodes: TreeNode[], id: number): TreeNode | null {
    for (const n of nodes) {
      if (n.id === id) return n
      if (n.children?.length) {
        const inChild = find(n.children, id)
        if (inChild) return inChild
      }
    }
    return null
  }
  const node = find(roots, sel)
  if (!node?.children?.length) return []
  return node.children
})

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
    inputPlaceholder: '请输入名称',
    inputValue: ''
  }).catch(() => null)
  if (!res) return
  const name = res.value.trim()
  if (!name) {
    ElMessage.warning('名称不能为空')
    return
  }
  const r = await window.api.createBookshelfFolder(name, parentId ?? undefined)
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

async function onCoverCommand(it: ItemRow, cmd: string): Promise<void> {
  if (it.type !== 'note') return
  if (cmd === 'clear') {
    const r = await window.api.patchNoteCover(it.id, null)
    if (!r.success) ElMessage.warning(r.message)
    else await loadItems()
    return
  }
  if (cmd.startsWith('preset:')) {
    const r = await window.api.patchNoteCover(it.id, cmd)
    if (!r.success) ElMessage.warning(r.message)
    else await loadItems()
    return
  }
  if (cmd === 'upload') {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = async () => {
        const url = String(reader.result || '')
        const r = await window.api.patchNoteCover(it.id, url)
        if (!r.success) ElMessage.warning(r.message)
        else await loadItems()
      }
      reader.readAsDataURL(file)
    }
    input.click()
  }
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
          <div v-else class="library-cards">
            <section v-if="childFolderNodes.length" class="folder-section">
              <div class="section-label">文件夹</div>
              <div class="folder-card-row">
                <button
                  v-for="fd in childFolderNodes"
                  :key="fd.id"
                  type="button"
                  class="folder-tile"
                  @click="onTreeSelect(fd)"
                >
                  <div class="folder-tile-icon">
                    <el-icon :size="28"><FolderOpened /></el-icon>
                  </div>
                  <div class="folder-tile-name">{{ fd.name }}</div>
                </button>
              </div>
            </section>

            <div class="section-label row-between">
              <span>笔记与文件</span>
            </div>
            <div class="card-grid">
              <div
                v-for="it in filteredItems"
                :key="it.id"
                class="shelf-card"
                :class="{ 'shelf-card--note': it.type === 'note' }"
                @click="openItem(it)"
              >
                <template v-if="it.type === 'note'">
                  <div class="note-cover" :style="noteCoverStyle(it.content_json)">
                    <el-dropdown trigger="click" @command="(c: string) => onCoverCommand(it, c)" @click.stop>
                      <el-button class="cover-edit-btn" circle size="small" :icon="Picture" />
                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item v-for="pr in PRESET_COVERS" :key="pr.key" :command="`preset:${pr.key}`">
                            封面 · {{ pr.label }}
                          </el-dropdown-item>
                          <el-dropdown-item command="upload">上传图片…</el-dropdown-item>
                          <el-dropdown-item command="clear" divided>恢复默认</el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                  </div>
                  <div class="shelf-card-body">
                    <div class="shelf-card-title-row">
                      <el-icon class="shelf-card-icon"><Reading /></el-icon>
                      <span class="shelf-card-title">{{ cardTitle(it) }}</span>
                    </div>
                    <div class="shelf-card-meta">创建 {{ it.created_at?.slice(0, 16) }}</div>
                    <p class="shelf-card-snippet">{{ (it.content_text || '').replace(/<[^>]+>/g, '').slice(0, 96) }}</p>
                  </div>
                </template>
                <template v-else>
                  <div class="shelf-card-body shelf-card-body--file">
                    <div class="shelf-card-title-row">
                      <el-icon v-if="it.type === 'file'" class="shelf-card-icon"><Document /></el-icon>
                      <el-icon v-else class="shelf-card-icon"><Collection /></el-icon>
                      <span class="shelf-card-title">{{ cardTitle(it) }}</span>
                    </div>
                    <div class="shelf-card-meta">{{ it.type }} · {{ it.created_at?.slice(0, 16) }}</div>
                  </div>
                </template>
              </div>
              <el-empty v-if="!filteredItems.length" description="该文件夹暂无条目" />
            </div>
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
.section-label {
  font-size: 12px;
  font-weight: 700;
  color: #64748b;
  letter-spacing: 0.02em;
  margin-bottom: 10px;
}
.row-between {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.library-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.folder-section {
  margin-bottom: 8px;
}
.folder-card-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.folder-tile {
  width: 112px;
  padding: 14px 10px;
  border-radius: 16px;
  border: 1px solid #e2e8f0;
  background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
  cursor: pointer;
  text-align: center;
  transition:
    box-shadow 0.15s,
    transform 0.15s;
}
.folder-tile:hover {
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
  transform: translateY(-2px);
}
.folder-tile-icon {
  color: #6366f1;
  margin-bottom: 8px;
}
.folder-tile-name {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}
.shelf-card {
  cursor: pointer;
  border-radius: 20px;
  border: 1px solid #e2e8f0;
  background: #fff;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
  transition:
    box-shadow 0.15s,
    transform 0.15s;
}
.shelf-card:hover {
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.1);
  transform: translateY(-2px);
}
.shelf-card--note {
  display: flex;
  flex-direction: column;
  padding: 0;
}
.note-cover {
  position: relative;
  height: 108px;
  border-radius: 20px 20px 0 0;
}
.cover-edit-btn {
  position: absolute;
  right: 8px;
  top: 8px;
  opacity: 0.92;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.shelf-card-body {
  padding: 12px 14px 14px;
}
.shelf-card-body--file {
  padding: 16px 14px;
}
.shelf-card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #0f172a;
}
.shelf-card-icon {
  font-size: 18px;
  color: #64748b;
  flex-shrink: 0;
}
.shelf-card-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}
.shelf-card-meta {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 6px;
}
.shelf-card-snippet {
  margin: 8px 0 0;
  font-size: 12px;
  color: #64748b;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
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
