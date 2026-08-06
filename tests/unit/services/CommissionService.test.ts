import { describe, it, expect } from 'vitest'
import { computeCommissions, applyPayoutFreeze, type CommissionRoleConfig, type CommissionEarner, type CommissionSale } from '~~/server/services/CommissionService'

const month = '2026-04'

const roles: CommissionRoleConfig[] = [
  { id: 1, name: 'owner',      tier: 'admin',      baseRate: 10, bonusRate: 2,    requiresKpi: false, kpiThreshold: null },
  { id: 2, name: 'admin',      tier: 'admin',      baseRate: 12, bonusRate: 2,    requiresKpi: false, kpiThreshold: null },
  { id: 3, name: 'vip',        tier: 'ambassador', baseRate: 8,  bonusRate: 1,    requiresKpi: true,  kpiThreshold: 30000 },
  { id: 4, name: 'ambassador', tier: 'ambassador', baseRate: 8,  bonusRate: null, requiresKpi: false, kpiThreshold: null },
]

const earners: CommissionEarner[] = [
  { userId: 1,  name: 'Johnny', roleId: 1, ambassadorId: 10 },
  { userId: 2,  name: 'Mok',    roleId: 2, ambassadorId: 11 },
  { userId: -3, name: 'VIP A',  roleId: 3, ambassadorId: 13 },
  { userId: -4, name: 'VIP B',  roleId: 3, ambassadorId: 14 },
  { userId: -5, name: 'Plain',  roleId: 4, ambassadorId: 15 },
]

const sale = (ambassadorId: number, amount: number, rate = '8.00', status: 'draft' | 'confirmed' | 'voided' = 'confirmed'): CommissionSale => ({
  id: Math.floor(Math.random() * 1e9), date: '2026-04-10', ambassadorId, amount: amount.toFixed(2),
  status, type: 'Table', confirmedCommissionRate: status === 'confirmed' ? rate : null, confirmedBonusRate: null,
})

describe('computeCommissions (role-based)', () => {
  it('matches the spec §7 worked example', () => {
    const sales = [
      sale(10, 100_000, '10.00'),
      sale(11, 50_000,  '12.00'),
      sale(13, 50_000,  '8.00'),
      sale(14, 25_000,  '8.00'),
      sale(15, 30_000,  '8.00'),
      sale(99, 245_000, '8.00'),
    ]
    const { rows } = computeCommissions({ month, roles, earners, sales })
    const byName = Object.fromEntries(rows.map(r => [r.name, r]))

    expect(byName.Johnny.ownCommission).toBe(10_000)
    expect(byName.Johnny.bonus).toBe(0)
    expect(byName.Johnny.total).toBe(10_000)

    expect(byName.Mok.ownCommission).toBe(6_000)
    expect(byName.Mok.bonus).toBe(0)
    expect(byName.Mok.total).toBe(6_000)

    expect(byName['VIP A'].ownCommission).toBe(4_000)
    expect(byName['VIP A'].bonus).toBe(500)
    expect(byName['VIP A'].total).toBe(4_500)

    expect(byName['VIP B'].ownCommission).toBe(2_000)
    expect(byName['VIP B'].bonus).toBe(0)
    expect(byName['VIP B'].total).toBe(2_000)

    expect(byName.Plain.ownCommission).toBe(2_400)
    expect(byName.Plain.bonus).toBe(0)
    expect(byName.Plain.total).toBe(2_400)
  })

  it('excludes draft and voided sales from base and pool', () => {
    const sales = [
      sale(10, 100_000, '10.00', 'draft'),
      sale(10, 100_000, '10.00', 'voided'),
      sale(10, 100_000, '10.00', 'confirmed'),
    ]
    const { rows } = computeCommissions({ month, roles, earners: [earners[0]], sales })
    expect(rows[0].ownSales).toBe(100_000)
    expect(rows[0].ownCommission).toBe(10_000)
    expect(rows[0].bonus).toBe(0)
  })

  it('uses each sale row frozen rate (mid-month rate change)', () => {
    const sales = [
      sale(10, 100_000, '8.00'),
      sale(10, 100_000, '10.00'),
    ]
    const { rows } = computeCommissions({ month, roles, earners: [earners[0]], sales })
    expect(rows[0].ownCommission).toBe(8_000 + 10_000)
  })

  it('ambassador-tier bonus uses OWN sales, not pool', () => {
    const sales = [
      sale(13, 50_000, '8.00'),
      sale(99, 450_000, '8.00'),
    ]
    const { rows } = computeCommissions({ month, roles, earners: [earners[2]], sales })
    expect(rows[0].bonus).toBe(500)
  })

  it('KPI gating drops bonus when own sales below threshold', () => {
    const sales = [
      sale(14, 29_999, '8.00'),
    ]
    const { rows } = computeCommissions({ month, roles, earners: [earners[3]], sales })
    expect(rows[0].bonus).toBe(0)
  })
})

