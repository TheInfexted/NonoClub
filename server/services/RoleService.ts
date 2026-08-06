import { z } from 'zod'
import { RoleRepo } from '~~/server/repositories/RoleRepository'
import { ApiError } from '~~/server/utils/errors'
import { assertCan, type Actor } from '~~/server/utils/permissions'

const PayloadSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(40),
  tier: z.enum(['admin', 'ambassador']),
  baseRate: z.number().min(0).max(100),
  bonusRate: z.number().min(0).max(100).nullable(),
  requiresKpi: z.boolean(),
  kpiThreshold: z.number().min(0).nullable(),
  poolShare: z.boolean().optional().default(false),
  // Per-sale-type rate overrides; types without an entry use baseRate.
  rateOverrides: z.record(z.string().trim().min(1).max(40), z.number().min(0).max(100))
    .refine(o => Object.keys(o).length <= 20, 'Too many overrides')
    .nullish(),
})

/** The commission rate a sale of `saleType` earns under this plan. */
export function resolveCommissionRate(
  role: { baseRate: string; rateOverrides?: Record<string, string> | null },
  saleType: string,
): string {
  return role.rateOverrides?.[saleType] ?? role.baseRate
}
export type RolePayload = z.infer<typeof PayloadSchema>

function toSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())
}

export function validateRolePayload(input: unknown): RolePayload {
  const parsed = PayloadSchema.safeParse(input)
  if (!parsed.success) {
    const details: Record<string, string> = {}
    for (const i of parsed.error.issues) {
      const key = i.path.map((p) => (typeof p === 'string' ? toSnake(p) : String(p))).join('.')
      details[key] = i.message
    }
    throw ApiError.validation(details)
  }
  const v = parsed.data

  if (v.tier === 'admin') {
    return { ...v, requiresKpi: false, kpiThreshold: null }
  }
  if (v.requiresKpi && (v.kpiThreshold === null || v.kpiThreshold <= 0)) {
    throw ApiError.validation({ kpi_threshold: 'kpi_threshold required when requires_kpi is true' })
  }
  if (v.kpiThreshold !== null && (v.bonusRate === null || v.bonusRate <= 0)) {
    throw ApiError.validation({ bonus_rate: 'bonus_rate required when kpi_threshold is set' })
  }
  return v
}

export const RoleService = {
  // Commission roles of the active club — what the roles page manages.
  listForClub(clubId: number) {
    return RoleRepo.listByClub(clubId)
  },

  // Company-level staff roles — what the access page assigns to logins.
  listStaff() {
    return RoleRepo.listStaff()
  },

  async get(id: number) {
    const r = await RoleRepo.findById(id)
    if (!r) throw ApiError.notFound('Role')
    return r
  },

  async create(actor: Actor & { roleName: string; tier?: string }, clubId: number, body: unknown) {
    assertCan(actor, 'roles', 'edit')
    const v = validateRolePayload(body)

    if (v.tier === 'admin' && !(actor as any).isOwner) {
      throw ApiError.forbidden('Only the owner can create admin-tier roles')
    }
    const clubRoles = await RoleRepo.listByClub(clubId)
    if (clubRoles.some(r => r.name === v.name)) {
      throw ApiError.conflict('A role with that name already exists in this club')
    }

    const r = await RoleRepo.insert({
      name: v.name, tier: v.tier,
      baseRate: v.baseRate.toFixed(2),
      bonusRate: v.bonusRate === null ? null : v.bonusRate.toFixed(2),
      kpiThreshold: v.kpiThreshold === null ? null : v.kpiThreshold.toFixed(2),
      requiresKpi: v.requiresKpi ? 1 : 0,
      poolShare: v.poolShare ? 1 : 0,
      clubId,
      rateOverrides: v.rateOverrides
        ? Object.fromEntries(Object.entries(v.rateOverrides).map(([k, n]) => [k, n.toFixed(2)]))
        : null,
    })
    return await RoleRepo.findById((r as any)[0].insertId)
  },

  async update(actor: Actor & { roleName: string; tier?: string }, clubId: number, id: number, body: unknown) {
    assertCan(actor, 'roles', 'edit')
    const existing = await this.get(id)
    if (existing.clubId === null) {
      throw ApiError.forbidden('Staff roles are not managed here')
    }
    if (existing.clubId !== clubId) throw ApiError.notFound('Role')
    const v = validateRolePayload(body)

    if (existing.isSystem) {
      if (v.name !== existing.name) {
        throw ApiError.validation({ name: 'System role name cannot be changed' })
      }
      if (v.tier !== existing.tier) {
        throw ApiError.validation({ tier: 'System role tier cannot be changed' })
      }
    }
    if (v.tier === 'admin' && existing.tier !== 'admin' && !(actor as any).isOwner) {
      throw ApiError.forbidden('Only the owner can promote a role to admin tier')
    }
    if (v.name !== existing.name) {
      const clubRoles = await RoleRepo.listByClub(existing.clubId)
      if (clubRoles.some(r => r.name === v.name && r.id !== id)) {
        throw ApiError.conflict('A role with that name already exists in this club')
      }
    }

    await RoleRepo.update(id, {
      name: v.name, tier: v.tier,
      baseRate: v.baseRate.toFixed(2),
      bonusRate: v.bonusRate === null ? null : v.bonusRate.toFixed(2),
      kpiThreshold: v.kpiThreshold === null ? null : v.kpiThreshold.toFixed(2),
      requiresKpi: v.requiresKpi ? 1 : 0,
      poolShare: v.poolShare ? 1 : 0,
      rateOverrides: v.rateOverrides === undefined ? undefined : (
        v.rateOverrides
          ? Object.fromEntries(Object.entries(v.rateOverrides).map(([k, n]) => [k, n.toFixed(2)]))
          : null
      ),
    })
    return await this.get(id)
  },

  async remove(actor: Actor & { tier?: string }, clubId: number, id: number) {
    assertCan(actor, 'roles', 'edit')
    const existing = await this.get(id)
    if (existing.clubId === null) {
      throw ApiError.forbidden('Staff roles are not managed here')
    }
    if (existing.clubId !== clubId) throw ApiError.notFound('Role')
    if (existing.isSystem) throw ApiError.conflict('System roles cannot be deleted')
    const inUse = (await RoleRepo.countAmbassadorsUsing(id)) + (await RoleRepo.countUsersUsing(id))
    if (inUse > 0) throw ApiError.conflict(`Role is in use by ${inUse} record(s)`)
    await RoleRepo.delete(id)
  },
}
