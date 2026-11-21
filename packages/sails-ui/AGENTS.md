# Sails UI: entry point for humans and AI agents

**Read before changing anything under `packages/sails-ui/`.** This applies to people, Claude, Codex, Copilot, Cursor and any other coding agent. It complements the repository's root [`AGENTS.md`](../../AGENTS.md), and the root rules still apply. This file is a router: it copies no rules and only points to where they live.

## Read in this order
1. [`DECISIONS.md`](DECISIONS.md): what the Product Owner, the CTO and the EPM have **decided**. It is binding. Never revert, work around or "improve" a recorded decision on your own. If your task conflicts with it, **stop and report**. Items under "Pendente de decisão" are not closed.
2. [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md): **how** the interface is built. Tokens, typography, components, states, contrast and voice. Use only its tokens and components.
3. [`docs/product/PRODUCT_REQUIREMENTS_REGISTRY.md`](../../docs/product/PRODUCT_REQUIREMENTS_REGISTRY.md): what we want to build and why, what is decided, what is pending and what blocks it (index issue #745).
4. `src/lib/looseWires.ts`: every planned feature the screen shows as "Em breve", with the contract it waits for (issue #729).

## Non-negotiables
- **Refine, never redo.** Change only what the task asks. Nothing that was approved disappears from the screen; when something moves, it is re-homed and old routes redirect.
- **Truth before looks.** No invented state, deadline, fee, count, rating, custody claim or reputation scale. If the SDK does not return it, the screen does not show it. Show "Em breve" and link a loose wire.
- **Reuse before creating.** Asset options come only from `src/lib/assetCatalog.ts`. Payment methods are read only through `offerPaymentMethods()`. Demo-only data goes only through the guards in `src/lib/demoMarkers.ts`. UI primitives live in `src/components/ui/`.
- **Every relevant UX discovery goes to the requirements registry before it is considered closed.** Send it to the EPM; the UI does not keep a parallel list.
- **Publishing** happens only after the EPM's inspection, and always as a Draft. Merge, migration, deploy and economic activation are behind the CTO/GK gates.

## Before you deliver
- [ ] Read `DECISIONS.md` and checked your change against it.
- [ ] TypeScript: `cd packages/sails-ui && node ../../node_modules/typescript/bin/tsc --noEmit -p .` returns 0 errors.
- [ ] Full Jest passes, including `tests/designSystemGuard.test.ts`, with no new `ds-allow`.
- [ ] Layout checked at 320–1440 px, dark and light, both menu positions: no horizontal scroll, truncation or overlap.
- [ ] Keyboard and screen-reader basics checked: names, focus, live regions only where needed.
- [ ] [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines) reviewed, with findings listed as file:line.
- [ ] LF line endings only.
- [ ] Copy comes from `t()` (pt-BR source catalog plus en, es, fr, de in `src/i18n/areas/`, DESIGN_SYSTEM.md 7.3), sentence case. Use "nó Sails", never "servidor"; money, dispute, deadline, reputation, custody and confirmation keys go in the native-review list.

If a linked file moves, fix the link here; do not copy its rules into this file.
