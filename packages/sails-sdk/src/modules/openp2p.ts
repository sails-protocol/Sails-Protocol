/**
 * @satsails/p2p-trading-sdk — Sails OpenP2P module (verified against
 * src/modules/open-p2p/trade.routes.ts and chat.routes.ts directly).
 *
 * Deviation from an earlier draft of SDK_GUIDE.md section 2's signature:
 * that doc originally specified `trade(offerId: string): Promise<Trade>`,
 * but `POST /v1/openp2p/trades`'s real body requires `amount` too
 * (trade.routes.ts) — a two-arg call that omits it would just 400 at
 * runtime, which is worse than an honest three-arg signature here.
 * SDK_GUIDE.md section 2 has since been reconciled (now reads
 * `trade(offerId: string, amount: string): Promise<Trade>`); the section 4
 * example still omits `amount` and remains to be fixed.
 */
import type { SailsTransport } from "../transport";
import type { PaginatedMessages, PaginatedTrades, Trade, TradeReconciliation } from "../types";
import { SailsTransportError } from "../errors";

export interface ChatFrame {
  type: string;
  payload: unknown;
}

// The real shape of a NEW_MESSAGE frame's payload
// (common/events/event-bus.ts's OpenP2PMessageSentEvent, broadcast
// verbatim by common/events/handlers.ts's `openp2p.message.sent`
// reaction) — genuinely different field names from the persisted
// `Message` row this file used to (incorrectly) claim onMessage()
// delivers: `messageId` not `id`, `timestamp` not `createdAt`, no
// `readAt`. Found and fixed wiring the first real caller
// (packages/sails-ui's Trade screen) — invisible to this SDK's own
// tests, which never exercise a live WS round trip.
export interface ChatMessageEvent {
  messageId: string;
  tradeId: string;
  senderId: string;
  content: string;
  msgType: string;
  timestamp: string;
}

export type WebSocketConnectionState = "open" | "reconnecting" | "closed";

export interface WebSocketChannelOptions {
  /** Default true — a dropped connection reopens itself with backoff instead of silently dying (PRODUCTION_READINESS_REVIEW.md's High-severity finding #1, closed 2026-08-02). Set false to get the pre-2026-08-02 "dies silently on close" behavior back, if a caller wants to manage this itself. */
  reconnect?: boolean;
  /** Default 10 — after this many consecutive failed reconnect attempts, gives up and reports 'closed'. Resets to 0 on every successful reconnect. */
  maxReconnectAttempts?: number;
  /** Default 500ms — first retry delay; doubles each subsequent attempt (capped at maxReconnectDelayMs), with ±20% jitter so many clients reconnecting at once don't all retry in lockstep. */
  initialReconnectDelayMs?: number;
  /** Default 30000ms. */
  maxReconnectDelayMs?: number;
  /** Default true — sends a PING frame on an interval and force-closes the socket if no PONG comes back within heartbeatTimeoutMs, so a "zombie connection" (socket object still open, but the network path underneath it is dead — no TCP RST/FIN ever arrives to trigger a real 'close' event) gets caught instead of silently going stale (CTO_DUE_DILIGENCE_REPORT.md A-STA-03, closed 2026-08-08). The force-close feeds into the exact same reconnect-with-backoff path a real network drop already uses above. */
  heartbeat?: boolean;
  /** Default 30000ms — matches A-STA-03's own "market pattern: ping a cada 30s" ask. */
  heartbeatIntervalMs?: number;
  /** Default 60000ms — matches A-STA-03's own "timeout em 60s" ask. */
  heartbeatTimeoutMs?: number;
}

const DEFAULT_WS_OPTIONS: Required<WebSocketChannelOptions> = {
  reconnect: true,
  maxReconnectAttempts: 10,
  initialReconnectDelayMs: 500,
  maxReconnectDelayMs: 30_000,
  heartbeat: true,
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 60_000,
};

/**
 * Wraps the real WS protocol at `GET /v1/openp2p/chat?ticket=...`
 * (API_REFERENCE.md section 5). Auto-joins `tradeId`'s room once the
 * socket opens (including every reconnect, not just the first time) —
 * matches SDK_GUIDE.md section 4's usage example (`chat.onMessage(...)`,
 * `chat.send(...)` with no further JOIN_TRADE plumbing exposed to the
 * caller).
 *
 * Real reconnect-with-backoff (PRODUCTION_READINESS_REVIEW.md's
 * High-severity finding #1 / docs/TODO.md's own "No WebSocket
 * reconnection logic anywhere in the client stack" entry, closed
 * 2026-08-02): a real WebSocket can't be reopened once closed, so this
 * takes a *factory* (`openSocket`) rather than an already-constructed
 * socket, and calls it again for each reconnect attempt.
 *
 * `openSocket` is now `() => Promise<WebSocket>`, not `() => WebSocket`
 * — disclosed, deliberate second breaking change to this class's own
 * constructor (not to `chat(tradeId)`'s own signature, which is
 * unchanged and still frozen per docs/API_STABLE.md), same justified
 * pre-v1 exception as the first one. Security review finding, 2026-08-15
 * (P1): the query param used to carry the raw, long-lived session token
 * (`?token=`) — reusable, and dangerous to have sitting in a URL that
 * proxies/load balancers commonly log in full. `chat()` below now fetches
 * a short-lived, single-use ticket (`POST /v1/identity/ws-ticket`) before
 * opening each connection attempt, which requires an async step ahead of
 * the actual `new WebSocket(...)` call — hence the factory's new return
 * type. `this.ws` is therefore nullable until the first `openSocket()`
 * resolves; every method that touches it below accounts for that.
 */
