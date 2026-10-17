/**
 * QvacAgentProvider.assessDisputeEvidence() (RFC-021 D8) — same mocking
 * discipline as qvac-prompt-injection.test.ts: the real @qvac/sdk
 * (llama.cpp local inference) is mocked here, the provider's own prompt-
 * building/schema logic is real. Confirms this capability is genuinely
 * payment-method-agnostic (never hardcodes "PIX" or any other specific
 * rail into the prompt) — the project owner's own explicit correction,
 * 2026-08-02: "lembre-se que é qualquer comprovante dos meios de
 * pagamento envolvidos... pois somos mundiais."
 */
export {} // same forced-module reasoning as chatUnification.test.ts

let capturedHistory: Array<{ role: string; content: string }> = []
let mockCompletionResult: unknown = { recommendation: 'RELEASE', confidence: 0.9, reasoning: 'mocked' }

jest.mock('@qvac/sdk', () => ({
  loadModel: jest.fn().mockResolvedValue('fake-model-id'),
  unloadModel: jest.fn().mockResolvedValue(undefined),
  LLAMA_3_2_1B_INST_Q4_0: 'fake-model-src',
  completion: jest.fn((args: { history: Array<{ role: string; content: string }> }) => {
    capturedHistory = args.history
    return { final: Promise.resolve({ contentText: JSON.stringify(mockCompletionResult) }) }
  }),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { QvacAgentProvider } = require('../src/modules/open-agents/qvac-agent.provider')

describe('QvacAgentProvider.assessDisputeEvidence()', () => {
  beforeEach(() => {
    capturedHistory = []
    mockCompletionResult = { recommendation: 'RELEASE', confidence: 0.9, reasoning: 'mocked' }
  })

  it('returns the model-provided assessment, parsed from the schema-constrained JSON', async () => {
    const provider = new QvacAgentProvider()
    const result = await provider.assessDisputeEvidence({
      paymentMethod: 'BANK_TRANSFER',
      asset: 'BTC',
      amount: '0.01',
      currency: 'USD',
      reason: 'Buyer claims payment sent, seller disputes receipt',
      evidence: [{ type: 'payment_receipt', note: 'bank transfer confirmation, ref #4471', submittedBy: 'buyer' }],
    })

    expect(result).toEqual(mockCompletionResult)
  })

  it('never hardcodes PIX or any specific rail — the system prompt is payment-method-agnostic', async () => {
    const provider = new QvacAgentProvider()
    await provider.assessDisputeEvidence({
      paymentMethod: 'CASH',
      asset: 'BTC',
      amount: '1',
      reason: 'test',
      evidence: [],
    })

    // The prompt may illustrate the CATEGORY of payment methods generically
    // ("it could be a bank transfer, an instant-payment rail, cash...") —
    // that's fine, it's explicitly followed by "do not assume which one."
    // What matters, and what the project owner explicitly corrected
    // (2026-08-02): no rail is treated as the default/assumed one, and
    // PIX specifically — the original, narrower framing — is never named.
    const systemPrompt = capturedHistory.find((m) => m.role === 'system')!.content
    expect(systemPrompt.toLowerCase()).not.toContain('pix')
    expect(systemPrompt.toLowerCase()).toContain('do not assume which one')
  })

  it('passes through whichever real PaymentMethod the trade actually used, unmodified — checked for every real enum value', async () => {
    const provider = new QvacAgentProvider()
    for (const method of ['PIX', 'TED', 'BANK_TRANSFER', 'CRYPTO_DIRECT', 'LIGHTNING_DIRECT', 'CASH', 'OTHER'] as const) {
      await provider.assessDisputeEvidence({ paymentMethod: method, asset: 'BTC', amount: '1', reason: 'r', evidence: [] })
      const userPrompt = capturedHistory.find((m) => m.role === 'user')!.content
      expect(userPrompt).toContain(`payment method used: ${method}`)
    }
  })

  it('includes every submitted evidence item, tagged by relative role (buyer/seller), never a raw participant id', async () => {
    const provider = new QvacAgentProvider()
    await provider.assessDisputeEvidence({
      paymentMethod: 'TED',
      asset: 'USDT_ERC20',
      amount: '500',
      reason: 'r',
      evidence: [
        { type: 'payment_receipt', note: 'receipt A', submittedBy: 'buyer' },
        { type: 'chat_log', note: 'seller admitted delay', submittedBy: 'seller' },
      ],
    })
    const userPrompt = capturedHistory.find((m) => m.role === 'user')!.content
    expect(userPrompt).toContain('submitted by buyer, type: payment_receipt, note: receipt A')
    expect(userPrompt).toContain('submitted by seller, type: chat_log, note: seller admitted delay')
  })

  it('handles no evidence submitted yet without crashing', async () => {
    const provider = new QvacAgentProvider()
    const result = await provider.assessDisputeEvidence({ paymentMethod: 'OTHER', asset: 'BTC', amount: '1', reason: 'r', evidence: [] })
    expect(result).toEqual(mockCompletionResult)
    const userPrompt = capturedHistory.find((m) => m.role === 'user')!.content
    expect(userPrompt).toContain('(no evidence submitted)')
  })

  it.each([
    [{ recommendation: 'RELEASE', confidence: -0.01, reasoning: 'bad' }, /confidence/],
    [{ recommendation: 'REFUND', confidence: 1.01, reasoning: 'bad' }, /confidence/],
    [{ recommendation: 'RELEASE', confidence: Number.NaN, reasoning: 'bad' }, /confidence/],
    [{ recommendation: 'RELEASE', confidence: Number.POSITIVE_INFINITY, reasoning: 'bad' }, /confidence/],
    [{ recommendation: 'EXECUTE', confidence: 0.9, reasoning: 'bad' }, /recommendation/],
    [{ recommendation: 'RELEASE', confidence: 0.9 }, /reasoning/],
    [{ recommendation: 'RELEASE', confidence: 0.9, reasoning: 'x'.repeat(2001) }, /reasoning/],
  ])('rejects semantically invalid model output at the protocol boundary: %p', async (invalid, error) => {
    mockCompletionResult = invalid
    const provider = new QvacAgentProvider()
    await expect(provider.assessDisputeEvidence({ paymentMethod: 'OTHER', asset: 'BTC', amount: '1', reason: 'r', evidence: [] }))
      .rejects.toThrow(error as RegExp)
  })

  it('can return INCONCLUSIVE with low confidence — the safe default for ambiguous evidence', async () => {
    mockCompletionResult = { recommendation: 'INCONCLUSIVE' as any, confidence: 0.2, reasoning: 'ambiguous' }
    const provider = new QvacAgentProvider()
    const result = await provider.assessDisputeEvidence({ paymentMethod: 'PIX', asset: 'BTC', amount: '1', reason: 'r', evidence: [] })
    expect(result.recommendation).toBe('INCONCLUSIVE')
    expect(result.confidence).toBeLessThan(0.5)
  })
})
