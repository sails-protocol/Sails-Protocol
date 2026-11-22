// Prop types for TrustLine and ExplanationPopover (Layer A), in a .ts file so lib/ can share them without importing JSX.

export type TrustKind = 'reputation' | 'trades' | 'disputes' | 'disputeRate' | 'rating'

export interface TrustLineItem {
  kind: TrustKind
  /** Visible text, e.g. "Reputação 82". */
  text: string
  /** Screen-reader text when it should say more than the visible one (e.g. "Reputação 82 pontos"). */
  srText?: string
}

export interface Explanation {
  title: string
  lines: string[]
  footer?: string
}
