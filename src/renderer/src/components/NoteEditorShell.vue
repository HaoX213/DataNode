<script setup lang="ts">
import { QuillEditor } from '@vueup/vue-quill'
import '@vueup/vue-quill/dist/vue-quill.snow.css'
import { ElMessage } from 'element-plus'
import { Close, DocumentChecked } from '@element-plus/icons-vue'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  visible: boolean
  /** 已有笔记 id；为空则新建 */
  noteId: number | null
  notebookId: number
  /** null = 书柜全局笔记 */
  projectId: number | null
  initialTitle: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'saved', payload: { id: number; isNew: boolean }): void
}>()

const title = ref('')
const html = ref('<p><br></p>')
const saving = ref(false)
let saveTimer: ReturnType<typeof setTimeout> | null = null
const quillRef = ref<InstanceType<typeof QuillEditor> | null>(null)

function stripEmpty(htmlContent: string): string {
  const t = htmlContent.replace(/<p><br><\/p>/gi, '').trim()
  return t.length ? htmlContent : ''
}

async function loadNote(): Promise<void> {
  if (!props.noteId) {
    title.value = props.initialTitle || '未命名笔记'
    html.value = '<p><br></p>'
    return
  }
  const r = await window.api.getNodeDetail(props.noteId)
  if (!r.success || !r.data) {
    ElMessage.error(r.message || '加载失败')
    return
  }
  title.value = (r.data.title || '').trim() || '未命名笔记'
  const body = (r.data.content_text || '').trim()
  html.value = body.length ? body : '<p><br></p>'
}

async function performSave(): Promise<void> {
  const plain = stripEmpty(html.value)
  if (!title.value.trim() && !plain.replace(/<[^>]+>/g, '').trim()) {
    ElMessage.warning('请先输入标题或正文')
    return
  }
  saving.value = true
  try {
    if (props.noteId) {
      const r = await window.api.updateNodeDetail({
        id: props.noteId,
        title: title.value.trim() || '未命名笔记',
        contentText: html.value,
        tags: []
      })
      if (!r.success) {
        ElMessage.warning(r.message)
        return
      }
      emit('saved', { id: props.noteId, isNew: false })
    } else {
      const r = await window.api.createNote(
        title.value.trim() || '未命名笔记',
        html.value,
        [],
        props.projectId,
        props.notebookId
      )
      if (!r.success || !r.data || typeof (r.data as { id?: number }).id !== 'number') {
        ElMessage.warning((r as { message?: string }).message || '保存失败')
        return
      }
      emit('saved', { id: (r.data as { id: number }).id, isNew: true })
    }
  } finally {
    saving.value = false
  }
}

function scheduleAutoSave(): void {
  if (!props.visible) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void performSave()
  }, 1200)
}

function close(): void {
  emit('update:visible', false)
}

function onAddImageClick(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result || '')
      const q = quillRef.value?.getQuill()
      if (!q) return
      const range = q.getSelection(true)
      q.insertEmbed(range?.index ?? q.getLength(), 'image', url, 'user')
    }
    reader.readAsDataURL(file)
  }
  input.click()
}

watch(
  () => props.visible,
  async (v) => {
    if (v) {
      await loadNote()
      await nextTick()
      const q = quillRef.value?.getQuill()
      if (q) {
        const toolbar = q.getModule('toolbar') as { addHandler?: (name: string, fn: () => void) => void }
        toolbar?.addHandler?.('image', onAddImageClick)
      }
    }
  }
)

watch([title, html], () => {
  if (props.visible && props.noteId) scheduleAutoSave()
})

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
})
</script>

<template>
  <teleport to="body">
    <div v-show="visible" class="note-editor-overlay">
      <div class="note-editor-chrome">
        <el-input v-model="title" class="note-editor-title" placeholder="标题" size="large" />
        <div class="note-editor-actions">
          <el-button type="primary" :loading="saving" :icon="DocumentChecked" @click="performSave">保存</el-button>
          <el-button :icon="Close" circle @click="close" />
        </div>
      </div>
      <div class="note-editor-paper">
        <QuillEditor
          ref="quillRef"
          v-model:content="html"
          theme="snow"
          content-type="html"
          class="note-quill"
          toolbar="full"
          @text-change="scheduleAutoSave"
        />
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.note-editor-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  background: rgba(15, 23, 42, 0.08);
}
.note-editor-chrome {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #fff8e7;
  border-bottom: 1px solid #e8dcc4;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}
.note-editor-title {
  flex: 1;
  max-width: 720px;
}
.note-editor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.note-editor-paper {
  flex: 1;
  overflow: auto;
  padding: 20px 24px 40px;
  background-color: #fffef6;
  background-image:
    linear-gradient(rgba(180, 170, 140, 0.12) 1px, transparent 1px),
    linear-gradient(90deg, rgba(180, 170, 140, 0.08) 1px, transparent 1px);
  background-size: 100% 28px, 28px 100%;
  background-position: 0 0;
}
.note-quill {
  max-width: 900px;
  margin: 0 auto;
  min-height: calc(100vh - 140px);
  background: rgba(255, 255, 255, 0.72);
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(15, 23, 42, 0.08);
}
.note-quill :deep(.ql-toolbar) {
  border-radius: 12px 12px 0 0;
  border-color: #e8dcc4;
  background: #fffdf7;
}
.note-quill :deep(.ql-container) {
  border-radius: 0 0 12px 12px;
  border-color: #e8dcc4;
  font-size: 16px;
  line-height: 1.65;
  color: #1e293b;
  min-height: 520px;
}
</style>
