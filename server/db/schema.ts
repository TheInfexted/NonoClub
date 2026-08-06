import {
  mysqlTable, int, varchar, text, datetime, date, decimal,
  mysqlEnum, tinyint, primaryKey, index, char, json, unique,
} from 'drizzle-orm/mysql-core'
import { sql } from 'drizzle-orm'

const ts = () => ({
  createdAt: datetime('created_at', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
})
const softDelete = () => ({ deletedAt: datetime('deleted_at', { mode: 'date' }) })

export const clubs = mysqlTable('clubs', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  logoPath: varchar('logo_path', { length: 500 }),
  // Monthly commission budget as % of confirmed sales. NULL = no cap/pool.
  commissionCapRate: decimal('commission_cap_rate', { precision: 5, scale: 2 }),
  ...ts(),
  ...softDelete(),
})

// club_id NULL = company-level staff role (what user logins reference, carries
// the permission tier); club_id = N = commission role of club N (what
// ambassadors reference, carries the rates).
export const roles = mysqlTable('roles', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 40 }).notNull(),
  clubId: int('club_id'),
  tier: mysqlEnum('tier', ['admin', 'ambassador']).default('ambassador').notNull(),
  baseRate: decimal('base_rate', { precision: 5, scale: 2 }).default('0.00').notNull(),
  bonusRate: decimal('bonus_rate', { precision: 5, scale: 2 }),
  kpiThreshold: decimal('kpi_threshold', { precision: 12, scale: 2 }),
  requiresKpi: tinyint('requires_kpi').default(0).notNull(),
  isSystem: tinyint('is_system').default(0).notNull(),
  // Owner-protection anchor: replaces literal role-name checks ('owner') so
  // companies can rename roles without silently disabling protections.
  isOwner: tinyint('is_owner').default(0).notNull(),
  // Member of this role splits the club's remaining commission pool
  // (cap% × sales − everyone's base − other bonuses) equally.
  poolShare: tinyint('pool_share').default(0).notNull(),
  // Optional per-sale-type rate overrides: { [saleTypeName]: '5.00' }.
  // A sale type without an entry earns the plan's base rate. Resolved at
  // confirmation time — the chosen rate freezes onto the sale as always.
  rateOverrides: json('rate_overrides').$type<Record<string, string>>(),
  ...ts(),
}, (t) => ({
  clubName: unique('roles_club_name_unique').on(t.clubId, t.name),
  byClub: index('roles_by_club').on(t.clubId),
}))

export const teams = mysqlTable('teams', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  clubId: int('club_id').notNull(),
  ...ts(),
  ...softDelete(),
}, (t) => ({
  byClub: index('teams_by_club').on(t.clubId),
}))

export const ambassadors = mysqlTable('ambassadors', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  fullName: varchar('full_name', { length: 200 }),
  ic: varchar('ic', { length: 60 }),
  teamId: int('team_id'),
  roleId: int('role_id').notNull(),
  clubId: int('club_id').notNull(),
  isProtected: tinyint('is_protected').default(0).notNull(),
  bankName: varchar('bank_name', { length: 120 }),
  bankAccountNumber: varchar('bank_account_number', { length: 60 }),
  bankOwnerName: varchar('bank_owner_name', { length: 200 }),
  ...ts(),
  ...softDelete(),
}, (t) => ({
  byClub: index('ambassadors_by_club').on(t.clubId),
}))

