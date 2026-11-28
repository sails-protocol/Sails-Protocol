/**
 * G3 (Despacho 069): the economic authority that signs the protocol fee policy, 2-of-3 Ed25519. PINNED in the release:
 * no configuration, environment variable or database row can add, replace or remove a key, and this module exports no
 * setter. Until the D-E1 key ceremony the key list is empty, and an empty list never verifies anything (fail closed,
 * never a bypass). Tests that need keys replace this module with jest.mock, or pass `authority` explicitly.
 */
export interface FeePolicyAuthority {
  readonly keys: readonly string[]
  readonly threshold: number
}

export const FEE_POLICY_AUTHORITY: FeePolicyAuthority = Object.freeze({ keys: Object.freeze([] as string[]), threshold: 2 })
