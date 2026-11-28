# ADR-008: Portable identity, social data and market ownership recovery

**Status:** Accepted as architectural direction (2026-11-23). **Not implemented.** Each part ships in its own pull request, with tests, mutation checks and review by commit. Diagrams: [SYSTEM_DESIGN.md section 14.5](../SYSTEM_DESIGN.md). Market Spaces: [README](../architecture/MARKET_SPACES/README.md).

## Context
Sails separates four roles:
- **Pears** carries messages;
- **Pubky** identifies the user and authorizes devices;
- the **Sails node and SDK** record and verify;
- the **wallet** moves funds.

Today only the Sails participant key, the client escrow keys and the node exist in code. Pubky is used only in experiments; prototypes are a source of test vectors and are not merged. This record decides how a user recovers access to social data, market administration and funds without new mandatory seeds or backups.

## Decision

### 1. Three separate mechanisms
| Domain | Mechanism |
| --- | --- |
| Social data (contacts, groups, favorites) | **First release: kept on the device only.** Later, once a signer that delivers scoped encryption keys (the `e` action) has been verified on real devices: an encrypted record in `/priv/` under a key for one versioned file, never a directory or `/`. |
| Market ownership | A **recovery authority** declared by the owner, which authorizes a **new** participant key. The old key is never reused or stored off the device. |
| Funds and escrow | Client escrow keys go in an encrypted local backup, requested **only while an escrow is open**. They are isolated from the other two mechanisms. |

### 2. Market ownership record
- Ownership is a chain of signed revisions. The market identifier is the hash of the signed genesis.
- A node's database row is a cache of the chain, never its source.
- Revisions follow the existing signed offer envelope pattern: owner, identifier, revision and content digest are unique together, and the highest revision wins.
- Two valid revisions with the same number **freeze** the market until the owner resolves them.
- Administrators act only inside a scope and validity signed by the owner. They never sign revisions, never delegate further and never transfer the market.
- Payment for activation never makes anyone the owner.

### 3. Recovery authority
- **Declaration.** The owner's current key signs a `recovery-authority` revision `{members, k, delayDays, scope: "market-ownership"}`.
  - Default: **1 of 1, the owner's own Pubky identity held in their signer.**
  - Optional: k of n members, offered when the market is created.
- **Scope.** A `recovery` revision (domain `sails-market-recovery-v1`) can only move ownership to a new key or change administrators. It never touches funds, escrow, fees, disputes or the economic identity.
- **Binding of the new key.** A recovery is valid only if all of the following hold:
  - the grant's issuer equals the declared Pubky identity;
  - the grant comes directly from the root; child grants are refused;
  - its capability names exactly `/pub/sails/v1/bindings/<new key>`;
  - it has not expired;
  - its signature verifies offline under the domain `sails-recovery-binding-v1`.
- **Delay.** `d = 7 days` is the **minimum security period**, not a promise of recovery within 7 days: if the host is unavailable or refuses, the recovery stays blocked. The same delay applies to a normal transfer signed by the current key, and to removing or changing the recovery authority, while an authority is named.
- **Concurrent recoveries.** Two pending recoveries cancel each other and freeze the market. The owner is notified, and a new recovery restarts the delay.

### 4. When a recovery takes effect
- **The market's host decides.** The host records the recovery in an append-only log (no update or delete) and uses the clock of its database, not that of the application process. The recovery takes effect at **host receipt + d**, if no veto was received by the host before then. A time signed by the new key never counts, and a recovery that has taken effect is final.
- **A veto** signed by the current key cancels the recovery permanently. It may reach the host by any channel, including relayed from the owner's homeserver.
- **The owner's homeserver is a transparency mirror only.** It shows the pending recovery so that the owner and others notice. It is not a source of time or of "no veto": whoever controls the Pubky root can delete files there, and its timestamps are unsigned. A recovery present only on the homeserver never takes effect.
- **A third-party SDK** checks the signatures and the binding itself. For timing and the absence of a veto it accepts the host's verdict for that host's market. It refuses and flags a recovery declared effective before its own first sighting + d, or one declared despite a veto it saw. For an ownership change that took effect less than d ago, the SDK shows a "recent ownership change" notice with the timeline instead of accepting it silently. Refusing means not recognizing the new owner for privileged actions and flagging it, while the market keeps running on the host; different clients may therefore see different states, which is the expected signal of a dishonest host.

### 5. User journey
| Moment | Actions | Secrets to keep |
| --- | --- | --- |
| Activate | 2: open the wallet; scan the code with the signer and approve | The signer's own recovery; the wallet seed |
| Open an escrow without a backup | 1: save the escrow backup. If the user declines and later loses the device, that escrow goes to dispute, with no guarantee | That backup, while the escrow is open |
| Lose the device | 3: restore the signer; scan; approve. Market administration can return no earlier than 7 days later, if the old device does not object and the host cooperates; the market keeps working meanwhile | As above |
| Change wallet | Same as losing the device | As above |
| Lose everything | None | Identity, markets (unless k of n is configured), contacts and reputation are lost; funds depend only on the wallet seed; open escrows resolve by dispute |

**What the product states:**
- the recovered key is a new economic identity; reputation does not move in the first release;
- approve bindings only inside the Sails app; revoking in the signer does not cancel a recovery in progress;
- contacts stay on this device in the first release.

Notifications of a pending recovery go to more than one channel. None of this copy appears before the corresponding part is implemented and approved.

## Accepted residual risks (first release)
- Whoever controls the owner's Pubky identity and is not vetoed within d takes over the market. This is inherent: that identity is the recovery authority the owner chose. Notifications on more than one channel and the optional k of n reduce it.
- The market depends on its host. A host that refuses to record a recovery blocks it: denial of service, never theft. The remedy is host migration, which is not implemented yet.
- A host colluding with the holder of the Pubky root can ignore a veto that only it received.
- A binding approved through phishing in the signer starts a recovery. Only a veto stops it.
- A client that never saw a pending recovery cannot detect early effect.
- Data is not moved automatically between hosts.
- Once scoped keys are used for social data, they are permanent for content already written.

## Alternatives rejected
- **Storing the participant key encrypted under a permanent scoped key.** A device or app that once held that key could recover the participant key forever.
- **Effect by timeout when one source is missing.** A missing source cannot prove the absence of a veto.
- **Requiring a backup file for social data.** This is disproportionate for data that carries no authority.
- **A public time anchor in the first release.** It costs a fee per fact and needs indexing. Reconsider only if liveness against a refusing host is required.

## Consequences
- **Market Spaces:** the first PR gains the append-only ownership revisions and their verification, and administrator membership becomes a projection. In the second PR, invites and member approval become signed administrative actions. The SDK PR adds only signing and verification helpers.
- **No migration, merge or deployment follows automatically from this record.**
