<script setup lang="ts">
import { formatRM, formatAmount, currencySymbol } from '~/utils/currency'
import { formatDate } from '~/utils/dateFormat'
import { useAuthStore } from '~/stores/auth'
import {
  ArrowUpTrayIcon, DocumentArrowDownIcon, CheckCircleIcon,
  DocumentTextIcon, XMarkIcon, ArrowPathIcon,
} from '@heroicons/vue/24/outline'
definePageMeta({ middleware: ['role'] })

const { data: ambassadors } = useAPI<any[]>('/ambassadors')
const activeClubId = useState<number | null>('active-club-id', () => null)

interface ParsedRow {
  date: string
  externalOrderId: string
  tableNumber: string
  amount: number
  saleType?: string
  ambassadorId: number | ''
}

const file = ref<File | null>(null)
const dryRun = ref<any | null>(null)
const rows = ref<ParsedRow[]>([])
const status = ref<'draft' | 'confirmed'>('draft')
const error = ref('')
const parsing = ref(false)
const importing = ref(false)
const result = ref<any | null>(null)
const isDragging = ref(false)

const stage = computed<'upload' | 'preview' | 'done'>(() => {
  if (result.value) return 'done'
  if (dryRun.value) return 'preview'
  return 'upload'
})

function onPickFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null
  file.value = f
  error.value = ''
}

function onDrop(e: DragEvent) {
  isDragging.value = false
  const f = e.dataTransfer?.files?.[0] ?? null
  if (f && f.type === 'application/pdf') file.value = f
  else error.value = 'Only PDF files are allowed'
}

async function parse() {
  error.value = ''
  if (!file.value) return
  parsing.value = true
  const fd = new FormData(); fd.set('file', file.value)
  try {
    const auth = useAuthStore()
    const r = await $fetch<any>('/api/v1/sales/import', {
      method: 'POST', body: fd,
      headers: {
        authorization: auth.token ? `Bearer ${auth.token}` : '',
        ...(activeClubId.value ? { 'x-club-id': String(activeClubId.value) } : {}),
      },
    })
    dryRun.value = r
    rows.value = (r.rows ?? []).map((x: any) => ({ ...x, ambassadorId: '' }))
  } catch (e: any) {
    error.value = e?.data?.error?.message || 'Parse failed'
  } finally {
    parsing.value = false
  }
}

const dupSet = computed(() => new Set<string>(dryRun.value?.duplicates ?? []))
const reactivateSet = computed(() => new Set<string>(dryRun.value?.reactivations ?? []))
const importableRows = computed(() => rows.value.filter(r => !dupSet.value.has(r.externalOrderId)))
const readyRows = computed(() => importableRows.value.filter(r => !!r.ambassadorId))
const unassignedCount = computed(() => importableRows.value.filter(r => !r.ambassadorId).length)
const allAssigned = computed(() => importableRows.value.length > 0 && unassignedCount.value === 0)

// Some formats don't print a gross total — reconciliation then runs against
// the statement's commission figures instead (parser-level errors below).
const totalsMismatch = computed(() =>
  dryRun.value && dryRun.value.headerTotal != null
  && Math.abs(dryRun.value.parsedTotal - dryRun.value.headerTotal) > 0.05)

const mixedTypes = computed<string[]>(() => dryRun.value?.rowTypes ?? [])

function reset() {
  file.value = null
  dryRun.value = null
  rows.value = []
  result.value = null
  error.value = ''
}

function removeRow(i: number) {
  rows.value.splice(i, 1)
}

