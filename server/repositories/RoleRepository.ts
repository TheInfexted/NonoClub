import { eq, isNull } from 'drizzle-orm'
import { useDB, schema } from '~~/server/db/client'

export const RoleRepo = {
  list() {
    return useDB().select().from(schema.roles)
  },
  // Commission roles of one club
  listByClub(clubId: number) {
    return useDB().select().from(schema.roles).where(eq(schema.roles.clubId, clubId))
  },
  // Company-level staff roles (what user logins reference)
  listStaff() {
    return useDB().select().from(schema.roles).where(isNull(schema.roles.clubId))
  },
  findById(id: number) {
    return useDB().select().from(schema.roles).where(eq(schema.roles.id, id)).limit(1).then(r => r[0])
  },
  findByName(name: string) {
    return useDB().select().from(schema.roles).where(eq(schema.roles.name, name)).limit(1).then(r => r[0])
  },
  insert(values: {
    name: string
    tier: 'admin' | 'ambassador'
    baseRate: string
    bonusRate: string | null
    kpiThreshold: string | null
    requiresKpi: number
    poolShare: number
    isSystem?: number
    clubId?: number | null
    rateOverrides?: Record<string, string> | null
  }) {
    return useDB().insert(schema.roles).values({
      name: values.name,
      tier: values.tier,
      baseRate: values.baseRate,
      bonusRate: values.bonusRate,
      kpiThreshold: values.kpiThreshold,
      requiresKpi: values.requiresKpi,
      poolShare: values.poolShare,
      isSystem: values.isSystem ?? 0,
      clubId: values.clubId ?? null,
      rateOverrides: values.rateOverrides ?? null,
    })
  },
  update(id: number, patch: Partial<{
    name: string
    tier: 'admin' | 'ambassador'
    baseRate: string
    bonusRate: string | null
    kpiThreshold: string | null
    requiresKpi: number
    poolShare: number
    rateOverrides: Record<string, string> | null
  }>) {
    return useDB().update(schema.roles).set({ ...patch, updatedAt: new Date() }).where(eq(schema.roles.id, id))
  },
  delete(id: number) {
    return useDB().delete(schema.roles).where(eq(schema.roles.id, id))
  },
  countAmbassadorsUsing(id: number) {
    return useDB().select().from(schema.ambassadors).where(eq(schema.ambassadors.roleId, id))
      .then(rows => rows.length)
  },
  countUsersUsing(id: number) {
    return useDB().select().from(schema.users).where(eq(schema.users.roleId, id))
      .then(rows => rows.length)
  },
}
