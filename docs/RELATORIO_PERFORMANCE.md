# RELATÓRIO DE GARGALOS DE PERFORMANCE — Sails Protocol

> **Corrected/Implemented 2026-11-27 (historical report, delimitation):** this is a dated performance analysis and not a current status or a work order. (1) Its remarks about `InMemoryEventStore` describe the default at the time; `PostgresEventStore` is the default `EventStore` today and `InMemoryEventStore` remains for tests. (2) Its remark that Redis is "never used" is also historical: Redis now carries rate-limit counters and a cross-instance fan-out signal (`docs/DATABASE.md`, Redis usage table). (3) Its suggestions to parallelize or batch sequential work, including refund and release paths and the expired-escrow sweep, are performance ideas only. They do not authorize any change of economic behavior: fund-moving paths depend on authority checks, an atomic status claim and per-escrow serialization, and any such change needs its own design and review.

## CRÍTICO

### C1. `settlement.escrow.released` handler: cascata de awaits sequenciais (7-10 round-trips ao DB)
**Arquivo:** `src/common/events/handlers.ts:146-225`

O handler reage a `settlement.escrow.released` e executa uma cadeia de **7 a 10 awaits sequenciais** ao Postgres:

1. `prisma.trade.update()` (linha 147)
2. `prisma.user.update(buyer)` (linha 153)
3. `prisma.user.update(seller)` (linha 157)
4. `prisma.escrow.findUnique()` (linha 169)
5. Condicional: `prisma.user.update(buyer, fees)` (linha 171)
6. Condicional: `prisma.user.update(seller, fees)` (linha 175)
7. `prisma.dispute.findFirst()` (linha 192)
8. `reputationService.recordOutcome(buyer)` (linha 196/204)
9. `reputationService.recordOutcome(seller)` (linha 197/205)
10. Condicional: `vouchService.burnVouchesFor()` (linha 202)
11. `intentEngine.transition(SETTLING)` (linha 218)
12. `intentEngine.transition(FULFILLED)` (linha 221)

Cada `recordOutcome` internamente faz `prisma.user.update()` + `eventBus.emit()`. Cada `transition` faz 3 queries (findUnique + updateMany + writeIntentEvent com findFirst+create). Total estimado: **15-20 round-trips ao DB por trade**.

**Impacto:** O caminho crítico de finalização de trade bloqueia o event loop por ~15-20 idas e voltas ao Postgres. Sob concorrência, isso serializa cada trade completo.

**Otimização:**
- Unificar os 4 `user.update` em um único `$transaction` com `updateMany` ou raw SQL
- Paralelizar `reputationService.recordOutcome(buyer)` e `recordOutcome(seller)` com `Promise.all`
- Paralelizar os dois `intentEngine.transition` (SETTLING + FULFILLED) — o estado permite transição direta SETTLING→FULFILLED; ou agrupar em apenas um `transition`
- `prisma.escrow.findUnique` na linha 169 é redundante — o `escrowId` já chegou no payload; o `feeCharged` pode vir no payload do evento

---

### C2. `intentEngine.create()`: 5 transições sequenciais de estado, cada uma com 3+ queries ao DB
**Arquivo:** `src/core/intent-engine.ts:169-248`

O fluxo `create()`:
1. `prisma.intent.create()` (linha 201)
2. `writeIntentEvent(CREATED)` → `prisma.intentEvent.findFirst` + `prisma.intentEvent.create` (linhas 92-103)
3. `transition(VALIDATED)` → `prisma.intent.findUnique` + `prisma.intent.updateMany` + `prisma.intent.findUnique` + `writeIntentEvent` + `emit` (linhas 114-157)
4. `coordinationEngine.decide()` → `prisma.intent.findUnique` (linha 34) — **redundante: acabou de obter a Intent acima**
5. `transition(COORDINATED)` → mesmo padrão de 5 queries

Total: **~18 queries ao DB por `create()`**.

