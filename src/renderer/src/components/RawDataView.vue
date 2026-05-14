<script setup lang="ts">
type ItemRow = {
  id: number
  project_id: number | null
  type: 'note' | 'excel_row' | 'document' | 'file'
  title: string
  content_text: string
  content_json: string
  source_file_path: string
  created_at: string
}

type FlattenedItemRow = ItemRow & Record<string, unknown>

defineProps<{
  rows: FlattenedItemRow[]
  loading: boolean
  showMetadata: boolean
  dynamicColumns: string[]
  currentTableFilter: string
  nodeTagsMap: Record<number, Array<{ id: number; name: string; color: string }>>
  summarizeContent: (row: ItemRow) => string
}>()

const emit = defineEmits<{
  rowClick: [row: FlattenedItemRow]
}>()

function isExcelType(type: unknown): boolean {
  return type === 'excel' || type === 'excel_row'
}

function onRowClick(row: FlattenedItemRow): void {
  emit('rowClick', row)
}
</script>

<template>
  <div class="raw-data-pane">
    <el-table
      :data="rows"
      stripe
      v-loading="loading"
      height="100%"
      class="modern-table"
      @row-click="onRowClick"
    >
      <el-table-column prop="id" label="ID" width="90" fixed="left" />
      <el-table-column prop="type" label="类型" width="130" fixed="left" />
      <el-table-column label="标签" min-width="220" show-overflow-tooltip fixed="left">
        <template #default="{ row }">
          <div class="flex flex-wrap gap-1">
            <el-tag
              v-for="tag in nodeTagsMap[row.id] || []"
              :key="`${row.id}-${tag.id}`"
              size="small"
              :style="{ backgroundColor: tag.color, borderColor: tag.color, color: '#fff' }"
            >
              {{ tag.name }}
            </el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="内容摘要/名称" min-width="320" show-overflow-tooltip fixed="left">
        <template #default="{ row }">
          <span class="text-slate-700">{{ summarizeContent(row) }}</span>
        </template>
      </el-table-column>
      <template v-if="currentTableFilter !== 'all' && String(currentTableFilter).includes('excel')">
        <el-table-column
          v-for="col in dynamicColumns"
          :key="col"
          :label="col"
          min-width="150"
          show-overflow-tooltip
        >
          <template #default="scope">
            <span v-if="isExcelType(scope.row.type)">{{ scope.row[col] ?? '-' }}</span>
            <span v-else class="text-slate-300">-</span>
          </template>
        </el-table-column>
      </template>
      <el-table-column
        v-if="showMetadata"
        prop="source_file_path"
        label="来源文件"
        min-width="320"
        fixed="right"
        show-overflow-tooltip
      />
      <el-table-column
        v-if="showMetadata"
        prop="created_at"
        label="创建时间"
        min-width="220"
        fixed="right"
      />
    </el-table>
  </div>
</template>

<style scoped>
.raw-data-pane {
  height: 100%;
  min-height: 400px;
}
</style>
