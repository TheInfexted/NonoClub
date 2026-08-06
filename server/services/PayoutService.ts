import { z } from 'zod'
import { PayoutRepo } from '~~/server/repositories/PayoutRepository'
import { RoleRepo } from '~~/server/repositories/RoleRepository'
import { AmbassadorRepo } from '~~/server/repositories/AmbassadorRepository'
import { SaleRepo } from '~~/server/repositories/SaleRepository'
import { ClubRepo } from '~~/server/repositories/ClubRepository'
import { computeCommissions, type CommissionRoleConfig } from '~~/server/services/CommissionService'
import { ApiError } from '~~/server/utils/errors'
import { assertNotOwnerProtected, assertCan, type Actor } from '~~/server/utils/permissions'
import { saveFile, readFileFromStorage, deleteFromStorage } from '~~/server/utils/storage'

const CreateSchema = z.object({
  ambassadorId: z.number().int().positive(),
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().nonnegative(),
  notes: z.string().nullish(),
  markPaid: z.boolean().optional(),
})

function assertAdminTier(actor: Actor & { tier?: string }) {
  assertCan(actor, 'payouts', 'edit')
}

// Payout ids are global — ownership is asserted against the active club so
// other clubs' payouts are indistinguishable from missing ones.
async function getOwned(id: number, clubId: number) {
  const p = await PayoutRepo.findById(id)
  if (!p || p.clubId !== clubId) throw ApiError.notFound('Payout')
  return p
}