**Impacto:** Cada intenção de trade executa 18 round-trips. O `coordinationEngine.decide()` na linha 39 refaz um `findUnique` que o `transition(VALIDATED)` já retornou.

**Otimização:**
- Passar o registro já obtido para `coordinationEngine.decide()` evitar a query redundante
- Combinar `writeIntentEvent` para usar `prisma.$transaction` com a transição de estado
- As transições CREATED→VALIDATED→COORDINATED poderiam ser uma única query de `UPDATE` encadeada

---

### C3. `writeIntentEvent()`: query `findFirst` no hot path de toda transição
**Arquivo:** `src/core/intent-engine.ts:85-104`

Cada transição de estado chama `writeIntentEvent()`, que faz:
```ts
const last = await prisma.intentEvent.findFirst({
  where: { intentId },
  orderBy: { createdAt: 'desc' },
})
```
Isso é um **ORDER BY + LIMIT 1 em toda transição** para buscar o hash anterior da cadeia. Não há índice composto em `(intentId, createdAt)` — apenas `@@index([intentId])`.

**Impacto:** Para intents com muitos eventos, essa query faz um scan + sort crescente à medida que a cadeia cresce.

**Otimização:**
- Adicionar índice composto `@@index([intentId, createdAt(desc)])` no schema
- Alternativa: manter o último `entryHash` em uma coluna na tabela `Intent` (denormalização) para evitar a query entirely

---

### C4. `reconcilePeerPair()`: loop sequencial N+1 de reconciliação por trade
**Arquivo:** `src/modules/open-p2p/reconciliation.service.ts:79-96`

```ts
for (const trade of trades) {
  results.push(await this.reconcileTrade(trade.id))
}
```

Cada `reconcileTrade()` faz **2 queries**: `trade.findUnique(include: escrow)` + `message.findMany`. Se há 20 trades ativos entre dois peers, são **40 queries sequenciais**.

**Impacto:** Reconciliation de peer é O(N) round-trips ao DB, bloqueando o event loop.

**Otimização:**
- Paralelizar com `Promise.all(trades.map(t => this.reconcileTrade(t.id)))`
- Ou melhor: buscar todas as trades com escrow numa única query, e todas as mensagens em um único `findMany` com `tradeId: { in: [...] }`

---

### C5. `InMemoryEventStore.byCorrelationId`: crescimento ilimitado de memória
**Arquivo:** `src/common/events/event-store.ts:74`

```ts
private byCorrelationId = new Map<string, DurableEvent[]>()
```

Cada evento publicado é armazenado para sempre neste Map. Nenhum cleanup, nenhum TTL, nenhum eviction.

**Impacto:** Vazamento de memória sob carga. Um servidor processando 100 trades/dia com ~20 eventos cada acumula ~2000 eventos/dia que nunca são coletados pelo GC. Após semanas de operação, isto consome centenas de MB.

**Otimização:**
- Implementar eviction com `max` + LRU, ou TTL por correlationId
- Quando usar o RedisStreamsEventStore, isto desaparece automaticamente

---

### C6. `BroadToTrade` é chamado 6 vezes por handler de evento WS de chat
**Arquivo:** `src/modules/open-p2p/chat.routes.ts:58-71`

Seis handlers de eventos diferentes registram broadcast `broadcastToTrade()` no startup:
```ts
eventBus.on('openp2p.trade.status_changed', ...)
eventBus.on('settlement.escrow.locked', ...)
eventBus.on('settlement.escrow.payment_pending', ...)
eventBus.on('settlement.escrow.released', ...)
eventBus.on('settlement.escrow.disputed', ...)
eventBus.on('settlement.escrow.refunded', ...)
eventBus.on('agents.social_engineering.risk_detected', ...)
```

Cada `broadcastToTrade` faz `JSON.stringify(payload)` **uma vez por chamada** — isso é eficiente. Mas o problema é que **o `settlement.escrow.released` handler em `handlers.ts` também emite `openp2p.trade.completed`**, que re-dispara o broadcast `TRADE_STATUS_UPDATE`. Resultado: o mesmo WS client recebe **dois pushes** por release: `ESCROW_STATUS_UPDATE` e `TRADE_STATUS_UPDATE`.