export class WebSocketChannel {
  private ws: WebSocket | null = null;
  private messageHandlers: Array<(msg: ChatMessageEvent) => void> = [];
  private eventHandlers: Array<(frame: ChatFrame) => void> = [];
  private connectionStateHandlers: Array<
    (state: WebSocketConnectionState) => void
  > = [];
  private readonly options: Required<WebSocketChannelOptions>;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByCaller = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;

  constructor(
    private readonly openSocket: () => Promise<WebSocket>,
    private readonly tradeId: string,
    options: WebSocketChannelOptions = {},
  ) {
    this.options = { ...DEFAULT_WS_OPTIONS, ...options };
    this.connect();
  }

  /** Fetches (or refetches, on reconnect) a fresh ticket via `openSocket()` and attaches it — a ticket is single-use, so unlike the old raw-token factory this can never reuse a prior value even if it wanted to. A rejected `openSocket()` (e.g. ticket fetch failed) is treated exactly like a real network drop: same reconnect-with-backoff path. Re-checks closedByCaller after the await: close() can now race a connection attempt that was already in flight (impossible with the old synchronous factory) — attaching (or reconnecting) after the caller asked to stop would leak an open socket nobody wants. */
  private connect(): void {
    this.openSocket()
      .then((ws) => {
        if (this.closedByCaller) {
          ws.close();
          return;
        }
        this.ws = this.attachSocket(ws);
      })
      .catch(() => {
        if (this.closedByCaller) return;
        this.scheduleReconnect();
      });
  }

