import { describe, it, expect, vi, beforeEach } from 'vitest'

const inserted: any[] = []
const updated: any[] = []
const role = { id: 7, name: 'VIP', tier: 'ambassador', baseRate: '9.50', bonusRate: '1.25', rateOverrides: { BGO: '11.00' } }

vi.mock('~~/server/repositories/SaleRepository', () => ({
  SaleRepo: {
    findByExternalOrderIds: vi.fn(async (_clubId: number, _ids: string[]) => [] as any[]),
    insertMany: vi.fn(async (rows: any[]) => { inserted.push(...rows) }),
    update: vi.fn(async (id: number, patch: any) => { updated.push({ id, patch }) }),
  },
}))
vi.mock('~~/server/repositories/AmbassadorRepository', () => ({
  AmbassadorRepo: { findById: vi.fn(async (id: number) => ({ id, roleId: 7, clubId: 1, deletedAt: null })) },
}))
vi.mock('~~/server/repositories/RoleRepository', () => ({
  RoleRepo: { findById: vi.fn(async (id: number) => (id === 7 ? role : undefined)) },
}))
vi.mock('~~/server/repositories/SaleTypeRepository', () => ({
  SaleTypeRepo: {
    listByClub: vi.fn(async () => [
      { id: 1, clubId: 1, name: 'Table', sortOrder: 0, isActive: 1 },
      { id: 2, clubId: 1, name: 'BGO', sortOrder: 1, isActive: 1 },
    ]),
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

import { PDFImportService } from '~~/server/services/PDFImportService'
import { SaleRepo } from '~~/server/repositories/SaleRepository'

const admin = { id: 1, roleName: 'admin', tier: 'admin' } as any
const row = { date: '2026-04-02', externalOrderId: 'T260402000000001', tableNumber: 'L1', amount: 1000, ambassadorId: 5 }

beforeEach(() => { inserted.length = 0; updated.length = 0; vi.mocked(SaleRepo.findByExternalOrderIds).mockReset().mockResolvedValue([] as any) })

describe('PDFImportService.commit', () => {
  it('freezes rates from the ambassador role when importing as confirmed', async () => {
    await PDFImportService.commit(admin, 1, { status: 'confirmed', rows: [row] })
    expect(inserted).toHaveLength(1)
    expect(inserted[0].confirmedCommissionRate).toBe('9.50')
    expect(inserted[0].confirmedBonusRate).toBe('1.25')
    expect(inserted[0].confirmedAt).toBeInstanceOf(Date)
    expect(inserted[0].clubId).toBe(1)
  })

  it('leaves rates null when importing as draft', async () => {
    await PDFImportService.commit(admin, 1, { status: 'draft', rows: [row] })
    expect(inserted[0].confirmedCommissionRate).toBeNull()
    expect(inserted[0].confirmedBonusRate).toBeNull()
    expect(inserted[0].confirmedAt).toBeNull()
  })

  it('rejects ambassadors from a different club', async () => {
    await expect(
      PDFImportService.commit(admin, 2, { status: 'draft', rows: [row] }),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('rejects non-admin-tier actors', async () => {
    await expect(
      PDFImportService.commit({ id: 2, roleName: 'whatever', tier: 'ambassador' } as any, 1, { status: 'draft', rows: [row] }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('per-row sale types: each row keeps its own type and resolves its own rate', async () => {
    const bgoRow = { date: '2025-12-14', externalOrderId: 'S-251214-BGO-L10-90000', tableNumber: 'L10', amount: 900, ambassadorId: 5, saleType: 'BGO' }
    const twinRow = { date: '2025-12-14', externalOrderId: 'S-251214-BGO-L10-90000-2', tableNumber: 'L10', amount: 900, ambassadorId: 5, saleType: 'BGO' }
    await PDFImportService.commit(admin, 1, { status: 'confirmed', rows: [row, bgoRow, twinRow] })
    expect(inserted).toHaveLength(3)
    expect(inserted[0].type).toBe('Table')                      // no row type → fallback (first active)
    expect(inserted[0].confirmedCommissionRate).toBe('9.50')    // base rate
    expect(inserted[1].type).toBe('BGO')
    expect(inserted[1].confirmedCommissionRate).toBe('11.00')   // BGO override from the rate plan
    expect(inserted[2].externalOrderId).toBe('S-251214-BGO-L10-90000-2') // occurrence suffix accepted
  })

  it('rejects rows whose sale type the club does not have', async () => {
    const badRow = { ...row, saleType: 'Karaoke' }
    await expect(
      PDFImportService.commit(admin, 1, { status: 'draft', rows: [badRow] }),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('reactivates a previously-voided receipt in place instead of inserting a duplicate', async () => {
    vi.mocked(SaleRepo.findByExternalOrderIds).mockResolvedValueOnce([
      { id: 42, externalOrderId: row.externalOrderId, status: 'voided' },
    ] as any)
    const res = await PDFImportService.commit(admin, 1, { status: 'confirmed', rows: [row] })
    expect(inserted).toHaveLength(0)                       // not a fresh insert — slot is reused
    expect(updated).toHaveLength(1)
    expect(updated[0].id).toBe(42)                         // the voided row itself
    expect(updated[0].patch.voidedAt).toBeNull()           // void cleared
    expect(updated[0].patch.status).toBe('confirmed')
    expect(updated[0].patch.confirmedCommissionRate).toBe('9.50')
    expect(res).toEqual({ imported: 1, skipped: 0 })
  })

  it('still skips an active (already-imported) receipt as a duplicate', async () => {
    vi.mocked(SaleRepo.findByExternalOrderIds).mockResolvedValueOnce([
      { id: 99, externalOrderId: row.externalOrderId, status: 'confirmed' },
    ] as any)
    const res = await PDFImportService.commit(admin, 1, { status: 'draft', rows: [row] })
    expect(inserted).toHaveLength(0)
    expect(updated).toHaveLength(0)
    expect(res).toEqual({ imported: 0, skipped: 1 })
  })
})
