const mockLoadModel = jest.fn().mockResolvedValue('model-1')
const mockCompletion = jest.fn()

jest.mock('@qvac/sdk', () => ({
  loadModel: (...args: unknown[]) => mockLoadModel(...args),
  completion: (...args: unknown[]) => mockCompletion(...args),
  unloadModel: jest.fn(),
  LLAMA_3_2_1B_INST_Q4_0: 'model-source',
}))

import { QvacAgentProvider, validateDisputeEvidenceAssessment } from '../src/modules/open-agents/qvac-agent.provider'

const input = {
  paymentMethod: 'BANK_TRANSFER' as const,
  asset: 'BTC' as const,
  amount: '0.01',
  reason: 'no payment received',
  evidence: [{ type: 'payment_receipt', submittedBy: 'buyer' as const }],
}

function mockModelOutput(output: unknown): void {
  mockCompletion.mockReturnValueOnce({
    final: Promise.resolve({ contentText: JSON.stringify(output) }),
  })
}

describe('QvacAgentProvider dispute assessment runtime validation', () => {
  beforeEach(() => {
    mockLoadModel.mockClear()
    mockCompletion.mockReset()
  })

  it.each(['RELEASE', 'REFUND', 'INCONCLUSIVE'] as const)('accepts supported recommendation %s', async (recommendation) => {
    mockModelOutput({ recommendation, confidence: 0.5, reasoning: 'evidence reviewed' })

    await expect(new QvacAgentProvider().assessDisputeEvidence(input)).resolves.toEqual({
      recommendation,
      confidence: 0.5,
      reasoning: 'evidence reviewed',
    })
  })

  it.each([0, 0.5, 1])('accepts valid confidence %p', async (confidence) => {
    mockModelOutput({ recommendation: 'RELEASE', confidence, reasoning: 'evidence reviewed' })

    await expect(new QvacAgentProvider().assessDisputeEvidence(input)).resolves.toMatchObject({ confidence })
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite confidence %p at the validation boundary', (confidence) => {
    expect(() => validateDisputeEvidenceAssessment({ recommendation: 'RELEASE', confidence, reasoning: 'evidence reviewed' })).toThrow(
      'Invalid QVAC dispute evidence assessment confidence'
    )
  })

  it.each([
    ['unknown recommendation', { recommendation: 'APPROVE', confidence: 0.5, reasoning: 'evidence reviewed' }],
    ['missing recommendation', { confidence: 0.5, reasoning: 'evidence reviewed' }],
    ['confidence below zero', { recommendation: 'RELEASE', confidence: -0.1, reasoning: 'evidence reviewed' }],
    ['confidence above one', { recommendation: 'RELEASE', confidence: 1.1, reasoning: 'evidence reviewed' }],
    ['NaN confidence', { recommendation: 'RELEASE', confidence: NaN, reasoning: 'evidence reviewed' }],
    ['positive infinity confidence', { recommendation: 'RELEASE', confidence: Infinity, reasoning: 'evidence reviewed' }],
    ['negative infinity confidence', { recommendation: 'RELEASE', confidence: -Infinity, reasoning: 'evidence reviewed' }],
    ['string confidence', { recommendation: 'RELEASE', confidence: '0.5', reasoning: 'evidence reviewed' }],
    ['missing confidence', { recommendation: 'RELEASE', reasoning: 'evidence reviewed' }],
    ['null output', null],
    ['array output', []],
    ['wrong reasoning type', { recommendation: 'RELEASE', confidence: 0.5, reasoning: 123 }],
  ])('rejects %s', async (_caseName, output) => {
    mockModelOutput(output)

    await expect(new QvacAgentProvider().assessDisputeEvidence(input)).rejects.toThrow('Invalid QVAC dispute evidence assessment')
  })
})