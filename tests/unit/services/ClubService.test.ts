import { describe, it, expect, vi, beforeEach } from 'vitest'

const clubs: any[] = [{ id: 1, name: 'Nono Club', logoPath: null, deletedAt: null }]
const counts = { teams: 0, ambassadors: 0, sales: 0, payouts: 0 }
const insertedRoles: any[] = []

vi.mock('~~/server/repositories/ClubRepository', () => ({
  ClubRepo: {
    list: vi.fn(async () => clubs.filter(c => !c.deletedAt)),
    findById: vi.fn(async (id: number) => clubs.find(c => c.id === id)),
    insert: vi.fn(async (v: any) => { clubs.push({ id: 2, ...v, deletedAt: null }); return [{ insertId: 2 }] }),
    update: vi.fn(async () => undefined),
    softDelete: vi.fn(async (id: number) => { const c = clubs.find(x => x.id === id); if (c) c.deletedAt = new Date() }),
    countScopedRows: vi.fn(async () => counts.teams + counts.ambassadors + counts.sales + counts.payouts),
  },
}))
vi.mock('~~/server/repositories/RoleRepository', () => ({
  RoleRepo: { insert: vi.fn(async (v: any) => { insertedRoles.push(v); return [{ insertId: insertedRoles.length }] }) },
}))
const insertedSaleTypes: any[] = []
vi.mock('~~/server/repositories/SaleTypeRepository', () => ({
  SaleTypeRepo: { insert: vi.fn(async (v: any) => { insertedSaleTypes.push(v); return [{ insertId: insertedSaleTypes.length }] }) },
}))

import { ClubService } from '~~/server/services/ClubService'
import { ClubRepo } from '~~/server/repositories/ClubRepository'

const admin = { id: 1, roleName: 'admin', tier: 'admin' } as any
const nonAdmin = { id: 9, roleName: 'x', tier: 'ambassador' } as any

beforeEach(() => {
  clubs.length = 0
  clubs.push({ id: 1, name: 'Nono Club', logoPath: null, deletedAt: null })
  counts.teams = 0; counts.ambassadors = 0; counts.sales = 0; counts.payouts = 0
  insertedRoles.length = 0
  insertedSaleTypes.length = 0
})

describe('ClubService', () => {
  it('list is available to any authenticated user', async () => {
    const r = await ClubService.list(nonAdmin)
    expect(r).toHaveLength(1)
  })

  it('create requires admin tier and seeds default commission roles and sale types', async () => {
    await expect(ClubService.create(nonAdmin, { name: 'Neon' })).rejects.toMatchObject({ statusCode: 403 })
    const club = await ClubService.create(admin, { name: 'Neon' })
    expect(club?.name).toBe('Neon')
    expect(insertedRoles.map(r => r.name).sort()).toEqual(['Ambassador', 'Leader'])
    expect(insertedRoles.every(r => r.clubId === 2)).toBe(true)
    expect(insertedSaleTypes.map(t => t.name)).toEqual(['Table', 'BGO'])
  })

  it('update and remove require admin tier', async () => {
    await expect(ClubService.update(nonAdmin, 1, { name: 'X' })).rejects.toMatchObject({ statusCode: 403 })
    await expect(ClubService.remove(nonAdmin, 1)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('update persists a numeric commission cap as a decimal string', async () => {
    await ClubService.update(admin, 1, { name: 'Nono', commissionCapRate: 12 })
    expect(ClubRepo.update).toHaveBeenCalledWith(1, { name: 'Nono', commissionCapRate: '12.00' })
  })

  it('update persists an explicit null commission cap', async () => {
    await ClubService.update(admin, 1, { name: 'Nono', commissionCapRate: null })
    expect(ClubRepo.update).toHaveBeenCalledWith(1, { name: 'Nono', commissionCapRate: null })
  })

  it('update omits commission cap from the patch when not provided', async () => {
    await ClubService.update(admin, 1, { name: 'Nono' })
    expect(ClubRepo.update).toHaveBeenCalledWith(1, { name: 'Nono' })
    const patch = vi.mocked(ClubRepo.update).mock.calls.at(-1)?.[1]
    expect(patch).not.toHaveProperty('commissionCapRate')
  })

  it('cannot delete the last remaining club', async () => {
    await expect(ClubService.remove(admin, 1)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('cannot delete a club that still owns data', async () => {
    clubs.push({ id: 2, name: 'Neon', logoPath: null, deletedAt: null })
    counts.sales = 3
    await expect(ClubService.remove(admin, 2)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('deletes an empty non-last club', async () => {
    clubs.push({ id: 2, name: 'Neon', logoPath: null, deletedAt: null })
    await ClubService.remove(admin, 2)
    expect(clubs.find(c => c.id === 2)?.deletedAt).toBeTruthy()
  })
})
