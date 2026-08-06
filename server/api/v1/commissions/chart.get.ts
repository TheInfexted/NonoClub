import { assertCan } from '~~/server/utils/permissions'
import { like, isNull, and, eq } from 'drizzle-orm'
import { useDB, schema } from '~~/server/db/client'
import { computeCommissions, type CommissionRoleConfig, type CommissionEarner } from '~~/server/services/CommissionService'
import { ClubRepo } from '~~/server/repositories/ClubRepository'
import { requireClubId } from '~~/server/utils/club'

export default defineEventHandler(async (event) => {
  assertCan(event.context.user! as any, 'commissions', 'view')
  const clubId = await requireClubId(event)
  const db = useDB()

  // Build last 6 months including current
  const months: string[] = []
  const now = new Date()
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  // Load roles, users, and ambassadors once
  const roleRows = await db.select().from(schema.roles)
  const club = await ClubRepo.findById(clubId)
  const capRate = club?.commissionCapRate == null ? null : Number(club.commissionCapRate)

  const userRows = await db.select({
    id: schema.users.id,
    name: schema.users.name,
    ambassadorId: schema.users.ambassadorId,
  })
    .from(schema.users)
    .where(isNull(schema.users.deletedAt))

  const ambassadorRows = await db.select({
    id: schema.ambassadors.id,
    name: schema.ambassadors.name,
    roleId: schema.ambassadors.roleId,
  })
    .from(schema.ambassadors)
    .where(and(isNull(schema.ambassadors.deletedAt), eq(schema.ambassadors.clubId, clubId)))

  const userByAmbassador = new Map<number, typeof userRows[number]>()
  for (const u of userRows) {
    if (u.ambassadorId != null) userByAmbassador.set(u.ambassadorId, u)
  }

  const earners: CommissionEarner[] = ambassadorRows.map(a => {
    const u = userByAmbassador.get(a.id)
    return {
      userId: u?.id ?? -a.id,
      name: a.name,
      roleId: a.roleId,
      ambassadorId: a.id,
    }
  })

  const roles: CommissionRoleConfig[] = roleRows.map(r => ({
    id: r.id,
    name: r.name,
    tier: r.tier,
    baseRate: Number(r.baseRate),
    bonusRate: r.bonusRate === null ? null : Number(r.bonusRate),
    requiresKpi: r.requiresKpi === 1,
    kpiThreshold: r.kpiThreshold === null ? null : Number(r.kpiThreshold),
    poolShare: r.poolShare === 1,
  }))

  const result: Array<{ month: string; totalSales: number; totalCommission: number }> = []
  for (const month of months) {
    const saleRows = await db.select().from(schema.sales)
      .where(and(like(schema.sales.date, `${month}%`), eq(schema.sales.clubId, clubId)))
    const sales = saleRows.map(s => ({
      id: s.id,
      date: s.date,
      ambassadorId: s.ambassadorId,
      amount: s.amount,
      status: s.status,
      type: s.type as 'Table' | 'BGO',
      confirmedCommissionRate: s.confirmedCommissionRate,
      confirmedBonusRate: s.confirmedBonusRate,
    }))
    const totalSales = sales
      .filter(s => s.status === 'confirmed')
      .reduce((a, s) => a + Number(s.amount), 0)
    const { rows } = computeCommissions({ month, roles, earners, sales, capRate })
    const totalCommission = rows.reduce((a, r) => a + r.total, 0)
    result.push({ month, totalSales, totalCommission })
  }
  return result
})
