import { and, eq, gte, lte, sql, like } from 'drizzle-orm'
import { useDB, schema } from '~~/server/db/client'
import type { NewSale } from '~~/server/db/schema'

export const SaleRepo = {
  list(filter: { clubId?: number; month?: string; ambassadorId?: number; type?: string; status?: 'draft' | 'confirmed' | 'voided' } = {}) {
    const db = useDB()
    const where = []
    if (filter.clubId) where.push(eq(schema.sales.clubId, filter.clubId))
    if (filter.month) where.push(like(schema.sales.date, `${filter.month}%`))
    if (filter.ambassadorId) where.push(eq(schema.sales.ambassadorId, filter.ambassadorId))
    if (filter.type) where.push(eq(schema.sales.type, filter.type))
    if (filter.status) where.push(eq(schema.sales.status, filter.status))
    return db.select().from(schema.sales).where(where.length ? and(...where) : undefined)
  },
  findById(id: number) {
    return useDB().select().from(schema.sales).where(eq(schema.sales.id, id)).limit(1).then(r => r[0])
  },
  insert(values: NewSale) {
    return useDB().insert(schema.sales).values(values)
  },
  insertMany(values: NewSale[]) {
    if (values.length === 0) return Promise.resolve()
    return useDB().insert(schema.sales).values(values)
  },
  update(id: number, patch: Partial<NewSale>) {
    return useDB().update(schema.sales).set({ ...patch, updatedAt: new Date() }).where(eq(schema.sales.id, id))
  },
  // Confirmed sales in an inclusive date range — feeds the commission report.
  listConfirmedRange(clubId: number, from: string, to: string) {
    return useDB().select().from(schema.sales)
      .where(and(
        eq(schema.sales.clubId, clubId),
        eq(schema.sales.status, 'confirmed'),
        gte(schema.sales.date, from),
        lte(schema.sales.date, to),
      ))
  },
  totalForMonth(clubId: number, month: string) {
    return useDB().select({
      total: sql<string>`COALESCE(SUM(amount), 0)`.as('total'),
    }).from(schema.sales)
      .where(and(eq(schema.sales.clubId, clubId), eq(schema.sales.status, 'confirmed'), like(schema.sales.date, `${month}%`)))
      .then(r => Number(r[0]?.total ?? 0))
  },
  // Dedupe is per club: different clubs may run POS vendors with overlapping order-id spaces.
  findByExternalOrderIds(clubId: number, orderIds: string[]) {
    if (orderIds.length === 0) return Promise.resolve([])
    return useDB().select({ id: schema.sales.id, externalOrderId: schema.sales.externalOrderId, status: schema.sales.status })
      .from(schema.sales)
      .where(and(
        eq(schema.sales.clubId, clubId),
        sql`${schema.sales.externalOrderId} IN (${sql.join(orderIds.map(id => sql`${id}`), sql`, `)})`,
      ))
  },
}
