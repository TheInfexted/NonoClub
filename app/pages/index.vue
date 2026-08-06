<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Chart from 'chart.js/auto'
import { TrophyIcon, ArrowTrendingUpIcon, BanknotesIcon, CheckBadgeIcon } from '@heroicons/vue/24/outline'
import { currentMonth } from '~/utils/dateFormat'
import { formatRM, formatAmount, currencySymbol } from '~/utils/currency'

const branding = inject<{ logoUrl: string | null; venueName: string } | null>('branding', null)
import { useAuthStore } from '~/stores/auth'

const auth = useAuthStore()
const month = ref('')

const { data: monthList } = useAPI<string[]>('/commissions/months')
watch(monthList, (list) => {
  if (list && list.length && !month.value) month.value = list[0]
  // Fall back to the calendar month only once the list has RESOLVED empty —
  // while it's still null (pending fetch) defaulting here would pin the
  // dashboard to a month with no sales and render a phantom pill.
  else if (Array.isArray(list) && list.length === 0 && !month.value) month.value = currentMonth()
}, { immediate: true })

const { data: resp } = useAPI<any>(() => month.value ? `/commissions?month=${month.value}` : '')
const commissions = computed(() => resp.value?.rows ?? [])
const { data: sales } = useAPI<any[]>(() => month.value ? `/sales?month=${month.value}` : '')
const { data: leaderboard } = useAPI<any[]>(() => month.value ? `/leaderboard?month=${month.value}&type=all` : '')
const { data: chartData } = useAPI<Array<{ month: string; totalSales: number; totalCommission: number }>>('/commissions/chart')

const me = computed(() => commissions.value?.find(r => r.userId === auth.user?.id))

const totalSales = computed(() =>
  (sales.value ?? [])
    .filter(s => s.status === 'confirmed')
    .reduce((a, s) => a + Number(s.amount || 0), 0))

const totalCommissions = computed(() =>
  (commissions.value ?? []).reduce((a, r) => a + Number(r.total || 0), 0))

const myCommission = computed(() => Number(me.value?.total ?? 0))

const confirmedCount = computed(() =>
  (sales.value ?? []).filter(s => s.status === 'confirmed').length)

const top5 = computed(() => (leaderboard.value ?? []).slice(0, 5))

const monthLabel = computed(() => {
  if (!month.value) return ''
  const [y, m] = month.value.split('-').map(Number)
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
})

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 5) return 'Working late'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  if (h < 22) return 'Good evening'
  return 'Working late'
})

const todayLabel = computed(() => {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
})

const salesChart = ref<HTMLCanvasElement | null>(null)
const commChart = ref<HTMLCanvasElement | null>(null)
let salesInst: Chart | null = null
let commInst: Chart | null = null

function shortMonth(ym: string) {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'short' })
}

