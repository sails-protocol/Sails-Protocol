// AUD1X-R4 (final negative proof) - the one deleter of an Outcome record has no unbound form.
//
// Compile time: the signed authority is a required argument (tests/ and src/ are compiled against it; a call without it
// does not build). Run time, proved here on the real function: a caller that bypasses the type system - an `any`, a value
// read from a missing column, an empty string - is refused BEFORE any statement is issued, so the deletion can never fall
// back to a delete by (escrow, appeal round) alone. The predicate it applies when the signature is valid is proved on
// real PostgreSQL (tests/integration/aud1xR2DispatchAuthority.test.ts, R4-*).
jest.mock('../src/common/database', () => ({ prisma: { semanticTransitionRecord: { deleteMany: jest.fn() } } }))

import { revertDisputeRulingRecord } from '../src/modules/open-settlement/dispute-outcome'

const fakeClient = (count = 1) => {
  const deleteMany = jest.fn(async (..._args: unknown[]) => ({ count }))
  return { client: { semanticTransitionRecord: { deleteMany } } as never, deleteMany }
}

describe('revertDisputeRulingRecord - the signed authority is mandatory on every path', () => {
  it.each<[string, unknown]>([
    ['an empty string', ''],
    ['undefined (a caller that bypasses the type)', undefined],
    ['null (a missing column read as null)', null],
    ['a number', 7],
    ['an object', { sig: 'x' }],
  ])('%s: refused with a TypeError, and no statement is issued', async (_name, signature) => {
    const { client, deleteMany } = fakeClient()

    await expect(revertDisputeRulingRecord('escrow-1', 0, signature as string, client)).rejects.toThrow(TypeError)
    await expect(revertDisputeRulingRecord('escrow-1', 0, signature as string, client)).rejects.toThrow(/requires the signed authority/)

    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('a valid signature binds the deletion to that authority\'s attribution, the slot alone never selects the record', async () => {
    const { client, deleteMany } = fakeClient(1)

    const deleted = await revertDisputeRulingRecord('escrow-1', 2, 'signature-hex', client)

    expect(deleted).toBe(1)
    expect(deleteMany).toHaveBeenCalledTimes(1)
    expect(deleteMany.mock.calls[0][0]).toEqual({
      where: { interactionId: 'escrow-1', transitionType: expect.any(String), appealRound: 2, attributionRawProof: 'signature-hex' },
    })
  })

  it('reports how many records matched (0 when the slot holds another authority\'s record)', async () => {
    const { client } = fakeClient(0)

    expect(await revertDisputeRulingRecord('escrow-1', 0, 'signature-of-another-ruling', client)).toBe(0)
  })
})
