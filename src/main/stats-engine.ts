/** 纯统计：在结构化行（每行一条记录）上计算指标，供 IPC / AI 共用 */

export type StructuredRow = Record<string, unknown>

export type UniqueValueEntry = { value: string; count: number }

export type GroupAggregateType = 'sum' | 'avg' | 'count'

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const s = String(value).trim().replace(/,/g, '')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function cellString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value).trim()
}

export function statsCount(rows: StructuredRow[]): number {
  return rows.length
}

export function statsSum(rows: StructuredRow[], field: string): number {
  let t = 0
  for (const row of rows) {
    const n = toNumber(row[field])
    if (n !== null) t += n
  }
  return t
}

export function statsAverage(rows: StructuredRow[], field: string): number | null {
  let t = 0
  let c = 0
  for (const row of rows) {
    const n = toNumber(row[field])
    if (n !== null) {
      t += n
      c += 1
    }
  }
  if (c === 0) return null
  return t / c
}

export function statsMax(rows: StructuredRow[], field: string): number | null {
  let m: number | null = null
  for (const row of rows) {
    const n = toNumber(row[field])
    if (n === null) continue
    if (m === null || n > m) m = n
  }
  return m
}

export function statsMin(rows: StructuredRow[], field: string): number | null {
  let m: number | null = null
  for (const row of rows) {
    const n = toNumber(row[field])
    if (n === null) continue
    if (m === null || n < m) m = n
  }
  return m
}

export function statsUniqueValues(rows: StructuredRow[], field: string, limit = 200): UniqueValueEntry[] {
  const map = new Map<string, number>()
  for (const row of rows) {
    const v = cellString(row[field])
    const key = v || '(空)'
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit)
}

export function statsGroupBy(
  rows: StructuredRow[],
  groupField: string,
  aggregateField: string,
  aggregateType: GroupAggregateType
): { group: string; value: number }[] {
  const buckets = new Map<string, { sum: number; count: number; numericCount: number }>()

  for (const row of rows) {
    const g = cellString(row[groupField]) || '(空)'
    if (!buckets.has(g)) buckets.set(g, { sum: 0, count: 0, numericCount: 0 })
    const b = buckets.get(g)!
    b.count += 1
    const n = toNumber(row[aggregateField])
    if (n !== null) {
      b.sum += n
      b.numericCount += 1
    }
  }

  const out: { group: string; value: number }[] = []
  for (const [g, b] of buckets) {
    let value = 0
    if (aggregateType === 'count') value = b.count
    else if (aggregateType === 'sum') value = b.sum
    else if (aggregateType === 'avg') value = b.numericCount > 0 ? b.sum / b.numericCount : 0
    out.push({ group: g, value })
  }
  out.sort((a, b) => b.value - a.value || a.group.localeCompare(b.group))
  return out
}

export function inferNumericFields(rows: StructuredRow[], sample = 50): string[] {
  if (rows.length === 0) return []
  const keys = new Set<string>()
  for (const row of rows.slice(0, sample)) {
    Object.keys(row).forEach((k) => keys.add(k))
  }
  const numeric: string[] = []
  for (const key of keys) {
    let ok = 0
    let tried = 0
    for (const row of rows.slice(0, sample)) {
      if (!(key in row)) continue
      tried += 1
      if (toNumber(row[key]) !== null) ok += 1
    }
    if (tried > 0 && ok / tried >= 0.6) numeric.push(key)
  }
  return numeric.sort()
}

export function inferAllFields(rows: StructuredRow[], sample = 200): string[] {
  const keys = new Set<string>()
  for (const row of rows.slice(0, sample)) {
    Object.keys(row).forEach((k) => keys.add(k))
  }
  return [...keys].sort()
}