function initials(name: string | undefined | null) {
  if (!name) return '·'
  return name.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

function chartOpts(seriesLabel: string, months: string[]): any {
  const fullMonthLabel = (idx: number) => {
    const m = months[idx]
    if (!m) return ''
    const [y, mo] = m.split('-').map(Number)
    return new Date(y, mo - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
  }
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false, axis: 'x' },
    hover: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        backgroundColor: 'rgba(14, 14, 16, 0.96)',
        borderColor: 'rgba(255,255,255,0.05)',
        borderWidth: 1,
        titleColor: '#ffffff',
        bodyColor: '#ffffff',
        titleFont: { family: 'Geist', weight: '600', size: 11 },
        bodyFont: { family: 'Geist Mono', weight: '500', size: 12 },
        padding: 12,
        cornerRadius: 10,
        displayColors: false,
        caretSize: 6,
        callbacks: {
          title: (items: any[]) => fullMonthLabel(items[0]?.dataIndex ?? 0),
          label: (ctx: any) => `${seriesLabel} · ${currencySymbol()} ${Number(ctx.parsed.y).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { display: false },
        ticks: { color: '#9A9AA1', font: { family: 'Geist Mono', size: 10 } },
      },
      y: {
        grid: { color: '#EFEAE2', drawTicks: false },
        border: { display: false },
        ticks: {
          color: '#9A9AA1',
          font: { family: 'Geist Mono', size: 10 },
          padding: 8,
          callback: (v: any) => `${currencySymbol()} ` + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v),
        },
        beginAtZero: true,
      },
    },
  }
}

// Charts read the design tokens so a tenant re-theme carries through —
// hex fallbacks only apply if the CSS variables are missing.
function themeColor(varName: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return v || fallback
}
const brandColor = () => themeColor('--color-brand', '#DC1A47')
const inkColor = () => themeColor('--color-ink', '#0E0E10')

function alphaGradient(ctx: CanvasRenderingContext2D, height: number, hex: string, topAlpha: number) {
  const g = ctx.createLinearGradient(0, 0, 0, height)
  const n = parseInt(hex.replace('#', ''), 16)
  const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
  g.addColorStop(0, `rgba(${rgb}, ${topAlpha})`)
  g.addColorStop(1, `rgba(${rgb}, 0)`)
  return g
}
const brandGradient = (ctx: CanvasRenderingContext2D, h: number) => alphaGradient(ctx, h, brandColor(), 0.28)
const inkGradient = (ctx: CanvasRenderingContext2D, h: number) => alphaGradient(ctx, h, inkColor(), 0.18)

function renderCharts() {
  const points = chartData.value ?? []
  const months = points.map(p => p.month)
  const labels = points.map(p => shortMonth(p.month))
  const salesData = points.map(p => p.totalSales)
  const commData = points.map(p => p.totalCommission)

  salesInst?.destroy()
  commInst?.destroy()

  if (salesChart.value) {
    const ctx = salesChart.value.getContext('2d')!
    salesInst = new Chart(salesChart.value, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Sales',
          data: salesData,
          borderColor: brandColor(),
          backgroundColor: brandGradient(ctx, 180),
          borderWidth: 2,
          fill: true,
          tension: 0.38,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointBackgroundColor: brandColor(),
          pointHoverBorderWidth: 2,
          pointHoverBorderColor: '#fff',
        }],
      },
      options: chartOpts('Sales', months),
    })
  }
  if (commChart.value) {
    const ctx = commChart.value.getContext('2d')!
    commInst = new Chart(commChart.value, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Commission',
          data: commData,
          borderColor: inkColor(),
          backgroundColor: inkGradient(ctx, 180),
          borderWidth: 2,
          fill: true,
          tension: 0.38,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointBackgroundColor: inkColor(),
          pointHoverBorderWidth: 2,
          pointHoverBorderColor: '#fff',
        }],
      },
      options: chartOpts('Commission', months),
    })
  }
}

watch(chartData, () => nextTick(renderCharts))
onMounted(() => nextTick(renderCharts))
onBeforeUnmount(() => {
  salesInst?.destroy()
  commInst?.destroy()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Editorial header -->
    <header class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div class="space-y-1">
        <p class="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--color-muted-2)] tabular">{{ todayLabel }}</p>
        <h1 class="font-display text-[26px] sm:text-[30px] lg:text-[34px] leading-[1.05] font-semibold tracking-tight text-[var(--color-ink)] text-balance">
          {{ greeting }}, {{ auth.user?.name?.split(' ')[0] ?? 'there' }}.
        </h1>
        <p class="text-[13px] text-[var(--color-muted)] max-w-[52ch]">
          {{ monthLabel ? `${monthLabel} · ${confirmedCount} confirmed sales · ${formatRM(totalSales)} in the room.` : 'No reporting period selected yet.' }}
        </p>
      </div>
      <div data-tour="month-pills"><AppMonthPills v-model="month" :months="monthList ?? []" empty-text="No sales recorded yet" /></div>
    </header>

    <!-- KPI strip — inverted hero + three accents -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3" data-tour="kpis">
      <AppCard tone="inverted" grain label="Total club sales" :prefix="currencySymbol()" :value="formatAmount(totalSales)">
        <template #icon>
          <span class="w-8 h-8 rounded-lg bg-white/8 flex items-center justify-center text-white/70">
            <ArrowTrendingUpIcon class="w-4 h-4" />
          </span>
        </template>
        <p class="mt-3 text-[11px] text-white/55 tabular">Across all confirmed entries · {{ monthLabel }}</p>
      </AppCard>

      <AppCard label="Commissions paid" :prefix="currencySymbol()" :value="formatAmount(totalCommissions)">
        <template #icon>
          <span class="w-8 h-8 rounded-lg bg-[var(--color-surface-2)] flex items-center justify-center text-[var(--color-muted)]">
            <BanknotesIcon class="w-4 h-4" />
          </span>
        </template>
        <p class="mt-3 text-[11px] text-[var(--color-muted-2)] tabular">Base + bonus across all earners</p>
      </AppCard>

      <AppCard label="My commission" :prefix="currencySymbol()" :value="formatAmount(myCommission)">
        <template #icon>
          <span class="w-8 h-8 rounded-lg bg-[var(--color-brand-soft)] flex items-center justify-center text-[var(--color-brand-dark)]">
            <TrophyIcon class="w-4 h-4" />
          </span>
        </template>
        <p class="mt-3 text-[11px] text-[var(--color-muted-2)] tabular">Personal earnings this period</p>
      </AppCard>

      <AppCard label="Confirmed sales" :value="confirmedCount">
        <template #icon>
          <span class="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-700">
            <CheckBadgeIcon class="w-4 h-4" />
          </span>
        </template>
        <p class="mt-3 text-[11px] text-[var(--color-muted-2)] tabular">Entries marked confirmed</p>
      </AppCard>
    </div>

    <!-- Trend charts -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="bg-[var(--color-card)] border border-[var(--color-border-2)] rounded-2xl p-5 shadow-card">
        <div class="flex items-start justify-between mb-4 gap-2">
          <div>
            <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-2)]">Sales trend</p>
            <p class="font-display text-[15px] font-semibold text-[var(--color-ink)] tracking-tight">Last 6 months</p>
          </div>
          <span class="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-muted)] tabular">
            <span class="w-2 h-2 rounded-full bg-[var(--color-brand)]" /> Sales
          </span>
        </div>
        <div class="h-[200px]"><canvas ref="salesChart" /></div>
      </div>
      <div class="bg-[var(--color-card)] border border-[var(--color-border-2)] rounded-2xl p-5 shadow-card">
        <div class="flex items-start justify-between mb-4 gap-2">
          <div>
            <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-2)]">Commission trend</p>
            <p class="font-display text-[15px] font-semibold text-[var(--color-ink)] tracking-tight">Last 6 months</p>
          </div>
          <span class="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-muted)] tabular">
            <span class="w-2 h-2 rounded-full bg-[var(--color-ink)]" /> Commission
          </span>
        </div>
        <div class="h-[200px]"><canvas ref="commChart" /></div>
      </div>
    </div>

    <!-- Top performers — full width -->
    <div class="bg-[var(--color-card)] border border-[var(--color-border-2)] rounded-2xl overflow-hidden shadow-card">
      <div class="px-5 py-4 border-b border-[var(--color-hairline)] flex items-center justify-between gap-3">
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-2)]">Top performers</p>
          <p class="font-display text-[15px] font-semibold text-[var(--color-ink)] tracking-tight">Top 5 · {{ monthLabel }}</p>
        </div>
        <div v-if="me" class="hidden sm:flex items-baseline gap-2 text-right">
          <span class="text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Your share</span>
          <span class="num-display text-[16px] font-semibold text-[var(--color-ink)] tabular-nums">{{ formatRM(me.total ?? 0) }}</span>
        </div>
      </div>

      <ul v-if="top5.length" class="divide-y divide-[var(--color-hairline)]">
        <li
          v-for="(row, i) in top5"
          :key="row.ambassadorId"
          class="flex items-center gap-4 px-5 py-3.5 hover:bg-[var(--color-hairline)]/50 transition-colors"
        >
          <span
            class="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold tabular tracking-tight shrink-0"
            :class="i === 0
              ? 'bg-[var(--color-ink)] text-white'
              : 'bg-[var(--color-surface-2)] text-[var(--color-muted)]'"
          >
            {{ String(i + 1).padStart(2, '0') }}
          </span>
          <div class="w-9 h-9 rounded-full bg-gradient-to-br from-[var(--color-ember)] to-[var(--color-brand)] flex items-center justify-center text-[11px] font-bold text-white shrink-0 ring-2 ring-white">
            {{ initials(row.name) }}
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-semibold text-[var(--color-ink)] truncate">{{ row.name }}</div>
            <div class="text-[11px] text-[var(--color-muted-2)] tabular">{{ row.saleCount }} {{ row.saleCount === 1 ? 'sale' : 'sales' }}</div>
          </div>
          <div class="text-right tabular shrink-0">
            <div class="text-[14px] font-semibold text-[var(--color-ink)] num-display">{{ formatRM(row.totalSales) }}</div>
            <div class="text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Sales</div>
          </div>
        </li>
      </ul>

      <div v-else class="px-5 py-12 text-center">
        <div class="inline-flex flex-col items-center gap-3 text-[var(--color-muted-2)]">
          <div class="w-12 h-12 rounded-2xl bg-[var(--color-surface-2)] flex items-center justify-center">
            <TrophyIcon class="w-6 h-6" />
          </div>
          <p class="text-[13px] font-medium text-[var(--color-muted)] max-w-[36ch] mx-auto text-balance">A quiet month so far. As sales get confirmed, the top five will appear here.</p>
        </div>
      </div>
    </div>

    <!-- Print signature -->
    <p class="pt-2 text-center text-[10px] uppercase tracking-[0.32em] text-[var(--color-muted-2)]">
      {{ branding?.venueName ?? 'The House Ledger' }} <span class="mx-1.5 opacity-50">·</span> {{ monthLabel || 'No period selected' }}
    </p>
  </div>
</template>
