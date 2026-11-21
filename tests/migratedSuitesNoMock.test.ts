/**
 * F4 / GK condition (X2): the suites migrated to the COMMITTED-pair / legacy-seed fixtures must not escape the trigger by switching an
 * escrow to MOCK. With the deployment_mode row present in test databases, MOCK passes the trigger, so swapping \`type: 'MULTISIG'\` for 'MOCK'
 * in a migrated suite or harness would otherwise go unnoticed. Each inventory suite is pinned to its EXACT number of quoted MOCK mentions
 * (0 where the suite has no MOCK case at all). A change here is a conscious decision, reviewed with the suite, never a side effect.
 * The list is the 30 suites of F4_INVENTARIO_CORPUS (plus the suites and the harness this migration touched).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const MOCK_MENTIONS: Record<string, number> = {
  'tests/integration/atomicDisputeOpening.test.ts': 2,
  'tests/integration/capabilityAuthorityEnforced.test.ts': 1,
  'tests/integration/codex585P1Findings.test.ts': 4,
  'tests/integration/disputeOutcomeMultisigLive.test.ts': 0,
  'tests/integration/disputedDispositionProductionPath.test.ts': 0,
  'tests/integration/distributionEntitlementFoundation.test.ts': 3,
  'tests/integration/escrowArbiterCommitmentIntegration.test.ts': 0,
  'tests/integration/escrowFundingConcurrency.test.ts': 0,
  'tests/integration/escrowFundingUncertainty.test.ts': 0,
  'tests/integration/escrowTimelockExpiryAuthority.test.ts': 2,
  'tests/integration/expiryRecoveryStateMachine.test.ts': 1,
  'tests/integration/f32PartyAbsenceCharacterization.test.ts': 0,
  'tests/integration/feeCollectionRecognitionIntegration.test.ts': 0,
  'tests/integration/feePolicyImmutability.test.ts': 2,
  'tests/integration/feeSnapshotPreFundingIntegration.test.ts': 4,
  'tests/integration/m9fReleaseReorg.test.ts': 0,
  'tests/integration/m9rClaimRecovery.test.ts': 0,
  'tests/integration/m9rDispatchRecovery.test.ts': 1,
  'tests/integration/multisigBroadcastOutcome.test.ts': 0,
  'tests/integration/multisigDustPolicyIntegration.test.ts': 0,
  'tests/integration/multisigOutpointIntegrity.test.ts': 0,
  'tests/integration/pendingRoundLifecycle.test.ts': 0,
  'tests/integration/pendingRoundLifecycleHarness.ts': 0,
  'tests/integration/pendingRoundLifecycleProcesses.test.ts': 0,
  'tests/integration/postBroadcastFeeRecovery.test.ts': 0,
  'tests/integration/rulingFinalizationEligibility.test.ts': 6,
  'tests/integration/semanticTransitionRecordAtomicity.test.ts': 0,
  'tests/integration/settlementProvenanceFailClosed.test.ts': 0,
  'tests/integration/signatureCollectionDisputeProvenance.test.ts': 0,
  'tests/integration/signatureCollectionRestartConvergence.test.ts': 0,
  'tests/integration/staleDisputeCleanupSignatureRace.test.ts': 0,
  'tests/integration/wdkSplitRestartConvergence.test.ts': 0,
  'tests/integration/wdkTerminalRestartConvergence.test.ts': 0,
  'tests/integration/wdkUnresolvedAttemptGuard.test.ts': 0,
  'tests/integration/wdkTransferAttemptConcurrency.test.ts': 0,
}

export function countMockMentions(source: string): number {
  return (source.match(/['"`]MOCK['"`]/g) || []).length
}

describe('migrated suites do not escape the F4 binding through MOCK', () => {
  it.each(Object.entries(MOCK_MENTIONS))('%s has exactly %i quoted MOCK mentions', (file, expected) => {
    expect(countMockMentions(readFileSync(join(ROOT, file), 'utf8'))).toBe(expected)
  })

  it('MUTANT: turning one MULTISIG escrow into MOCK (the vetoed bypass) changes the count and is caught', () => {
    const real = readFileSync(join(ROOT, 'tests/integration/pendingRoundLifecycleHarness.ts'), 'utf8')
    const mutated = real.replace("type: 'MULTISIG'", "type: 'MOCK'")
    expect(mutated).not.toBe(real)
    expect(countMockMentions(mutated)).not.toBe(MOCK_MENTIONS['tests/integration/pendingRoundLifecycleHarness.ts'])
  })

  it('the pinned list is not vacuous: it covers the inventory suites and the harness', () => {
    expect(Object.keys(MOCK_MENTIONS).length).toBeGreaterThanOrEqual(30)
    expect(MOCK_MENTIONS['tests/integration/pendingRoundLifecycleHarness.ts']).toBe(0)
  })
})
