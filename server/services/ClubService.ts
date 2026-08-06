import { z } from 'zod'
import { ClubRepo } from '~~/server/repositories/ClubRepository'
import { RoleRepo } from '~~/server/repositories/RoleRepository'
import { SaleTypeRepo } from '~~/server/repositories/SaleTypeRepository'
import { ApiError } from '~~/server/utils/errors'
import { assertCan, type Actor } from '~~/server/utils/permissions'

const NameSchema = z.object({ name: z.string().min(1).max(120) })
const UpdateSchema = z.object({
  name: z.string().min(1).max(120),
  commissionCapRate: z.number().min(0).max(100).nullable().optional(),
})

function assertAdminTier(actor: Actor & { tier?: string }) {
  assertCan(actor, 'clubs', 'edit')
}

// Owner-managed club restrictions: null clubAccess = every club.
function filterByAccess<T extends { id: number }>(actor: Actor, clubs: T[]): T[] {
  const a = actor as any
  if (a.isOwner || !Array.isArray(a.clubAccess)) return clubs
  const allowed = new Set<number>(a.clubAccess)
  return clubs.filter(c => allowed.has(c.id))
}

// Every new club starts with editable commission-role scaffolding so the
// roles page is never empty and ambassadors can be created immediately.
const DEFAULT_CLUB_ROLES = [
  { name: 'Leader', tier: 'ambassador' as const, baseRate: '8.00' },
  { name: 'Ambassador', tier: 'ambassador' as const, baseRate: '8.00' },
]

export const ClubService = {
  async list(actor: Actor) {
    return filterByAccess(actor, await ClubRepo.list())
  },

  async listWithStats(actor: Actor) {
    const [clubs, stats] = await Promise.all([ClubRepo.list(), ClubRepo.stats()])
    return filterByAccess(actor, clubs).map(c => ({
      ...c,
      ambassadors: stats[c.id]?.ambassadors ?? 0,
      sales: stats[c.id]?.sales ?? 0,
    }))
  },

  async create(actor: Actor & { tier?: string }, body: unknown) {
    assertAdminTier(actor)
    const v = NameSchema.parse(body)
    const r = await ClubRepo.insert({ name: v.name })
    const clubId = (r as any)[0].insertId as number
    for (const role of DEFAULT_CLUB_ROLES) {
      await RoleRepo.insert({
        name: role.name, tier: role.tier, baseRate: role.baseRate,
        bonusRate: null, kpiThreshold: null, requiresKpi: 0, clubId,
      })
    }
    await SaleTypeRepo.insert({ clubId, name: 'Table', sortOrder: 0 })
    await SaleTypeRepo.insert({ clubId, name: 'BGO', sortOrder: 1 })
    return ClubRepo.findById(clubId)
  },

  async update(actor: Actor & { tier?: string }, id: number, body: unknown) {
    assertAdminTier(actor)
    const club = await ClubRepo.findById(id)
    if (!club || club.deletedAt) throw ApiError.notFound('Club')
    const v = UpdateSchema.parse(body)
    const patch = {
      name: v.name,
      ...(v.commissionCapRate === undefined
        ? {}
        : { commissionCapRate: v.commissionCapRate === null ? null : v.commissionCapRate.toFixed(2) }),
    }
    await ClubRepo.update(id, patch)
    return ClubRepo.findById(id)
  },

  async remove(actor: Actor & { tier?: string }, id: number) {
    assertAdminTier(actor)
    const club = await ClubRepo.findById(id)
    if (!club || club.deletedAt) throw ApiError.notFound('Club')
    const all = await ClubRepo.list()
    if (all.length <= 1) throw ApiError.conflict('Cannot delete the only club')
    const rows = await ClubRepo.countScopedRows(id)
    if (rows > 0) throw ApiError.conflict('Club still has teams, ambassadors, sales or payouts')
    await ClubRepo.softDelete(id)
  },
}
