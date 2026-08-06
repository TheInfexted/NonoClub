<script setup lang="ts">
import { formatRM, formatAmount, currencySymbol } from '~/utils/currency'
import { downloadAuthed } from '~/utils/download'
import { useAuthStore } from '~/stores/auth'

const auth = useAuthStore()
const isAdmin = computed(() => auth.user?.tier === 'admin')

const month = ref('')
const ambassadorFilter = ref<number | ''>('')
const { data: monthList } = useAPI<string[]>('/commissions/months')
const { data: resp } = useAPI<any>(() => month.value ? `/commissions?month=${month.value}` : '')
const rows = computed(() => resp.value?.rows ?? [])
const pool = computed(() => resp.value?.pool ?? null)
const { data: ambassadors } = useAPI<any[]>('/ambassadors')

watch(monthList, (list) => {
  if (list && list.length && !month.value) month.value = list[0]
}, { immediate: true })

const monthLabel = computed(() => {
  if (!month.value) return '—'
  const [y, m] = month.value.split('-').map(Number)
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
})

const filteredRows = computed(() => {
  const list = rows.value
  if (!ambassadorFilter.value) return list
  return list.filter(r => r.ambassadorId === Number(ambassadorFilter.value))
})

// A fully-paid month's record is its payouts — once every row is frozen,
// the live pool numbers (budget/balance/per-member) no longer describe
// what happened, so the strip drops them rather than mixing live and frozen figures.
const monthFullySettled = computed(() =>
  filteredRows.value.length > 0 && filteredRows.value.every(r => r.paid === true))

const summary = computed(() => {
  const list = filteredRows.value
  const totalOwnSales = list.reduce((a, r) => a + Number(r.ownSales || 0), 0)
  const totalCommission = list.reduce((a, r) => a + Number(r.total || 0), 0)
  const totalBonus = list.reduce((a, r) => a + Number(r.bonus || 0), 0)
  return [
    { label: 'Earners', value: list.length, tone: 'ink' as const },
    { label: 'Sales pool', prefix: currencySymbol(), value: formatAmount(totalOwnSales) },
    { label: 'Commissions', prefix: currencySymbol(), value: formatAmount(totalCommission) },
    { label: 'Bonuses', prefix: currencySymbol(), value: formatAmount(totalBonus) },
    ...(pool.value && !monthFullySettled.value ? [
      { label: `Budget (${pool.value.capRate}%)`, prefix: currencySymbol(), value: formatAmount(pool.value.budget) },
      { label: 'Pool balance', prefix: currencySymbol(), value: formatAmount(pool.value.remainder) },
      { label: `Per member (×${pool.value.members})`, prefix: currencySymbol(), value: formatAmount(pool.value.share) },
    ] : []),
  ]
})

const ambassadorFilterOptions = computed(() => [
  { value: '', label: 'All ambassadors' },
  ...((ambassadors.value ?? []).map(a => ({ value: a.id, label: a.name }))),
])

const roleTone = (r: string) => {
  if (r === 'owner' || r === 'admin') return 'rose'
  if (r === 'leader') return 'amber'
  return 'slate'
}

// --- Date-range commission report (weekly submissions) ---
const showReport = ref(false)
const reportFrom = ref('')
const reportTo = ref('')
const exporting = ref(false)
const toast = useToast()

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function setPreset(preset: 'this-week' | 'last-week' | 'mtd') {
  const now = new Date()
  if (preset === 'mtd') {
    reportFrom.value = ymd(new Date(now.getFullYear(), now.getMonth(), 1))
    reportTo.value = ymd(now)
    return
  }
  // Weeks run Monday–Sunday
  const dow = (now.getDay() + 6) % 7
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow)
  if (preset === 'last-week') monday.setDate(monday.getDate() - 7)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  reportFrom.value = ymd(monday)
  reportTo.value = ymd(sunday)
}
watch(showReport, (v) => { if (v && !reportFrom.value) setPreset('last-week') })

