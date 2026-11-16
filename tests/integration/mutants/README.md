# Mutants for the OS-process reconciler suites (Issue #253)

Evidence tooling, not part of any build. Each `.patch` breaks ONE property of the production projection code on
purpose; `run-mutants.sh` applies it to the working tree, runs
`reconcilerOsProcess.test.ts` + `reconcilerOsProcessFanout.test.ts` against it, and reverts it.

```bash
bash tests/integration/mutants/run-mutants.sh NONE   # GREEN: the suites against unmodified code
bash tests/integration/mutants/run-mutants.sh M1 M4  # RED: chosen mutants
```

It needs what `npm run test:integration:postgres` needs (a disposable PostgreSQL, Redis, and the
`SAILS_INTEGRATION_TEST_DB_CONFIRMED` / `TRUSTED_ARBITRATORS` variables).

| Mutant | What it breaks | Property it attacks |
| --- | --- | --- |
| M1 | `effectIdentity()` returns the durable eventId instead of the source transition id | two durable events for one transition apply every effect twice |
| M2 | the result of the claim insert is ignored | a second delivery applies the effect again |
| M3 | the claim is inserted outside the effect transaction | a crash between claim and effect loses the effect for good |
| M4 | the fee floor is accrued to the buyer only | seller side of the fee effect |
| M5 | trade volume is counted for the buyer only | seller side of the volume effect |
| M6 | the score notification is published on every delivery, not once per claimed effect | notification repeats beyond what a rollback explains |
| M7 | the score notification reports the score from before the increment | notification value vs the persisted score |

M4 and M5 exist because the suite this one replaces checked only the buyer's volume and fees: they are the evidence that
the widened assertions (every participant, every counter) can fail where the old ones could not. M6 and M7 are the same
for notifications (count and value).

The measured results of each mutant are in the pull request description. A mutant that a suite does not kill is
reported there as surviving, not hidden.
