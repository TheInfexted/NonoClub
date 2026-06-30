import { extractText, getDocumentProxy } from 'unpdf'
import { detectParser, importParsers, type PositionedPage } from '~~/server/import/parsers'
import { z } from 'zod'
import { SaleRepo } from '~~/server/repositories/SaleRepository'
import { AmbassadorRepo } from '~~/server/repositories/AmbassadorRepository'
import { RoleRepo } from '~~/server/repositories/RoleRepository'
import { SaleTypeRepo } from '~~/server/repositories/SaleTypeRepository'
import { resolveCommissionRate } from '~~/server/services/RoleService'
import { ApiError } from '~~/server/utils/errors'
import { assertNotOwnerProtected, assertCan, type Actor } from '~~/server/utils/permissions'

export interface ParsedRow {
  date: string
  externalOrderId: string
  tableNumber: string
  amount: number
  reportedRate?: number
  reportedCommission?: number
  saleType?: string
}

export interface ParseResult {
  ambassadorHint: string | null
  headerTotal: number | null
  reportedCommissionTotal: number | null
  rows: ParsedRow[]
  errors: string[]
  /** Which registered statement format matched, and its sale type. */
  format: string
  formatId: string
  suggestedSaleType: string
}

export async function parsePdfBuffer(buf: Buffer): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text: pages } = await extractText(pdf, { mergePages: true })
  const rawText = Array.isArray(pages) ? pages.join('\n') : pages
  const normalized = rawText.replace(/\s+/g, ' ')

  const detected = detectParser(rawText)
  if (!detected) {
    throw ApiError.validation({
      file: `Unrecognised statement format. Supported: ${importParsers.map(p => p.label).join('; ')}`,
    })
  }

  // Positioned items let column-based formats (404's BGO vs AMT ORD amount
  // columns) recover which column a number sat under — flat text can't.
  const positioned: PositionedPage[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const tc = await page.getTextContent()
    positioned.push({
      items: (tc.items as Array<{ str?: string; transform: number[]; width?: number }>)
        .filter(it => typeof it.str === 'string' && it.str.trim() !== '')
        .map(it => ({ str: it.str!, x: it.transform[4]!, y: it.transform[5]!, w: it.width ?? 0 })),
    })
  }

  const r = detected.parser.parse(normalized, rawText, positioned)
  return {
    ...r,
    format: detected.parser.label,
    formatId: detected.parser.id,
    suggestedSaleType: detected.parser.defaultSaleType,
  }
}

// Receipt ids: T+15 (Nono POS), A+15-20 (404 POS). Synthetic ids: M- (rows
// the Nono statement prints without a receipt), S- (commission-statement
// rows, which carry no receipt at all). Both synthetic shapes allow a
// trailing -N occurrence suffix for legitimately repeated identical rows.
// Segment bounds mirror the parser's idSegment caps so every accepted id is
// guaranteed to fit the varchar(50) external_order_id column.
const ORDER_ID_RE = /^(T\d{15}|A\d{15,20}|M-\d{6}-[A-Za-z0-9]{0,20}-\d{1,12}(?:-\d{1,4})?|S-\d{6}-[A-Za-z0-9]{1,12}-[A-Za-z0-9]{0,10}-\d{1,12}(?:-\d{1,4})?)$/

const CommitSchema = z.object({
  status: z.enum(['draft', 'confirmed']).default('draft'),
  saleType: z.string().trim().min(1).max(40).optional(),
  rows: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    externalOrderId: z.string().regex(ORDER_ID_RE),
    tableNumber: z.string(),
    amount: z.number().positive(),
    ambassadorId: z.number().int().positive(),
    saleType: z.string().trim().min(1).max(40).optional(),
  })).min(1),
})