async function exportReport() {
  if (!reportFrom.value || !reportTo.value || exporting.value) return
  exporting.value = true
  try {
    await downloadAuthed(`/commissions/report?from=${reportFrom.value}&to=${reportTo.value}`, 'commission-report.pdf')
    showReport.value = false
  } catch {
    toast.error('Could not generate the report')
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-2)]">Commissions for</p>
        <p class="font-display text-[18px] font-semibold text-[var(--color-ink)] tracking-tight">{{ monthLabel }}</p>
      </div>
      <div class="flex flex-col sm:flex-row sm:items-end gap-2">
        <AppMonthPills v-model="month" :months="monthList ?? []" label="Month" empty-text="No sales recorded yet" />
        <AppButton v-if="isAdmin" variant="secondary" class="shrink-0" @click="showReport = true">Export report</AppButton>
      </div>
    </div>

    <AppModal :open="showReport" title="Commission report" @close="showReport = false">
      <div class="space-y-4">
        <p class="text-[12.5px] text-[var(--color-muted)]">
          PDF of every earner's confirmed sales and base commission (frozen rates) for a date range —
          made for the weekly submission. Monthly bonuses settle at month close and are excluded.
        </p>
        <div class="flex flex-wrap gap-1.5">
          <AppButton size="sm" variant="ghost" @click="setPreset('this-week')">This week</AppButton>
          <AppButton size="sm" variant="ghost" @click="setPreset('last-week')">Last week</AppButton>
          <AppButton size="sm" variant="ghost" @click="setPreset('mtd')">Month to date</AppButton>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <AppInput v-model="reportFrom" type="date" label="From" />
          <AppInput v-model="reportTo" type="date" label="To" />
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="showReport = false">Cancel</AppButton>
        <AppButton :disabled="exporting || !reportFrom || !reportTo" @click="exportReport">
          {{ exporting ? 'Generating…' : 'Download PDF' }}
        </AppButton>
      </template>
    </AppModal>

    <AppStatStrip :stats="summary" />

    <div class="flex flex-col sm:flex-row gap-2 sm:items-center">
      <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Ambassador</span>
      <div class="sm:min-w-[220px]">
        <AppSelect v-model="ambassadorFilter" :options="ambassadorFilterOptions" />
      </div>
    </div>

    <AppTable :rows="filteredRows" empty-text="Commissions appear once sales are confirmed.">
      <template #head>
        <th class="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Name</th>
        <th class="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Role</th>
        <th class="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Own sales</th>
        <th class="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Own commission</th>
        <th class="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Bonus</th>
        <th class="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Total</th>
      </template>
      <template #row="{ row }">
        <td class="px-4 py-3 text-[13px] text-[var(--color-ink)]">
          <div class="font-medium">{{ row.name }}</div>
          <div class="text-[11px] text-[var(--color-muted-2)] mt-0.5">
            <span class="capitalize">{{ row.roleName }}</span>
            <span v-if="row.bonus > 0">
              · base {{ Number(row.ownCommission).toLocaleString() }} + bonus {{ Number(row.bonus).toLocaleString() }}
            </span>
            <span v-else>
              · base only
            </span>
          </div>
        </td>
        <td class="px-4 py-3"><AppBadge :tone="roleTone(row.roleName)">{{ row.roleName }}</AppBadge></td>
        <td class="px-4 py-3 text-[13px] text-right text-[var(--color-muted)] tabular">{{ formatRM(row.ownSales) }}</td>
        <td class="px-4 py-3 text-[13px] text-right text-[var(--color-muted)] tabular">{{ formatRM(row.ownCommission) }}</td>
        <td class="px-4 py-3 text-[13px] text-right text-[var(--color-muted)] tabular">{{ formatRM(row.bonus) }}</td>
        <td class="px-4 py-3 text-[13px] text-right font-semibold text-[var(--color-brand-dark)] tabular">
          <AppBadge v-if="row.paid" tone="emerald" class="mr-1.5">Paid</AppBadge>{{ formatRM(row.total) }}
        </td>
      </template>
    </AppTable>
  </div>
</template>
