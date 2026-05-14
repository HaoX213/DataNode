<script setup lang="ts">
import { QuillEditor } from '@vueup/vue-quill'
import Quill from 'quill'
import '@vueup/vue-quill/dist/vue-quill.snow.css'
import { ElMessage } from 'element-plus'
import { Close, DocumentChecked, FullScreen } from '@element-plus/icons-vue'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const FONT_WHITELIST = [
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  '"Segoe UI"',
  'Roboto',
  '"Helvetica Neue"',
  'Arial',
  '"PingFang SC"',
  '"Microsoft YaHei"',
  '"Source Han Sans SC"',
  '"Noto Sans SC"',
  '"Source Han Serif SC"',
  '"Times New Roman"',
  'Georgia',
  'Menlo',
  'Consolas',
  '"Courier New"'
]

const QuillFont = Quill.import('formats/font') as { whitelist: string[] }
QuillFont.whitelist = FONT_WHITELIST
Quill.register('formats/font', QuillFont as never, true)

const props = defineProps<{
  visible: boolean
  noteId: number | null
  notebookId: number
  projectId: number | null
  initialTitle: string
  /** split：主内容区右侧停靠；fullscreen：全屏覆盖 */
  variant?: 'split' | 'fullscreen'
  /** 全屏模式下是否显示「退回分屏」 */
  allowExitToSplit?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'saved', payload: { id: number; isNew: boolean }): void
  (e: 'request-fullscreen'): void
  (e: 'exit-fullscreen'): void
}>()

const title = ref('')
const html = ref('<p><br></p>')
const saving = ref(false)
let saveTimer: ReturnType<typeof setTimeout> | null = null
const quillRef = ref<InstanceType<typeof QuillEditor> | null>(null)
let detachImageResize: (() => void) | null = null

const isSplit = (): boolean => props.variant === 'split'

const toolbarOptions = [
  [{ font: FONT_WHITELIST }],
  ['bold', 'italic', 'underline', 'strike'],
  ['blockquote', 'code-block'],
  [{ header: 1 }, { header: 2 }],
  [{ list: 'ordered' }, { list: 'bullet' }],
  [{ script: 'sub' }, { script: 'super' }],
  [{ indent: '-1' }, { indent: '+1' }],
  [{ direction: 'rtl' }],
  [{ size: ['small', false, 'large', 'huge'] }],
  [{ header: [1, 2, 3, 4, 5, 6, false] }],
  [{ color: [] }, { background: [] }],
  [{ align: [] }],
  ['link', 'image'],
  ['clean']
]

function stripEmpty(htmlContent: string): string {
  const t = htmlContent.replace(/<p><br><\/p>/gi, '').trim()
  return t.length ? htmlContent : ''
}

function attachQuillImageCornerResize(quill: InstanceType<typeof Quill> | null): void {
  detachImageResize?.()
  detachImageResize = null
  if (!quill) return
  const editor = quill.container?.querySelector?.('.ql-editor') as HTMLElement | null
  if (!editor) return

  const onDown = (e: MouseEvent) => {
    const t = e.target
    if (!(t instanceof HTMLImageElement)) return
    const r = t.getBoundingClientRect()
    const edge = 18
    if (e.clientX < r.right - edge || e.clientY < r.bottom - edge) return
    e.preventDefault()
    const startX = e.clientX
    const startW = t.width || t.offsetWidth || 120
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(48, Math.round(startW + (ev.clientX - startX)))
      t.style.width = `${w}px`
      t.style.height = 'auto'
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  editor.addEventListener('mousedown', onDown)
  detachImageResize = () => editor.removeEventListener('mousedown', onDown)
}

async function loadNote(): Promise<void> {
  if (!props.noteId) {
    title.value = props.initialTitle?.trim() ? props.initialTitle.trim() : ''
    html.value = '<p><br></p>'
    return
  }
  const r = await window.api.getNodeDetail(props.noteId)
  if (!r.success || !r.data) {
    ElMessage.error(r.message || '加载失败')
    return
  }
  title.value = (r.data.title || '').trim()
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

function goFullscreen(): void {
  emit('request-fullscreen')
}

function exitFullscreen(): void {
  emit('exit-fullscreen')
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
        attachQuillImageCornerResize(q)
      }
    } else {
      detachImageResize?.()
      detachImageResize = null
    }
  }
)

watch([title, html], () => {
  if (props.visible && props.noteId) scheduleAutoSave()
})

watch(
  () => props.noteId,
  () => {
    if (props.visible) void loadNote()
  }
)

onMounted(() => {
  void nextTick(() => {
    const q = quillRef.value?.getQuill()
    if (q && props.visible) attachQuillImageCornerResize(q)
  })
})

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
  detachImageResize?.()
})
</script>

<template>
  <div
    v-show="visible"
    class="note-editor-root"
    :class="{ 'note-editor-root--split': isSplit(), 'note-editor-root--fs': !isSplit() }"
  >
    <div class="note-editor-chrome">
      <el-input
        v-model="title"
        class="note-editor-title"
        placeholder="标题"
        size="large"
        clearable
      />
      <div class="note-editor-actions">
        <el-tooltip v-if="isSplit()" content="全屏编辑" placement="bottom">
          <el-button text circle :icon="FullScreen" @click="goFullscreen" />
        </el-tooltip>
        <el-tooltip v-else-if="allowExitToSplit" content="退出全屏" placement="bottom">
          <el-button text circle :icon="FullScreen" @click="exitFullscreen" />
        </el-tooltip>
        <el-button type="primary" :loading="saving" :icon="DocumentChecked" @click="performSave">保存</el-button>
        <el-button :icon="Close" circle @click="close" />
      </div>
    </div>
    <div class="note-editor-paper">
      <div class="note-img-resize-hint">图片右下角拖拽可调整宽度</div>
      <QuillEditor
        ref="quillRef"
        v-model:content="html"
        theme="snow"
        content-type="html"
        class="note-quill"
        :toolbar="toolbarOptions"
        @text-change="scheduleAutoSave"
      />
    </div>
  </div>
</template>

<style scoped>
.note-editor-root {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: rgba(15, 23, 42, 0.06);
}

.note-editor-root--fs {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgba(15, 23, 42, 0.08);
}

.note-editor-root--split {
  border-left: 1px solid #e2e8f0;
  border-radius: 16px 0 0 16px;
  box-shadow: -12px 0 40px rgba(15, 23, 42, 0.08);
  background: #fffef9;
}

.note-editor-chrome {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #fff8e7;
  border-bottom: 1px solid #e8dcc4;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
  flex-shrink: 0;
}

.note-editor-root--split .note-editor-chrome {
  border-radius: 16px 0 0 0;
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
  padding: 12px 16px 28px;
  background-color: #fffef6;
  background-image:
    linear-gradient(rgba(180, 170, 140, 0.12) 1px, transparent 1px),
    linear-gradient(90deg, rgba(180, 170, 140, 0.08) 1px, transparent 1px);
  background-size: 100% 28px, 28px 100%;
  background-position: 0 0;
  min-height: 0;
}

.note-img-resize-hint {
  font-size: 11px;
  color: #94a3b8;
  margin: 0 auto 8px;
  max-width: 900px;
}

.note-quill {
  max-width: 900px;
  margin: 0 auto;
  min-height: 320px;
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
  min-height: 280px;
}

.note-quill :deep(.ql-editor img) {
  max-width: 100%;
  height: auto;
  cursor: nwse-resize;
}
</style>
