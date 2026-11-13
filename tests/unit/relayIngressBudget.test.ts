import { describe, expect, it, beforeEach } from '@jest/globals'
import {
  consumeRelayBudget, resetRelayBudgetForTests,
  RELAY_FRAME_MAX_BYTES, RELAY_WINDOW_MAX_BYTES,
  RELAY_WINDOW_MAX_MESSAGES, RELAY_WINDOW_MS,
} from '../../src/infrastructure/p2p/relay-ingress-budget'

describe('relay ingress budget — process-local candidate', () => {
  beforeEach(() => resetRelayBudgetForTests())

  it('rejects invalid sizes and frames above the byte ceiling', () => {
    expect(consumeRelayBudget('a', -1, 0)).toBe(false)
    expect(consumeRelayBudget('a', Number.NaN, 0)).toBe(false)
    expect(consumeRelayBudget('a', RELAY_FRAME_MAX_BYTES + 1, 0)).toBe(false)
    expect(consumeRelayBudget('a', RELAY_FRAME_MAX_BYTES, 0)).toBe(true)
  })

  it('caps messages across reconnects sharing the same participant ID', () => {
    for (let i = 0; i < RELAY_WINDOW_MAX_MESSAGES; i++) {
      expect(consumeRelayBudget('a', 1, 100)).toBe(true)
    }
    expect(consumeRelayBudget('a', 1, 100)).toBe(false)
    expect(consumeRelayBudget('b', 1, 100)).toBe(true)
    expect(consumeRelayBudget('a', 1, 100 + RELAY_WINDOW_MS)).toBe(true)
  })

  it('caps aggregate bytes independently of the message limit', () => {
    for (let i = 0; i < RELAY_WINDOW_MAX_BYTES / RELAY_FRAME_MAX_BYTES; i++) {
      expect(consumeRelayBudget('a', RELAY_FRAME_MAX_BYTES, 100)).toBe(true)
    }
    expect(consumeRelayBudget('a', 1, 100)).toBe(false)
  })

  it('fails closed on participant churn beyond bounded storage', () => {
    for (let i = 0; i < 10_000; i++) {
      expect(consumeRelayBudget('participant-' + i, 1, 100)).toBe(true)
    }
    expect(consumeRelayBudget('overflow', 1, 100)).toBe(false)
    expect(consumeRelayBudget('overflow', 1, 100 + RELAY_WINDOW_MS)).toBe(true)
  })
})
