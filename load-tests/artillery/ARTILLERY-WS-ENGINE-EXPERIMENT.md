# Artillery WebSocket engine assertion experiment (not parity evidence)

Status: **NOT EXECUTED / NOT APPROVED**. PR #472 stays DRAFT. This document defines the minimum evidence required before changing the bounded comparator or its existing CI assertions.

## Known implementation boundary

The pinned Artillery package inspected in candidate CI exposes `_deps.WebSocket` and installs `context.ws.onmessage = getMessageHandler(...)` during its receive path. These are observed bundled implementation details, not a documented stable processor hook. The current `chat-ws-bounded-comparator.yml` only connects, sends application PING and thinks; it does not verify application PONG. The standalone `ws-real-transport.test.cjs` validates the transport helper, **not** Artillery engine behavior.

## Safe experiment design

1. Use only a disposable loopback WebSocket server on `127.0.0.1` with an ephemeral port. Never send a bearer ticket, session token, private key, or URL with a query string to logs or CI artifacts.
2. Pin and record the exact Artillery version and dependency hashes; inspect the actual installed engine's receive-step schema and callback semantics. Do not assume that a processor `function` step receives the socket or that the mutable `_deps` object is a supported extension point.
3. Create a **separate** experimental Artillery YAML/processor, leaving the production-shaped bounded comparator and its fail-closed CI guard unchanged until independently reviewed.
4. Run the actual Artillery CLI against three server modes: valid application `{\"type\":\"PONG\"}`, silence past a bounded deadline, and application `{\"type\":\"ERROR\"}`. Require valid PONG to exit successfully, silence to fail nonzero for the **missing-PONG reason**, and ERROR to fail nonzero for the **application-ERROR reason**. A mere completed VU or an external helper failure is insufficient.
5. Assert that the PING was sent once per connection, the receive assertion was executed by the Artillery engine, and the three modes have isolated bounded runs. Record sanitized error categories, command exit codes, Artillery version and counters; never preserve raw frames or URLs containing credentials.
6. If the installed engine cannot express this assertion through a supported hook, mark the experiment **BLOCKED**, keep the existing comparator non-parity, and request an independently reviewed alternative. Do not monkey-patch transport internals merely to force a green result.

## Promotion gate

Only after the real CLI positive/negative controls pass on exact HEAD and an independent reviewer approves the integration may the bounded comparator and its CI scope guard be updated. HTTP comparator parity, repeated measurements, backend/generator CPU/RSS, security limits and authorization for dependency removal remain separate open gates. No merge, deploy, Artillery removal or rate-limit changes are authorized by this experiment.
