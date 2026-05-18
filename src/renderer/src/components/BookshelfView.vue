<script setup lang="ts">
import { Collection, Delete, Document, EditPen, FolderAdd, FolderOpened, Operation, Picture, Plus, Reading, Upload } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { CheckboxValueType } from 'element-plus'
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
  if (sel == null) return roots
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

const notebookNameById = computed(() => {
  const m = new Map<number, string>()
  for (const r of tree.value) {
    m.set(r.id, r.name)
  }
  return m
})

function itemNotebookLabel(it: ItemRow): string {
  const nid = it.notebook_id
  if (nid == null) return ''
  return notebookNameById.value.get(nid) ?? `#${nid}`
}

function itemDateLine(it: ItemRow): string {
  const d = it.updated_at?.trim() || it.created_at || ''
  return d.slice(0, 16)
}

function defaultTargetNotebookId(): number | null {
  if (selectedNotebookId.value != null) return selectedNotebookId.value
  return tree.value[0]?.id ?? null
}
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

const shelfBulkManual = ref(false)
const shelfBulkSelected = ref<number[]>([])
const shelfBulkDeleting = ref(false)

const shelfBulkPickActive = computed(() => shelfBulkManual.value || shelfBulkSelected.value.length > 0)
const shelfBulkBarVisible = computed(() => shelfBulkSelected.value.length > 0)
const shelfSelectableIds = computed(() => filteredItems.value.map((i) => i.id))

const shelfBulkSelectAllChecked = computed(
  () =>
    shelfSelectableIds.value.length > 0 &&
    shelfSelectableIds.value.every((id) => shelfBulkSelected.value.includes(id))
)

const shelfBulkSelectAllIndeterminate = computed(() => {
  const n = shelfBulkSelected.value.length
  const all = shelfSelectableIds.value.length
  return n > 0 && n < all
})

watch(filteredItems, (list) => {
  const valid = new Set(list.map((i) => i.id))
  shelfBulkSelected.value = shelfBulkSelected.value.filter((id) => valid.has(id))
})

function toggleShelfBulkManual(): void {
  shelfBulkManual.value = !shelfBulkManual.value
}

