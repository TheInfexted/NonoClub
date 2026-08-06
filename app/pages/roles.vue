<script setup lang="ts">
import { currencySymbol } from '~/utils/currency'
definePageMeta({ middleware: ['role'] })
const { data: roles, refresh } = useAPI<any[]>('/roles')
const showAdd = ref(false)
const editing = ref<any | null>(null)
const m = useAPIMutation()
const confirm = useConfirm()
const toast = useToast()

async function remove(row: any) {
  if (!await confirm(`Delete role "${row.name}"?`, { tone: 'danger', confirmText: 'Delete' })) return
  try {
    await m.del(`/roles/${row.id}`)
    await refresh()
    toast.success('Role deleted')
  } catch (e: any) {
    toast.error(e?.data?.error?.message || 'Failed to delete role')
  }
}

function fmtBonus(r: any) {
  if (r.poolShare) return 'splits remaining pool'
  if (r.bonusRate === null) return '— no bonus'
  return `+${Number(r.bonusRate).toFixed(2)}% bonus`
}
function fmtKpi(r: any) {
  if (!r.requiresKpi || !r.kpiThreshold) return ''
  return `KPI: hit ${currencySymbol()} ${Number(r.kpiThreshold).toLocaleString()}`
}
function fmtOverrides(r: any) {
  const o = r.rateOverrides
  if (!o || !Object.keys(o).length) return ''
  return Object.entries(o).map(([t, v]) => `${t} ${Number(v)}%`).join(' · ')
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <p class="text-[13px] text-[var(--color-muted)]">
        Each rate plan bundles the commission rates, bonus, and KPI an ambassador earns under — per club.
      </p>
      <AppButton @click="showAdd = true">+ New plan</AppButton>
    </div>

    <div data-tour="roles-table">
    <AppTable :rows="roles ?? []" empty-text="No rate plans yet — a plan bundles the rates, bonus, and KPI an ambassador earns under.">
      <template #empty-action>
        <AppButton size="sm" @click="showAdd = true">+ New plan</AppButton>
      </template>
      <template #head>
        <th class="px-4 py-3 text-left text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Name</th>
        <th class="px-4 py-3 text-left text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Tier</th>
        <th class="px-4 py-3 text-right text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Base</th>
        <th class="px-4 py-3 text-left text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Bonus / KPI</th>
        <th class="px-4 py-3" />
      </template>
      <template #row="{ row }">
        <td class="px-4 py-3 text-[13px] font-medium text-[var(--color-ink)]">
          <span class="inline-flex items-center gap-2">
            {{ row.name }}
            <AppBadge v-if="row.isSystem" tone="slate" :dot="false" shape="square">System</AppBadge>
          </span>
        </td>
        <td class="px-4 py-3 text-[13px] text-[var(--color-muted)] capitalize">{{ row.tier }}</td>
        <td class="px-4 py-3 text-[13px] text-right font-semibold text-[var(--color-ink)] tabular">
          {{ Number(row.baseRate).toFixed(2) }}%
          <div v-if="fmtOverrides(row)" class="text-[10.5px] font-normal text-[var(--color-muted-2)] tabular">{{ fmtOverrides(row) }}</div>
        </td>
        <td class="px-4 py-3 text-[12px] text-[var(--color-muted)]">
          <div>{{ fmtBonus(row) }}</div>
          <div v-if="fmtKpi(row)" class="text-[var(--color-muted-2)]">{{ fmtKpi(row) }}</div>
        </td>
        <td class="px-4 py-3 text-right">
          <div class="inline-flex gap-1.5">
            <AppButton size="sm" variant="secondary" @click="editing = row; showAdd = true">Edit</AppButton>
            <AppButton size="sm" variant="danger" :disabled="!!row.isSystem" @click="remove(row)">Delete</AppButton>
          </div>
        </td>
      </template>
    </AppTable>
    </div>

    <RoleEditorModal
      :open="showAdd"
      :role="editing"
      @close="showAdd = false; editing = null"
      @saved="refresh"
    />
  </div>
</template>
