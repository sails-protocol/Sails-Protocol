/**
 * F4 / invariant 3b, R-C (GK): Escrow.type has the schema default MOCK, the ONE type exempt from the commitment-pair trigger, so a
 * caller that omits `type` must never reach the database. Three layers, each with its own proof: the TypeScript signature
 * (@ts-expect-error is itself compiled by ts-jest: if `type` became optional this file stops compiling), the repository's runtime
 * check, and the production path (createEscrow resolves a concrete type before it calls the repository).
 * The production gate for an explicit MOCK and for a persisted MOCK row is already proven by tests/escrowProviderWiring.test.ts (Issue #229).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const create = jest.fn(async (args: any) => ({ id: 'e1', ...args.data }))
jest.mock('../src/common/database', () => ({ prisma: { escrow: { create: (a: any) => create(a) } } }))

import { escrowRepository } from '../src/modules/open-settlement/escrow-repository'
import type { CreateEscrowData } from '../src/modules/open-settlement/escrow-repository'

const base = { tradeId: 't1', lockedAmount: '0.005', asset: 'BTC' as const, network: undefined, timelockHours: 24 }

describe('Escrow.type is required at every creation point (never the schema default MOCK)', () => {
  beforeEach(() => create.mockClear())

  it('compile time: CreateEscrowData without `type` does not type-check', () => {
    // @ts-expect-error `type` is required in CreateEscrowData
    const missing: CreateEscrowData = { ...base }
    expect(missing).toBeDefined()
  })

  it('runtime: the repository refuses an omitted or empty type and never calls the database', async () => {
    await expect(escrowRepository.create({ ...base } as any)).rejects.toThrow(/`type` is required/)
    await expect(escrowRepository.create({ ...base, type: undefined } as any)).rejects.toThrow(/`type` is required/)
    await expect(escrowRepository.create({ ...base, type: '' } as any)).rejects.toThrow(/`type` is required/)
    expect(create).not.toHaveBeenCalled()
  })

  it('runtime: an explicit type reaches the database exactly as given (the guard is not over-broad)', async () => {
    await escrowRepository.create({ ...base, type: 'MULTISIG' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0].data.type).toBe('MULTISIG')
  })

  it('production path: createEscrow resolves a concrete type and hands it to the repository (it never leaves it to the default)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'modules', 'open-settlement', 'escrow.service.ts'), 'utf8')
    expect(src).toMatch(/const type = resolveEscrowType\(input\.asset, input\.type\)/)
    const call = src.slice(src.indexOf('const escrow = await this.repo.create({'), src.indexOf('const escrow = await this.repo.create({') + 200)
    expect(call).toMatch(/\n\s+type,\n/)
  })
})
