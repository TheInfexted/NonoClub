import { describe, it, expect, vi, beforeEach } from 'vitest'

const roles = [
  { id: 1, name: 'admin', tier: 'admin', baseRate: '8.00', bonusRate: '1.00', requiresKpi: 0, kpiThreshold: null, poolShare: 1 },
  { id: 3, name: 'vip', tier: 'ambassador', baseRate: '8.00', bonusRate: '2.00', requiresKpi: 1, kpiThreshold: '30000.00' },
]
const ambassadors = [
  { id: 11, name: 'Mok', roleId: 1, clubId: 1, deletedAt: null },
  { id: 13, name: 'Sasha', roleId: 3, clubId: 1, deletedAt: null },
]
// Month pool = 50_000 (Mok 20k @8%, Sasha 30k @8%); Sasha hits the 30k KPI exactly.
const sales = [
  { id: 1, date: '2026-04-05', ambassadorId: 11, amount: '20000.00', status: 'confirmed', type: 'Table', confirmedCommissionRate: '8.00', confirmedBonusRate: '1.00' },
  { id: 2, date: '2026-04-06', ambassadorId: 13, amount: '30000.00', status: 'confirmed', type: 'Table', confirmedCommissionRate: '8.00', confirmedBonusRate: null },
]
const insertedPayouts: any[] = []

vi.mock('~~/server/repositories/RoleRepository', () => ({
  RoleRepo: { list: vi.fn(async () => roles) },
}))
vi.mock('~~/server/repositories/ClubRepository', () => ({
  ClubRepo: { findById: vi.fn(async (id: number) => ({ id, commissionCapRate: '12.00' })) },
}))
vi.mock('~~/server/repositories/AmbassadorRepository', () => ({
  AmbassadorRepo: { list: vi.fn(async () => ambassadors) },
}))
vi.mock('~~/server/repositories/SaleRepository', () => ({
  SaleRepo: { list: vi.fn(async () => sales) },
}))
vi.mock('~~/server/repositories/PayoutRepository', () => ({
  PayoutRepo: {
    list: vi.fn(async () => []),
    insert: vi.fn(async (v: any) => { insertedPayouts.push(v); return [{ insertId: insertedPayouts.length }] }),
    findById: vi.fn(async (id: number) => ({ id, ...insertedPayouts[id - 1] })),
  },
}))
vi.mock('~~/server/utils/permissions', async () => {
  const { can } = await import('~~/shared/permissions')
  return {
    assertNotOwnerProtected: vi.fn(async () => undefined),
    assertCan: (actor: any, module: any, level: any) => {
      if (!can(actor, module, level)) {
        throw Object.assign(new Error('Insufficient permissions'), { statusCode: 403 })
      }
    },
  }
})

import { PayoutService } from '~~/server/services/PayoutService'

const admin = { id: 1, roleName: 'admin', tier: 'admin' } as any

beforeEach(() => { insertedPayouts.length = 0 })

describe('PayoutService.createBatch', () => {
  it('admin-tier earner gets commission + pool bonus, identical to computeCommissions', async () => {
    await PayoutService.createBatch(admin, 1, { items: [{ ambassadorId: 11, periodMonth: '2026-04' }] })
    // Mok (admin, poolShare): base 20000*8% = 1600.
    // Sasha (vip, not poolShare): base 30000*8% = 2400, bonus 30000*2% (KPI met) = 600.
    // budget = 12% of confirmed sales (50000) = 6000; used = 1600 + (2400+600) = 4600;
    // remainder = 6000 - 4600 = 1400; 1 flagged earner (Mok) => share = 1400.
    // Mok's payout = base 1600 + share 1400 = 3000.
    expect(insertedPayouts).toHaveLength(1)
    expect(insertedPayouts[0].amount).toBe('3000.00')
    expect(insertedPayouts[0].snapshotBonusRate).toBe('1.00')
    expect(insertedPayouts[0].clubId).toBe(1)
  })

  it('KPI-gated ambassador at threshold gets own-sales bonus and snapshots', async () => {
    await PayoutService.createBatch(admin, 1, { items: [{ ambassadorId: 13, periodMonth: '2026-04' }] })
    // commission 30000*8% = 2400; bonus 30000*2% = 600 (KPI met at exactly 30000)
    expect(insertedPayouts[0].amount).toBe('3000.00')
    expect(insertedPayouts[0].snapshotBonusRate).toBe('2.00')
    expect(insertedPayouts[0].snapshotKpiThreshold).toBe('30000.00')
    expect(insertedPayouts[0].snapshotRequiresKpi).toBe(1)
  })

  it('rejects non-admin tier', async () => {
    await expect(
      PayoutService.createBatch({ id: 9, roleName: 'x', tier: 'ambassador' } as any, 1, { items: [{ ambassadorId: 11, periodMonth: '2026-04' }] }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