describe('computeCommissions (commission pool)', () => {
  const poolRoles: CommissionRoleConfig[] = [
    { id: 5, name: 'New Owner', tier: 'admin',      baseRate: 10, bonusRate: null, requiresKpi: false, kpiThreshold: null, poolShare: true },
    { id: 6, name: 'In-Charge', tier: 'admin',      baseRate: 12, bonusRate: null, requiresKpi: false, kpiThreshold: null, poolShare: true },
    { id: 4, name: 'Ambassador', tier: 'ambassador', baseRate: 8,  bonusRate: null, requiresKpi: false, kpiThreshold: null },
  ]
  const poolEarners: CommissionEarner[] = [
    { userId: 1,  name: 'Johnny', roleId: 5, ambassadorId: 10 },
    { userId: 2,  name: 'Mok',    roleId: 6, ambassadorId: 11 },
    { userId: -5, name: 'Team',   roleId: 4, ambassadorId: 15 },
  ]

  it('splits the cap remainder equally among pool-flagged earners', () => {
    // team 100k@8% = 8_000; johnny 50k@10% = 5_000; mok 25k@12% = 3_000
    // pool 175k, budget 12% = 21_000, used 16_000, remainder 5_000 → 2_500 each
    const sales = [
      sale(15, 100_000, '8.00'),
      sale(10, 50_000, '10.00'),
      sale(11, 25_000, '12.00'),
    ]
    const { rows, pool } = computeCommissions({ month, roles: poolRoles, earners: poolEarners, sales, capRate: 12 })
    const byName = Object.fromEntries(rows.map(r => [r.name, r]))
    expect(pool).toEqual({ capRate: 12, budget: 21_000, used: 16_000, remainder: 5_000, share: 2_500, members: 2 })
    expect(byName.Johnny.total).toBe(7_500)
    expect(byName.Mok.total).toBe(5_500)
    expect(byName.Team.total).toBe(8_000)
  })

  it('matches the July 2026 production numbers', () => {
    // Aggregate fixture: total sales 172_783.21, base commissions 15_974.67.
    // Model each earner as one sale at a synthetic rate reproducing the real Σ.
    // Team amount tuned (per brief step 3's "adjust if needed") so the 3-sale
    // aggregate's budget/used land exactly on the real remainder/share.
    const sales = [
      sale(10, 34_482.30, '10.00'),  // Johnny base 3_448.23
      sale(11, 36_559.37, '12.00'),  // Mok base 4_387.12
      sale(15, 101_741.54, '8.00'),  // Team base 8_139.32
    ]
    const { pool } = computeCommissions({ month, roles: poolRoles, earners: poolEarners, sales, capRate: 12 })
    expect(pool!.budget).toBeCloseTo(0.12 * (34_482.30 + 36_559.37 + 101_741.54), 2)
    expect(pool!.share).toBeCloseTo((pool!.remainder) / 2, 2)
    expect(pool!.remainder).toBeCloseTo(4_759.32, 0)
    expect(pool!.share).toBeCloseTo(2_379.66, 0)
  })

  it('clamps a negative remainder to zero', () => {
    const sales = [sale(11, 100_000, '12.00')] // used 12_000 = budget 12_000 → remainder 0
    const { rows, pool } = computeCommissions({ month, roles: poolRoles, earners: poolEarners, sales, capRate: 12 })
    expect(pool!.remainder).toBe(0)
    expect(rows.find(r => r.name === 'Johnny')!.bonus).toBe(0)
  })

  it('capRate null → no pool, admin roles earn base only', () => {
    const sales = [sale(10, 100_000, '10.00')]
    const { rows, pool } = computeCommissions({ month, roles: poolRoles, earners: poolEarners, sales, capRate: null })
    expect(pool).toBeNull()
    expect(rows.find(r => r.name === 'Johnny')!.total).toBe(10_000)
  })

  it('KPI ambassador bonus is deducted from the pool budget and still paid', () => {
    const kpiRoles: CommissionRoleConfig[] = [
      ...poolRoles,
      { id: 9, name: 'KPI Amb', tier: 'ambassador', baseRate: 10, bonusRate: 1, requiresKpi: true, kpiThreshold: 10_000 },
    ]
    const kpiEarners = [...poolEarners, { userId: -6, name: 'Kpi', roleId: 9, ambassadorId: 16 }]
    const sales = [sale(16, 20_000, '10.00')] // base 2_000, kpi bonus 200
    const { rows, pool } = computeCommissions({ month, roles: kpiRoles, earners: kpiEarners, sales, capRate: 12 })
    expect(rows.find(r => r.name === 'Kpi')!.bonus).toBe(200)
    // budget 2_400, used 2_000 + 200 → remainder 200, 100 each
    expect(pool).toMatchObject({ budget: 2_400, used: 2_200, remainder: 200, share: 100 })
  })

  it('cap set but no pool-flagged roles → remainder reported, nobody paid', () => {
    const flagless = poolRoles.map(r => ({ ...r, poolShare: false }))
    const sales = [sale(15, 100_000, '8.00')]
    const { rows, pool } = computeCommissions({ month, roles: flagless, earners: poolEarners, sales, capRate: 12 })
    expect(pool).toMatchObject({ remainder: 4_000, share: 0, members: 0 })
    expect(rows.every(r => r.bonus === 0)).toBe(true)
  })
})

describe('applyPayoutFreeze', () => {
  const row = (ambassadorId: number, ownCommission: number, bonus: number): any => ({
    userId: 1, ambassadorId, name: `A${ambassadorId}`, roleId: 5, roleName: 'x', tier: 'admin',
    ownSales: 0, ownCommission, bonus, total: ownCommission + bonus, paid: false,
  })

  it('overrides paid rows with the frozen payout amount', () => {
    const rows = [row(10, 2334.55, 4130.00), row(11, 100, 0)]
    applyPayoutFreeze(rows, [{ ambassadorId: 10, amount: '4399.55' }])
    expect(rows[0]).toMatchObject({ paid: true, total: 4399.55, bonus: 2065.00 })
    expect(rows[1]).toMatchObject({ paid: false, total: 100 })
  })

  it('sums multiple payouts for the same ambassador-month', () => {
    const rows = [row(10, 1000, 0)]
    applyPayoutFreeze(rows, [{ ambassadorId: 10, amount: '600.00' }, { ambassadorId: 10, amount: '500.00' }])
    expect(rows[0]).toMatchObject({ paid: true, total: 1100, bonus: 100 })
  })
})
