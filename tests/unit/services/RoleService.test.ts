import { describe, it, expect } from 'vitest'
import { validateRolePayload } from '~~/server/services/RoleService'

describe('validateRolePayload', () => {
  it('rejects requires_kpi=true without kpi_threshold', () => {
    expect(() => validateRolePayload({
      name: 'X', tier: 'ambassador', baseRate: 8, bonusRate: 1, requiresKpi: true, kpiThreshold: null,
    })).toThrow(/kpi_threshold/i)
  })

  it('rejects kpi_threshold without bonus_rate', () => {
    expect(() => validateRolePayload({
      name: 'X', tier: 'ambassador', baseRate: 8, bonusRate: null, requiresKpi: false, kpiThreshold: 30000,
    })).toThrow(/bonus_rate/i)
  })

  it('forces tier=admin to drop KPI fields', () => {
    const r = validateRolePayload({
      name: 'X', tier: 'admin', baseRate: 10, bonusRate: 2, requiresKpi: true, kpiThreshold: 30000,
    })
    expect(r.requiresKpi).toBe(false)
    expect(r.kpiThreshold).toBeNull()
  })

  it('accepts ambassador tier with bonus + KPI', () => {
    const r = validateRolePayload({
      name: 'VIP', tier: 'ambassador', baseRate: 8, bonusRate: 1, requiresKpi: true, kpiThreshold: 30000,
    })
    expect(r).toEqual({ name: 'VIP', tier: 'ambassador', baseRate: 8, bonusRate: 1, requiresKpi: true, kpiThreshold: 30000, poolShare: false })
  })

  it('accepts ambassador tier with no bonus', () => {
    const r = validateRolePayload({
      name: 'Plain', tier: 'ambassador', baseRate: 8, bonusRate: null, requiresKpi: false, kpiThreshold: null,
    })
    expect(r.bonusRate).toBeNull()
    expect(r.kpiThreshold).toBeNull()
  })

  it('rejects negative base_rate', () => {
    expect(() => validateRolePayload({
      name: 'X', tier: 'ambassador', baseRate: -1, bonusRate: null, requiresKpi: false, kpiThreshold: null,
    })).toThrow(/base_rate/i)
  })

  it('rejects empty name', () => {
    expect(() => validateRolePayload({
      name: '', tier: 'ambassador', baseRate: 0, bonusRate: null, requiresKpi: false, kpiThreshold: null,
    })).toThrow(/name/i)
  })
})

const base = { name: 'X', tier: 'admin' as const, baseRate: 10, bonusRate: null, requiresKpi: false, kpiThreshold: null }

describe('validateRolePayload poolShare', () => {
  it('defaults poolShare to false', () => {
    expect(validateRolePayload(base).poolShare).toBe(false)
  })
  it('passes poolShare through', () => {
    expect(validateRolePayload({ ...base, poolShare: true }).poolShare).toBe(true)
  })
})