**Impacto:** Duplicate push ao cliente, largura de banda desperdiçada.

**Otimização:** Consolidar os broadcasts ou desduplicar no cliente; idealmente não emitir `openp2p.trade.completed` como evento separado se `settlement.escrow.released` já foi broadcast.

---

## IMPORTANTE

### I1. `escrow.service.ts`: read-then-update pattern com 3 queries por método
**Arquivo:** `src/modules/open-settlement/escrow.service.ts` (todos os métodos de transição)

Cada método (`lockFunds`, `releaseFunds`, `refundFunds`, `splitFunds`, etc.) segue o padrão:
1. `prisma.escrow.findUnique()` — obter estado atual
2. `prisma.trade.findUnique()` — obter trade para autorização
3. `prisma.escrow.updateMany()` — claim atômico
4. `provider.lockFunds/releaseFunds/etc()` — chamada externa
5. `prisma.escrow.update()` — persistir resultado
6. `this.transition()` → `prisma.escrowEvent.create()` + `eventBus.emit()`

São **5-6 queries ao DB + 1 chamada externa** por método. As queries 1 e 2 podem ser paralelizadas com `Promise.all`.

### I2. `settlement.escrow.split` handler: 3 queries `user.update` sequenciais + 2 `recordOutcome`
**Arquivo:** `src/common/events/handlers.ts:294-329`

Mesmo padrão do C1 mas sem a complexidade do branch de disputa. Ainda assim: 2× `user.update` (linhas 300-307) + 2× `recordOutcome` (linhas 309-310) duplicam o trabalho. Combinar em um `$transaction`.

### I3. `openp2p.trade.disputed` handler: TradeEmDisputa fica redundante
**Arquivo:** `src/common/events/handlers.ts:332-343`

```ts
const trade = await prisma.trade.findUnique({ where: { id: payload.tradeId } })
```

O `settlement.escrow.disputed` handler (linha 228) **já fez** `prisma.trade.update()` com o mesmo `tradeId`. Este handler re-busca a mesma trade só para obter `buyerId`/`sellerId`.

**Impacto:** Query redundante em todo disputed trade.

### I4. `LiquidityRouter.getAggregatedOffers()`: `isAvailable()` + `getOffers()` sequenciais por provider
**Arquivo:** `src/modules/open-liquidity/liquidity.service.ts:315-324`

```ts
for (const provider of this.providers) {
  if (!(await provider.isAvailable())) continue
  const offers = await provider.getOffers(asset, side)
  ...
}
```

Chamadas sequenciais entre providers. Hoje só há 2 providers (um é stub), mas a arquitetura não escala. Paralelizar com `Promise.allSettled`.

### I5. `sweepExpiredEscrows()`: loop sequencial com `refundFunds()` por escrow
**Arquivo:** `src/modules/open-settlement/escrow.service.ts:1234-1254`

```ts
for (const escrow of expired) {
  const trade = await prisma.trade.findUnique(...)
  await this.refundFunds(escrow.id, trade.sellerId)
}
```

Cada `refundFunds()` faz 5+ queries. Se há 50 escrows expirados, são 250+ queries sequenciais. Não há paralelismo nem batching.

**Otimização:** `Promise.allSettled(expired.map(...))` com limite de concorrência.

### I6. `PearNode.handleNewConnection()`: `JSON.parse` em todo chunk de dados sem framing
**Arquivo:** `src/infrastructure/p2p/pear.service.ts:198-203`

```ts
socket.on('data', async (data: Buffer) => {
  let msg: any
  try { msg = JSON.parse(data.toString()) } catch { return }
```

Se uma mensagem P2P chega em múltiplos chunks TCP, o `JSON.parse` falha silenciosamente e descarta dados. Isso pode causar perda silenciosa de mensagens de negociação. Pode ser aceitável hoje com HyperDHT (que geralmente entrega frames completos), mas é um risco latente.

