# Gate 2 — Jest open-handle diagnostic runbook (non-production)

Status: **Prepared, not executed.** This runbook isolates the persistent warning seen in green CI builds: `A worker process has failed to exit gracefully and has been force exited`. The responsible suite/handle is unknown. No claim of resolution.

## Evidence baseline

- Green baseline SHA: `91a1572e75c0cdf94cd870637eb4c7d26bbf6cdd`; CI build `121074326298` reports 197/197 suites and 2633/2633 tests passing, and still reports the forced-worker-exit warning.
- The Redis two-process suite forks a Node child and opens Redis clients. **Do not assume it causes the warning**; Jest's warning can originate elsewhere in the parallel suite.
- Current candidate branch is `security/307-relay-bounded-frames-candidate`. Tests depending on real Redis must run only against a disposable isolated instance.

## Reproduction commands (execute in an ephemeral runner; not executed by this document)

```sh
# First: isolated two-process suite with disposable Redis already available
RELAY_REDIS_INTEGRATION_URL=redis://127.0.0.1:6379 \
  npx jest tests/relayDeliveryRedis.process.integration.test.ts --runInBand --detectOpenHandles --no-coverage

# Second: full suite in diagnostic mode (may be slow)
RELAY_REDIS_INTEGRATION_URL=redis://127.0.0.1:6379 \
  npx jest --runInBand --detectOpenHandles --no-coverage

# Third: normal parallel suite, after targeted fixes, to verify the warning is gone
RELAY_REDIS_INTEGRATION_URL=redis://127.0.0.1:6379 \
  npx jest --no-coverage
```

Use the repository's exact package-manager/test scripts if CI invokes Jest through a wrapper; preserve environment parity. Do not add `--forceExit`, suppress stderr, or globally increase timeouts to make the warning disappear.

## Triage and acceptance

1. Capture SHA, Node/Jest versions, exact command, Redis service lifecycle, logs, and exit status for each run.
2. Check child-process `exit`/`close` and IPC teardown; Redis client `quit`/`disconnect`; leftover timers, server sockets, and event listeners. Attribute each open handle to a specific suite before editing.
3. Repair only the offending teardown, preferably in an isolated test file, then rerun targeted diagnostics and the normal parallel CI.
4. Mark resolved only when the **standard CI log** no longer emits the forced-worker-exit warning, all tests pass, and the result is independently reviewed against an exact SHA.

This is a diagnostic procedure, not a claim that diagnostics have run or a production change.