const m = useAPIMutation()
const toast = useToast()
async function commit() {
  if (!dryRun.value || importableRows.value.length === 0) return
  if (!allAssigned.value) {
    toast.error('Assign every row to an ambassador first')
    return
  }
  importing.value = true
  try {
    result.value = await m.post('/sales/import-commit', {
      status: status.value,
      saleType: dryRun.value.suggestedSaleType ?? undefined,
      rows: importableRows.value.map(r => ({
        date: r.date,
        externalOrderId: r.externalOrderId,
        tableNumber: r.tableNumber,
        amount: r.amount,
        saleType: r.saleType ?? undefined,
        ambassadorId: Number(r.ambassadorId),
      })),
    })
    toast.success(`Imported ${result.value?.imported ?? 0} sale(s)`)
  } catch (e: any) {
    const apiMsg = e?.data?.error?.message
    const details = e?.data?.error?.details
    const detail = details && typeof details === 'object' ? Object.entries(details).map(([k, v]) => `${k}: ${v}`).join('; ') : ''
    const fallback = e?.data?.message || e?.statusMessage || e?.message || 'Import failed'
    toast.error(detail ? `${apiMsg || fallback} — ${detail}` : (apiMsg || fallback))
  } finally { importing.value = false }
}

function rowStatus(r: ParsedRow): { tone: 'slate' | 'emerald' | 'amber' | 'rose'; label: string } {
  if (dupSet.value.has(r.externalOrderId)) return { tone: 'slate', label: 'Duplicate' }
  if (!r.ambassadorId) return { tone: 'amber', label: 'Unassigned' }
  if (reactivateSet.value.has(r.externalOrderId)) return { tone: 'rose', label: 'Re-import' }
  return { tone: 'emerald', label: 'Ready' }
}

const statusOptions = [
  { value: 'draft', label: 'Draft' },
  { value: 'confirmed', label: 'Confirmed' },
] as const
</script>