### I7. Prisma `log: ['query']` em desenvolvimento loga cada query
**Arquivo:** `src/common/database/index.ts:29`

```ts
log: config.isProduction ? ['error', 'warn'] : ['error', 'warn', 'query'],
```

Em dev, cada uma das ~20 queries por trade é logada no console. Não é um problema de produção, mas reduz throughput em testes e ambientes de staging.

### I8. `broadcast()` em `PearNode` serializa JSON uma vez por peer inútil
**Arquivo:** `src/infrastructure/p2p/pear.service.ts:270-286`

```ts
broadcast(payload: Record<string, unknown>): number {
  const msg = JSON.stringify(payload)
  for (const [, peer] of this.peers) {
    socket.write(msg)
  }
}
```

Isso é correto — serializa uma vez. Mas o `sendToPeer` (linha 295) re-serializa a cada chamada. Não é hoje um gargalo (poucos peers), mas se o número de peers cresce no futuro, considerar cache de serialização por message kind.

### I9. Índices ausentes em colunas de busca frequente
**Arquivo:** `prisma/schema.prisma`

- `IntentEvent`: falta `@@index([intentId, createdAt])` — a query `findFirst({ orderBy: createdAt desc })` em `writeIntentEvent()` beneficia diretamente
- `Message`: tem `@@index([tradeId])` mas não composto com `createdAt` — a query `findMany({ orderBy: createdAt: 'asc' })` precisa de `@@index([tradeId, createdAt])`
- `Dispute`: tem `@@index([status])` mas buscas por `(status, autoResolutionDeadline)` no sweeper não têm índice composto
- `Escrow`: não há `@@index([status, expiresAt])` — o sweeper `findMany({ where: { status: 'FUNDS_LOCKED', expiresAt: { lt } } })` faz um full scan

## MELHORIA

### M1. `chat-room-registry.ts`: `JSON.stringify` em cada `broadcastToTrade` independente do número de recipients
Já é eficiente (serializa uma vez por chamada), mas se o mesmo `payload` é broadcast para múltiplos `tradeId`s simultaneamente (ex: `settlement.escrow.released` para ambos os participants WS), há serialização duplicada. Não é hoje um gargalo.

### M2. `validateFinancialSanity()`: `Number()` parse em cada chamada de create
**Arquivo:** `src/core/policy-engine.ts:65-90`

Converte strings decimais para `Number()` em cada validação. Overhead de CPU mínimo, mas `Number(maxValue) > MAX_SANE_TRADE_VALUE` é uma comparação de float que pode ter edge cases com precisão — usar `BigInt` ou comparação de strings decimais seria mais robusto.

### M3. `NegotiationService.status`: Map em memória sem eviction
**Arquivo:** `src/modules/open-p2p/negotiation.service.ts:177`

```ts
private status = new Map<string, NegotiationStatus>()
```

Cresce sem limites. Trades completados/cancelados nunca são removidos. Com 10k trades/dia, acumula entradas mortas. Pequeno, mas é um vazamento lento.

### M4. `chat.routes.ts`: `prisma.trade.findUnique` em cada `SEND_MESSAGE` WS
**Arquivo:** `src/modules/open-p2p/chat.routes.ts:140-142`

Cada mensagem WS de chat faz uma query ao DB para validar se o sender é parte do trade. Para salas ativas com alta frequência de mensagens, isso é uma query por mensagem. Considerar cache em memória com TTL (trade→parties) ou validar via JWT que já carrega `participantId` e confiar na verificação de `joinRoom`.

### M5. `redis/index.ts`: cliente singleton sem pipeline/multi
**Arquivo:** `src/common/redis/index.ts`

O Redis é instanciado mas **nunca usado em lugar nenhum do código** além de `connectRedis()`. Não há cache, não há pub/sub, não há rate-limit Redis. Toda a carga está no Postgres. Se o objetivo é ter Redis como cache, ele está completamente inerte.

