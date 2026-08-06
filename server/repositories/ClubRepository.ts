import { eq, isNull, and, sql } from 'drizzle-orm'
import { useDB, schema } from '~~/server/db/client'

export const ClubRepo = {
  list() {
    return useDB().select().from(schema.clubs).where(isNull(schema.clubs.deletedAt))
  },
  findById(id: number) {
    return useDB().select().from(schema.clubs).where(eq(schema.clubs.id, id)).limit(1).then(r => r[0])
  },
  insert(values: { name: string; logoPath?: string | null }) {
    return useDB().insert(schema.clubs).values({ name: values.name, logoPath: values.logoPath ?? null })
  },
  update(id: number, patch: Partial<{ name: string; logoPath: string | null; commissionCapRate: string | null }>) {
    return useDB().update(schema.clubs).set({ ...patch, updatedAt: new Date() }).where(eq(schema.clubs.id, id))
  },
  softDelete(id: number) {
    return useDB().update(schema.clubs).set({ deletedAt: new Date() }).where(eq(schema.clubs.id, id))
  },
  // Per-club ambassador and sale counts for the clubs overview page.
  async stats(): Promise<Record<number, { ambassadors: number; sales: number }>> {
    const db = useDB()
    const out: Record<number, { ambassadors: number; sales: number }> = {}
    const ambs = await db.select({ clubId: schema.ambassadors.clubId, n: sql<number>`COUNT(*)` })
      .from(schema.ambassadors)
      .where(isNull(schema.ambassadors.deletedAt))
      .groupBy(schema.ambassadors.clubId)
    for (const r of ambs) {
      out[r.clubId] = { ambassadors: Number(r.n), sales: 0 }
    }
    const sales = await db.select({ clubId: schema.sales.clubId, n: sql<number>`COUNT(*)` })
      .from(schema.sales)
      .groupBy(schema.sales.clubId)
    for (const r of sales) {
      out[r.clubId] = { ambassadors: out[r.clubId]?.ambassadors ?? 0, sales: Number(r.n) }
    }
    return out
  },

  // Total rows across club-owned tables — guards club deletion.
  async countScopedRows(clubId: number): Promise<number> {
    const db = useDB()
    const one = async (table: any) => {
      const r = await db.select({ n: sql<number>`COUNT(*)` }).from(table).where(eq(table.clubId, clubId))
      return Number(r[0]?.n ?? 0)
    }
    return (await one(schema.teams)) + (await one(schema.ambassadors))
      + (await one(schema.sales)) + (await one(schema.payouts))
  },
}