  private attachSocket(ws: WebSocket): WebSocket {
    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.emitConnectionState("open");
      this.sendFrame("JOIN_TRADE", { tradeId: this.tradeId });
      this.startHeartbeat();
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      let frame: ChatFrame;
      try {
        frame = JSON.parse(
          typeof event.data === "string" ? event.data : String(event.data),
        );
      } catch {
        return;
      }
      if (frame.type === "PONG") {
        this.lastPongAt = Date.now();
      }
      for (const handler of this.eventHandlers) handler(frame);
      if (frame.type === "NEW_MESSAGE") {
        for (const handler of this.messageHandlers)
          handler(frame.payload as ChatMessageEvent);
      }
    });
    // A real browser WebSocket always follows 'error' with 'close' (the
    // spec guarantees it) — reconnect scheduling lives entirely in the
    // 'close' handler below so it only ever runs once per drop, not
    // twice for the same disconnect.
    ws.addEventListener("close", () => {
      this.stopHeartbeat();
      if (this.closedByCaller) {
        this.emitConnectionState("closed");
        return;
      }
      this.scheduleReconnect();
    });
    return ws;
  }

  /** A-STA-03 — sends PING on an interval; force-closes if no PONG arrives
   *  within heartbeatTimeoutMs. The force-close runs through the exact
   *  same 'close' listener a real network drop does, so it reuses that
   *  path's reconnect-with-backoff rather than duplicating it here. */
  private startHeartbeat(): void {
    if (!this.options.heartbeat) return;
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastPongAt > this.options.heartbeatTimeoutMs) {
        this.ws?.close();
        return;
      }
      this.sendFrame("PING", {});
    }, this.options.heartbeatIntervalMs);
    // Node-only: an un-ref'd interval doesn't keep the process alive on
    // its own (same convention as src/app.ts's escrow/dispute sweepers).
    // Browsers have no such concept — `unref` simply doesn't exist on a
    // browser's setInterval return value, hence the guarded check rather
    // than calling it unconditionally.
    const timer = this.heartbeatTimer as unknown as { unref?: () => void };
    if (typeof timer.unref === "function") timer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (
      !this.options.reconnect ||
      this.reconnectAttempts >= this.options.maxReconnectAttempts
    ) {
      this.emitConnectionState("closed");
      return;
    }
    this.reconnectAttempts += 1;
    this.emitConnectionState("reconnecting");
    const baseDelay = Math.min(
      this.options.initialReconnectDelayMs * 2 ** (this.reconnectAttempts - 1),
      this.options.maxReconnectDelayMs,
    );
    const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.max(0, baseDelay + jitter);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private emitConnectionState(state: WebSocketConnectionState): void {
    for (const handler of this.connectionStateHandlers) handler(state);
  }

  private sendFrame(type: string, payload: unknown): void {
    // Only reachable once a socket has actually attached (onMessage/
    // onEvent/onConnectionStateChange registration, the realistic thing
    // to do before a connection opens, don't hit this path) — a caller
    // sending before 'open' would already get a real WebSocket error
    // from the underlying socket today; this just makes the failure
    // mode explicit during the brief window before the first ticket
    // fetch + handshake resolves.
    if (!this.ws) {
      throw new Error("WebSocketChannel: not connected yet — wait for onConnectionStateChange('open') before sending.");
    }
    this.ws.send(JSON.stringify({ type, payload }));
  }

  /** Fires for every NEW_MESSAGE frame — the common case (SDK_GUIDE.md section 4). */
  onMessage(handler: (msg: ChatMessageEvent) => void): void {
    this.messageHandlers.push(handler);
  }

  /** Fires for every frame (TRADE_STATUS_UPDATE, ESCROW_STATUS_UPDATE, USER_ONLINE/OFFLINE, ERROR, ...) — for callers that need more than chat messages. */
  onEvent(handler: (frame: ChatFrame) => void): void {
    this.eventHandlers.push(handler);
  }

  /** Real connection-state signal (closed 2026-08-02) — 'open' (including after every successful reconnect), 'reconnecting' (a drop just happened, a retry is scheduled), 'closed' (either close() was called, or reconnect gave up after maxReconnectAttempts). Lets a UI show a real "reconectando..." indicator instead of silently going stale. */
  onConnectionStateChange(
    handler: (state: WebSocketConnectionState) => void,
  ): void {
    this.connectionStateHandlers.push(handler);
  }

  send(input: { content: string; msgType?: string }): void {
    this.sendFrame("SEND_MESSAGE", {
      tradeId: this.tradeId,
      content: input.content,
      msgType: input.msgType ?? "TEXT",
    });
  }

  leave(): void {
    this.sendFrame("LEAVE_TRADE", { tradeId: this.tradeId });
  }

  /** Closes for real and disables reconnect — the only way to stop this channel from trying to come back. Safe to call before the first connection attempt resolves — closedByCaller stops connect()'s own reconnect-on-failure path too. */
  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.ws?.close();
  }
}

export class SailsOpenP2PModule {
  constructor(private readonly transport: SailsTransport) {}

  /**
   * Requires an active session. See this file's header for the `amount`
   * deviation from SDK_GUIDE.md.
   *
   * `idempotencyKey` (CROSS-LAYER-SEMANTIC-CORRECTIVE-1, item 37,
   * 2026-09-13) — optional; omit it and this call behaves exactly as
   * before (a retry after a timeout can create a second Trade). Pass a
   * value your own application generates once per user-initiated
   * "accept this offer" attempt and reuses across your own retries of
   * that SAME attempt (a new value for a genuinely new attempt) — the
   * server then guarantees at most one Trade is created for that key,
   * returning the original Trade on a safe replay instead of a second
   * row. See `src/common/idempotency.ts`'s own header for the full
   * server-side contract.
   *
   * `paymentAccountHash` (#235 R7C) — only when taking a BUY offer, i.e.
   * you are the seller: the hash of your own registered payment account the
   * buyer will pay into, bound to this trade. Rejected on a SELL offer.
   */
  async trade(offerId: string, amount: string, idempotencyKey?: string, paymentAccountHash?: string): Promise<Trade> {
    return this.transport.post<Trade>(
      "/v1/openp2p/trades",
      { offerId, amount, idempotencyKey, paymentAccountHash },
      true,
    );
  }

  /**
   * Requires an active session — the caller's own trade history (as
   * buyer or seller), never a global listing (trade.service.ts's
   * getTrades()). Fase 2 (SDK React) addition: closes the gap
   * useSailsTrades() needed — no such endpoint existed before (see that
   * service method's own comment for why packages/sails-ui's
   * TradeHistory.tsx uses mock data today). `limit` is clamped
   * server-side to 1-50 (default 10), matching liquidity's
   * getOffers()/discover() pagination convention.
   */
  async getTrades(pagination?: {
    limit?: number;
    offset?: number;
  }): Promise<PaginatedTrades> {
    return this.transport.get<PaginatedTrades>(
      "/v1/openp2p/trades",
      { limit: pagination?.limit, offset: pagination?.offset },
      true,
    );
  }