function toggleShelfSelection(id: number): void {
  const s = new Set(shelfBulkSelected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  shelfBulkSelected.value = [...s]
  if (shelfBulkSelected.value.length > 0) shelfBulkManual.value = true
}

function onShelfCardClick(it: ItemRow, e: MouseEvent): void {
  if (shelfBulkPickActive.value) {
    e.preventDefault()
    toggleShelfSelection(it.id)
    return
  }
  openItem(it)
}

function onShelfBulkSelectAllChange(val: CheckboxValueType): void {
  if (val === true) {
    shelfBulkSelected.value = [...shelfSelectableIds.value]
    shelfBulkManual.value = true
  } else {
    shelfBulkSelected.value = []
  }
}

function exitShelfBulkMode(): void {
  shelfBulkSelected.value = []
  shelfBulkManual.value = false
}

async function shelfBulkDelete(): Promise<void> {
  const ids = shelfBulkSelected.value
  if (!ids.length) return
  try {
    await ElMessageBox.confirm(`确定要删除选中的 ${ids.length} 个文件吗？此操作不可恢复。`, '批量删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  shelfBulkDeleting.value = true
  try {
    const r = await window.api.deleteBookshelfItemsBatch(ids)
    if (!r.success) {
      ElMessage.error(r.message || '删除失败')
      return
    }
    ElMessage.success(r.message || '已删除')
    exitShelfBulkMode()
    await loadItems()
    await graphCanvasRef.value?.refresh()
  } finally {
    shelfBulkDeleting.value = false
  }
}

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
  if (selectFirst) {
    const first = tree.value[0]?.id ?? null
    selectedNotebookId.value = first
  }
}

async function loadItems(): Promise<void> {
  if (selectedNotebookId.value == null) {
    const r = await window.api.listAllBookshelfGlobalItems()
    items.value = r.success ? r.data ?? [] : []
    return
  }
  const r = await window.api.listBookshelfItems(selectedNotebookId.value)
  if (!r.success) {
    items.value = []
    return
  }
  items.value = r.data ?? []
}

const hasAnyNotebook = computed(() => tree.value.length > 0)

async function createFolder(parentIdOverride?: number | null): Promise<void> {
  const parentId = parentIdOverride !== undefined ? parentIdOverride : (selectedNotebookId.value ?? null)
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
  const r = await window.api.createBookshelfFolder(name, parentId == null ? undefined : parentId)
  if (!r.success) {
    ElMessage.warning((r as { message?: string }).message || '创建失败')
    return
  }
  await loadTree(false)
}

async function renameFolder(data: NotebookRow): Promise<void> {
  const res = await ElMessageBox.prompt('新名称', '重命名', {
    confirmButtonText: '保存',
    inputPlaceholder: '请输入名称',
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
  if (selectedNotebookId.value === data.id) {
    selectedNotebookId.value = null
  }
  await loadTree(false)
  await loadItems()
}

function showOverview(): void {
  selectedNotebookId.value = null
}

function onTreeSelect(node: NotebookRow): void {
  selectedNotebookId.value = node.id
}

function allowTreeDrop(): boolean {
  return true
}

async function onNotebookDrop(draggingNode: { data: NotebookRow }, dropNode: { data: NotebookRow; parent: { data?: NotebookRow } }, dropType: string): Promise<void> {
  const dragId = draggingNode.data.id
  let parentId: number | null = null
  if (dropType === 'inner') {
    parentId = dropNode.data.id
  } else {
    const pd = dropNode.parent?.data
    parentId = pd?.id ?? null
  }
  if (dragId === parentId) {
    await loadTree(false)
    return
  }
  const r = await window.api.moveBookshelfNotebook(dragId, parentId)
  if (!r.success) {
    ElMessage.warning((r as { message?: string }).message || '移动失败')
  }
  await loadTree(false)
  if (selectedNotebookId.value === dragId) {
    /* keep */
  }
  await loadItems()
}

function onItemDragStart(it: ItemRow, ev: DragEvent): void {
  if (shelfBulkPickActive.value) {
    ev.preventDefault()
    return
  }
  if (it.type === 'note' || it.type === 'file' || it.type === 'document') {
    ev.dataTransfer?.setData('application/x-datanode-bookshelf-item', String(it.id))
    ev.dataTransfer!.effectAllowed = 'move'
  }
}

async function onDropOnFolder(fd: NotebookRow, ev: DragEvent): Promise<void> {
  ev.preventDefault()
  const raw = ev.dataTransfer?.getData('application/x-datanode-bookshelf-item')
  if (!raw) return
  const r = await window.api.moveBookshelfItem(Number(raw), fd.id)
  if (!r.success) ElMessage.warning((r as { message?: string }).message || '移动失败')
  else {
    ElMessage.success('已移动到文件夹')
  }
  await loadItems()
  await graphCanvasRef.value?.refresh()
}

const ctxMenu = ref<{
  x: number
  y: number
  kind: 'note' | 'file' | 'folder'
  note?: ItemRow
  folder?: NotebookRow
} | null>(null)

function ctxPanelStyle(m: { x: number; y: number }): Record<string, string> {
  const maxL = Math.max(8, window.innerWidth - 220)
  const maxT = Math.max(8, window.innerHeight - 280)
  return {
    left: `${Math.min(m.x, maxL)}px`,
    top: `${Math.min(m.y, maxT)}px`
  }
}

function closeCtx(): void {
  ctxMenu.value = null
}

function openNoteCtx(ev: MouseEvent, it: ItemRow): void {
  ev.preventDefault()
  ctxMenu.value = { x: ev.clientX, y: ev.clientY, kind: it.type === 'note' ? 'note' : 'file', note: it }
}

function openFolderCtx(ev: MouseEvent, fd: NotebookRow): void {
  ev.preventDefault()
  ctxMenu.value = { x: ev.clientX, y: ev.clientY, kind: 'folder', folder: fd }
}

function ctxNewNoteInFolder(): void {
  const fd = ctxMenu.value?.folder
  closeCtx()
  if (!fd) return
  emit('new-note', { notebookId: fd.id })
}

async function ctxNewFolderUnder(): Promise<void> {
  const fd = ctxMenu.value?.folder
  closeCtx()
  if (!fd) return
  await createFolder(fd.id)
}

function ctxOpenFolderRename(): void {
  const fd = ctxMenu.value?.folder
  closeCtx()
  if (!fd) return
  void renameFolder(fd)
}

async function ctxOpenFolderDelete(): Promise<void> {
  const fd = ctxMenu.value?.folder
  closeCtx()
  if (!fd) return
  await removeFolder(fd)
}

function ctxOpenFolderMove(): void {
  const fd = ctxMenu.value?.folder
  if (!fd) return
  openMoveFolderDialog(fd)
}

async function ctxRenameItem(): Promise<void> {
  const it = ctxMenu.value?.note
  closeCtx()
  if (!it) return
  const res = await ElMessageBox.prompt('名称', '重命名', {
    confirmButtonText: '保存',
    inputPlaceholder: '请输入名称',
    inputValue: cardTitle(it)
  }).catch(() => null)
  if (!res) return
  const name = res.value.trim()
  if (!name) return
  const r = await window.api.renameBookshelfItem(it.id, name)
  if (!r.success) ElMessage.warning((r as { message?: string }).message || '失败')
  await loadItems()
}

async function ctxDeleteItem(): Promise<void> {
  const it = ctxMenu.value?.note
  closeCtx()
  if (!it) return
  try {
    await ElMessageBox.confirm(`确定删除「${cardTitle(it)}」？`, '删除', { type: 'warning' })
  } catch {
    return
  }
  const r = await window.api.deleteBookshelfItem(it.id)
  if (!r.success) ElMessage.warning((r as { message?: string }).message || '删除失败')
  await loadItems()
  await graphCanvasRef.value?.refresh()
}

async function ctxCoverCmd(cmd: string): Promise<void> {
  const it = ctxMenu.value?.note
  closeCtx()
  if (!it || it.type !== 'note') return
  await onCoverCommand(it, cmd)
}

async function ctxCopyNote(): Promise<void> {
  const it = ctxMenu.value?.note
  closeCtx()
  if (!it || it.type !== 'note') return
  const r = await window.api.duplicateBookshelfNote(it.id)
  if (!r.success) ElMessage.warning((r as { message?: string }).message || '复制失败')
  else ElMessage.success('已复制笔记')
  await loadItems()
}

const moveItemDialogVisible = ref(false)
const moveItemPick = ref<ItemRow | null>(null)
const moveItemTargetNotebookId = ref<number | undefined>(undefined)

function openMoveItemDialog(it: ItemRow): void {
  closeCtx()
  moveItemPick.value = it
  const first = tree.value[0]?.id
  const cur = it.notebook_id ?? selectedNotebookId.value
  moveItemTargetNotebookId.value = tree.value.find((row) => row.id !== cur)?.id ?? first
  moveItemDialogVisible.value = true
}

async function confirmMoveItem(): Promise<void> {
  const it = moveItemPick.value
  const nid = moveItemTargetNotebookId.value
  if (!it || nid == null) {
    moveItemDialogVisible.value = false
    return
  }
  const r = await window.api.moveBookshelfItem(it.id, nid)
  if (!r.success) ElMessage.warning((r as { message?: string }).message || '移动失败')
  else {
    ElMessage.success('已移动')
    await loadItems()
    await graphCanvasRef.value?.refresh()
  }
  moveItemDialogVisible.value = false
}

const moveFolderDialogVisible = ref(false)
const moveFolderPick = ref<NotebookRow | null>(null)
/** `null` = 书柜根目录 */
const moveFolderNewParentId = ref<number | null | undefined>(undefined)

function folderIsAncestorOf(ancestorId: number, nodeId: number): boolean {
  let id: number | null = nodeId
  const byId = new Map(tree.value.map((r) => [r.id, r]))
  while (id != null) {
    if (id === ancestorId) return true
    id = byId.get(id)?.parent_id ?? null
  }
  return false
}

function openMoveFolderDialog(fd: NotebookRow): void {
  closeCtx()
  moveFolderPick.value = fd
  moveFolderNewParentId.value = fd.parent_id == null ? null : fd.parent_id
  moveFolderDialogVisible.value = true
}

const moveFolderParentOptions = computed(() => {
  const fd = moveFolderPick.value
  if (!fd) return []
  return tree.value.filter((r) => r.id !== fd.id && !folderIsAncestorOf(fd.id, r.id))
})

async function confirmMoveFolder(): Promise<void> {
  const fd = moveFolderPick.value
  if (fd == null) {
    moveFolderDialogVisible.value = false
    return
  }
  const parentId = moveFolderNewParentId.value
  if (parentId === undefined) {
    moveFolderDialogVisible.value = false
    return
  }
  const r = await window.api.moveBookshelfNotebook(fd.id, parentId)
  if (!r.success) ElMessage.warning((r as { message?: string }).message || '移动失败')
  else {
    ElMessage.success('文件夹已移动')
    await loadTree(false)
    await loadItems()
    await graphCanvasRef.value?.refresh()
  }
  moveFolderDialogVisible.value = false
}

function newNote(): void {
  const nid = defaultTargetNotebookId()
  if (nid == null) {
    ElMessage.warning('请先新建或选择一个文件夹')
    return
  }
  emit('new-note', { notebookId: nid })
}

async function importDocument(): Promise<void> {
  const nid = defaultTargetNotebookId()
  if (nid == null) {
    ElMessage.warning('请先新建或选择一个文件夹')
    return
  }
  const picked = await window.api.pickBookshelfDocumentFile()
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
    const nb = it.notebook_id ?? selectedNotebookId.value
    if (nb == null) {
      ElMessage.warning('无法定位笔记所在文件夹')
      return
    }
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

function itemMetaLine(it: ItemRow): string {
  const loc = itemNotebookLabel(it)
  const d = itemDateLine(it)
  return [loc, d].filter(Boolean).join(' · ')
}

async function onLayoutSave(positions: Array<{ id: number; x: number; y: number }>): Promise<void> {
  await window.api.updateNodePositions(positions)
}

const treeRef = ref<{ setCurrentKey: (k?: number) => void } | null>(null)

watch(selectedNotebookId, (id) => {
  treeRef.value?.setCurrentKey(id ?? undefined)
  void loadItems()
})

watch(shelfTab, (t) => {
  if (t === 'graph') {
    void graphCanvasRef.value?.refresh()
  }
})

onMounted(() => {
  void loadTree(false).then(() => loadItems())
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
        <div class="aside-actions aside-actions--stack">
          <el-button size="small" plain @click="showOverview">资料概览</el-button>
          <el-button type="primary" size="small" :icon="FolderAdd" @click="createFolder()">新建文件夹</el-button>
        </div>
        <el-scrollbar class="tree-wrap">
          <el-tree
            v-if="treeData.length"
            ref="treeRef"
            :data="treeData"
            :props="treeProps"
            node-key="id"
            highlight-current
            default-expand-all
            draggable
            :allow-drop="allowTreeDrop"
            @node-click="onTreeSelect"
            @node-drop="onNotebookDrop"
          >
            <template #default="{ data }">
              <span class="tree-node-row" @contextmenu.prevent="openFolderCtx($event, data)">
                <span class="tree-node-label">{{ data.name }}</span>
                <span class="tree-node-actions">
                  <el-button text circle size="small" :icon="EditPen" @click.stop="renameFolder(data)" />
                  <el-button text circle size="small" type="danger" :icon="Delete" @click.stop="removeFolder(data)" />
                </span>
              </span>
            </template>
          </el-tree>
          <el-empty v-else description="尚无文件夹，请先新建" :image-size="64" />
        </el-scrollbar>
      </aside>

      <main class="bookshelf-main">
        <transition name="bs-toolbar" mode="out-in">
        <header v-if="shelfBulkBarVisible" key="bulk" class="bookshelf-toolbar bookshelf-toolbar--bulk">
          <div class="bookshelf-bulk-left">
            <span class="bookshelf-bulk-count">已选择 {{ shelfBulkSelected.length }} 项</span>
            <el-checkbox
              :model-value="shelfBulkSelectAllChecked"
              :indeterminate="shelfBulkSelectAllIndeterminate"
              @change="onShelfBulkSelectAllChange"
            >
              全选当前列表
            </el-checkbox>
          </div>
          <div class="bookshelf-bulk-right">
            <el-button type="danger" plain :loading="shelfBulkDeleting" @click="shelfBulkDelete">批量删除</el-button>
            <el-button @click="exitShelfBulkMode">退出选择</el-button>
          </div>
        </header>
        <header v-else key="normal" class="bookshelf-toolbar">
          <el-button type="primary" :icon="Plus" :disabled="!hasAnyNotebook" @click="newNote">新建笔记</el-button>
          <el-button :icon="Upload" :disabled="!hasAnyNotebook" @click="importDocument">导入文档</el-button>
          <el-button
            :type="shelfBulkManual ? 'primary' : 'default'"
            plain
            :icon="Operation"
            @click="toggleShelfBulkManual"
          >
            批量选择
          </el-button>
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
        </transition>

        <el-scrollbar class="card-scroll">
          <div class="library-cards">
            <div class="section-label row-between">
              <span>{{ selectedNotebookId == null ? '资料概览' : '当前文件夹' }}</span>
            </div>

            <section v-if="childFolderNodes.length" class="folder-section">
              <div class="section-label">文件夹</div>
              <div class="folder-card-row">
                <button
                  v-for="fd in childFolderNodes"
                  :key="fd.id"
                  type="button"
                  class="folder-tile"
                  @click="onTreeSelect(fd)"
                  @contextmenu.prevent="openFolderCtx($event, fd)"
                  @dragover.prevent
                  @drop="onDropOnFolder(fd, $event)"
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
                :class="{
                  'shelf-card--note': it.type === 'note',
                  'is-bulk-pick': shelfBulkPickActive,
                  'is-bulk-selected': shelfBulkSelected.includes(it.id)
                }"
                :draggable="!shelfBulkPickActive"
                @dragstart="onItemDragStart(it, $event)"
                @click="onShelfCardClick(it, $event)"
                @contextmenu.prevent="openNoteCtx($event, it)"
              >
                <div class="shelf-bulk-cb" @click.stop="toggleShelfSelection(it.id)">
                  <el-checkbox :model-value="shelfBulkSelected.includes(it.id)" />
                </div>
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
                    <div class="shelf-card-meta">{{ itemMetaLine(it) }}</div>
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
                    <div class="shelf-card-meta">{{ it.type }} · {{ itemMetaLine(it) }}</div>
                  </div>
                </template>
              </div>
              <el-empty v-if="!filteredItems.length" description="暂无条目" />
            </div>
          </div>
        </el-scrollbar>
      </main>
    </div>

    <div
      v-if="ctxMenu"
      class="ctx-scrim"
      @mousedown="closeCtx"
    />
    <div v-if="ctxMenu" class="ctx-panel" :style="ctxPanelStyle(ctxMenu)" @mousedown.stop>
      <template v-if="ctxMenu.kind === 'folder' && ctxMenu.folder">
        <button type="button" class="ctx-item" @click="ctxOpenFolderRename">重命名</button>
        <button type="button" class="ctx-item" @click="ctxOpenFolderDelete">删除</button>
        <button type="button" class="ctx-item" @click="ctxOpenFolderMove">移动到…</button>
        <button type="button" class="ctx-item" @click="ctxNewNoteInFolder">新建笔记</button>
        <button type="button" class="ctx-item" @click="ctxNewFolderUnder">新建文件夹</button>
      </template>
      <template v-else-if="ctxMenu.note">
        <button type="button" class="ctx-item" @click="ctxRenameItem">重命名</button>
        <button type="button" class="ctx-item" @click="ctxDeleteItem">删除</button>
        <button type="button" class="ctx-item" @click="openMoveItemDialog(ctxMenu.note)">移动到…</button>
        <button v-if="ctxMenu.note.type === 'note'" type="button" class="ctx-item" @click="ctxCopyNote">复制</button>
        <template v-if="ctxMenu.note.type === 'note'">
          <div class="ctx-sub">切换封面</div>
          <button
            v-for="pr in PRESET_COVERS"
            :key="pr.key"
            type="button"
            class="ctx-item ctx-item--sub"
            @click="ctxCoverCmd(`preset:${pr.key}`)"
          >
            {{ pr.label }}
          </button>
          <button type="button" class="ctx-item ctx-item--sub" @click="ctxCoverCmd('upload')">自定义图片…</button>
          <button type="button" class="ctx-item ctx-item--sub" @click="ctxCoverCmd('clear')">恢复默认</button>
        </template>
      </template>
    </div>

    <el-dialog v-model="moveItemDialogVisible" title="移动到文件夹" width="420px" destroy-on-close align-center>
      <el-select v-model="moveItemTargetNotebookId" placeholder="选择目标文件夹" filterable style="width: 100%">
        <el-option v-for="row in tree" :key="row.id" :label="row.name" :value="row.id" />
      </el-select>
      <template #footer>
        <el-button @click="moveItemDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmMoveItem">移动</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="moveFolderDialogVisible" title="移动文件夹" width="420px" destroy-on-close align-center>
      <p v-if="moveFolderPick" class="move-folder-hint">将「{{ moveFolderPick.name }}」移动到：</p>
      <el-select v-model="moveFolderNewParentId" placeholder="选择父文件夹" filterable style="width: 100%">
        <el-option label="书柜根目录" :value="null" />
        <el-option v-for="row in moveFolderParentOptions" :key="row.id" :label="row.name" :value="row.id" />
      </el-select>
      <template #footer>
        <el-button @click="moveFolderDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmMoveFolder">移动</el-button>
      </template>
    </el-dialog>

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
.aside-actions--stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
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

.bookshelf-toolbar--bulk {
  justify-content: space-between;
  background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);
}

.bookshelf-bulk-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}

.bookshelf-bulk-count {
  font-size: 13px;
  font-weight: 700;
  color: #0f172a;
}

.bookshelf-bulk-right {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.bs-toolbar-enter-active,
.bs-toolbar-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.bs-toolbar-enter-from,
.bs-toolbar-leave-to {
  opacity: 0;
  transform: translateY(-5px);
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
  position: relative;
}
.shelf-card.is-bulk-selected {
  outline: 2px solid #6366f1;
  outline-offset: 0;
}
.shelf-bulk-cb {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 4;
  padding: 2px 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
  opacity: 0;
  transition: opacity 0.18s ease;
}
.shelf-card:hover .shelf-bulk-cb,
.shelf-card.is-bulk-pick .shelf-bulk-cb {
  opacity: 1;
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
.ctx-scrim {
  position: fixed;
  inset: 0;
  z-index: 2999;
  background: transparent;
}
.ctx-panel {
  position: fixed;
  z-index: 3000;
  min-width: 200px;
  max-width: 280px;
  padding: 8px 0;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(15, 23, 42, 0.18);
  border: 1px solid #e2e8f0;
}
.ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 16px;
  border: none;
  background: none;
  font-size: 14px;
  color: #0f172a;
  cursor: pointer;
  font-family: inherit;
}
.ctx-item:hover {
  background: #f1f5f9;
}
.ctx-item--sub {
  padding-left: 28px;
  font-size: 13px;
  color: #475569;
}
.ctx-sub {
  padding: 8px 16px 4px;
  font-size: 11px;
  font-weight: 700;
  color: #94a3b8;
  letter-spacing: 0.04em;
}
.move-folder-hint {
  margin: 0 0 12px;
  font-size: 14px;
  color: #475569;
}
</style>