export const PayoutService = {
  list: PayoutRepo.list,
  async create(actor: Actor & { id: number; roleName: string }, clubId: number, body: unknown) {
    assertAdminTier(actor)
    const v = CreateSchema.parse(body)
    const amb = await AmbassadorRepo.findById(v.ambassadorId)
    if (!amb || amb.deletedAt) throw ApiError.validation({ ambassadorId: 'Unknown ambassador' })
    if (amb.clubId !== clubId) throw ApiError.validation({ ambassadorId: 'Ambassador belongs to a different club' })
    await assertNotOwnerProtected(actor, { kind: 'payout', ambassadorId: v.ambassadorId })
    const dups = await PayoutRepo.list({ ambassadorId: v.ambassadorId, month: v.periodMonth })
    if (dups.length > 0) {
      throw ApiError.conflict('A payout already exists for this ambassador and month')
    }
    const r = await PayoutRepo.insert({
      ambassadorId: v.ambassadorId,
      clubId,
      periodMonth: v.periodMonth,
      amount: v.amount.toFixed(2),
      notes: v.notes ?? null,
      createdBy: actor.id,
      paidAt: v.markPaid ? new Date() : null,
    })
    return await PayoutRepo.findById((r as any)[0].insertId)
  },
  async markPaid(actor: Actor, clubId: number, id: number) {
    assertAdminTier(actor)
    const p = await getOwned(id, clubId)
    await assertNotOwnerProtected(actor, { kind: 'payout', ambassadorId: p.ambassadorId })
    await PayoutRepo.update(id, { paidAt: new Date() })
    return await PayoutRepo.findById(id)
  },
  async markUnpaid(actor: Actor, clubId: number, id: number) {
    assertAdminTier(actor)
    const p = await getOwned(id, clubId)
    await assertNotOwnerProtected(actor, { kind: 'payout', ambassadorId: p.ambassadorId })
    await PayoutRepo.update(id, { paidAt: null })
    return await PayoutRepo.findById(id)
  },
  async remove(actor: Actor, clubId: number, id: number) {
    assertAdminTier(actor)
    const p = await getOwned(id, clubId)
    await assertNotOwnerProtected(actor, { kind: 'payout', ambassadorId: p.ambassadorId })
    for (const r of ((p.receiptPaths as any[]) ?? [])) {
      await deleteFromStorage(r.path).catch(() => {})
    }
    if (p.payslipPath) await deleteFromStorage(p.payslipPath).catch(() => {})
    await PayoutRepo.delete(id)
  },

  async addReceipt(actor: Actor, clubId: number, id: number, file: { name: string; mime: string; data: Buffer }) {
    assertAdminTier(actor)
    const p = await getOwned(id, clubId)
    await assertNotOwnerProtected(actor, { kind: 'payout', ambassadorId: p.ambassadorId })

    const existing = (p.receiptPaths as any[]) ?? []
    if (existing.length >= 10) throw ApiError.conflict('Max 10 receipts per payout')

    const ts = Date.now()
    const safeName = file.name.replace(/[^\w.-]/g, '_').slice(0, 100)
    const relPath = `payouts/${id}/receipts/${ts}_${safeName}`
    await saveFile(relPath, file.data)

    const updated = [...existing, { path: relPath, name: file.name, size: file.data.length, mime: file.mime }]
    await PayoutRepo.update(id, { receiptPaths: updated as any })
    return { receipts: updated }
  },

  async getReceipt(_actor: Actor, clubId: number, id: number, index: number) {
    const p = await getOwned(id, clubId)
    // No owner-protection on read — owner-protected target's receipts are still readable by admins for audit
    const arr = (p.receiptPaths as any[]) ?? []
    const item = arr[index]
    if (!item) throw ApiError.notFound('Receipt')
    const data = await readFileFromStorage(item.path)
    return { name: item.name as string, mime: item.mime as string, data }
  },

  async deleteReceipt(actor: Actor, clubId: number, id: number, index: number) {
    assertAdminTier(actor)
    const p = await getOwned(id, clubId)
    await assertNotOwnerProtected(actor, { kind: 'payout', ambassadorId: p.ambassadorId })
    const arr = ((p.receiptPaths as any[]) ?? []).slice()
    const item = arr[index]
    if (!item) throw ApiError.notFound('Receipt')
    await deleteFromStorage(item.path)
    arr.splice(index, 1)
    await PayoutRepo.update(id, { receiptPaths: arr as any })
  },

  async createBatch(actor: Actor & { id: number }, clubId: number, body: unknown) {
    const Schema = z.object({
      items: z.array(z.object({
        ambassadorId: z.number().int().positive(),
        periodMonth: z.string().regex(/^\d{4}-\d{2}$/),
      })).min(1).max(100),
      markPaid: z.boolean().optional(),
    })
    assertAdminTier(actor)
    const v = Schema.parse(body)
    const created: any[] = []

    // Single source of truth: amounts come from computeCommissions, the same
    // engine the commissions page uses. Loaded once, computed once per month.
    // All inputs are scoped to the club: the pool bonus is the CLUB's pool.
    const roleRows = await RoleRepo.list()
    const roleById = new Map(roleRows.map(r => [r.id, r]))
    const roleConfigs: CommissionRoleConfig[] = roleRows.map(r => ({
      id: r.id, name: r.name, tier: r.tier,
      baseRate: Number(r.baseRate),
      bonusRate: r.bonusRate === null ? null : Number(r.bonusRate),
      requiresKpi: r.requiresKpi === 1,
      kpiThreshold: r.kpiThreshold === null ? null : Number(r.kpiThreshold),
      poolShare: r.poolShare === 1,
    }))
    const ambRows = await AmbassadorRepo.list({ clubId })
    const months = Array.from(new Set(v.items.map(i => i.periodMonth)))
    const club = await ClubRepo.findById(clubId)
    const capRate = club?.commissionCapRate == null ? null : Number(club.commissionCapRate)

    for (const month of months) {
      const saleRows = await SaleRepo.list({ clubId, month })
      const { rows } = computeCommissions({
        month,
        roles: roleConfigs,
        earners: ambRows.map(a => ({ userId: -a.id, name: a.name, roleId: a.roleId, ambassadorId: a.id })),
        sales: saleRows.map(s => ({
          id: s.id, date: s.date, ambassadorId: s.ambassadorId, amount: s.amount,
          status: s.status, type: s.type,
          confirmedCommissionRate: s.confirmedCommissionRate, confirmedBonusRate: s.confirmedBonusRate,
        })),
        capRate,
      })
      const rowByAmbassador = new Map(rows.map(r => [r.ambassadorId, r]))

      for (const item of v.items.filter(i => i.periodMonth === month)) {
        await assertNotOwnerProtected(actor, { kind: 'payout', ambassadorId: item.ambassadorId })
        const existing = await PayoutRepo.list({ ambassadorId: item.ambassadorId, month: item.periodMonth })
        if (existing.length > 0) continue
        const row = rowByAmbassador.get(item.ambassadorId)
        if (!row) continue // unknown or deleted ambassador
        const role = roleById.get(row.roleId)!
        const r = await PayoutRepo.insert({
          ambassadorId: item.ambassadorId, clubId, periodMonth: item.periodMonth,
          amount: row.total.toFixed(2), notes: null, createdBy: actor.id,
          paidAt: v.markPaid ? new Date() : null,
          snapshotBonusRate: role.bonusRate ?? null,
          snapshotKpiThreshold: role.kpiThreshold ?? null,
          snapshotRequiresKpi: role.requiresKpi,
        })
        const created_row = await PayoutRepo.findById((r as any)[0].insertId)
        if (created_row) created.push(created_row)
      }
    }
    return { created: created.length, items: created }
  },
}