  /** Requires an active session (SECURITY_AUDIT_REPORT.md §2, closed 2026-08-08 — the backend route now enforces buyer/seller-only access, since a trade carries the full chat history and the seller's payment details). Unlike trade()'s create response, this always populates `offer` (trade.service.ts's getTrade() includes it) — real, not just typed-optional. */
  async getTrade(tradeId: string): Promise<Trade> {
    return this.transport.get<Trade>(`/v1/openp2p/trades/${tradeId}`, undefined, true);
  }

  /**
   * Requires an active session — same fix as getTrade() above. RFC-018's intentId link, exposed directly — the same
   * lookup intent-facade.ts's dispute() uses internally to turn an intentId into the Trade/Escrow it produced.
   *
   * #235 R7H-NF-E3C-5 — the lookup is scoped to the CALLER's own trades and is deterministic:
   * - a trade's own Intent (`trade.tradeIntentId`) resolves to that trade for its buyer and its seller;
   * - an Offer Intent (`trade.intentId`, shared by every trade taken from that offer) resolves to the caller's trade
   *   if they are a party to exactly one;
   * - several (typically the maker of a popular offer) → `SailsError` with `code: 'AMBIGUOUS_INTENT'`, statusCode 409,
   *   and `error.details.tradeIds` listing only the caller's own trade ids — resolve one by `tradeIntentId` or by id;
   * - none, or an Intent the caller has no trade on → `SailsNotFoundError` (404): another participant's trades are
   *   never revealed, not even their existence.
   */
  async getTradeByIntent(intentId: string): Promise<Trade> {
    return this.transport.get<Trade>(
      `/v1/openp2p/trades/by-intent/${intentId}`,
      undefined,
      true,
    );
  }

  /** Requires an active session. status: 'ACTIVE' | 'CANCELLED'. */
  async updateTradeStatus(
    tradeId: string,
    status: "ACTIVE" | "CANCELLED",
  ): Promise<Trade> {
    return this.transport.patch<Trade>(
      `/v1/openp2p/trades/${tradeId}/status`,
      { status },
      true,
    );
  }

  /** Paginated (chat.routes.ts, closed 2026-08-08) — limit clamped server-side to 1-100 (default 50). */
  async getMessages(tradeId: string, pagination?: { limit?: number; offset?: number }): Promise<PaginatedMessages> {
    return this.transport.get<PaginatedMessages>(
      `/v1/openp2p/chat/${tradeId}/messages`,
      { limit: pagination?.limit, offset: pagination?.offset },
      true,
    );
  }

  /**
   * RFC-011 — client-side reconciliation. Returns the trade's current
   * trade/escrow status plus the messages created after
   * `sinceMessageCreatedAt` (oldest first, at most 100). Requires an
   * active session. Useful after reconnects or app resume.
   *
   * The return type used to be declared `Message[]`, but the route has
   * always returned reconciliation.service.ts's ReconciliationResult
   * object — a caller iterating the "array" got nothing. Not in
   * API_STABLE.md's frozen inventory, so correcting it is a bug fix.
   */
  async reconcileTrade(
    tradeId: string,
    sinceMessageCreatedAt: Date | null,
  ): Promise<TradeReconciliation> {
    return this.transport.post<TradeReconciliation>(
      `/v1/openp2p/trades/${tradeId}/reconcile`,
      { sinceMessageCreatedAt },
      true,
    );
  }

  /**
   * Requires an active session. Real reconnect-with-backoff by default
   * (closed 2026-08-02, `options` param added — additive, this method's
   * own signature was never in the frozen inventory beyond its return
   * type).
   *
   * Security review finding, 2026-08-15 (P1): the WS route used to take
   * the raw session token as a `?token=` query param — reusable, and
   * dangerous to have sitting in a URL that proxies/load balancers
   * commonly log in full. Fixed at the source: this now calls the real
   * `POST /v1/identity/ws-ticket` (Bearer-authenticated, same as every
   * other authenticated call) to mint a short-lived, single-use ticket,
   * then opens the socket with `?ticket=` instead. A fresh ticket is
   * fetched for every connection attempt, including every reconnect —
   * a ticket is single-use by design, so there is no "reuse the same
   * value" option the old token factory had; this fully replaces that
   * pattern rather than extending it.
   */
  chat(tradeId: string, options?: WebSocketChannelOptions): WebSocketChannel {
    if (!this.transport.getSessionToken()) {
      throw new SailsTransportError(
        "openp2p.chat() requires an active session — call identity.authenticate() first.",
      );
    }
    const openSocket = async () => {
      const { ticket } = await this.transport.post<{ ticket: string; expiresIn: number }>(
        "/v1/identity/ws-ticket",
        {},
        true,
      );
      return this.transport.openWebSocket("/v1/openp2p/chat", { ticket });
    };
    return new WebSocketChannel(openSocket, tradeId, options);
  }
}