export const PDFImportService = {
  async dryRun(clubId: number, buf: Buffer) {
    const r = await parsePdfBuffer(buf)
    const orderIds = r.rows.map(x => x.externalOrderId)
    const matches = await SaleRepo.findByExternalOrderIds(clubId, orderIds)
    // A voided receipt no longer occupies the ledger — re-importing it reuses
    // its row (the unique slot blocks a fresh insert) rather than duplicating.
    const dupSet = new Set(matches.filter(d => d.status !== 'voided').map(d => d.externalOrderId))
    const reactivateSet = new Set(matches.filter(d => d.status === 'voided').map(d => d.externalOrderId))
    const reportedRates = Array.from(new Set(r.rows.map(x => x.reportedRate).filter((x): x is number => x !== undefined)))

    // Formats with per-row sale types: surface any type the club hasn't
    // configured yet, so the operator can add it before committing.
    const rowTypes = Array.from(new Set(r.rows.map(x => x.saleType).filter((x): x is string => !!x)))
    const activeTypes = new Set((await SaleTypeRepo.listByClub(clubId)).filter(t => t.isActive === 1).map(t => t.name))
    const unknownTypes = rowTypes.filter(t => !activeTypes.has(t))

    return {
      format: r.format,
      formatId: r.formatId,
      suggestedSaleType: r.suggestedSaleType,
      ambassadorHint: r.ambassadorHint,
      headerTotal: r.headerTotal,
      reportedCommissionTotal: r.reportedCommissionTotal,
      reportedRates,
      rowTypes,
      unknownTypes,
      errors: r.errors,
      parsedTotal: r.rows.reduce((a, x) => a + x.amount, 0),
      duplicates: Array.from(dupSet),
      reactivations: Array.from(reactivateSet),
      rows: r.rows,
    }
  },

  async commit(actor: Actor & { id: number; tier?: string }, clubId: number, body: unknown) {
    assertCan(actor, 'import', 'edit')
    const parsed = CommitSchema.safeParse(body)
    if (!parsed.success) {
      const issues = parsed.error.issues
      const first = issues[0]
      const path = first?.path?.join('.') || 'body'
      throw ApiError.validation({ [path]: first?.message || 'Invalid input' })
    }
    const v = parsed.data

    // Validate every ambassador exists and isn't owner-protected for the actor
    const uniqueIds = Array.from(new Set(v.rows.map(r => r.ambassadorId)))
    const ambassadors = new Map<number, any>()
    for (const id of uniqueIds) {
      const amb = await AmbassadorRepo.findById(id)
      if (!amb || amb.deletedAt) {
        throw ApiError.validation({ rows: `Unknown ambassador (id=${id})` })
      }
      if (amb.clubId !== clubId) {
        throw ApiError.validation({ rows: `Ambassador (id=${id}) belongs to a different club` })
      }
      await assertNotOwnerProtected(actor, { kind: 'sale', ambassadorId: id })
      ambassadors.set(id, amb)
    }

    // Rates freeze from each ambassador's role at commit time, mirroring SaleService.confirm
    const rolesById = new Map<number, any>()
    for (const amb of ambassadors.values()) {
      if (rolesById.has(amb.roleId)) continue
      const role = await RoleRepo.findById(amb.roleId)
      if (!role) throw ApiError.validation({ rows: `Ambassador (id=${amb.id}) has an unknown role` })
      rolesById.set(amb.roleId, role)
    }

    // Rows that carry their own sale type (mixed-type statements) keep it;
    // the rest take the requested type, defaulting to the club's first
    // active type. Every type involved must exist on this club.
    const clubTypes = (await SaleTypeRepo.listByClub(clubId)).filter(t => t.isActive === 1)
    if (clubTypes.length === 0) throw ApiError.validation({ saleType: 'This club has no active sale types' })
    const activeNames = new Set(clubTypes.map(t => t.name))
    const fallbackType = v.saleType ?? clubTypes[0]!.name
    const rowType = (r: { saleType?: string }) => r.saleType ?? fallbackType
    const usedTypes = Array.from(new Set(v.rows.map(rowType)))
    const missing = usedTypes.filter(t => !activeNames.has(t))
    if (missing.length > 0) {
      throw ApiError.validation({ saleType: `This club has no sale type named: ${missing.join(', ')} — add it in Settings first` })
    }

    const matches = await SaleRepo.findByExternalOrderIds(clubId, v.rows.map(r => r.externalOrderId))
    const activeSet = new Set(matches.filter(m => m.status !== 'voided').map(m => m.externalOrderId))
    const voidedById = new Map(matches.filter(m => m.status === 'voided').map(m => [m.externalOrderId, m.id]))

    // Active receipts are skipped as duplicates. Voided receipts get reactivated
    // in place — their unique (club_id, external_order_id) slot blocks a fresh
    // insert — overwriting the row with the new import and clearing the void.
    const toReactivate = v.rows.filter(r => voidedById.has(r.externalOrderId))
    const toInsert = v.rows.filter(r => !activeSet.has(r.externalOrderId) && !voidedById.has(r.externalOrderId))

    if (toReactivate.length === 0 && toInsert.length === 0) return { imported: 0, skipped: v.rows.length }

    const buildFields = (r: (typeof v.rows)[number]) => {
      const amb = ambassadors.get(r.ambassadorId)!
      const role = rolesById.get(amb.roleId)!
      const type = rowType(r)
      return {
        date: r.date,
        ambassadorId: r.ambassadorId,
        clubId,
        type,
        amount: r.amount.toFixed(2),
        notes: null,
        // PDF table tokens are unbounded; the column is varchar(20).
        tableNumber: r.tableNumber.slice(0, 20),
        externalOrderId: r.externalOrderId,
        status: v.status,
        confirmedCommissionRate: v.status === 'confirmed' ? resolveCommissionRate(role, type) : null,
        confirmedBonusRate: v.status === 'confirmed' ? role.bonusRate : null,
        confirmedAt: v.status === 'confirmed' ? new Date() : null,
      }
    }

    // ponytail: per-row updates; batch into a CASE update only if a statement
    // ever re-imports hundreds of voided rows at once (it won't in practice).
    for (const r of toReactivate) {
      await SaleRepo.update(voidedById.get(r.externalOrderId)!, { ...buildFields(r), voidedAt: null } as any)
    }

    if (toInsert.length > 0) {
      const records = toInsert.map(r => ({ ...buildFields(r), createdBy: actor.id }))
      try {
        await SaleRepo.insertMany(records as any)
      } catch (e: any) {
        // The (club_id, external_order_id) unique index is the backstop against
        // two imports racing past the pre-filter — surface it cleanly.
        if (e?.code === 'ER_DUP_ENTRY' || /Duplicate entry/.test(String(e?.message))) {
          throw ApiError.conflict('Some rows were imported by a concurrent request — run the import again to skip them')
        }
        throw e
      }
    }

    const imported = toInsert.length + toReactivate.length
    return { imported, skipped: v.rows.length - imported }
  },
}
