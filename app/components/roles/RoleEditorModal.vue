<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { currencySymbol } from '~/utils/currency'

interface Role {
  id?: number
  name: string
  tier: 'admin' | 'ambassador'
  baseRate: string | number
  bonusRate: string | number | null
  kpiThreshold: string | number | null
  requiresKpi: number | boolean
  poolShare?: number | boolean
  isSystem?: number
  rateOverrides?: Record<string, string> | null
}

const props = defineProps<{ open: boolean; role: Role | null }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()

const auth = useAuthStore()
const isOwner = computed(() => !!(auth.user as any)?.isOwner)
const m = useAPIMutation()
const toast = useToast()
const saving = ref(false)

// Active sale types of the current club — each may carry its own rate.
const { data: saleTypes } = useAPI<Array<{ name: string; isActive: number }>>('/sale-types')
const activeTypes = computed(() => (saleTypes.value ?? []).filter(t => t.isActive === 1).map(t => t.name))

const blank = (): Role => ({
  name: '', tier: 'ambassador', baseRate: 0, bonusRate: null,
  kpiThreshold: null, requiresKpi: false, poolShare: false, isSystem: 0,
})
const form = ref<Role>(blank())
const overrides = ref<Record<string, number | ''>>({})

watch([() => props.role, activeTypes], ([r]) => {
  form.value = r ? {
    ...r,
    baseRate: Number(r.baseRate),
    bonusRate: r.bonusRate === null ? null : Number(r.bonusRate),
    kpiThreshold: r.kpiThreshold === null ? null : Number(r.kpiThreshold),
    requiresKpi: !!r.requiresKpi,
    poolShare: !!r.poolShare,
  } : blank()
  const seeded: Record<string, number | ''> = {}
  for (const t of activeTypes.value) {
    const v = (r as Role | null)?.rateOverrides?.[t]
    seeded[t] = v === undefined || v === null ? '' : Number(v)
  }
  overrides.value = seeded
}, { immediate: true })

const isEdit = computed(() => !!props.role?.id)
const isSystemRole = computed(() => !!props.role?.isSystem)
const showKpi = computed(() => form.value.tier === 'ambassador' && Number(form.value.bonusRate) > 0)

async function save() {
  saving.value = true
  try {
    const filled = Object.entries(overrides.value)
      .filter(([, v]) => v !== '' && v !== null && Number.isFinite(Number(v)))
      .map(([k, v]) => [k, Number(v)] as const)
    const payload = {
      name: typeof form.value.name === 'string' ? form.value.name.trim() : form.value.name,
      tier: form.value.tier,
      baseRate: Number(form.value.baseRate),
      bonusRate: form.value.bonusRate === null || form.value.bonusRate === '' ? null : Number(form.value.bonusRate),
      requiresKpi: !!form.value.requiresKpi,
      kpiThreshold: form.value.kpiThreshold === null || form.value.kpiThreshold === '' ? null : Number(form.value.kpiThreshold),
      poolShare: !!form.value.poolShare,
      rateOverrides: filled.length ? Object.fromEntries(filled) : null,
    }
    if (isEdit.value) await m.put(`/roles/${props.role!.id}`, payload)
    else await m.post('/roles', payload)
    emit('saved')
    emit('close')
    toast.success(isEdit.value ? 'Rate plan updated' : 'Rate plan created')
  } catch (e: any) {
    toast.error(e?.data?.error?.message || 'Failed to save rate plan')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AppModal :open="open" :title="isEdit ? 'Edit rate plan' : 'New rate plan'" size="md" @close="emit('close')">
    <div class="space-y-4">
      <AppInput v-model="form.name" label="Plan name" :disabled="isSystemRole" />
      <AppSelect
        v-model="form.tier"
        :options="[
          { value: 'ambassador', label: 'Ambassador tier — own-sales bonus, optional KPI' },
          { value: 'admin', label: 'Admin tier — company-pool bonus, full permissions', disabled: !isOwner },
        ]"
        :disabled="isSystemRole"
        label="Tier"
      />
      <AppInput v-model="form.baseRate" type="number" label="Base commission rate (%)" />

      <div v-if="activeTypes.length" class="space-y-2 p-3 rounded-lg bg-[var(--color-surface-2)]">
        <p class="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-2)]">Per-type rates (optional)</p>
        <p class="text-[11.5px] text-[var(--color-muted)]">Leave a type blank to use the base rate.</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <AppInput
            v-for="t in activeTypes" :key="t"
            v-model="overrides[t]"
            type="number"
            :label="`${t} rate (%)`"
            :placeholder="String(form.baseRate)"
          />
        </div>
      </div>

      <AppInput v-if="form.tier !== 'admin'" v-model="form.bonusRate" type="number" label="Bonus commission rate (%) — optional, leave blank for none" />
      <div v-if="showKpi" class="space-y-3 p-3 rounded-lg bg-[var(--color-surface-2)]">
        <label class="flex items-center gap-2 text-[13px] cursor-pointer">
          <input v-model="form.requiresKpi" type="checkbox" class="w-4 h-4 rounded" />
          Requires KPI to earn bonus
        </label>
        <AppInput v-if="form.requiresKpi" v-model="form.kpiThreshold" type="number" :label="`KPI threshold (${currencySymbol()} own monthly sales)`" />
      </div>
      <label class="flex items-center gap-2 text-[13px] text-[var(--color-ink)] cursor-pointer">
        <input v-model="form.poolShare" type="checkbox" class="w-4 h-4 rounded" />
        Splits the remaining monthly pool (club cap − everyone's commissions)
      </label>
      <p class="text-[11px] text-[var(--color-muted-2)]">
        Changes affect future sale confirmations only. Bonus uses current settings until the month's batch payout is created.
      </p>
    </div>
    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">Cancel</AppButton>
      <AppButton :disabled="saving || !String(form.name).trim()" @click="save">
        {{ saving ? 'Saving…' : (isEdit ? 'Save' : 'Create') }}
      </AppButton>
    </template>
  </AppModal>
</template>