### M6. `WebSocketRelayTransportProvider.sendToPeer()`: `JSON.stringify` em cada envio
**Arquivo:** `src/infrastructure/p2p/websocket-relay.service.ts:99`

```ts
socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
```

Serialização por chamada — overhead mínimo hoje, mas com alto throughput de relays, considerar pré-serializar quando possível.

### M7. `prisma.intent.updateMany` + `prisma.intent.findUnique` redundante em `transition()`
**Arquivo:** `src/core/intent-engine.ts:148-155`

```ts
const claim = await prisma.intent.updateMany(...)
if (claim.count === 0) throw ...
const updated = await prisma.intent.findUnique({ where: { id: intentId } })
```

O `updateMany` não retorna a linha atualizada, então é necessário um `findUnique` adicional. Usar `update` com cláusula `WHERE` condicional (via raw SQL) evitaria a segunda query, mas Prisma não suporta `updateMany` com retorno de linha. Alternativa: usar `prisma.$executeRaw` com `UPDATE ... WHERE ... RETURNING *`.

### M8. `escrow.service.ts`: `escrowParticipantKey.findMany` repetido em múltiplos métodos
**Arquivo:** `src/modules/open-settlement/escrow.service.ts:517, 462, 916, 964, 1021`

Os métodos `lockFunds`, `initiateRelease`, `initiateRefund`, `initiateSplit` e `submitParticipantKey` todos fazem:
```ts
const keys = await prisma.escrowParticipantKey.findMany({ where: { escrowId } })
```

Não há cache. Cada chamada ao escrow durante fluxo de trade re-busca as mesmas 2 chaves. Considerar `include` na query do escrow pai ou cache por `escrowId` no tempo de vida da request.

---

## RESUMO PRIORIZADO

| # | Severidade | Local | Problema | Queries desnecessárias |
|---|------------|-------|---------|----------------------|
| C1 | **CRÍTICO** | `handlers.ts:146-225` | Cascata de 15-20 queries no release de escrow | ~10 |
| C2 | **CRÍTICO** | `intent-engine.ts:169-248` | 18 queries por `create()` | ~8 |
| C3 | **CRÍTICO** | `intent-engine.ts:92` | `findFirst` ordenado em cada transição | 1/transição |
| C4 | **CRÍTICO** | `reconciliation.service.ts:92` | Loop N+1 de reconciliação | N trades × 2 |
| C5 | **CRÍTICO** | `event-store.ts:74` | Map ilimitado (memory leak) | — |
| C6 | **CRÍTICO** | `chat.routes.ts:58-71` | Duplicate WS broadcast | — |
| I1 | IMPORTANTE | `escrow.service.ts` (geral) | 3+ queries por método, sem paralelismo | 1/método |
| I2 | IMPORTANTE | `handlers.ts:294-329` | Split handler duplica user updates | 2-3 |
| I3 | IMPORTANTE | `handlers.ts:332-343` | `trade.findUnique` redundante | 1 |
| I4 | IMPORTANTE | `liquidity.service.ts:315` | Providers sequenciais em vez de paralelos | N-1 |
| I5 | IMPORTANTE | `escrow.service.ts:1234` | Sweep loop sem paralelismo | N |
| I6 | IMPORTANTE | `pear.service.ts:198` | `JSON.parse` sem framing | — |
| I7 | IMPORTANTE | `database/index.ts:29` | Log de query em dev | — |
| I8 | IMPORTANTE | `pear.service.ts:270` | Serialização por `sendToPeer` | — |
| I9 | IMPORTANTE | `schema.prisma` | 4 índices compostos ausentes | — |
| M1-M8 | MELHORIA | vários | Micro-otimizações, cache, redundancy | 1-2 cada |

**Estimativa de ganho potencial:** Reduzir 40-50% das queries do caminho crítico de trade (C1+C2+C3+I1) e eliminar o vazamento de memória (C5) são os impactos mais significativos.