<template>
  <!-- ===== STAGE 1 : UPLOAD ===== -->
  <div v-if="stage === 'upload'" class="space-y-5 max-w-3xl mx-auto">
    <div class="bg-[var(--color-card)] border border-[var(--color-border-2)] rounded-2xl p-6 shadow-card">
      <div class="flex items-start justify-between mb-5 gap-3">
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-2)]">Step 1 of 2</p>
          <h3 class="font-display text-[18px] font-semibold text-[var(--color-ink)] tracking-tight mt-0.5">Upload sales PDF</h3>
        </div>
        <p class="text-[11px] text-[var(--color-muted-2)] tabular hidden sm:block">PDF only · max 20 MB</p>
      </div>

      <label
        v-if="!file"
        class="flex flex-col items-center justify-center gap-3 px-4 py-16 border-2 border-dashed rounded-xl cursor-pointer transition-[border-color,background-color] duration-200"
        :class="isDragging
          ? 'border-[var(--color-brand)] bg-[var(--color-brand-tint)]'
          : 'border-[var(--color-border)] hover:border-[var(--color-brand)] hover:bg-[var(--color-hairline)]/60'"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="onDrop"
      >
        <div class="w-14 h-14 rounded-2xl bg-[var(--color-brand-soft)] flex items-center justify-center text-[var(--color-brand-dark)] shadow-rose">
          <ArrowUpTrayIcon class="w-6 h-6" />
        </div>
        <div class="text-center">
          <p class="text-[14px] font-semibold text-[var(--color-ink)]">
            <span class="text-[var(--color-brand-dark)]">Click to choose</span>
            <span class="text-[var(--color-muted)]"> or drag &amp; drop</span>
          </p>
          <p class="text-[12px] text-[var(--color-muted-2)] mt-1">Drop your Nono Club POS export here.</p>
        </div>
        <input type="file" accept="application/pdf" class="hidden" @change="onPickFile">
      </label>

      <div
        v-else
        class="flex items-center gap-3 px-4 py-4 border border-[var(--color-border-2)] rounded-xl bg-[var(--color-hairline)]/60"
      >
        <div class="w-10 h-10 rounded-lg bg-[var(--color-brand-soft)] flex items-center justify-center shrink-0 text-[var(--color-brand-dark)]">
          <DocumentTextIcon class="w-5 h-5" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-[13px] font-semibold text-[var(--color-ink)] truncate">{{ file.name }}</p>
          <p class="text-[11px] text-[var(--color-muted)] tabular">{{ (file.size / 1024).toFixed(0) }} KB · ready to parse</p>
        </div>
        <button
          type="button"
          class="press w-8 h-8 rounded-lg hover:bg-[var(--color-surface-2)] flex items-center justify-center text-[var(--color-muted-2)] hover:text-[var(--color-ink)] shrink-0"
          aria-label="Remove file"
          @click="file = null; error = ''"
        >
          <XMarkIcon class="w-4 h-4" />
        </button>
      </div>

      <p v-if="error" class="mt-3 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{{ error }}</p>

      <div class="mt-5 flex flex-col sm:flex-row sm:justify-end gap-2">
        <AppButton class="w-full sm:w-auto" :disabled="!file || parsing" @click="parse">
          <DocumentArrowDownIcon class="w-4 h-4" />
          {{ parsing ? 'Parsing…' : 'Parse PDF' }}
        </AppButton>
      </div>
    </div>
  </div>

  <!-- ===== STAGE 2 : PREVIEW & ASSIGN ===== -->
  <div v-else-if="stage === 'preview'" class="space-y-6">
    <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
      <div>
        <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-2)]">Step 2 of 2</p>
        <h2 class="font-display text-[20px] font-semibold text-[var(--color-ink)] tracking-tight">Review parsed sales</h2>
        <p class="text-[12px] text-[var(--color-muted)] mt-1">
          From <span class="font-medium text-[var(--color-ink)]">{{ file?.name }}</span>
          <span v-if="dryRun.ambassadorHint" class="ml-2">· PDF hint: <span class="font-medium text-[var(--color-ink)]">{{ dryRun.ambassadorHint }}</span></span>
          <span v-if="dryRun.format" class="ml-2">· Detected: <span class="font-medium text-[var(--color-ink)]">{{ dryRun.format }}</span>
            <AppBadge v-if="mixedTypes.length > 0" tone="slate" :dot="false" shape="square" class="ml-1">imports as {{ mixedTypes.join(' + ') }}</AppBadge>
            <AppBadge v-else-if="dryRun.suggestedSaleType" tone="slate" :dot="false" shape="square" class="ml-1">imports as {{ dryRun.suggestedSaleType }}</AppBadge>
          </span>
        </p>
      </div>
      <AppButton variant="secondary" class="w-full sm:w-auto" @click="reset">
        <ArrowPathIcon class="w-4 h-4" />
        Start over
      </AppButton>
    </div>

    <!-- Summary cards -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <AppCard label="PDF total" :prefix="dryRun.headerTotal != null ? currencySymbol() : undefined" :value="dryRun.headerTotal != null ? formatAmount(dryRun.headerTotal) : '—'" />
      <AppCard label="Parsed total" :prefix="currencySymbol()" :value="formatAmount(dryRun.parsedTotal)" />
      <AppCard tone="brand" label="Will import" :value="readyRows.length" />
      <AppCard label="Duplicates" :value="dryRun.duplicates.length" />
    </div>

    <p v-if="totalsMismatch" class="text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5 inline-flex items-start gap-2">
      <span aria-hidden="true">⚠</span>
      Header and parsed totals don't match. Double-check the PDF before importing.
    </p>

    <p v-for="err in (dryRun.errors ?? [])" :key="err" class="text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5 inline-flex items-start gap-2 max-w-2xl">
      <span aria-hidden="true">⚠</span>
      <span>{{ err }}</span>
    </p>

    <p v-if="dryRun.unknownTypes?.length" class="text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5 inline-flex items-start gap-2 max-w-2xl">
      <span aria-hidden="true">⚠</span>
      <span>
        This statement contains sale type{{ dryRun.unknownTypes.length === 1 ? '' : 's' }}
        <span class="font-semibold text-[var(--color-ink)]">{{ dryRun.unknownTypes.join(', ') }}</span>
        that this club doesn't have yet. The import will be rejected until you add
        {{ dryRun.unknownTypes.length === 1 ? 'it' : 'them' }} under Settings → Sale types —
        you can do that in another tab and import again without re-parsing.
      </span>
    </p>

    <p v-if="reactivateSet.size" class="text-[12px] text-[var(--color-brand-dark)] bg-[var(--color-brand-soft)] border border-[var(--color-brand)]/20 rounded-lg px-3.5 py-2.5 inline-flex items-start gap-2 max-w-2xl">
      <span aria-hidden="true">↻</span>
      <span>
        {{ reactivateSet.size }} receipt{{ reactivateSet.size === 1 ? ' was' : 's were' }} previously voided —
        re-importing reuses {{ reactivateSet.size === 1 ? 'that record' : 'those records' }} and clears the void, so {{ reactivateSet.size === 1 ? 'it is' : 'they are' }} not duplicated.
      </span>
    </p>

    <p v-if="dryRun.reportedCommissionTotal" class="text-[12px] text-[var(--color-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border-2)] rounded-lg px-3.5 py-2.5 inline-flex items-start gap-2 max-w-2xl">
      <span aria-hidden="true">ℹ</span>
      <span>
        The statement reports
        <span class="font-semibold text-[var(--color-ink)] tabular">{{ currencySymbol() }}{{ formatAmount(dryRun.reportedCommissionTotal) }}</span>
        commission<template v-if="dryRun.reportedRates?.length"> at {{ dryRun.reportedRates.join('%, ') }}%</template>.
        Commissions here come from each ambassador's rate plan — check it matches before importing as confirmed.
      </span>
    </p>

    <!-- Per-row table -->
    <div class="bg-[var(--color-card)] border border-[var(--color-border-2)] rounded-2xl shadow-card overflow-hidden">
      <div class="px-5 py-3.5 border-b border-[var(--color-hairline)] flex items-center justify-between">
        <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-2)]">Sales rows</p>
        <p v-if="unassignedCount > 0" class="text-[12px] text-amber-800 inline-flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-500" />
          {{ unassignedCount }} row{{ unassignedCount === 1 ? '' : 's' }} need an ambassador
        </p>
        <p v-else class="text-[12px] text-emerald-800 inline-flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500" /> All assigned
        </p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[760px] tabular">
          <thead>
            <tr class="bg-[var(--color-hairline)] border-b border-[var(--color-border-2)]">
              <th class="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Date</th>
              <th class="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Order</th>
              <th class="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Table</th>
              <th class="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Type</th>
              <th class="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Amount</th>
              <th class="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)] w-[220px]">Ambassador</th>
              <th class="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Status</th>
              <th class="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)] w-[56px]"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, i) in rows"
              :key="i"
              class="border-b border-[var(--color-hairline)] last:border-b-0 hover:bg-[var(--color-hairline)]/60 transition-colors"
            >
              <td class="px-4 py-3 text-[13px] text-[var(--color-muted)]">{{ formatDate(row.date) }}</td>
              <td class="px-4 py-3 text-[12px] font-mono">
                <span v-if="row.externalOrderId.startsWith('M-') || row.externalOrderId.startsWith('S-')" class="text-[var(--color-muted-2)] italic" title="No order ID in PDF — synthesized from date + table + amount">—</span>
                <span v-else class="text-[var(--color-muted)]">{{ row.externalOrderId }}</span>
              </td>
              <td class="px-4 py-3 text-[13px] text-[var(--color-muted)]">{{ row.tableNumber }}</td>
              <td class="px-4 py-3 text-[12px] text-[var(--color-muted)]">{{ row.saleType ?? dryRun.suggestedSaleType }}</td>
              <td class="px-4 py-3 text-[13px] text-right font-semibold text-[var(--color-ink)]">{{ formatRM(row.amount) }}</td>
              <td class="px-4 py-3">
                <select
                  v-if="!dupSet.has(row.externalOrderId)"
                  v-model="row.ambassadorId"
                  class="w-full max-w-[200px] rounded-lg border px-2.5 py-1.5 text-[12px] bg-white outline-none focus:border-[var(--color-brand)] focus:ring-4 focus:ring-[var(--color-brand)]/12 transition-[border-color,box-shadow]"
                  :class="row.ambassadorId ? 'border-[var(--color-border)]' : 'border-amber-300 bg-amber-50'"
                >
                  <option value="">— Pick ambassador —</option>
                  <option v-for="a in (ambassadors ?? [])" :key="a.id" :value="a.id">{{ a.name }}</option>
                </select>
                <span v-else class="text-[12px] text-[var(--color-muted-2)] italic">—</span>
              </td>
              <td class="px-4 py-3">
                <AppBadge :tone="rowStatus(row).tone">{{ rowStatus(row).label }}</AppBadge>
              </td>
              <td class="px-4 py-3 text-right">
                <button
                  type="button"
                  class="press w-7 h-7 rounded-lg hover:bg-rose-50 flex items-center justify-center text-[var(--color-muted-2)] hover:text-rose-700 transition-colors ml-auto"
                  aria-label="Remove this row"
                  title="Remove row"
                  @click="removeRow(i)"
                >
                  <XMarkIcon class="w-4 h-4" />
                </button>
              </td>
            </tr>
            <tr v-if="rows.length === 0">
              <td colspan="8" class="px-4 py-12 text-center text-[13px] text-[var(--color-muted-2)]">No rows parsed.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Footer action bar -->
    <div class="bg-[var(--color-card)] border border-[var(--color-border-2)] rounded-2xl p-4 shadow-card flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
      <AppPillGroup v-model="status" :options="statusOptions" label="Import as" />
      <AppButton class="w-full sm:w-auto" :disabled="!allAssigned || importing" @click="commit">
        {{ importing ? 'Importing…' : `Import ${readyRows.length} row${readyRows.length === 1 ? '' : 's'}` }}
      </AppButton>
    </div>
  </div>

  <!-- ===== STAGE 3 : DONE ===== -->
  <div v-else class="space-y-5 max-w-3xl mx-auto">
    <div class="relative bg-[var(--color-card)] border border-[var(--color-border-2)] rounded-2xl p-6 shadow-card flex items-start gap-4 overflow-hidden">
      <div
        aria-hidden="true"
        class="pointer-events-none absolute -top-16 -right-16 w-56 h-56 rounded-full opacity-30 blur-3xl"
        style="background: radial-gradient(closest-side, #10b981 0%, transparent 70%);"
      />
      <div class="relative w-12 h-12 rounded-2xl bg-emerald-50 flex items-center justify-center text-emerald-700 shrink-0 ring-1 ring-emerald-200">
        <CheckCircleIcon class="w-6 h-6" />
      </div>
      <div class="relative flex-1">
        <p class="font-display text-[18px] font-semibold text-[var(--color-ink)] tracking-tight">Import complete</p>
        <p class="text-[12px] text-[var(--color-muted)] mt-1 tabular">
          Imported <span class="font-semibold text-[var(--color-ink)]">{{ result.imported }}</span> sale{{ result.imported === 1 ? '' : 's' }},
          skipped <span class="font-semibold text-[var(--color-ink)]">{{ result.skipped }}</span>.
        </p>
        <div class="mt-4 flex flex-col sm:flex-row gap-2">
          <AppButton variant="secondary" @click="reset">Import another file</AppButton>
          <NuxtLink to="/sales">
            <AppButton>View sales</AppButton>
          </NuxtLink>
        </div>
      </div>
    </div>
  </div>
</template>
