<script setup lang="ts">
import { ref, computed } from 'vue'
import { BuildingStorefrontIcon, CheckBadgeIcon, PlusIcon } from '@heroicons/vue/24/outline'
import { useAuthStore } from '~/stores/auth'
import { useClub } from '~/composables/useClub'

const auth = useAuthStore()
const { activeClubId, setClub, refreshClubs } = useClub()
const { data: clubs, refresh } = useAPI<Array<{
  id: number; name: string; logoPath: string | null; ambassadors: number; sales: number
  commissionCapRate: string | null
}>>('/clubs?stats=1')

const m = useAPIMutation()
const confirm = useConfirm()
const toast = useToast()
const router = useRouter()
const isAdmin = computed(() => auth.user?.tier === 'admin')

const showCreate = ref(false)
const newName = ref('')
const creating = ref(false)
const renaming = ref<{ id: number; name: string; commissionCapRate: string } | null>(null)

async function createClub() {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    const club = await m.post<{ id: number }>('/clubs', { name })
    await Promise.all([refresh(), refreshClubs()])
    showCreate.value = false
    newName.value = ''
    toast.success(`Club “${name}” created`)
    if (club?.id) setClub(club.id)
  } catch (e: any) {
    toast.error(e?.data?.error?.message ?? 'Could not create club')
  } finally {
    creating.value = false
  }
}

async function saveRename() {
  if (!renaming.value) return
  const { id, name } = renaming.value
  if (!name.trim()) return
  try {
    await m.put(`/clubs/${id}`, {
      name: name.trim(),
      commissionCapRate: renaming.value.commissionCapRate === '' ? null : Number(renaming.value.commissionCapRate),
    })
    await Promise.all([refresh(), refreshClubs()])
    useState('branding-rev', () => 0).value++
    renaming.value = null
    toast.success('Club updated')
  } catch (e: any) {
    toast.error(e?.data?.error?.message ?? 'Rename failed')
  }
}

async function removeClub(c: { id: number; name: string }) {
  if (!await confirm(`Delete ${c.name}? Only possible while it has no data.`, { tone: 'danger', confirmText: 'Delete' })) return
  try {
    await m.del(`/clubs/${c.id}`)
    await Promise.all([refresh(), refreshClubs()])
    toast.success('Club deleted')
  } catch (e: any) {
    toast.error(e?.data?.error?.message ?? 'Delete failed')
  }
}

function switchTo(id: number) {
  setClub(id)
  router.push('/')
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <p class="text-[13px] text-[var(--color-muted)] max-w-prose">
        Every club keeps its own ambassadors, commission roles, sale types, and ledger.
      </p>
      <AppButton v-if="isAdmin" class="w-full sm:w-auto" @click="showCreate = true">
        <PlusIcon class="w-4 h-4 mr-1 -ml-0.5 inline" aria-hidden="true" /> New club
      </AppButton>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
      <section
        v-for="c in clubs ?? []"
        :key="c.id"
        class="bg-[var(--color-card)] border rounded-2xl p-5 shadow-card space-y-4"
        :class="c.id === activeClubId ? 'border-[var(--color-brand)]/40 ring-1 ring-[var(--color-brand)]/20' : 'border-[var(--color-border-2)]'"
      >
        <div class="flex items-start gap-3">
          <div class="w-11 h-11 rounded-xl bg-[var(--color-ink)] overflow-hidden flex items-center justify-center shrink-0 ring-1 ring-black/10">
            <img
              v-if="c.logoPath"
              :src="`/api/v1/branding/logo?club=${c.id}`"
              alt=""
              class="w-full h-full object-cover"
            />
            <BuildingStorefrontIcon v-else class="w-5 h-5 text-white/60" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <h3 class="font-display text-[16px] font-semibold text-[var(--color-ink)] tracking-tight truncate">{{ c.name }}</h3>
            <p class="text-[11.5px] text-[var(--color-muted-2)] tabular mt-0.5">
              {{ c.ambassadors }} ambassador{{ c.ambassadors === 1 ? '' : 's' }} · {{ c.sales }} sale{{ c.sales === 1 ? '' : 's' }}
            </p>
          </div>
          <AppBadge v-if="c.id === activeClubId" tone="rose" :dot="false" shape="square">
            <CheckBadgeIcon class="w-3.5 h-3.5 mr-0.5 inline" aria-hidden="true" /> Active
          </AppBadge>
        </div>

        <div class="flex items-center gap-1.5">
          <AppButton v-if="c.id !== activeClubId" size="sm" @click="switchTo(c.id)">Switch to this club</AppButton>
          <span v-else class="text-[12px] text-[var(--color-muted-2)]">You're working in this club.</span>
          <span class="flex-1" />
          <template v-if="isAdmin">
            <AppButton
              size="sm" variant="secondary"
              @click="renaming = { id: c.id, name: c.name, commissionCapRate: c.commissionCapRate == null ? '' : String(Number(c.commissionCapRate)) }"
            >Edit</AppButton>
            <AppButton
              size="sm" variant="danger"
              :disabled="c.ambassadors > 0 || c.sales > 0 || (clubs ?? []).length <= 1"
              @click="removeClub(c)"
            >Delete</AppButton>
          </template>
        </div>
      </section>
    </div>

    <AppModal :open="showCreate" title="New club" @close="showCreate = false">
      <div class="space-y-3">
        <AppInput v-model="newName" label="Club name" placeholder="e.g. Neon KL" @keyup.enter="createClub" />
        <p class="text-[12px] text-[var(--color-muted-2)]">
          Starts with its own Leader and Ambassador commission roles and Table/BGO sale types — all editable.
        </p>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="showCreate = false">Cancel</AppButton>
        <AppButton :disabled="creating || !newName.trim()" @click="createClub">Create club</AppButton>
      </template>
    </AppModal>

    <AppModal :open="!!renaming" title="Edit club" @close="renaming = null">
      <div v-if="renaming" class="space-y-3">
        <AppInput v-model="renaming.name" label="Club name" @keyup.enter="saveRename" />
        <AppInput v-model="renaming.commissionCapRate" type="number" label="Commission cap (% of monthly sales) — blank for none" />
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="renaming = null">Cancel</AppButton>
        <AppButton :disabled="!renaming?.name.trim()" @click="saveRename">Save</AppButton>
      </template>
    </AppModal>
  </div>
</template>
