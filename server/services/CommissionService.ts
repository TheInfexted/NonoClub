import { eq, and, like, isNull } from 'drizzle-orm'
import { useDB, schema } from '~~/server/db/client'
import { ClubRepo } from '~~/server/repositories/ClubRepository'
import { PayoutRepo } from '~~/server/repositories/PayoutRepository'

export interface CommissionRoleConfig {
  id: number
  name: string
  tier: 'admin' | 'ambassador'
  baseRate: number
  bonusRate: number | null
  requiresKpi: boolean
  kpiThreshold: number | null
  poolShare?: boolean
}

export interface CommissionEarner {
  userId: number
  name: string
  roleId: number
  ambassadorId: number
}

export interface CommissionSale {
  id: number
  date: string
  ambassadorId: number
  amount: string
  status: 'draft' | 'confirmed' | 'voided'
  type: string
  confirmedCommissionRate: string | null
  confirmedBonusRate: string | null
}

export interface CommissionRow {
  userId: number
  ambassadorId: number
  name: string
  roleId: number
  roleName: string
  tier: 'admin' | 'ambassador'
  ownSales: number
  ownCommission: number
  bonus: number
  total: number
  paid: boolean
}

export interface PoolSummary {
  capRate: number
  budget: number
  used: number
  remainder: number
  share: number
  members: number
}

export function computeCommissions(input: {
  month: string
  roles: ReadonlyArray<CommissionRoleConfig>
  earners: ReadonlyArray<CommissionEarner>
  sales: ReadonlyArray<CommissionSale>
  capRate?: number | null
}): { rows: CommissionRow[], pool: PoolSummary | null } {
  const confirmed = input.sales.filter(s => s.status === 'confirmed')
  const totalPool = confirmed.reduce((a, s) => a + Number(s.amount), 0)
  const rolesById = new Map(input.roles.map(r => [r.id, r]))

  const rows = input.earners.map((e): CommissionRow => {
    const role = rolesById.get(e.roleId)
    if (!role) throw new Error(`Earner ${e.name} references unknown roleId ${e.roleId}`)

    const own = confirmed.filter(s => s.ambassadorId === e.ambassadorId)
    const ownSales = own.reduce((a, s) => a + Number(s.amount), 0)
    const ownCommission = own.reduce(
      (a, s) => a + Number(s.amount) * Number(s.confirmedCommissionRate ?? 0) / 100,
      0,
    )

    let bonus = 0
    if (role.tier === 'ambassador' && role.bonusRate !== null && role.bonusRate > 0) {
      const kpiPassed = !role.requiresKpi || (role.kpiThreshold !== null && ownSales >= role.kpiThreshold)
      if (kpiPassed) bonus = ownSales * role.bonusRate / 100
    }

    return {
      userId: e.userId,
      ambassadorId: e.ambassadorId,
      name: e.name,
      roleId: e.roleId,
      roleName: role.name,
      tier: role.tier,
      ownSales: round2(ownSales),
      ownCommission: round2(ownCommission),
      bonus: round2(bonus),
      total: round2(ownCommission + bonus),
      paid: false,
    }
  })

  let pool: PoolSummary | null = null
  if (input.capRate != null) {
    const budget = round2(totalPool * input.capRate / 100)
    const used = round2(rows.reduce((a, r) => a + r.ownCommission + r.bonus, 0))
    const remainder = Math.max(0, round2(budget - used))
    const poolRows = rows.filter(r => rolesById.get(r.roleId)?.poolShare)
    const share = poolRows.length ? round2(remainder / poolRows.length) : 0
    for (const r of poolRows) {
      r.bonus = round2(r.bonus + share)
      r.total = round2(r.ownCommission + r.bonus)
    }
    pool = { capRate: input.capRate, budget, used, remainder, share, members: poolRows.length }
  }

  return { rows, pool }
}

function round2(n: number) { return Math.round(n * 100) / 100 }

export function applyPayoutFreeze(
  rows: CommissionRow[],
  payouts: ReadonlyArray<{ ambassadorId: number; amount: string }>,
): CommissionRow[] {
  const paidBy = new Map<number, number>()
  for (const p of payouts) paidBy.set(p.ambassadorId, (paidBy.get(p.ambassadorId) ?? 0) + Number(p.amount))
  for (const r of rows) {
    const paid = paidBy.get(r.ambassadorId)
    if (paid === undefined) continue
    r.paid = true
    r.total = round2(paid)
    r.bonus = Math.max(0, round2(r.total - r.ownCommission))
  }
  return rows
}

export async function loadCommissions(clubId: number, month: string): Promise<{ rows: CommissionRow[], pool: PoolSummary | null }> {
  const db = useDB()
  const roleRows = await db.select().from(schema.roles)
  const club = await ClubRepo.findById(clubId)
  const payoutRows = await PayoutRepo.list({ clubId, month })

  const userRows = await db.select({
    id: schema.users.id, name: schema.users.name, ambassadorId: schema.users.ambassadorId,
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

  const saleRows = await db.select().from(schema.sales)
    .where(and(like(schema.sales.date, `${month}%`), eq(schema.sales.clubId, clubId)))

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

  const roleConfigs: CommissionRoleConfig[] = roleRows.map(r => ({
    id: r.id,
    name: r.name,
    tier: r.tier,
    baseRate: Number(r.baseRate),
    bonusRate: r.bonusRate === null ? null : Number(r.bonusRate),
    requiresKpi: r.requiresKpi === 1,
    kpiThreshold: r.kpiThreshold === null ? null : Number(r.kpiThreshold),
    poolShare: r.poolShare === 1,
  }))

  const { rows, pool } = computeCommissions({
    month,
    roles: roleConfigs,
    earners,
    sales: saleRows.map(s => ({
      id: s.id, date: s.date, ambassadorId: s.ambassadorId, amount: s.amount,
      status: s.status, type: s.type,
      confirmedCommissionRate: s.confirmedCommissionRate, confirmedBonusRate: s.confirmedBonusRate,
    })),
    capRate: club?.commissionCapRate == null ? null : Number(club.commissionCapRate),
  })
  applyPayoutFreeze(rows, payoutRows)
  return { rows, pool }
}