export const users = mysqlTable('users', {
  id: int('id').autoincrement().primaryKey(),
  email: varchar('email', { length: 160 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  roleId: int('role_id').notNull(),
  ambassadorId: int('ambassador_id'),
  // Per-chapter onboarding-tour progress: { [chapterId]: 'done' | 'skipped' }
  onboardingState: json('onboarding_state').$type<Record<string, 'done' | 'skipped'>>(),
  // Owner-managed access: null = all clubs; array = only these club ids.
  clubAccess: json('club_access').$type<number[]>(),
  // Owner-managed module permissions: null = tier defaults;
  // { [module]: 'edit' | 'view' | 'none' } overrides per module.
  permissions: json('permissions').$type<Record<string, 'edit' | 'view' | 'none'>>(),
  ...ts(),
  ...softDelete(),
})

// Per-club sale categories (pick-list). Sales snapshot the type NAME as a
// string so renaming a type never rewrites historical rows.
export const saleTypes = mysqlTable('sale_types', {
  id: int('id').autoincrement().primaryKey(),
  clubId: int('club_id').notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  sortOrder: int('sort_order').default(0).notNull(),
  isActive: tinyint('is_active').default(1).notNull(),
  ...ts(),
}, (t) => ({
  clubName: unique('sale_types_club_name_unique').on(t.clubId, t.name),
  byClub: index('sale_types_by_club').on(t.clubId),
}))

export const sales = mysqlTable('sales', {
  id: int('id').autoincrement().primaryKey(),
  date: date('date', { mode: 'string' }).notNull(),
  ambassadorId: int('ambassador_id').notNull(),
  clubId: int('club_id').notNull(),
  type: varchar('type', { length: 40 }).notNull(),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  notes: text('notes'),
  status: mysqlEnum('status', ['draft', 'confirmed', 'voided']).default('draft').notNull(),
  confirmedCommissionRate: decimal('confirmed_commission_rate', { precision: 5, scale: 2 }),
  confirmedBonusRate: decimal('confirmed_bonus_rate', { precision: 5, scale: 2 }),
  externalOrderId: varchar('external_order_id', { length: 50 }),
  tableNumber: varchar('table_number', { length: 20 }),
  createdBy: int('created_by').notNull(),
  confirmedAt: datetime('confirmed_at', { mode: 'date' }),
  voidedAt: datetime('voided_at', { mode: 'date' }),
  ...ts(),
}, (t) => ({
  byDate: index('sales_by_date').on(t.date),
  byAmbassador: index('sales_by_ambassador').on(t.ambassadorId),
  byOrderId: index('sales_by_order_id').on(t.externalOrderId),
  byClub: index('sales_by_club').on(t.clubId, t.date),
  // Hard dedupe backstop for imports: a receipt can exist once per club.
  // NULL external ids (manual sales) are exempt by MySQL unique semantics.
  clubOrderUnique: unique('sales_club_order_unique').on(t.clubId, t.externalOrderId),
}))

export const payouts = mysqlTable('payouts', {
  id: int('id').autoincrement().primaryKey(),
  ambassadorId: int('ambassador_id').notNull(),
  clubId: int('club_id').notNull(),
  periodMonth: char('period_month', { length: 7 }).notNull(),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  snapshotBonusRate: decimal('snapshot_bonus_rate', { precision: 5, scale: 2 }),
  snapshotKpiThreshold: decimal('snapshot_kpi_threshold', { precision: 12, scale: 2 }),
  snapshotRequiresKpi: tinyint('snapshot_requires_kpi'),
  notes: text('notes'),
  receiptPaths: json('receipt_paths').$type<Array<{ path: string; name: string; size: number; mime: string }>>(),
  payslipPath: varchar('payslip_path', { length: 500 }),
  paidAt: datetime('paid_at', { mode: 'date' }),
  createdBy: int('created_by').notNull(),
  ...ts(),
}, (t) => ({
  byAmbMonth: index('payouts_by_amb_month').on(t.ambassadorId, t.periodMonth),
  byClub: index('payouts_by_club').on(t.clubId, t.periodMonth),
}))

export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 60 }).primaryKey(),
  value: text('value').notNull(),
  updatedAt: datetime('updated_at', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
})

export type Club = typeof clubs.$inferSelect
export type SaleType = typeof saleTypes.$inferSelect
export type Role = typeof roles.$inferSelect
export type Team = typeof teams.$inferSelect
export type Ambassador = typeof ambassadors.$inferSelect
export type User = typeof users.$inferSelect
export type Sale = typeof sales.$inferSelect
export type NewSale = typeof sales.$inferInsert
export type Payout = typeof payouts.$inferSelect
export type Setting = typeof settings.$inferSelect
