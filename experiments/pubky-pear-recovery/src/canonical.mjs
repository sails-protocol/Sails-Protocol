// Canonical JSON for signed bodies: sorted keys, no whitespace, integers only.
// Prototype encoding. A production format should be a binary canonical encoding
// (CBOR/compact-encoding) with a versioned schema; see the ADR proposal.
import b4a from 'b4a'

export function canonicalize (value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical: only safe integers are allowed')
    return String(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    for (const k of keys) if (value[k] === undefined) throw new Error('canonical: undefined value for ' + k)
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}'
  }
  throw new Error('canonical: unsupported type ' + typeof value)
}

// Domain-separated signing input: PREFIX || 0x00 || canonical(body)
export function signingBytes (prefix, body) {
  return b4a.from(prefix + '\0' + canonicalize(body), 'utf8')
}

export const PREFIX = Object.freeze({
  authorization: 'SAILS-P2P-PEAR-AUTH-V1',
  pop: 'SAILS-P2P-PEAR-POP-V1',
  revocation: 'SAILS-P2P-REVOCATION-V1',
  history: 'SAILS-P2P-HISTORY-ENTRY-V1'
})
