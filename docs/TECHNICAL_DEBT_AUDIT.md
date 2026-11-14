# Technical Debt Audit — Dívida Técnica Invisível

> **Data:** 2026-08-07
> **Escopo:** Apenas dívida técnica invisível — sem bugs, sem funcionalidades faltantes
> **Objetivo:** Identificar pequenas decisões hoje inocentes que dificultam manutenção, escalabilidade, onboarding, evolução do SDK, testes e modularização

---

## Resumo Executivo

| Impacto | Quantidade | Esforço para fixar |
|---------|------------|-------------------|
| **Crítico** (bloqueia evolução) | 8 | Alto (semanas) |
| **Alto** (dificulta manutenção) | 12 | Médio (dias) |
| **Médio** (dificulta onboarding) | 15 | Baixo (horas) |
| **Baixo** (melhoria de DX) | 10 | Baixo (minutos) |

**Total:** 45 itens de dívida técnica invisível identificados no
levantamento original de 2026-08-07 (tabela acima, itens classificados
na escala Crítico/Alto/Médio/Baixo).

**Nota — 2026-09-04 (Independent Master Backlog Audit), contagem
verificada diretamente da fonte, não assumida.** Este documento foi
posteriormente estendido por missões subsequentes (Mission 9, Missão
M8.5, Missão 11, Durable Protocol Truth, entre outras) que registraram
itens adicionais numerados até o **item #50** — verificado por contagem
direta dos cabeçalhos `### N.` deste arquivo, sequencial, sem lacunas.
Esses itens adicionais (aproximadamente #31-#50) usam seu próprio
vocabulário de classificação específico da missão que os registrou
(ex.: "débito arquitetural reconhecido", "POSSIBLE VIOLATION",
"débito de superfície de leitura") em vez da escala Crítico/Alto/Médio/
Baixo da tabela acima — deliberadamente não forçados nela nesta
correção, para não fabricar uma classificação de severidade que a
missão original que os registrou nunca atribuiu. A tabela acima
permanece precisa para o escopo do levantamento original de
2026-08-07; ela nunca pretendeu, e não deve ser lida como, cobrindo
o total atual de itens registrados neste documento.

**Nota — 2026-09-06 (Independent Code Quality & Production Reality
Audit, Institutional Sync).** O documento foi estendido novamente,
itens **#51 a #55**, verificado por contagem direta dos cabeçalhos
`### N.` (agora sequencial até #55, sem lacunas). Quatro são dívida
técnica nova genuína (#51 timeout/retry de chain/RPC, #52 schema
compartilhado SDK↔backend de criação de escrow, #53 `verifyLock()` sem
call site, #54 observabilidade de degradação de detecção QVAC); um
(#55) é classificado explicitamente como **Current Truth Documentation
Drift**, não dívida técnica — um comentário desatualizado em
`proof.service.ts`, não um gap de implementação real. Mesma ressalva de
antes se aplica: os itens novos não são forçados na escala Crítico/
Alto/Médio/Baixo da tabela original.

**Nota — 2026-09-07 (Bounded Remediation F6, CTO Gate #2).** Um sexto
item novo foi adicionado, **#56**, sequencial (agora até #56, sem
lacunas). Diferente de #51-#55, não veio da auditoria original — foi
encontrado durante a própria revisão do fechamento do F6 (#53): um gap
de evidência sobre segurança de retry do `lockFunds()` do
`WDK_USDT_EVM` após uma falha externa ambígua. Classificado como novo
delta de backlog/obrigação de evidência de segurança de produção, não
como débito técnico da mesma família dos itens #51-#54 — mesma
ressalva, não forçado na escala Crítico/Alto/Médio/Baixo.

**Nota — 2026-09-07 (CTO Gate Follow-up sobre F8).** Um sétimo item
novo foi adicionado, **#57**, sequencial (agora até #57, sem lacunas).
Mesma categoria de #56 (não veio da auditoria original, descoberto
durante a validação de uma missão de remediação — desta vez o F8): 10
suites de teste não relacionadas ao F8 falharam sob carga paralela do
Jest (`beforeAll()`'s `buildApp()` excedendo 30s), todas passando
isoladamente. Classificado como novo delta de backlog/confiabilidade de
sistema de engenharia/qualidade de evidência do harness de testes, não
como débito técnico da mesma família dos itens #51-#54, e explicitamente
NÃO uma regressão causada pelo F8. Mesma ressalva, não forçado na escala
Crítico/Alto/Médio/Baixo.

**Nota — 2026-09-08 (WDK Fund-Moving Operations Safety Sweep).** Um oitavo
item novo foi adicionado, **#58**, sequencial (agora até #58, sem
lacunas). Mesma categoria de #56/#57 (obrigação de investigação, não
achado da auditoria original): estende #56 (que cobriu apenas
`lockFunds()` do `WDK_USDT_EVM`) às três outras chamadas de fund-moving
do mesmo provider (`releaseFunds()`, `refundFunds()`, `splitFunds()`),
com veredito por método (não forçado uniforme) — os três demonstrados
como gap estrutural (C), `splitFunds()` carregando um achado adicional de
execução parcial multi-leg. Mesma ressalva, não forçado na escala
Crítico/Alto/Médio/Baixo.

**Nota — 2026-09-08 (Test-Harness Reliability).** Um nono item novo foi
adicionado, **#59**, sequencial (agora até #59, sem lacunas) — **CLOSED**,
diferente de todos os itens anteriores desta família (#56-#58, ainda
abertos/investigação). Colisão de Haste module map do Jest causada por
`.claude/worktrees/` (checkouts locais deixados por invocações
anteriores da Agent tool) — demonstrada por experimento controlado,
corrigida com uma única entrada em `modulePathIgnorePatterns` já
existente em `jest.config.js`, evidenciada antes/depois (`npm run
test:unit`: 742 suítes/442 falhas → 154 suítes/0 falhas, nenhuma
cobertura real perdida). Genuinamente distinto do item #57 (contenção de
`buildApp()` sob carga paralela), que permanece aberto — ver a nota de
desambiguação no próprio #57.

**Nota — 2026-09-08 (Identity Architecture Discovery).** Um décimo item
novo foi adicionado, **#60**, sequencial (agora até #60, sem lacunas) —
current-truth documentation drift encontrado de passagem durante a
missão Identity Architecture Discovery
(`docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`), não relacionado a nenhum
item anterior desta família: `docs/CRYPTOGRAPHIC_MODEL.md` §1 ainda
afirma que a identidade Pears/HyperDHT é "o mesmo primitivo" da
identidade econômica do participante — desatualizado desde o fix de
custódia de chave de `pear.service.ts` (2026-08-09), já corrigido em
`docs/TRUST_BOUNDARY.md`/`docs/BACKLOG.md` mas nunca propagado de volta
para o documento que originou a afirmação. Não corrigido pelo registro
original (fora do escopo de uma missão de discovery) — **corrigido e
fechado em 2026-09-08 (Institutional Cold Sweep)**, ver #60 para o
achado completo e a correção aplicada.

---

## CRÍTICO — Bloqueia Evolução do Sistema

### 1. God Module: `handlers.ts` é o ponto único de falha arquitetural

**Arquivo:** `src/common/events/handlers.ts` (546 linhas)

**Problema:** Este arquivo:
- Importa singletons de **7 módulos diferentes** (reconciliation, reputation, vouch, chat, settlement, WDK, intent-engine)
- Define **6 funções helper** que escrevem diretamente em tabelas de outros módulos
- Registra **10 handlers** cobrindo settlement, reputation, vouch, reconciliation, chat, social engineering
- Usa `require()` lazy para 3 módulos adicionais (QVAC, dispute, social engineering)

**Por que bloqueia:**
- Adicionar um novo cross-module event requer editar este arquivo
- Extrair qualquer módulo em pacote separado quebra este arquivo
- Rodar handlers em worker process requer a árvore de dependências inteira
- O arquivo **viola a própria regra** documentada: "No module ever imports another module's service directly"

**Impacto:** Modularização → **IMPOSSÍVEL** extrair módulos em packages separados

---

### 2. God Module: `escrow.service.ts` tem 1218+ linhas

**Arquivo:** `src/modules/open-settlement/escrow.service.ts`

**Problema:** Contém:
- 5 interfaces (SettlementProvider, SignatureCollectionProvider, CreateEscrowInput, EscrowRecord, ExecuteSettlementInput)
- 3 static maps (PROVIDERS, NON_CUSTODIAL_PROVIDERS, SIGNATURE_COLLECTION_PROVIDERS)
- 4 classes (MockSettlementProvider, EscrowService, helpers)
- 15+ métodos de negócio
- 4 funções helper de módulo

**Por que bloqueia:**
- Testar QUALQUER funcionalidade carrega todos os 4 providers (bitcoinjs-lib, @arkade-os/sdk, ethers/KMS)
- Adicionar um 5º provider requer editar este arquivo
- Provider registry não permite registro dinâmico
- Extrair lógica de signature-collection ou fee computation requer desfilar 1200 linhas entrelaçadas

**Impacto:** Testes → carregam dependências pesadas desnecessariamente

---

### 3. Singletons Nível Módulo: 23 instâncias criadas no import time

**Arquivos:** Todos os `src/modules/open-*/`, `src/common/`, `src/core/`, `src/infrastructure/`

**Problema:** Cada serviço, provider e componente de infraestrutura é construído no escopo do módulo sem argumentos e exportado como `const`. Nenhum aceita dependências injetadas via construtor.

**Por que bloqueia:**
- Testes não podem injetar implementações mock sem `jest.mock()` frágil
- Impossível rodar duas instâncias isoladas do mesmo serviço (ex: testnet + mainnet)
- Cada import dispara efeitos colaterais reais: `new PrismaClient()`, `new Redis()`, `new WalletManagerEvm()`
- Deploy multi-tenant é estruturalmente impossível

**Impacto:** Escalabilidade → **IMPOSSÍVEL** multi-tenant ou worker processes

---

### 4. `handlers.ts` viola Fronteiras de Módulo — Feature Envy

**Arquivo:** `src/common/events/handlers.ts`

**Problema:** Apesar de estar em `common/` (camada de infraestrutura compartilhada), escreve diretamente em:
- `prisma.trade.update()` — tabela do OpenP2P (6 ocorrências)
- `prisma.user.update()` — tabela do OpenReputation (6 ocorrências)
- `prisma.dispute.findFirst()` — tabela do OpenSettlement (3 ocorrências)
- `prisma.escrow.findUnique()` — tabela do OpenSettlement (1 ocorrência)

**Por que bloqueia:**
- Transições de status do Trade estão divididas entre `trade.service.ts` e `handlers.ts`
- Nenhum módulo é "dono" do ciclo de vida do Trade
- Mover handlers para o módulo que possui a tabela quebra a arquitetura

**Impacto:** Modularização → ownership ambíguo de dados

---

### 5. Config Global Nunca Injetável

**Arquivo:** `src/config/index.ts` (314 linhas, 40+ env vars)

**Problema:** Um objeto frozen construído no import time a partir de `process.env`. Todos os módulos importam diretamente: `import { config } from '../config'`.

**Por que bloqueia:**
- Trocar um valor de config para teste requer `process.env.X = 'value'` antes do import (ordem dependente)
- Impossível testar o mesmo código com duas configs diferentes simultaneamente
- Rodar serviço com configs diferentes (multi-tenant, A/B testing) é impossível
- Config não pode ser injetada em serviços

**Impacto:** Testes → impossível testar com configs diferentes

---

### 6. Prisma/Redis Global — Dependências Implícitas

**Arquivos:** `src/common/database/index.ts`, `src/common/redis/index.ts`

**Problema:** Prisma armazenado em `global.__prisma` (hack para hot-reload). Redis é `new Redis(config.redis.url)`. Ambos importados por 20+ arquivos.

**Por que bloqueia:**
- Cada serviço cria dependência oculta nestas instâncias específicas
- Migrar para read replicas, connection pooling por serviço, ou multi-database requer tocar todos os import sites
- O hack `__prisma` é anti-pattern documentado pela própria Prisma

**Impacto:** Escalabilidade → impossível read replicas ou connection pooling por serviço

---

### 7. Event Store é Stub — Tudo em Memória

**Arquivo:** `src/common/events/event-store.ts`

**Problema:** `RedisStreamsEventStore` lança erro em todos os métodos ("not yet implemented"). O construtor padrão de `SailsEventBus` sempre cria `new InMemoryEventStore()`.

**Por que bloqueia:**
- Eventos são perdidos no restart do processo
- Multi-instance (load balancer) não pode compartilhar eventos
- Código que depende de durabilidade (`onDurable()`, Timeline) não é testado em condições reais
- A "one-line swap" documentada não funciona porque a implementação lança erro

**Impacto:** Escalabilidade → **IMPOSSÍVEL** multi-instance

---

### 8. Handlers.ts usa `require()` Lazy — Bypass no TypeScript

**Arquivo:** `src/common/events/handlers.ts` (linhas 426, 446, 507)

**Problema:**
```typescript
const { qvacAgentProvider } = require('../../modules/open-agents/qvac-agent.provider')
const { getDisputeService } = require('../../modules/open-settlement/dispute.service')
const { socialEngineeringAgent } = require('../../modules/open-agents/social-engineering-agent')
```

**Por que bloqueia:**
- Estes `require()` derrotam a checagem de tipos do TypeScript
- Valores importados são tipados como `any`
- Renomear uma exportação ou mudar a API não é capturado no compile time
- Migrar para ESM (onde `require()` não existe) quebra estes call sites

**Impacto:** Manutenção → erros de runtime que deveriam ser de compile

---

## ALTO — Dificulta Manutenção

### 9. Três Sistemas de Logging Competindo

| Sistema | Ocorrências |
|---------|------------|
| `console.log/warn/error` | ~60+ em 15+ arquivos |
| `app.log.warn/error` | 2 ocorrências em `app.ts` |
| `pino` (via Fastify config) | implícito |

**Problema:** `console.*` em código de produção é unstructured (sem JSON, sem log levels, sem request correlation). Pino é configurado mas quase não usado.

**Fix:** Criar módulo logger que wrap pino, substituir todos os `console.*` em `src/`.

---

### 10. Silent Error Swallowing — `.catch(() => {})`

**Localizações críticas:**
- `escrow.service.ts:335` — reverte status do escrow silenciosamente → escrow fica permanentemente preso
- `escrow.service.ts:1087` — cascade delete silencioso
- `Trade.tsx:179,186,199` — 3 chamadas críticas engolidas silenciosamente

**Fix:** Substituir por `.catch((err) => { logger.debug('...', err) })`.

---

### 11. `as any` vs `as unknown as X` — Três Padrões de Escape Hatch

| Padrão | Ocorrências | Risco |
|--------|------------|-------|
| `as any` | ~15+ em código produção | **CRÍTICO** — desabilita toda checagem de tipos |
| `as unknown as X` | 33 ocorrências | **MÉDIO** — documenta a intenção |
| Tipagem adequada | maioria | **BAIXO** |

**Problema:** No mesmo arquivo, `escrow.service.ts` tem both patterns. Desenvolvedor não sabe se um cast é "sei o que estou fazendo" ou "só quero calar o compilador".

**Fix:** Eliminar `as any`, padronizar `as unknown as X` como escape hatch documentado.

**Evidência adicional — 2026-09-06 (Independent Code Quality & Production
Reality Audit).** Reforço de evidência apenas, sem nova classificação:
instâncias concretas do padrão `as any` sobre `status`/`type`/`asset`
foram confirmadas em `escrow-repository.ts:182,185,268,315,316,338` e
`escrow-lifecycle.ts:386,394,408` — precisamente no caminho de escrita de
transição de estado do escrow (fundos reais), não em código periférico.
Não altera a classificação CRÍTICO já atribuída acima; apenas ancora o
achado a um caminho de código específico e sensível a fundos.

---

### 12. Config Accessor Triplicado

| Accessor | Valor | Onde usado |
|----------|-------|-----------|
| `config.env` | `process.env.NODE_ENV ?? 'development'` | **NUNCA lido** |
| `config.app.env` | `process.env.NODE_ENV ?? 'development'` | `app.ts:37,158` |
| `config.isProduction` | `process.env.NODE_ENV === 'production'` | 4+ arquivos |

**Problema:** `config.env` definido mas nunca referenciado. `config.app.env === 'development'` é true para `test` também. `config.isProduction` é false para `test`. Comportamento diferente em ambientes de teste.

**Fix:** Remover `config.env`, padronizar em `config.isProduction` para checagens de produção.

---

### 13. Inconsistência de Response Envelope

`settlement.routes.ts` define helper `success()` que adiciona campo `status` no body. Nenhum outro módulo faz isso. Resposta tem campo redundante com HTTP status code.

**Fix:** Extrair `success()` para `src/common/`, remover campo `status`.

---

### 14. Async Patterns Misturados no Mesmo Arquivo

`app.ts` mistura:
- `try/catch` (health check)
- `.then().catch()` (escrow sweepers)
- `async/await` (shutdown)

**Fix:** Padronizar `async/await` + `try/catch` em código servidor.

---

### 15. `participantId()` Extraído em 5 Arquivos Diferentes

Cada route file re-implementa o mesmo cast:
```typescript
const p = (request as AuthenticatedRequest).participantId
```

**Fix:** Extrair para `src/common/middleware/auth.ts`.

---

### 16. Validação Hex Regex Recriada a Cada Chamada

`escrow.service.ts:263` — `new RegExp(...)` criada a cada chamada de `isValidParticipant()`.

**Fix:** Pré-compilar regex no escopo do módulo.

---

### 17. Versão da API Duplicada 4x

`'0.1.0'` aparece 4 vezes em `app.ts` (linhas 78, 166, 206, 222).

**Fix:** Criar constante `API_VERSION` importada de package.json.

**✅ Fechado 2026-08-09** — achado real além da duplicação: o valor
hardcoded (`0.1.0`) já estava **desatualizado** em relação ao
`package.json` real (`0.1.1`) — as 4 rotas afetadas (`/health`,
`/health/live`, `/`, o info do Swagger) reportavam a versão errada.
`app.ts` agora importa `package.json` (`resolveJsonModule`) e usa uma
única `const API_VERSION = packageJson.version`. Efeito colateral
encontrado e corrigido no mesmo pass: `tsc --build` passou a copiar
`package.json` para `dist/`, colidindo com o haste module map do Jest
(`dist/package.json` vs. o `package.json` real, mesmo `"name"`) —
`jest.config.js` ganhou `modulePathIgnorePatterns: ['<rootDir>/dist/']`,
a exclusão correta de qualquer forma (Jest nunca deveria escanear
build output). Verificado via build real (`tsc --build` + inspeção do
`dist/src/app.js` compilado) antes de aceitar a abordagem, não só por
typecheck.

---

## MÉDIO — Dificulta Onboarding

### 18. Pagination Defaults Inconsistentes

| Módulo | Default | Max |
|--------|---------|-----|
| Trade | 10 | 50 |
| Dispute | 10 | 50 |
| Chat | 50 | 100 |
| Reputation | 20 | — |

**Problema:** 4 defaults diferentes sem rationale documentado.

**Fix:** Constantes compartilhadas `DEFAULT_PAGE_SIZE` e `MAX_PAGE_SIZE`.

**✅ Parcialmente fechado 2026-08-09** — correção ao próprio diagnóstico:
Trade/Dispute/Liquidity (`InternalOrderBook.getOffers()`) já usavam o
**mesmo** par 10/50 de propósito — o comentário original de
`liquidity.service.ts` já dizia "matched here rather than inventing a
second pagination convention." Essas três foram unificadas em
`src/common/pagination.ts` (`DEFAULT_PAGE_LIMIT`/`MAX_PAGE_LIMIT`), um
real ganho de DRY sem mudança de comportamento. Chat (50/100) e
Reputation (20/—) **não** foram unificados — forçá-los pros mesmos dois
números mudaria o default público dessas rotas sem necessidade real,
não é limpeza, é regressão. Se algum dia fizer sentido dar nome aos
valores de Chat/Reputation também, cada um merece sua própria constante
nomeada — nunca reaproveitar `DEFAULT_PAGE_LIMIT`/`MAX_PAGE_LIMIT` para
um valor que não é 10/50.

---

### 19. Event Names como String Literals

28 chamadas `emit()` e 26 chamadas `on()` usam string literals. `SailsEventMap` fornece segurança no bus, mas o `as any` em `escrow.service.ts:413` derrota isso.

**Fix:** Extrair event names como constantes exportadas.

---

### 20. Status Strings como Literais Bare

Escrow statuses (`'CREATED'`, `'FUNDS_LOCKED'`, etc.), trade statuses, dispute statuses — todos são strings bare em chamadas Prisma. `Record<string, string[]>` no `VALID_TRANSITIONS` é completamente untyped.

**Fix:** Usar enums do Prisma ou string literal unions tipadas.

---

### 21. File Naming Inconsistente ✅ RESOLVIDO 2026-08-10

~~`src/routes/intentRoutes.ts` (camelCase, fora do módulo) vs `src/modules/open-*/<name>.routes.ts` (kebab-case, dentro do módulo).~~

Movido para `src/core/intent.routes.ts` — consistente com toda a
convenção `<name>.routes.ts` co-localizada no módulo/core dono do
código (Intent é primitivo Core, não um módulo `open-*`).

---

### 22. Function Signature Style Misturado

| Padrão | Exemplo |
|--------|---------|
| Parâmetros individuais | `lockFunds(escrowId, triggeredBy)` |
| Object parameter | `createEscrow(input: CreateEscrowInput)` |
| Misturado na mesma classe | `EscrowService` |

**Fix:** Documentar convenção: 3+ parâmetros → object parameter.

---

### 23. Singleton Lazy vs Eager

20+ serviços usam `export const x = new X()`. Apenas `dispute.service.ts` usa `export function getDisputeService()` (lazy). Razão válida (config-dependent) mas não documentada como convenção.

**Fix:** Documentar quando usar cada padrão.

---

## BAIXO — Melhoria de DX

### 24. Magic Numbers Espalhados

| Constante | Ocorrências | Arquivos |
|-----------|------------|----------|
| `10000` (basis points) | 3 | escrow.service, wdk-settlement, settlement.routes |
| `0.4/0.3/0.2/0.1` (fee split) | 1 | escrow.service |
| `3600 * 1000` (hours→ms) | 3 | escrow, dispute, proof |
| `100` (mock delay) | 4 | escrow.service |
| `2` (dual approval) | 1 | escrow.service |
| `144n` (timelock blocks) | 1 | lightning-hodl.provider |
| `1n` (refund timelock) | 1 | lightning-hodl.provider |

**Fix:** Criar `src/common/constants/protocol.ts` com todas as constantes econômicas/protocolares.

---

### 25. SDK Não Tem Interface Abstrata

`SailsTransport`, `SailsClient`, e todos os módulos são classes concretas. Não existem interfaces `ITransport`, `ISailsClient`. Testar módulos requer construir a stack inteira.

**Fix:** Extrair interfaces para testabilidade.

---

### 26. SDK Não Valida Inputs

- `identity.create()` aceita qualquer string como `publicKeyHex`
- `reputation.rate()` aceita `score: 99` (só 1-5 é válido)
- `liquidity.discover()` aceita `limit: -1`

**Fix:** Adicionar validação runtime antes de enviar ao server.

---

### 27. SDK Error Types Genéricos

`throw new Error(...)` em 5+ locais. Erros de validação (`SailsValidationError`) não são usados. Callers não podem diferenciar "bad input" de "SDK bug".

**Fix:** Usar `SailsValidationError` para inputs inválidos, `SailsNetworkError` para rede.

---

### 28. SDK Hardcodes `/v1/` 89 Vezes

Nenhuma constante central. Se server introduzir `/v2/`, 10+ arquivos devem ser editados individualmente.

**Fix:** Criar `API_BASE` constante, usar em todos os módulos.

---

### 29. `WalletAdapter` Não Tem `disconnect()`

Interface não suporta cleanup. Quando `SailsClient` é destruído, a wallet connection fica aberta.

**Fix:** Adicionar `disconnect?()` opcional à interface.

---

### 30. `@tanstack/react-query` em Dependencies (deveria ser Peer)

`packages/sdk-react/package.json` lista `@tanstack/react-query` como dependency. Consumidores que já usam React Query terão duas cópias.

**Fix:** Mover para `peerDependencies`.

---

### 31. SDK: `SailsSettlementModule.getArbiterProfile()`/`ArbiterProfile` duplicam `SailsArbitrationModule` com tipos errados

Achado durante a Missão 11 Fase 9.3.4, registrado na Fase 9.3.5 e
**corrigido nesta entrada na Fase 9.3.6** — o nome do método e o status
de "morto" declarados na versão original desta entrada estavam ambos
errados, e essa correção só apareceu por acidente: investigando o
contrato público de `ReputationScore` (item de dívida separado, ver
`docs/PROTOCOL_INVARIANTS.md`'s `INV-OP-10`/`SECURITY_MODEL.md` §4.7),
`tests/modules.test.ts` (SDK) apareceu com um teste real, passando,
chamando exatamente este método contra uma URL real — provando
diretamente que a alegação original ("zero chamadas, confirmado via
grep") estava errada. Mesma lição desta fase inteira: nunca confiar em
"confirmado via grep" de uma sessão anterior sem re-verificar.

`packages/sails-sdk/src/modules/settlement.ts` tem um método real,
testado e alcançável — `getArbiterProfile()` (não
`getArbitrationProfile()`, nome que nunca existiu no código; erro de
digitação/memória da Fase 9.3.4, propagado sem verificação até aqui) —
e um tipo `ArbiterProfile`, que duplicam `SailsArbitrationModule.
getProfile()`/`ArbiterCandidate` (`packages/sails-sdk/src/modules/
arbitration.ts`): **ambos batem exatamente nas mesmas duas rotas reais**
(`POST /v1/settlement/arbitration/register`,
`GET /v1/settlement/arbitration/profile/:participantId`) — mas
`ArbiterProfile` usa nomes de campo errados: `reputationScore`/
`activeDisputes`/`registeredAt` em vez dos campos reais que
`market-arbitration.provider.ts`'s `toCandidate()` de fato retorna
(`arbiterReputation`/`effectiveStake`/`cumulativeFeesObserved`) — a
mesma classe de bug que `ReputationScore` tinha (nomes de campo que nunca
corresponderam à resposta real do servidor). `tests/modules.test.ts`
exercita ambos os caminhos (`registerArbiter()`/`getArbiterProfile()`
com o tipo errado, `SailsArbitrationModule.register()`/`getProfile()`
com o tipo certo) contra o mesmo par de rotas — os testes passam porque
são autoconsistentes com o mock, não porque a forma está certa. Não é
referência circular nem risco de segurança — é uma superfície pública
duplicada e alcançável, com um dos dois lados usando nomes de campo que
nunca corresponderam à resposta real do servidor.

**Fix:** consolidar em `SailsArbitrationModule`/`ArbiterCandidate` (a
forma correta) e remover `getArbiterProfile()`/`registerArbiter()`/
`ArbiterProfile` de `settlement.ts`, ou corrigir os nomes de campo de
`ArbiterProfile` para bater com a resposta real — numa passada de
limpeza de release/API separada, não sob um mandato de contract-
integrity pontual (fora do escopo da Missão 11 Fase 9.3.6, cujo mandato
era exclusivamente `reputation.service.ts`/`ReputationScore`). Deixado
intocado nesta fase por instrução explícita do CTO.

---

### 32. Reconciliação de crash-recovery (INV-OP-11) — verdade-autoritativa do fund movement só cobre MULTISIG; catch-up de efeitos downstream (C5) já cobre todas as rails

Achado na Missão 11 Fase 9.6, refinado na Fase 9.7 depois que o
mecanismo de reconciliação ganhou um segundo pass. Duas perguntas
DIFERENTES, escopos DIFERENTES:

**Pergunta 1 — "o movimento real de fundos aconteceu?"** (`txReleaseId`
ainda nulo). Só MULTISIG tem uma primitiva de verdade-autoritativa
construída (`multisig.provider.ts`'s `reconcilePendingSettlement()`,
verdade on-chain do Bitcoin). Para `MOCK`/`WDK_USDT_EVM` (caminho de
chamada direta, sem transação independentemente reconstruível
persistida) e `LIGHTNING_HODL`/`SAFE_GUARD_EVM` (rails de assinatura-
colaborativa estruturalmente iguais ao MULTISIG, mas sem uma primitiva
equivalente construída ainda), o mecanismo sinaliza
`requiresManualReview` — nunca tenta recuperação automática, por design
(fail-closed é explicitamente preferível a um replay inseguro).
**Ainda fora de escopo — sem mudança na Fase 9.7.**

**Pergunta 2 — "os efeitos downstream de um settlement já confirmado
rodaram?" (C5, `txReleaseId` já setado).** Esta pergunta **não precisa**
de nenhuma primitiva de verdade específica de rail (o movimento de
fundos já é um fato confirmado — só falta saber se a obrigação de taxa/
Trade.status/reputação/volume/evento já foram aplicados). Fechado para
**todas as rails** na Fase 9.7 (`reconcileMissingCompletionEffects()`,
guardado pela própria idempotência atômica de `emitEscrowTransition()`
— ver `docs/PROTOCOL_INVARIANTS.md`'s `INV-OP-11`, extensão C5). Uma
limitação genuína e divulgada permanece: um SPLIT de rail de chamada
direta sem `EscrowPendingTransaction` sobrevivente não consegue
recuperar seu `buyerBps` (nunca persistido em lugar nenhum nesse
caminho) — a obrigação de taxa é explicitamente PULADA e sinalizada
para revisão manual nesse caso específico, nunca adivinhada.

**Fix restante:** construir uma primitiva de verdade-autoritativa
análoga à do MULTISIG para cada rail (Pergunta 1) antes de qualquer
ativação de produção real nesses tipos de escrow — para EVM, consultar
o próprio chain por hash/nonce esperado; para Lightning HODL/VTXOs, um
mecanismo próprio ainda não desenhado. Fora do escopo desta fase (que
era MULTISIG-only para a Pergunta 1, per instrução explícita do CTO —
"não toque em Lightning/EVM architecture").

### 33. `INV-12` (Attributed Authority Integrity, Missão 12) — execução de ruling de árbitro/QVAC não é verificável independentemente da própria assinatura do servidor

**Corrigido/Implementado 2026-08-29 (Missão 13 Fase 2), rail MULTISIG.**
Ambos os POSSIBLE VIOLATION abaixo foram fechados: `dispute.service.ts`'s
`resolveDispute()` agora EXIGE uma decisão de autoridade assinada
(`arbitration-authority.ts`'s `AuthorityDecisionPayload`, Ed25519,
reutilizando a identidade já registrada do árbitro em `User.publicKey` —
nenhum tipo de chave novo) e verifica essa assinatura, independentemente
do servidor, antes de invocar qualquer ação de settlement — um chamador
que apenas afirma ser o árbitro (`arbiterId` batendo no banco) sem uma
assinatura válida é recusado (`ForbiddenError`), nunca cai de volta para
confiar no corpo da requisição. `sweepExpiredAutoResolutions()` (a
automação QVAC) foi rebaixada para apenas advisory: uma recomendação
expirada e não contestada agora reverte a disputa para
`EVIDENCE_SUBMITTED` (exigindo uma decisão humana real assinada), em vez
de executar sozinha usando a chave server-derived do árbitro — fecha o
segundo POSSIBLE VIOLATION pela mesma causa raiz, sem exigir nenhuma
mudança de threshold/contest-window/policy-gating. Alvo de segurança
explicitamente perseguido foi TARGET 1 (Atribuição Verificável), não
TARGET 2 (Impossibilidade Criptográfica) — `INV-12`'s próprio texto e
NON-REQUIREMENTS não exigem mais que isso (Missão 13 Fase 1/1B
confirmaram essa leitura antes da implementação, incluindo uma pesquisa
real sobre Bisq/Hodl Hodl/DLC/Taproot/MuSig2/adaptor signatures que
concluiu por manter o desenho atual em vez de adotar qualquer um deles
por inteiro). Testado: `tests/arbitrationAuthority.test.ts` (26 testes,
incluindo substituição de outcome/SPLIT, replay cross-dispute/escrow/
appeal-round, forja de assinatura), `tests/arbitrationAuthoritySdkParity.test.ts`
(paridade byte-a-byte servidor↔SDK + interoperabilidade criptográfica
real), mais os testes de integração em `dispute.service.ts` já
existentes atualizados. SDK: `resolveDisputeWithWallet()` (novo,
`packages/sails-sdk/src/modules/settlement.ts`) constrói e assina a
decisão automaticamente via `wallet.signMessage()` — a chave privada do
chamador nunca sai da própria wallet. **Gap residual, disclosed, não
escondido:** o console de árbitro do `sails-ui` (`Disputes.tsx`) ainda
não tem infraestrutura de wallet/assinatura nenhuma — as ações de
resolver disputa falham com um erro claro em vez de silenciosamente,
mas não funcionam de fato até uma sessão dedicada de UI decidir onde a
chave de assinatura do árbitro deve viver nesse console de referência
(tarefa já sinalizada separadamente). Rails além de MULTISIG
(LIGHTNING_HODL/SAFE_GUARD_EVM) não foram tocados nesta passada — fora
de escopo explícito do mandato da Fase 2.

Achado pela Missão 12 (Testes de Constituição/Red Team, Fases 6.1–7T),
fechado normativamente com a adição de `INV-12` em
`docs/PROTOCOL_INVARIANTS.md` — este item registra o **débito de
implementação** que `INV-12` agora torna explicitamente não-conformante,
sem redesenhar nada.

**`multisig.provider.ts`'s `deriveArbiterKey()`** deriva a chave privada
do árbitro sob demanda, a partir de `MULTISIG_SEED` (uma seed única do
servidor) mais o `arbiterId`, e o próprio servidor assina diretamente
toda liberação/reembolso/split em status `DISPUTED`
(`multisig.provider.ts` — os três branches `DISPUTED` de
`buildUnsignedRelease`/`Refund`/`Split`). Não existe nenhum registro,
checável por um terceiro que não o próprio servidor, de que a
assinatura produzida corresponde à decisão real do árbitro nomeado —
`INV-12`'s EXAMPLE FAIL descreve exatamente este caso. **Classificação:
POSSIBLE VIOLATION** de `INV-12` (o caminho feliz MULTISIG, buyer+seller,
permanece plenamente conformante — a não-conformidade é específica ao
caminho disputado).

**`dispute.service.ts`'s `proposeAutoResolution()`/
`sweepExpiredAutoResolutions()`** (automação QVAC de disputa, opt-in,
off por padrão, confidence-gated, contestável) executa um REFUND
automatizado usando a mesma chave server-derived do árbitro já
designado, sem nenhum vínculo criptográfico verificável entre a
recomendação do modelo e a execução resultante além do registro interno
do próprio servidor. **Classificação: POSSIBLE VIOLATION**, mesma causa
raiz do item acima — nenhuma mudança seria necessária no design de
threshold/contest-window/policy-gating já existente, apenas na camada
de execução.

**Fix restante:** dar ao árbitro (humano ou o slot que a automação
QVAC herda) uma capacidade de assinatura verificável e distinta da do
servidor — ex.: uma credencial de delegação assinada e escopada com a
própria identidade Ed25519 já registrada do árbitro, que um terceiro
possa checar contra a execução real — sem exigir que o árbitro detenha
diretamente a chave secp256k1 do script (`INV-12`'s NON-REQUIREMENTS
já permite isso explicitamente). Fora do escopo da Missão 12 (que era
constitucional, não de remediação de implementação).

### 34. Ausência de mecanismo formal de identidade de versão publicada (Constitutional Closure, Missão 12)

Achado pela Missão 12 (Fase 6.2, reconfirmado nas Fases 7/7T) e agora
normativamente reconhecido na extensão da Structural Invariant 5
("Constitutional Closure") em `docs/PROTOCOL_INVARIANTS.md`. Hoje não
existe um conjunto declarado e fechado de artefatos que constitua "Sails
vX" — `PROTOCOL_SPECIFICATION.md` tem seu próprio número de versão
(v7.1) na capa, mas isso não amarra a nenhuma versão de
`PROTOCOL_INVARIANTS.md`, nenhum conjunto de RFCs, nenhum commit
específico do SDK. Isso não refuta a propriedade de Closure (o mesmo
princípio que já se aplica à violação de custódia do WDK — a
Constituição julga a implementação, a implementação não define a
Constituição) — é uma dependência de remediação em camada inferior
(Especificação/Governança), disclosed aqui, não escondida.

**Fix restante:** definir, em `PROTOCOL_SPECIFICATION.md` ou
`GOVERNANCE.md`, o conjunto exato de artefatos (e sua forma de
incorporação/resolução de conflito) que constitui uma versão lançada do
Sails — deliberadamente fora do escopo da Missão 12, que estabeleceu
apenas o princípio constitucional (nenhuma hierarquia normativa
universal foi codificada; ver `INV-12`'s vizinho na Structural
Invariant 5 e a rejeição explícita de `Constitution > Specification >
RFC > Schema` como ordenação fixa).

### 35. Classificação do Arbiter como ator não está ancorada em nenhuma taxonomia formal (Semantic Kernel, 2026-08-29)

Achado durante o processo de Semantic Kernel Discovery/Red Team/Final
Validation que produziu `docs/SEMANTIC_KERNEL.md`. `PROTOCOL_SPECIFICATION.md`
§1.9 descreve o Arbiter como "a genuinely new actor" e o
`ArbitrationProvider` como "registered per application (not a
protocol-native role)" — nunca classificando formalmente o Arbiter como
`Participant` (RFC-001), `Agent`, ou qualquer outra categoria de ator
definida. **K2** (`SEMANTIC_KERNEL.md` §6, "Attributed Discretion") exige
que uma decisão discricionária seja atribuível a "um ator específico,"
mas a Especificação nunca ancora essa expressão a uma taxonomia concreta
de ator para o Arbiter especificamente.

**Classificação:** ambiguidade de especificação (não é uma contradição
normativa — nada no texto atual viola K2/INV-12; apenas nunca resolve a
pergunta "que TIPO de ator é o Arbiter" de forma explícita).

**Fix restante:** decidir, em `PROTOCOL_SPECIFICATION.md` ou um RFC
dedicado, se o Arbiter é uma subcategoria de `Participant`, uma categoria
própria e nomeada, ou permanece deliberadamente não tipado — uma decisão
normativa real, fora do escopo do processo de Semantic Kernel (que é
descritivo, não normativo) e não inventada nesta auditoria.

### 36. Cobertura adversarial de K2 (Attributed Discretion) além de MULTISIG não está demonstrada (Semantic Kernel, 2026-08-29)

O mesmo processo confirmou, via leitura direta de código, que o portão de
verificação em `dispute.service.ts`'s `resolveDispute()` — a
implementação real de **K2**/`INV-12` — executa de forma incondicional
para toda resolução de disputa, independente do `EscrowType` do escrow
(o branch em `applyRuling()` que escolhe entre execução direta e
`initiateRelease`/`initiateRefund`/`initiateSplit` acontece DEPOIS do
portão de verificação, não antes). Ou seja, o código em si já não é
MULTISIG-específico neste ponto.

O que permanece genuinamente limitado a MULTISIG é a **cobertura de teste
adversarial dedicada** (`tests/arbitrationAuthority.test.ts`'s cenários
de substituição/replay/forja) e a disciplina de STOP GATE da Missão 13
Fase 2, que restringiu escopo de revisão detalhada a essa rail
especificamente.

**Classificação:** débito de cobertura de teste, não de implementação.

**Fix restante:** estender `tests/arbitrationAuthority.test.ts` (ou um
arquivo irmão) com os mesmos cenários adversariais já cobertos para
MULTISIG, exercitando explicitamente LIGHTNING_HODL e SAFE_GUARD_EVM via
`resolveDispute()`, para fechar a lacuna entre "o código já é
rail-agnóstico" e "isso foi verificado adversarialmente para cada rail."

### 37. Sails Core Architecture congelada em `docs/CORE_ARCHITECTURE.md`, mas sem nenhuma implementação (2026-08-29)

Achado ao final do processo de Sails Core Architecture (Fases 1 → 3.1)
que produziu `docs/CORE_ARCHITECTURE.md`. A arquitetura de software
(Pure Core / Runtime / Modules / Providers, os quatro estados de
`ConditionResult`, o modelo de Transition Record/Outcome, as nove regras
finais) está congelada, mas nenhum código foi escrito — `@sails/core`
continua não autorizado. O gap register do próprio documento (§44,
G1-G15) já lista os itens concretos; este item existe apenas para que
`TECHNICAL_DEBT_AUDIT.md` (que outros times consultam primeiro) não
fique silenciosamente desatualizado em relação a esse novo documento.

**Itens de maior prioridade do gap register** (ver `docs/CORE_ARCHITECTURE.md`
§44 para a lista completa): ausência de mecanismo de identidade/versão de
ruleset (G1); ausência do "Canonical Semantic Profile" necessário para
conformidade cross-language (G2); ausência de um artefato de Transition
Record/Decision (G3) — hoje o State machine só produz atualizações de
status brutas; ausência de mecanismo de commitment para referências de
State/ruleset/Assertion (G4).

**Classificação:** débito de arquitetura reconhecido e disclosed, não
escondido — a própria `docs/CORE_ARCHITECTURE.md` §43 já documenta o
mapeamento honesto ALIGNED/PARTIAL/MISSING contra o código real.

**Fix restante:** um programa futuro e separado, "Sails Core
Implementation Architecture" (representação concreta, boundary
Core/Runtime, migração do código atual) — deliberadamente não iniciado
por esta auditoria nem pela missão que congelou a arquitetura.

### 38. Sails Core Implementation Architecture congelada em `docs/CORE_IMPLEMENTATION_ARCHITECTURE.md`, ferramental ainda não existe (2026-08-29)

O item 37 acima já está fechado: o programa "Sails Core Implementation
Architecture" (Fases 1 → 3.1) que ele previa foi concluído e produziu
`docs/CORE_IMPLEMENTATION_ARCHITECTURE.md`. A arquitetura de
representação/boundary/migração está congelada, mas nenhuma das três
peças de ferramental que ela exige ainda existe no repositório:

- ~~**Boundary mecânico do Pure Core** (§17 do documento)~~ — **FECHADO
  2026-08-29** (Core Implementation Program, Fase 1 — M0). `packages/sails-core`
  existe como workspace interno não publicado (`"private": true`),
  zero dependências de runtime. `scripts/check-core-boundary.ts`
  (nenhuma dependência nova instalada — usa o `typescript` já existente
  via sua própria Compiler API) rejeita mecanicamente qualquer import
  não-relativo, `require(...)`, `import()` dinâmico, e qualquer
  referência a globals ambiente (`process`, `fetch`, `Date.now()`/`new
  Date()` sem argumento, timers, `Math.random`) — validado com uma
  violação real e temporária (`@prisma/client` + `Date.now()` +
  `process.env`) confirmando rejeição em ambas as camadas antes de ser
  removida. `tsconfig.json` do pacote (`"types": []`, sem `"DOM"`) dá
  uma segunda camada independente: o `tsc --noEmit` do próprio pacote já
  falha ao referenciar `process`, sem depender do checker. Cobertura de
  teste: `tests/coreBoundaryCheck.test.ts` (fixtures `.ts.fixture`,
  nunca compiladas de verdade) + verificação direta de
  `packages/sails-core/src` real, todas passando. Ver
  `packages/sails-core/README.md` para os comandos.
- ~~**Publicação da Canonical Evaluator Identity** (§5-6)~~ — **PARCIALMENTE
  FECHADO 2026-08-29** (Core Implementation Program, Fase 2 — M2). O
  mecanismo repositório-local agora existe e está demonstrado para um
  evaluator real: `conformance/evaluators/*.json` (definição semântica
  pública, machine-addressable, versionada, nunca dependente de source
  TypeScript) + `conformance/profiles/*.json` (Canonical Semantic
  Profile mínimo) + `conformance/vectors/*.vectors.json` (vetores JSON
  puro, sem valores TypeScript-only) + `scripts/run-conformance-harness.ts`
  (fora do boundary do Pure Core — faz I/O de arquivo). Testado
  adversarialmente: um evaluator com a identidade correta mas
  comportamento incorreto (`>` em vez de `>=`, e um "identity spoofing"
  puro) é corretamente reconhecido-mas-não-conformante. **O que
  permanece genuinamente aberto**: isto é publicação *repositório-local*
  (git), não um processo de publicação/governança externo — evitando
  virar um ponto de interpretação privada exige que esse processo
  externo exista, o mesmo risco já documentado no item 35 sobre o
  Arbiter. Ver `conformance/README.md`.
- **Ferramental de Ruleset Admission** (§23) — ainda **ABERTO**. M2
  deliberadamente não implementou a camada de reconhecimento de
  governança (decidir se uma combinação Ruleset/Evaluator/Profile é
  *confiável*) — apenas a verificação estrutural pura do Core
  (`checkRulesetBinding`, já existente desde M1) e o mecanismo de
  *resolução* (`recognized`, via `checkEvaluatorConformance`) existem.
  "Resolvível" e "confiável para uso" continuam sendo fatos distintos,
  intencionalmente não colapsados.

**Classificação:** débito de arquitetura reconhecido e disclosed, não
escondido — nenhum destes bloqueia o início da migração em M0 (o
boundary mecânico é justamente o primeiro passo do próprio
`docs/CORE_IMPLEMENTATION_ARCHITECTURE.md` §29).

**Fix restante:** parte do futuro "SAILS CORE IMPLEMENTATION PROGRAM —
PHASE 1 — MECHANICAL BOUNDARY & SEMANTIC MODEL FOUNDATION" —
deliberadamente não iniciado por esta auditoria nem pela missão que
congelou a arquitetura de implementação.

### 39. Destination Authority arquiteturalmente resolvida, remediação ainda não implementada (Mission M8.5, 2026-08-30)

Achado pela Missão M8 (Provider Dispatch Gate) e resolvido no nível de
arquitetura pela Missão M8.5: `dispute.service.ts`'s `resolveDispute()`
aceita `releaseToAddress`/`refundToAddress` do próprio pedido do
**árbitro**, e `escrow-lifecycle.ts`'s `resolvePayoutAddress()` deixa
esse valor sobrescrever incondicionalmente o `PayoutAddress` já
registrado do beneficiário, sem nenhum traço à autorização verificada do
próprio beneficiário — uma instância real, não hipotética, de
`INV-01` (ver a anotação adicionada a esse invariante,
`docs/PROTOCOL_INVARIANTS.md`). `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md`
define o modelo que fecha isso (Economic Disposition Authority ≠
Destination Authority, reaproveitando o primitivo de Attribution já
construído em M5 — zero mudança de Kernel ou Core).

**Classificação:** débito de implementação, não de arquitetura — a
arquitetura já está congelada e validada; o código de `resolveDispute()`/
`applyRuling()` ainda não foi alterado.

**Fix restante:** implementar o remendo descrito em
`docs/DESTINATION_AUTHORITY_ARCHITECTURE.md` §16 (parar de aceitar o
parâmetro de destino do árbitro; resolver e capturar o `PayoutAddress`
do beneficiário no momento do commit do Outcome) — bloqueado apenas por
uma decisão de produto ainda pendente sobre disputas legadas em voo
(mesmo documento, §14) — e só então retomar a Missão M8-R.

**Corrigido/Parcialmente remediado — escopo por rail 2026-09-04
(Independent Master Backlog Audit, verificado diretamente contra
`dispute.service.ts` na baseline `c9812a8`).** O achado acima estava
correto na sua baseline original (Missão M8.5, 2026-08-30) e permanece
preservado sem alteração — a Missão M8-R, executada depois, de fato
retomou o trabalho e fechou este débito **apenas para o rail MULTISIG**.
Verificação direta, rail por rail:

- **MULTISIG — remediação implementada.** `resolveDispute()` bifurca
  para `applyRulingCoreAuthoritative()` (`dispute.service.ts:415-421`)
  quando `escrowForBranch.type === 'MULTISIG'`. O parâmetro legado
  `releaseToAddress`/`refundToAddress` ainda pode entrar em
  `resolveDispute()` (a assinatura pública não foi alterada, por
  decisão deliberada — ver o comentário `@deprecated for MULTISIG` no
  próprio `resolveDispute()`), mas está **estruturalmente ausente** dos
  parâmetros de `applyRulingCoreAuthoritative()` — não pode alcançar a
  execução econômica deste rail de forma alguma. A autoridade de
  Outcome + DestinationBinding é Core-autoritativa para este caminho: o
  commit durável (Outcome + snapshot do destino, `commitAuthoritativeDisputeRuling()`)
  "STRICTLY PRECEDES dispatch-eligibility evaluation, which STRICTLY
  PRECEDES calling any settlement action" (comentário do próprio
  método). Comprovado por `tests/disputeOutcomeMultisig.test.ts`'s
  casos "wrong legacy parameter is ignored". **Isto não demonstra
  verificabilidade independente do destino** — apenas que o árbitro não
  tem mais poder de override; ver a distinção com o property gap
  separado citado abaixo.
- **LIGHTNING_HODL / SAFE_GUARD_EVM — achado original permanece
  integralmente válido, não remediado.** Ambos continuam no caminho
  legado `applyRuling()`, byte-for-byte inalterado desde a baseline
  original. O destino fornecido pelo árbitro/chamador **ainda afeta a
  execução econômica real** — o próprio código documenta isso como
  "fully authoritative by this file's own documented boundary"
  (`dispute.service.ts:335`). A remediação de Destination Authority
  **não** é Core-autoritativa para nenhum dos dois.
- **WDK_USDT_EVM — assimetria real entre RELEASE e REFUND, preservada
  sem achatamento.** RELEASE: o destino fornecido pelo árbitro/chamador
  permanece economicamente efetivo (`escrowService.releaseFunds()`,
  mesmo caminho legado). REFUND: o destino **não** é escolhido pelo
  chamador pelo mesmo mecanismo — `refundFunds()` não aceita parâmetro
  de endereço algum, sempre envia para `treasuryAccount()`
  (`wdk-settlement.provider.ts:167-177`, verificado diretamente) — a
  semântica é fixa/tesouraria, não um destino arbitrário do árbitro.
- **MOCK — mesmo comportamento legado de RELEASE que WDK_USDT_EVM**,
  mesmo branch de código (`needsSignatureCollection === false`); não
  reivindicado além do que a evidência sustenta.

**Distinto de, e não equivalente a**, o property gap separado
`Independent Verifiability of Authority → Outcome → Destination
Binding` (`docs/DURABLE_PROTOCOL_TRUTH_EVIDENCE.md`, `docs/BACKLOG.md`
"Known Debt" — permanece **OPEN PROPERTY GAP**, não afetado por esta
atualização). Aquele item pergunta se um terceiro pode *provar*, de
forma independente e sem confiar no banco de dados do operador, qual
destino foi autorizado — mesmo para MULTISIG, onde este item 39 já foi
resolvido, nada assina ou hasheia o `DestinationBinding`, então aquele
gap permanece aberto **mesmo depois desta remediação**. Destination
Authority (quem decide) ≠ Verificabilidade Independente de Destino
(quem consegue provar depois) — resolver um não resolve o outro; o
MULTISIG é a prova formal disso.

---

### 40. Identidade de execução multi-tentativa (T1/T2) não é representável no schema atual (Mission 9, Missão M9-TC, 2026-08-31)

`Escrow.txReleaseId` é um escalar único, permanentemente não-nulo uma
vez definido — nenhuma rotina do sistema (nem `escrow-repository.ts`'s
`findTerminalWithoutTxReleaseId()`/`findTerminalWithTxReleaseId()`, nem
o sweep de reorg do release leg, `multisig-release-reorg-sweep.ts`)
jamais o revisita depois de gravado. Isso significa que, quando uma
transação de liquidação já confirmada (T1) é posteriormente reorganizada
para fora da chain canônica (World C — outpoint de funding ainda não
gasto), o schema atual não tem como representar uma segunda tentativa
de execução (T2) como irmã de T1 sob o mesmo `Outcome` autorizado — só
pode sobrescrever o fato histórico de T1 (violando `INV-05`) ou não
representar T2 de forma alguma.

**Achado experimentalmente, não hipotético:** um T2 construído sob o
mesmo `Outcome`/`DestinationBinding` durável, com uma taxa de mineração
diferente (e portanto um txid diferente), passa mecanicamente pelo mesmo
guard real (`assertTranslationMatchesOutcome()`,
`dispatch-translation-guard.ts`) que uma dispatch ao vivo já precisa
passar — ou seja, a AUTORIZAÇÃO de T2 já está resolvida. O que falta é
a capacidade de MODELAR T1 e T2 coexistindo.

**Classificação:** débito arquitetural registrado, não crítico para o
boundary de segurança fail-closed atual — `reconcileMissingDispatch()`'s
própria query de candidatos (`dispute-dispatch-recovery.ts`) já exclui
estruturalmente qualquer escrow terminal, então nenhum redispatch
automático é sequer tentado hoje. **Necessário investigar antes de**
reivindicar convergência automática pós-completion para World C — não
antes disso.

**Fix restante:** nenhum proposto por esta missão (fora de escopo:
exigiria uma nova relação `EscrowExecutionAttempt` um-para-muitos e uma
decisão de produto sobre reabrir dispatch-eligibility para um escrow
terminal — uma missão própria, maior).

### 41. Settlement Consistency Read Surface — nenhuma leitura pública expõe reorg detectado (Mission 9, Missão M9-TC, 2026-08-31)

Um escrow pode estar internamente em `Escrow.status = COMPLETED` com um
`EscrowReleaseEvidence(REORGED_INVALIDATED)` já registrado
(`multisig-release-reorg-sweep.ts`), e nenhuma leitura pública
(`GET /v1/settlement/escrows/:id`, `escrow-repository.ts`'s
`findByIdWithDetails()`) expõe esse fato — um consumidor só vê
`COMPLETED`, indistinguível de uma liquidação saudável.

**Classificação:** débito de superfície de leitura, não de arquitetura
— a distinção em si (Historical Completion ≠ Current Settlement
Satisfaction) já é sustentada por evidência durável append-only
(`EscrowReleaseEvidence`); falta apenas um consumidor.

**Fix restante:** nenhum implementado por esta missão — decisão
explícita do freeze de não fixar nomes de campo/enum agora. Formato
conceitual candidato (não congelado): `workflowStatus` + um valor de
consistência de liquidação DERIVADO de `EscrowReleaseEvidence`, nunca
um novo estado mutável persistido (`SettlementConsistencyStatus`
permanece explicitamente não autorizado). Pertence a uma fase futura de
M10/SDK/DX/Protocol UX, após o freeze do Core.

### 42. Semântica de volume após invalidação de settlement não está definida (Mission 9, Missão M9-TC, 2026-08-31)

`User.totalTrades`/`totalVolumeBtc` são incrementados quando uma
liquidação é OBSERVADA como confirmada (`common/events/handlers.ts`'s
`recordTradeCompletion()`). Se essa liquidação for depois invalidada por
reorg (World C) e permanecer sem resolução, o sistema atual não
distingue "volume historicamente observado" de "volume atualmente
liquidado" — ao contrário da reputação (cujo racional de "comportamento
adjudicado, não localização atual de fundos" foi articulado por
M9-TC), o volume não tem nenhum racional equivalente hoje.

**Classificação:** débito semântico real, explicitamente não
corrigido nem escondido por esta missão.

**Fix restante:** nenhum proposto — requer uma decisão de produto sobre
o que "volume" deve significar antes de qualquer mudança de código.

### 43. Re-verificabilidade independente de Correspondence não está garantida (Mission 9, Missão M9-EI/M9-TC, 2026-08-31)

`CorrespondenceEvaluation` (`schema.prisma`) armazena o veredito
(`results: Json`, `MATCH`/`DIVERGENT`/`PENDING`/`UNKNOWN`) mas não os
valores decodificados da transação real que produziram esse veredito.
Se a transação subjacente se tornar indisponível na chain (podada, ou
justamente evictada por um reorg que este mesmo Mission 9 detecta), uma
implementação independente não consegue recomputar um `MATCH` histórico
a partir apenas dos artefatos duráveis do próprio Sails — só pode
confiar no veredito já registrado.

**Classificação:** débito não-bloqueante para o freeze do Mission 9
(nenhuma propriedade de recovery/consistência terminal depende de
resolver isso); relacionado a Credible Exit / Conformance de forma mais
ampla.

**Fix restante:** nenhum proposto — se algum dia priorizado, o menor
fix seria registrar os valores decodificados ao lado do veredito, não
persistir bytes de transação brutos.

### 44. `CI`/`CI Tests` (GitHub Actions) estão estruturalmente quebrados, não apenas instáveis (Mission 9.9 Completion Delta, 2026-09-01)

Achado ao investigar quais status checks eram reais/confiáveis o
suficiente para exigir em branch protection (`docs/GITHUB_PROJECT.md`
§8). `gh run list --branch main` mostrou `CI` e `CI Tests` falhando em
praticamente todo push recente, incluindo M9-F, M8-RF e o próprio M9
freeze — não uma flakiness ocasional, uma quebra estrutural.

**`CI` (`.github/workflows/ci.yml`)** — diagnóstico original (M9.9)
confirmado correto: o job `build` falhava em `npm ci` porque
`defaults.run.working-directory: ./sails-push-ready` só existia no
layout de pasta local aninhado deste ambiente, nunca dentro de um
checkout real do CI.

**`CI Tests` (`.github/workflows/ci-tests.yml`)** — **diagnóstico
original (M9.9) estava ERRADO, corrigido nesta missão (M9.10) por
instrução explícita de não confiar nele e reproduzir o log real.** A
causa real, confirmada baixando o artefato `jest-output.txt` da run
33352899462: 80 de 147 suites falhavam em `TS2305: Module
"@prisma/client" has no exported member 'Prisma'/'PrismaClient'/
'AssetType'` — nenhum dos dois workflows executava `prisma generate`
antes dos testes (só `prisma migrate deploy`, que não gera o client).
O ruído `FATAL: role "root" does not exist` que motivou o diagnóstico
original era o próprio health-check `pg_isready` (sem `-U postgres`)
falhando em segundo plano — confirmado inofensivo: o step "Apply
database migrations" (que usa a conexão real da aplicação) sempre
teve sucesso na mesma run.

**`CodeQL` (`Analyze (javascript-typescript)`)** permanece o único
check real e confiável — verificado verde em toda execução recente
checada; 61 alertas abertos no total, 60 confinados a
`.github/skills/impeccable/` (ferramenta de terceiros vendorizada, não
código próprio do Sails, fora de escopo desta auditoria), 1 real
(`load-tests/artillery/pregenerate-users.js`, `js/http-to-file-access`,
medium) — revisado e classificado como não explorável (script de
load-test rodado manualmente contra `localhost`, nenhum ator externo
envolvido em nenhuma ponta do fluxo rede→arquivo).

**Status: CLOSED.** Ambos os workflows corrigidos nesta missão —
`ci.yml` (working-directory removido, `prisma generate` adicionado,
`pg_isready -U postgres`) e `ci-tests.yml` (`prisma generate`
adicionado, `pg_isready -U postgres`). Evidência: ver
`docs/GITHUB_PROJECT.md` §16-19 (M9.10) para as execuções reais no
GitHub Actions pós-fix.

---

### 45. `@fastify/rate-limit` — CVE real, não corrigível sem regressão conhecida (Mission 9.10, 2026-09-01)

`@fastify/rate-limit@11.2.0` é uma "⚠️ Security Release" real e
confirmada (release notes do próprio mantenedor,
`GHSA-grpc-p53c-r64v`/`CVE-2026-15144`, severity HIGH/CVSS 7.3): a
chave de rate-limit por IP não normaliza endereços IPv6, permitindo
bypass do limite via rotação/reescrita textual do mesmo endereço
IPv6 quando `trustProxy` está habilitado atrás de um proxy que
expõe IPv6 ao origin.

**Reachability, verificado diretamente:** `trustProxy` nunca é setado
em nenhum lugar deste código (`grep -rn "trustProxy" src/` só encontra
o comentário que MENCIONA a opção, nunca a define) — não explorável
na configuração padrão deste repositório hoje. **Mas** torna-se
explorável no momento em que um deployment real atrás de um CDN/load
balancer (exatamente o cenário que qualquer deployment de produção
real precisaria) habilitar `trustProxy`, derrotando silenciosamente a
proteção de rate-limit que `/challenge`/`/authenticate` (RT-002) foram
desenhados para fornecer.

**Por que não foi corrigido nesta missão, confirmado empiricamente, não
apenas por comentário herdado:** `app.ts`'s própria pin em `11.1.0`
(não um range) já documentava, com evidência, que `11.2.0`'s
`normalizeIP()` lança `TypeError: Cannot read properties of undefined
(reading 'toLowerCase')` sempre que `request.ip` é `undefined` — o que
acontece em todo WebSocket upgrade real sob `app.injectWS()`. **Esta
missão reproduziu o exato mesmo crash de forma independente** (bumped
para 11.2.0 primeiro, sem ler este comentário; 6 testes de "Pears
relay" em `tests/routes.test.ts` falharam com o mesmo stack trace
`normalizeIP → defaultKeyGenerator → applyRateLimit`; revertido para
11.1.0, 134/134 passaram) — confirmação direta e independente de que o
pin continua necessário, não apenas herdado.

**Classificação:** NEEDS INVESTIGATION, não DEFER — diferente de um
major de tooling qualquer, esta é uma vulnerabilidade real, já
publicada, sem patch aplicável hoje sem quebrar WebSocket. **Fix
restante (não tentado nesta missão — é trabalho de código de
segurança de aplicação, fora do escopo de "repository hygiene"):**
ou aguardar uma versão upstream que corrija ambos os problemas juntos,
ou escrever um `keyGenerator` customizado que normalize IPv6
manualmente enquanto permanece em `11.1.0` (o próprio advisory
documenta esse workaround, mas o helper exportado `normalizeIP()` só
existe a partir de `11.2.0` — um `keyGenerator` customizado precisaria
reimplementar a normalização, não reusar o helper).

### 46. Majors deliberadamente adiados por esta missão (Mission 9.10, 2026-09-01)

Registrados, não implementados — nenhum critério do
`docs/GITHUB_PROJECT.md`-equivalente "major upgrade" gate (segurança
real / dependência de outra transição justificada / bloqueio de CI-
segurança-confiabilidade / risco de migração baixo E redução material
de débito) foi satisfeito para nenhum destes:

- `@noble/curves`/`@noble/hashes` (root: 1.x→2.x; `packages/sails-ui`:
  1.9.0→2.3.0) e `@bitcoinerlab/secp256k1` (1.x→2.x, `packages/sails-sdk`
  + `examples/wallet-integration`) — Classe B (cripto). Achado real que
  reduz o risco de uma futura investigação isolada: `packages/sails-sdk`
  já roda em produção contra `@noble/curves@2.2.0` hoje (resolução real
  do workspace, `npm ls` verificado) — o bump do root/UI para 2.3.0
  convergiria versões já parcialmente em uso, não introduziria uma v2
  inteiramente nova ao ecossistema. `multisig.provider.ts`/
  `arbitration-authority.ts` (o caminho de assinatura real Mission13/M8/
  M9) não importam nenhum destes pacotes diretamente — mas
  `@bitcoinerlab/secp256k1` é importado diretamente pelos próprios
  testes de integração reais desta suite (`m9fReleaseReorg.test.ts` e
  irmãos), via hoisting da declaração do SDK — uma investigação futura
  precisa rodar exatamente esses testes contra a v2 antes de aplicar.
- `@scure/btc-signer` (`packages/sails-sdk`, 2.0.1→2.3.0) — adiado
  junto com os nobles acima por acoplamento real (btc-signer v2.x
  alveja noble-curves v2.x internamente); aplicar um sem o outro é o
  próprio risco de inconsistência parcial que este item existe para
  evitar.
- `ioredis` (5.x→6.x) — Classe D, major real, não investigado a fundo
  nesta missão (fora do orçamento).
- `typescript` (5.9.3→7.0.2, pula a v6 inteira) — Classe E, mas com
  blast radius total do repositório; exemplo nomeado explicitamente
  pela própria missão como "não faça isso só porque existe."
- Família Storybook (`@chromatic-com/storybook`, `@storybook/*`,
  `@testing-library/jest-dom`, `@vitejs/plugin-react` em
  `packages/sdk-react`, `jsdom`, `storybook`) — **achado real, não
  apenas adiado por cautela:** o PR #39, como construído, bumpava
  `@storybook/addon-a11y`/`addon-themes`/`react`/`react-vite` para v10
  enquanto deixava `@storybook/addon-essentials`/`addon-interactions`/
  `test` em v8 — Storybook exige versões major idênticas entre seus
  próprios pacotes; mergeado como estava, isso quebraria o Storybook,
  não apenas arriscaria quebrá-lo. Uma futura migração precisa mover
  TODOS os pacotes `@storybook/*` juntos, na mesma major, nunca parcial.
- `@qvac/sdk` (0.15.0→0.18.2) — pre-1.0, bump minor pode ser breaking;
  ver item 47.
- `next.js`/demais deps de `examples/sails-integration-starter` e
  `examples/wallet-integration` (exceto o bitcoinerlab já listado acima)
  — apps standalone isolados, deliberadamente fora do escopo desta
  passada para manter o diff pequeno e diagnosticável.

### 47. QVAC SDK — investigado, não aplicado (Mission 9.10, 2026-09-01)

`@qvac/sdk` `0.15.0→0.18.2` (PR #39) não foi aplicado. Semver pre-1.0
— um bump "minor" pode ser breaking pela própria convenção do
ecossistema. `qvac-agent.provider.ts` mantém QVAC estritamente
advisory-only onde autoridade de protocolo é exigida
(`SEMANTIC_KERNEL.md` §16) — esta fronteira é imposta pelo código do
próprio Sails (QVAC nunca é chamado em um caminho que trata sua
resposta como autoridade), não por uma garantia do SDK, então um
upgrade de versão não pode silenciosamente movê-la sozinho. Ainda
assim, uma mudança de superfície de API entre 0.15→0.18 não foi
auditada função a função nesta missão — registrado como trabalho
futuro antes de aplicar, não como "seguro por design."

### 48. `deepmerge-ts` — vulnerabilidade real, sem fix disponível, não explorável (Mission 9.10, 2026-09-01)

`npm audit --omit=dev` aponta `deepmerge-ts@7.1.5 < 8.0.0`
(GHSA-ggr8-5vv4-36mx, high, stack exhaustion em merge de grafos de
objeto recursivos), puxado transitivamente por `prisma@7.10.0` →
`@prisma/config@7.10.0`. `npm audit fix --force`'s própria sugestão é
fazer DOWNGRADE do prisma inteiro para `6.12.0` — rejeitado
explicitamente (regressão de major inteira, exatamente o tipo de
"fix" automático que esta missão existe para não aceitar cegamente).
Corresponde ao alerta Dependabot #73, historicamente
`auto_dismissed` pelo GitHub, reintroduzido pela própria resolução do
lockfile desta missão. **Classificação: não explorável** — `prisma`
é uma ferramenta de CLI/dev, nunca processa grafo de objeto vindo de
rede não confiável; `deepmerge-ts` aqui só processa os próprios
arquivos de config/schema locais do desenvolvedor. Nenhum fix
disponível upstream ainda; registrado, não corrigido.

### 49. Nenhum workflow de CI buildava os pacotes do workspace antes dos testes (Mission 9.10, 2026-09-01)

**Achado real, de terceira camada** — descoberto só depois que os dois
fixes do item 44 deixaram os workflows reais avançarem o suficiente
para alcançá-lo pela primeira vez, confirmando exatamente por que a
missão instruiu "reproduza, não confie no diagnóstico anterior."

Uma PR real (#40) rodando no GitHub Actions falhou com `TS2307: Cannot
find module '@satsails/p2p-trading-sdk'` em ~29 suites, tanto em
`ci.yml` (Node 20) quanto em `ci-tests.yml` (Node 24) — descartando
uma causa específica de versão do Node. `packages/sails-sdk/package.json`
aponta `"types": "dist/index.d.ts"` (`dist/` no `.gitignore`, nunca
commitado). `jest.config.js`'s próprio `moduleNameMapper` (comentário
já existente: "tests must not depend on packages/*/dist having been
built first") só cobre a resolução em TEMPO DE EXECUÇÃO do Jest — a
passada de diagnóstico do TypeScript dentro do `ts-jest` resolve
módulos de forma independente, via `node_modules` → o symlink do
workspace → o próprio campo `"types"` do pacote, exatamente como um
consumidor real faria. Nenhum dos dois workflows nunca rodou
`npm run build` antes dos testes.

**Reproduzido localmente byte a byte, não assumido:** removido
`packages/sails-sdk/dist` com cache do Jest limpo → erro idêntico;
restaurado → passa. **Fix:** um step `Build workspace packages`
(`npm run build -w @sails/core -w @satsails/p2p-schemas -w
@satsails/p2p-trading-sdk`) adicionado a ambos os workflows, entre
`Install dependencies` e `Generate Prisma Client`. Confirmado
localmente com build genuinamente do zero (dist/ removido, cache do
Jest limpo, suite completa rodada) antes de commitar. **Resultado
real, verificado em PR #40:** de ~29 suites falhando para exatamente
1 suite / 6 testes — ver item 50.

### 50. `tests/settlementReadAccess.test.ts`'s bloco `/disputes/:id` — 6 testes falhavam de forma determinística no GitHub Actions real, não reproduzia localmente (Mission 9.10 → **FECHADO na Mission 9.10-R**, 2026-09-01)

Achado durante a validação real do PR #40 (Mission 9.10), depois que os
itens 44/49 já haviam fechado toda a quebra estrutural anterior. Não
reproduzia localmente sob nenhuma condição testada naquele momento —
único débito real, disclosed, deixado ABERTO ao final da Mission 9.10
em vez de um fix às cegas.

**Root cause real, isolado na Mission 9.10-R via diagnóstico temporário
rodado em CI real** (não em teoria — `console.log` disclosed, pushado,
lido do log real do GitHub Actions, removido antes do fix final):
`TRUSTED_ARBITRATORS` nunca era setado em nenhum workflow. `config/
index.ts` lê `process.env.TRUSTED_ARBITRATORS` uma única vez, no
import do módulo; `dispute.service.ts`'s `getDisputeService()` é um
singleton lazy que, na primeira tentativa de construção, lança
`ValidationError('No trusted arbitrators configured')` se esse array
estiver vazio — e continua lançando para toda chamada seguinte no
mesmo worker, já que o singleton nunca constrói com sucesso. Isso
explica por que os 6 testes falhavam identicamente (400) independente
da identidade do chamador: nenhum chegava a alcançar a checagem de
autorização. Localmente sempre foi mascarado por um `.env` gitignored
(`TRUSTED_ARBITRATORS=k6-test-arbiter`) — daí não reproduzir.

**Esta investigação revelou, em sequência, DUAS camadas adicionais do
mesmo root cause — só visíveis depois que a camada anterior foi
corrigida e o CI real avançou mais longe do que nunca antes ("cada
falha corrigida pode revelar a falha que estava impedida de
executar"):**
1. `tests/settlementReadAccess.test.ts` — não setava a var (fix:
   `process.env.TRUSTED_ARBITRATORS` explícito em `beforeAll`, antes
   do `require('../src/app')` dinâmico, mesmo padrão já estabelecido
   por `tests/cors.test.ts`). Commit `f399aaa`.
2. Nem `ci.yml` nem `ci-tests.yml` jamais setavam
   `TRUSTED_ARBITRATORS` como env de workflow — ~10 arquivos
   `tests/integration/*.test.ts` assumiam o valor ambiente que todo
   checkout local já provê via `.env`. Fix: `TRUSTED_ARBITRATORS:
   k6-test-arbiter` adicionado a ambos os workflows, mesmo escopo de
   `DATABASE_URL`.
3. Esse fix (2) imediatamente expôs um TERCEIRO problema adjacente:
   `tests/integration/escrowFundingConcurrency.test.ts` tinha sua
   própria linha de default (`process.env.TRUSTED_ARBITRATORS =
   process.env.TRUSTED_ARBITRATORS || 'funding-concurrency-test-
   arbiter'`), que só disparava quando a var estava vazia — e uma
   constante `ARBITER_ID` separada, hardcoded, com o MESMO literal,
   que parou de bater assim que (2) passou a fornecer um valor
   ambiente real. Fix: `ARBITER_ID` agora deriva de
   `process.env.TRUSTED_ARBITRATORS` diretamente, eliminando a
   segunda fonte de verdade. Commit `a92f812`.

**Verificação real, não teórica:** cada uma das 3 camadas foi
reproduzida localmente (falha causada deliberadamente, confirmada,
depois corrigida e reconfirmada) antes do push. Regressão completa
local limpa (unit: 147/147 suites, 1848/1848 testes; Postgres real:
27/27 suites, 218/218 testes, contra containers Postgres genuinamente
novos, nunca reaproveitados). PR #40 real no GitHub Actions: **CI** e
**CI Tests** verdes **duas vezes consecutivas** no mesmo commit
(`a92f812`, via `gh run rerun` independente) — não apenas uma
execução isolada.

**Classificação: débito FECHADO com causa raiz completa, não um
"CI ficou verde" sem explicação.** Nenhum teste foi pulado, nenhum
status code foi trocado para forçar passagem, nenhuma
autorização foi enfraquecida, nenhum retry foi usado para mascarar
falha determinística — ver Sacrifice Check da Mission 9.10-R.

### 51. Chamadas de chain/RPC ao vivo não têm timeout ou retry limitado (Independent Code Quality & Production Reality Audit, 2026-09-06)

**Classificação: P1 — débito técnico novo, disponibilidade operacional do settlement.**

Toda chamada `fetch()` a um explorer Bitcoin real ou ao bundler EVM é
uma chamada única, sem `AbortSignal`, sem timeout, sem retry/backoff
limitado: `multisig.provider.ts:228,243,270,300,314,654,908,930`;
`safe-guard-evm.provider.ts:571`.

**Propriedade em risco:** liveness/disponibilidade operacional do
settlement — não uma questão de correção econômica (nenhum "sucesso
fabricado" foi encontrado nesses caminhos, ver item de auditoria de
error-handling correspondente), mas um endpoint travado bloqueia a
requisição indefinidamente em vez de falhar rápido ou tentar novamente
com limite.

**Por que importa:** deveria ser corrigido antes de expansão
significativa de rails — cada novo rail adiciona mais chamadas de rede
sem essa proteção.

**Fix recomendado (propriedade, não mecanismo):** toda chamada de rede
a um provedor de liquidação/chain externo deve falhar dentro de um
tempo limitado e pode ser reexecutada um número limitado de vezes antes
de propagar o erro. Não prescreve um mecanismo específico (sem
"ResilienceManager" genérico ou camada de resiliência universal) —
decisão de implementação de uma futura Refactoring Authorization Gate.

**Não corrigido por este registro.**

**Status — CLOSED (Bounded Remediation F1, 2026-09-06). CORRIGIDO O MESMO
DIA — ver "Status — PARTIAL / PENDING CTO GATE" abaixo. Preservado
verbatim, não apagado, para o histórico da correção.** Todas as 9
chamadas `fetch()` cruas (8 em `multisig.provider.ts`, 1 em
`safe-guard-evm.provider.ts`) mais as 4 chamadas RPC via `ethers`
`JsonRpcProvider`/`Contract` (`getNonce`/`getStorage`/`getBalance`×2 em
`safe-guard-evm.provider.ts`) agora resolvem ou falham dentro de um
timeout limitado (`AbortController` real para `fetch()`; um
`Promise.race` com timeout — limitação honestamente registrada, não
garante o encerramento do socket subjacente do `ethers` — para as
chamadas via `ethers`). Retry limitado e seguro (3 tentativas, backoff
linear) foi aplicado SOMENTE aos 11 caminhos de leitura pura; os 2
caminhos de submissão/broadcast (`multisig.provider.ts`'s `broadcast()`,
`safe-guard-evm.provider.ts`'s `broadcast()` via bundler) permanecem
TIMEOUT_ONLY, sem retry automático, por design — um timeout após o
envio significa resultado DESCONHECIDO, não FALHOU, e reenviar
poderia duplicar uma ação econômica já aceita pela rede. Nenhuma
semântica de estado do escrow, autoridade, destino, ou assinatura foi
alterada. Novo arquivo: `src/modules/open-settlement/bounded-rpc.ts`
(helper local compartilhado, não um framework de resiliência genérico).
Evidência completa: PR (branch `fix/f1-rpc-bounded-liveness`),
`tests/boundedRpc.test.ts` (13 testes provando timeout/retry/no-retry/
erro-final-visível/sem-sucesso-fabricado) + testes existentes
atualizados em `tests/multisigProvider.test.ts` para refletir o novo
retry seguro intencional.

**Status — PARTIAL / PENDING CTO GATE (CTO Gate correction, 2026-09-06,
mesmo dia).** O CTO corretamente rejeitou o CLOSED acima: `Promise.race()`
limita apenas a espera do CHAMADOR, não a operação de rede subjacente —
e cria um risco real de trabalho de rede sobreposto entre tentativas de
retry. Investigação direta do `ethers@6.17.0` instalado
(`node_modules/ethers/lib.commonjs/utils/geturl.js`) mais um teste
empírico (servidor TCP real que aceita conexão e nunca responde)
confirmaram: `ethers.FetchRequest.timeout` é um timeout real de
transporte (`Node http.ClientRequest.setTimeout()`), não um mero
`Promise.race`; `JsonRpcProvider` aceita um `FetchRequest` já configurado
no construtor. `safe-guard-evm.provider.ts`'s `provider()` foi corrigido
para configurar esse timeout nativamente; `withBoundedRpcTimeout()` foi
removido de `bounded-rpc.ts`, substituído por `withBoundedRetry()`
(retry puro, sem timer próprio) — elimina a sobreposição de tentativas
que preocupava o CTO, já que cada retry só começa depois que a promise
nativa do `ethers` já se resolveu.

**Achado adicional, não solicitado, mas provado durante a investigação
do próprio Gate:** o handler de timeout do `ethers` rejeita a promise em
JS mas nunca chama `request.destroy()` no socket subjacente — confirmado
de forma reproduzível: um teste de diagnóstico ficou pendurado
indefinidamente em `server.close()` porque o socket cliente do `ethers`
nunca foi encerrado após seu próprio timeout disparar. Isso é evidência
concreta, não apenas teórica, de que **CALLER-WAIT É LIMITADO; A
OPERAÇÃO DE REDE SUBJACENTE NÃO É** — em runtime real, isto significa
que um endpoint RPC do SAFE_GUARD_EVM cronicamente travado pode acumular
sockets TCP abandonados (limitado a `RPC_READ_RETRY.attempts`=3 por
chamada, mas não limitado ao longo de chamadas repetidas, ex.:
sweepers/reconciliação). Escrever um transporte customizado para forçar
o encerramento do socket foi explicitamente rejeitado pelo CTO
("Do not invent a large custom transport") — permanece um resíduo
disclosed, não corrigido.

**Classificação final desta seção:** caminhos `fetch()` cru (multisig
explorer, bundler EVM) = **CLOSED**, propriedade "resolve ou falha
dentro de tempo limitado, com abort real" totalmente satisfeita. Caminhos
`ethers` RPC (SAFE_GUARD_EVM `getNonce`/`getStorage`/`getBalance`×2) =
**PARTIAL** — espera do chamador limitada e comprovada (timeout real de
transporte, não uma corrida), retry seguro e sequencial (sem sobreposição
entre tentativas), mas encerramento do socket subjacente não garantido
pelo `ethers` nessa versão instalada. F1 permanece **PARTIAL / PENDING
CTO GATE** no geral até o CTO decidir se essa propriedade mais estreita é
aceitável ou se um transporte customizado se justifica.

### 52. Contrato de criação de escrow entre SDK e backend não tem schema compartilhado canônico (Independent Code Quality & Production Reality Audit, 2026-09-06)

**Classificação: P1 — débito técnico novo, integridade de contrato SDK↔servidor.**

`packages/sails-p2p-schemas` cobre dispute/offer/trade/capability-profile/
bitcoin-network, mas não a criação de escrow. `packages/sails-sdk/src/modules/settlement.ts`'s
`create()` e `settlement.routes.ts`'s `createEscrowSchema` (zod) são
mantidos independentemente, com paridade garantida apenas por
comentários manuais — um dos quais já documenta uma divergência real
passada ("found missing WDK_USDT_EVM/SAFE_GUARD_EVM").

**Propriedade em risco:** integridade do contrato SDK↔backend — um
campo novo obrigatório ou um valor de enum renomeado compila
corretamente dos dois lados de forma independente e só é descoberto por
um integrador real em runtime (erro 400 genérico), nunca pelo CI.

**Por que importa:** deveria ser corrigido antes de expansão
substancial de superfície SDK/settlement.

**Fix recomendado (propriedade, não mecanismo):** SDK e servidor devem
compartilhar a mesma fonte de verdade estrutural para o contrato de
criação de escrow. Não prescreve uma ferramenta/serviço específico (sem
"schema broker service") — decisão de implementação de uma futura
Refactoring Authorization Gate.

**Não corrigido por este registro.**

**Status — CLOSED (Bounded Remediation F5, 2026-09-06). CORRIGIDO no
mesmo dia (CTO Gate) — ver a nota logo abaixo. Texto original
preservado, não apagado, para o histórico da correção.** Novo arquivo
`packages/sails-p2p-schemas/src/escrow.ts` — `ESCROW_TYPE_VALUES`/
`EscrowType`, `ASSET_TYPE_VALUES`/`AssetType`, `CreateEscrowInput`, e um
validador estrutural puro (`isValidCreateEscrowInput`, zero
dependências, mesma convenção zero-runtime-dependency já estabelecida
por este pacote) — é agora a ÚNICA fonte canônica. Três declarações
independentes foram encontradas (não duas, como o achado original
citava): `packages/sails-sdk/src/modules/settlement.ts`'s
`CreateEscrowInput`, `src/modules/open-settlement/escrow.service.ts`'s
próprio `CreateEscrowInput`, e `settlement.routes.ts`'s `createEscrowSchema`
(zod) — as três agora importam o mesmo tipo/arrays canônicos em vez de
redeclarar sua própria cópia. A prova de paridade é o próprio compilador:
`settlement.routes.ts`'s handler removeu o cast `as any` que existia
antes (`escrowService.createEscrow(body as any, ...)` → `(body, ...)`)
— `z.infer<typeof createEscrowSchema>` agora precisa satisfazer
estruturalmente `CreateEscrowInput` sem cast algum, confirmado por
`npx tsc --noEmit` limpo; se as duas alguma vez divergirem, isso deixa
de compilar. `tests/escrowCreationSchemaParity.test.ts` (11 testes)
prova adicionalmente: (1) o enum do zod foi construído a partir do
array canônico exportado (introspecção real do schema, não uma cópia
reconstruída), (2) identidade de tipo em tempo de compilação entre as
três declarações (`Equal<A,B>` — falha ao compilar, não apenas em
runtime, se divergirem), (3) todo valor histórico de provider atual
(MOCK/MULTISIG/LIGHTNING_HODL/WDK_USDT_EVM/SAFE_GUARD_EVM) continua
válido, (4) `LIQUID_COVENANT` continua estruturalmente válido, sem
alteração — reservado/não-implementado no nível do provider, não no
nível do schema, distinção preservada, não removida. Escopo
deliberadamente estreito: `AssetType`/`EscrowType` permanecem
declarados independentemente em outros lugares
(`src/common/types/index.ts`, `src/common/types/trade.ts`,
`packages/sails-sdk/src/types.ts`) para seus próprios usos mais amplos,
não relacionados à criação de escrow (Offer/Trade/PayoutAddress) —
hoje estruturalmente idênticos aos valores acima, não alterados por
este fix, fora do escopo desta remediação. Nenhuma semântica
econômica, de máquina de estados, ou de maturidade de provider foi
alterada. Validação positiva de `lockedAmount` permanece
deliberadamente server-side apenas (`positiveDecimalString()`) — regra
de negócio, não fato estrutural, per a distinção explícita desta
missão.

**Correção (CTO Gate, 2026-09-07).** O parágrafo acima descreve
corretamente a arquitetura primária (fonte estrutural canônica → SDK →
backend → validação Zod), mas registrava incorretamente
`isValidCreateEscrowInput()` (junto com seus dois helpers de suporte,
`isKnownEscrowType()`/`isKnownAssetType()`) como parte do design
aceito. O CTO identificou que esse validador era, ele mesmo, uma
SEGUNDA implementação de validação de runtime, independente da
verdadeira autoridade (`settlement.routes.ts`'s `createEscrowSchema`,
Zod) — com uma divergência de comportamento real e deliberada
(`lockedAmount`: o helper só checava "string não-vazia," o schema real
exige `positiveDecimalString()`, finito e positivo). Chamar os dois
"em paralelo" para provar paridade criava exatamente o tipo de proxy
enganoso que este fix existe para eliminar — dois validadores nunca
foram, e nunca deveriam ter sido, tratados como equivalentes.

Os três helpers foram **removidos** de
`packages/sails-p2p-schemas/src/escrow.ts` (confirmado, via grep, zero
consumidores de produção fora do próprio teste de paridade antes da
remoção). A superfície canônica final é deliberadamente menor:
`ESCROW_TYPE_VALUES`/`EscrowType`, `ASSET_TYPE_VALUES`/`AssetType`,
`CreateEscrowInput` — nada mais. O pacote compartilhado fornece a
fonte estrutural canônica (tipo/enum); o backend permanece a única
autoridade de validação em runtime (Zod, inalterado). `tests/escrowCreationSchemaParity.test.ts`
foi reescrito para validar exclusivamente contra o `createEscrowSchema`
real (13 testes, incluindo dois novos provando explicitamente que a
validação positiva de `lockedAmount` no schema real permanece
inalterada) — nenhum teste cria ou depende de um segundo validador
falso/compartilhado. `LIQUID_COVENANT` não teve seu status estrutural
alterado por esta correção — continua exatamente como estava antes e
depois do F5 original.

### 53. `SettlementProvider.verifyLock()` existe em todos os providers mas não tem nenhum call site real (Independent Code Quality & Production Reality Audit, 2026-09-06)

**Classificação: P2 — débito técnico novo, integridade de abstração / deriva de interface morta.**

Toda implementação real (`multisig.provider.ts:892`,
`lightning-hodl.provider.ts:312`, `wdk-settlement.provider.ts:201`,
`safe-guard-evm.provider.ts:622`) implementa `verifyLock()`; nenhum call
site real existe em `src/` além das próprias definições —
auto-documentado em `multisig.provider.ts:762-765`.

**Propriedade em risco:** integridade da abstração — um método nunca
exercitado no caminho de fundos reais pode divergir silenciosamente da
lógica real de `lockFunds()` sem que nenhum teste ou chamador jamais
perceba.

**Decisão futura necessária (não tomada aqui):** (A) conectar
`verifyLock()` a um caminho real que carregue uma propriedade genuína,
ou (B) removê-lo com uma nota disclosed. Este registro não escolhe —
apenas nomeia a decisão pendente.

**Não corrigido por este registro. Nenhum mecanismo criado.**

**Status — CLOSED, Decisão B (Bounded Remediation F6, 2026-09-07).**
Investigação exaustiva do call-graph real (não apenas grep) confirmou:
em todos os 4 providers reais, `verifyLock()` reimplementa — de forma
independente, textualmente quase idêntica — exatamente a mesma lógica
de verificação de fundos que `lockFunds()` já executa (mesmo padrão em
MULTISIG, LIGHTNING_HODL, SAFE_GUARD_EVM, WDK_USDT_EVM); `MOCK`'s
`verifyLock()` era um `return true` incondicional, sem propriedade
alguma.

**Correção de precisão (CTO Gate, 2026-09-07).** Uma versão anterior
deste registro afirmava que "a transição CREATED→FUNDS_LOCKED já
verifica fundos externos de verdade" — formulação forte demais.
Confirmado lendo `escrow.service.ts`'s `lockFunds()` diretamente: o
claim atômico via Postgres acontece PRIMEIRO, de forma PROVISÓRIA,
ANTES de chamar `provider.lockFunds()` — a verificação real
específica de cada rail (ou o movimento de fundos, para providers
custodiais) acontece DEPOIS, dentro da própria chamada ao provider.
Logo, o status `FUNDS_LOCKED` pode existir no banco enquanto
`provider.lockFunds()` ainda está em execução. A propriedade real,
precisa, que esta remoção preserva inalterada é: **uma operação de
lock só é finalizada/evidenciada depois que `provider.lockFunds()` tem
sucesso** — o resultado do lock é persistido, evidência de funding é
gravada quando aplicável, e `settlement.escrow.locked` só é emitido
então; uma falha do provider reverte o claim provisório
(`revertEscrowStatus`, retorno a CREATED, retry no nível de aplicação).
Reivindicação de estado ≠ fato externo verificado — o status provisório
`FUNDS_LOCKED` em si não é evidência durável de settlement nem é o
evento de lock emitido; ambos continuam dependendo do sucesso da
chamada ao provider. Esta ordenação de controle de concorrência (claim
→ chamada ao provider → finalização/evidência, ou reversão em erro
lançado) permanece inalterada por esta remoção — existe para prevenir
efeitos colaterais duplicados em chamadas concorrentes de
`lockFunds()`, não para servir de gate de verificação, e está fora do
escopo desta missão.

**Correção adicional (CTO Gate #2, 2026-09-07) — "retry seguro" era
forte demais.** A reversão acima torna o estado INTERNO (no banco)
retentável — não prova, por si só, que os efeitos colaterais EXTERNOS
de todo provider são seguros para retry, ou inexistentes, após uma
falha ambígua. Para MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM,
`lockFunds()` é uma verificação somente-leitura contra um funding já
externo — um erro lançado ali genuinamente não implica um novo efeito
colateral daquela chamada. Para `WDK_USDT_EVM`, `lockFunds()` chama
`treasury.transfer(...)` — um movimento de fundos com efeito colateral
externo real — então um erro lançado depois dessa chamada NÃO prova,
por si só, que a transferência nunca foi efetivada; segurança de retry
nesse caso específico NÃO é demonstrada por este mecanismo de reversão
isoladamente. Não se afirma que este cenário seja explorável na
prática, nem que `WDK_USDT_EVM` de fato duplique transferências — ver
o novo item de backlog registrado logo abaixo, que nomeia a lacuna de
evidência sem respondê-la.

A reconciliação de reorg do MULTISIG (`multisig-funding-reorg-sweep.ts`)
já usa seu próprio método dedicado, mais rico (`rescanFunding()` —
outpoint, profundidade, alturas), nunca `verifyLock()`. Nenhuma rota
HTTP, método de SDK, ou RFC normativo jamais expôs ou exigiu
`verifyLock()` como capacidade chamável — confirmado por busca
completa no repositório antes da remoção.

**Ataque à Opção A (conectar) — rejeitada.** Toda tentativa de wiring
revelou "uso pelo uso": duplicaria uma chamada de rede já realizada por
`lockFunds()`; criaria ambiguidade TOCTOU (o estado da chain pode mudar
entre um "pre-check" e o `lockFunds()` real); sugeriria falsamente
garantias de segurança uniformes entre rails que não compartilham o
mesmo modelo (MULTISIG verifica profundidade de confirmação; LIGHTNING_HODL
verifica apenas VTXO gasto; SAFE_GUARD_EVM verifica saldo nativo;
WDK_USDT_EVM é custodial — o saldo é consequência direta do próprio
`lockFunds()`); e qualquer wiring que realmente "significasse algo"
exigiria alterar semântica da máquina de estados, o que esta missão
foi explicitamente instruída a não fazer.

**Ataque à Opção B (remover) — sobreviveu.** Nenhum tipo público/SDK
depende dele; nenhum teste prova uma propriedade de produção real (só
a correção interna do próprio método, isolado); a verificação real
continua exatamente onde sempre esteve (`lockFunds()`, e para MULTISIG,
`rescanFunding()`); impacto de compatibilidade pública é zero.

**Implementação:** `verifyLock(escrow): Promise<boolean>` removido de
`SettlementProvider` (`escrow-providers.ts`) e das 5 implementações
(`MockSettlementProvider`, `MultisigProvider`, `LightningHodlProvider`,
`SafeGuardEvmProvider`, `WdkSettlementProvider`). Nenhuma lógica real de
verificação de fundos foi removida — `lockFunds()`/`rescanFunding()`
permanecem inalterados. Comentários que descreviam `verifyLock()` como
capacidade viva (código-fonte, testes, whitepaper) corrigidos para
refletir a verdade atual. `tests/multisigProvider.test.ts`/
`tests/safeGuardEvmProvider.test.ts` tiveram seus testes específicos de
`verifyLock()` removidos — a propriedade de bounded-retry/timeout (F1)
que 3 desses testes também provavam permanece coberta de forma
genérica e independente de provider em `tests/boundedRpc.test.ts`.
Nenhuma claim de "todos os locks são verificados de forma independente"
ou "verificação uniforme entre rails" é feita — pelo contrário, este
registro documenta explicitamente que as garantias diferem por rail.
Evidência completa: PR (branch `fix/f6-verifylock-decision`).

### 54. Caminhos de detecção baseados em QVAC degradam silenciosamente (log-only) em falha de inferência (Independent Code Quality & Production Reality Audit, 2026-09-06)

**Classificação: P2 — débito técnico novo, observabilidade / sinal de segurança.**

`liquidity.service.ts:270-289` (`screenOfferContent`) e
`handlers.ts:519-543` (`socialEngineeringAgent.evaluate`) envolvem a
chamada QVAC em um `.catch(err => log.error(...))` terminal — em
falha, o sinal de detecção simplesmente nunca é emitido, sem
métrica/alerta visível ao operador.

**Importante, para não superestimar:** isto NÃO fabrica um resultado
(nenhum veredito falso é inventado) e NÃO é um bug de correção de
settlement — é puramente uma questão de visibilidade operacional de um
sinal protetivo degradado.

**Propriedade em risco:** visibilidade operacional de controles de
segurança degradados.

**Fix recomendado (propriedade, não mecanismo):** uma falha no pipeline
de detecção deve ser distinguível operacionalmente de "nenhuma ameaça
detectada" — não prescreve um mecanismo de alerta específico.

**Não corrigido por este registro.**

**CLOSED (Bounded Remediation F8, 2026-09-07).** Dois `Counter`s
`prom-client` pareados, registrados no `Registry` já existente de
`common/metrics.ts` e expostos pelo `GET /metrics` já existente (nenhuma
biblioteca de telemetria nova, nenhum endpoint novo):
`sails_qvac_detection_invocations_total` e
`sails_qvac_detection_failures_total`, ambos com um único label limitado
(`path`, enum fechado de 2 valores: `offer_screening` |
`social_engineering`) — o mesmo padrão já estabelecido por
`suspiciousActivityTotal` (`common/security/suspicious-activity.ts`).

Pareados deliberadamente: um contador de falhas isolado, lendo 0, não
distingue "rodou limpo sempre" de "nunca rodou" (a feature flag
`socialEngineeringDetection` é `false` por padrão) — o contador de
invocações resolve essa ambiguidade (Fase 7 da missão F8). SUCCESS+CLEAN
vs. SUCCESS+THREAT já eram distinguíveis via o evento de risco que cada
caminho já emite (`liquidity.offer.content_risk_detected`,
`agents.social_engineering.risk_detected`) — este fechamento não
adiciona nada ali; o que genuinamente faltava era apenas DEGRADED vs.
qualquer um dos dois estados de SUCCESS.

Nenhum label carrega texto de erro livre, IDs de
participante/trade/offer/message, ou saída do modelo. Nenhum evento
novo, nenhum indicador de health/degraded, e nenhum label
`reason_class` foram adicionados — cada um avaliado e rejeitado por não
justificar seu custo (não existe hoje uma taxonomia de erro QVAC para
classificar contra; um evento ou sinal de health implicaria autoridade
de enforcement que este detector não tem). Detecção em si, e seu
comportamento fail-open, permanecem completamente inalterados —
nenhuma semântica de settlement, estado de protocolo, ou comportamento
de bloqueio foi tocado.

`liquidity.service.ts` incrementa `invocations` logo após seus dois
pre-filtros existentes (flag desligada / sem texto) — uma chamada
filtrada nunca conta como invocação. `social-engineering-agent.ts`
incrementa `invocations` no mesmo ponto equivalente: logo após seus
próprios dois pre-filtros (tipo de evento, conteúdo vazio), mas ANTES
das duas leituras de preparação de contexto (`recentMessageContext()`,
`buildTradeStateContext()`) e da chamada real ao QVAC. `failures` é
incrementado exatamente nos dois `catch` já existentes (inalterados na
lógica, só ganharam a chamada `.inc()`) — no caminho
`social_engineering`, esse `catch` vive em `handlers.ts`, uma camada
acima de `evaluate()`, e cobre também uma falha de leitura do
`TradeRepository`/Timeline usada para montar o contexto do QVAC, não só
a chamada ao SDK em si; isso é deliberado, não uma imprecisão — do
ponto de vista operacional, uma avaliação protetiva que não completou é
igualmente "degradada" independente de qual etapa interna falhou.

**Correção (CTO Gate, 2026-09-07).** Uma primeira versão deste fechamento
incrementava `invocations` do caminho `social_engineering` DEPOIS das
duas leituras de preparação de contexto, imediatamente antes da chamada
real ao QVAC — o que permitia uma falha de leitura de contexto produzir
`failures += 1` com `invocations += 0` para o mesmo item, tornando
`failures / invocations` matematicamente inválido (podendo exceder 1) e
misturando dois denominadores diferentes (uma "tentativa de avaliação
protetiva" completa vs. apenas "a chamada ao SDK QVAC"). Corrigido
movendo o incremento de `invocations` para o ponto acima — logo após os
pre-filtros, antes das leituras de contexto — de modo que os dois
contadores compartilhem uma única população por item avaliado: `failures
<= invocations` sempre, para o mesmo `path`. O catch mais amplo em
`handlers.ts` (cobrindo falha de contexto E falha do provider QVAC)
permanece deliberado e inalterado — não é "QVAC availability", é
"degradação da avaliação protetiva", que pode legitimamente incluir uma
falha de preparação de contexto anterior à própria chamada ao QVAC.

Testes: `tests/qvacDetectionMetrics.test.ts` (cardinalidade de label,
ausência de PII, não-duplicação de registro sob reimport de módulo,
tipo `Counter`); extensões em `tests/offerContentScreening.test.ts`,
`tests/socialEngineeringAgent.test.ts` (incluindo um caso novo de falha
de preparação de contexto, QVAC nunca alcançado) e
`tests/socialEngineeringDetection.test.ts` provando, para cada caminho:
não-invocado ≠ invocado-e-limpo ≠ invocado-e-falhou, e que SUCCESS+THREAT
não é contado como falha. `tests/qvacDetectionSharedPopulation.test.ts`
(novo, adicionado na correção do CTO Gate) prova a propriedade
`failures <= invocations` diretamente contra a fiação real de
`social-engineering-agent.ts` + `handlers.ts` (não mockando nenhum dos
dois), com um lote misto de avaliação limpa, ameaça, falha de
preparação de contexto, e falha do provider QVAC. Evidência completa:
PR (branch `fix/f8-qvac-degraded-observability`).

### 55. `proof.service.ts`'s comentário sobre o event store default está desatualizado (Current Truth Documentation Drift, 2026-09-06)

**Classificação: Current Truth Documentation Drift — não é débito técnico novo, não é gap de implementação.**

`proof.service.ts:346-352`'s comentário (datado "Missão 05,
2026-08-15") ainda descreve "o store default (`InMemoryEventStore`...)"
como o comportamento atual. Isso era verdade quando escrito, mas
`event-bus.ts`'s próprio `SailsEventBus` mudou seu default para
`PostgresEventStore` na MESMA data, em uma passagem posterior (Missão
05.7, per `event-bus.ts:450-451,463`). O comportamento em runtime já
está correto — `timelineDurable`/`timelineStore` (`proof.service.ts:364-368`)
leem dinamicamente o store real configurado, não um valor hardcoded —
apenas o texto estático do comentário nunca foi atualizado para
refletir a mudança de default.

**Não é:** um gap de durabilidade real, um bug de implementação, ou uma
nova obrigação técnica. A auditoria original que levantou este ponto
("runtime durability gap") superestimou o achado — corrigido aqui após
verificação direta contra `event-bus.ts`.

**Correção futura (comment-only, não feita aqui):** atualizar o
comentário para refletir que `PostgresEventStore` é o default real
desde Missão 05.7, preservando a explicação da distinção
durável/não-durável (que continua genuinamente relevante caso um
deployment configure explicitamente `InMemoryEventStore`).

**CLOSED (F7, 2026-09-07).** Comentário de `proof.service.ts` corrigido
diretamente no código-fonte (não é um ledger versionado como este
documento, então a correção foi aplicada in-place, não anexada como
bloco datado). Confirmado por leitura direta do código, não assumido:
`event-bus.ts:463`'s `constructor(private readonly store: EventStore =
new PostgresEventStore())` mais `event-bus.ts:542`'s `export const
eventBus = new SailsEventBus()` — nenhum argumento passado, nenhuma
outra construção de `SailsEventBus`/`PostgresEventStore`/
`InMemoryEventStore` existe em `src/` fora de testes, nenhuma seleção
de store via `config/index.ts` ou variável de ambiente — confirmam que
o default real e único caminho de produção é `PostgresEventStore`
(`storeName='postgres'`, `durable=true`, `event-store.ts:219-221`).
`InMemoryEventStore` (`storeName='in-memory'`, `durable=false`,
`event-store.ts:120-122`) e `RedisStreamsEventStore`
(`storeName='redis-streams'`, `durable=true`, `event-store.ts:518-519`)
continuam existindo como classes importáveis — nenhuma seleção
silenciosa entre elas foi encontrada. `tests/evidenceBundleDurability.test.ts`
já prova isso contra o `eventBus` real, não mockado
(`expect(eventBus.durable).toBe(true)`,
`expect(eventBus.storeName).toBe('postgres')`) — nenhum teste novo
necessário. O comentário corrigido preserva: (1) que
claims/proofs/verifications/externalReferences são Postgres-backed;
(2) que `timeline` é lido através do `EventStore` de fato configurado,
não uma suposição hardcoded; (3) que o default atual é
`PostgresEventStore`; (4) que `timelineDurable`/`timelineStore`
reportam o store real em tempo de leitura; (5) que um `InMemoryEventStore`
explicitamente configurado continua possível; (6) que, se configurado
assim, um restart/redeploy pode perder o histórico do timeline e por
isso ausência não pode ser inferida de um timeline vazio; (7) que a
evidência de violação (hash chain, RFC-008 D2) é uma propriedade
distinta de durabilidade. Nenhum comportamento em runtime alterado.
Nenhuma nova obrigação técnica. **BACKLOG DELTA: ZERO** — nenhuma
contradição encontrada entre o entendimento registrado neste item #55
e o comportamento real do código.

**Correção (CTO Gate, mesmo dia).** O parágrafo acima e o comentário de
código continham duas sobre-afirmações, corrigidas em ambos os lugares:
(a) "um timeline vazio genuinamente significa 'nada aconteceu'" foi
substituído por uma afirmação mais estreita — sob o default atual,
o histórico do timeline não é perdido apenas por um restart do
processo (diferente do antigo default `InMemoryEventStore`), mas isso
não prova, por si só, que nenhum evento deixou de ser gravado; (b) "um
prova nada foi alterado silenciosamente, o outro prova nada foi
perdido silenciosamente" foi substituído por linguagem precisa por
propriedade: verificação por hash chain (RFC-008 D2) detecta mutação/
reordenação/deleção COBERTA dos eventos que de fato foram registrados;
durabilidade descreve se o histórico registrado sobrevive à fronteira
de persistência/restart relevante; nenhuma das duas propriedades,
isoladamente, prova completude, não-ocorrência histórica,
portabilidade, ou verificabilidade independente. Também esclarecido:
o item (5) acima ("um `InMemoryEventStore` explicitamente configurado
continua possível") não deve ser lido como afirmando que existe hoje
um caminho de configuração/variável de ambiente operacional para
selecioná-lo no singleton de produção — nenhum foi encontrado
(confirmado por inspeção direta, ver acima); `SailsEventBus` aceita um
`EventStore` via seu construtor e `InMemoryEventStore` continua
existindo como implementação não-durável disponível, mas o singleton
real (`eventBus`) não expõe hoje nenhum switch de config/env para
selecioná-lo. Nenhuma mudança de comportamento em runtime nesta
correção — apenas precisão de linguagem, no comentário-fonte e neste
registro.

### 56. `WDK_USDT_EVM`'s `lockFunds()` — resultado desconhecido/segurança de retry não demonstrada (CTO Gate #2 sobre F6, 2026-09-07)

**Classificação: novo delta de backlog / obrigação de evidência de segurança de produção. Não é causado pela remoção de `verifyLock()` (F6/#53) nem invalida a Decisão B — descoberto durante a revisão do F6, mas é um achado independente sobre `lockFunds()`, não sobre `verifyLock()`.**

**Propriedade em risco:** uma ação de movimentação de fundos com efeito
colateral externo não deve ser repetida apenas porque o chamador não
conseguiu determinar o resultado da primeira tentativa.

**Achado (fato atual, sem sobre-afirmar em nenhuma direção):**
`escrow.service.ts`'s `lockFunds()` reverte o claim provisório de
estado para `CREATED` sempre que `provider.lockFunds()` lança um erro
(`revertEscrowStatus`). Isso torna o estado INTERNO (no banco)
retentável. Para MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM, o
`lockFunds()` de cada provider é uma verificação somente-leitura contra
funding já externo — um erro lançado ali genuinamente não implica
efeito colateral novo. Para `WDK_USDT_EVM` especificamente,
`wdk-settlement.provider.ts`'s `lockFunds()` chama
`treasury.transfer(...)` — um movimento real de fundos, com efeito
colateral externo — ANTES de retornar. Se essa chamada lançar um erro
depois que a transferência já tiver sido transmitida/aceita pela rede
(timeout, resposta perdida, etc.), a sequência reversão-depois-retry
poderia, em princípio, solicitar uma segunda transferência real.

**Não se afirma:** que este cenário seja comprovadamente explorável na
prática, nem que `WDK_USDT_EVM` de fato duplique transferências hoje.
Este é um GAP DE EVIDÊNCIA, não um defeito demonstrado.

**Perguntas para uma futura missão de evidência dedicada (não
respondidas aqui, não devem ser respondidas por suposição):**
1. O que exatamente `transfer()` do WDK garante quando rejeita?
2. Uma transação pode ser transmitida/aceita pela rede antes de uma
   resposta de rejeição/timeout chegar ao chamador?
3. Existe um hash de transação / nonce / identidade de operação
   determinística recuperável que `lockFunds()` poderia usar para
   checar "minha última tentativa já foi efetivada" antes de tentar de
   novo?
4. A operação pode ser reconciliada antes do retry, da mesma forma que
   o reorg-sweep do MULTISIG reconcilia estado de funding?
5. A submissão duplicada é naturalmente idempotente na camada de
   transação/nonce da EVM, e sob quais condições exatas de falha isso
   vale ou não vale?
6. O atual revert-para-`CREATED` do `escrowService` colapsa
   incorretamente um resultado externo DESCONHECIDO em FALHOU (a mesma
   distinção DESCONHECIDO-vs-FALHOU que o próprio trabalho de
   broadcast/timeout do F1 já estabeleceu para outros rails)?
7. Isso já está totalmente contido pela classificação existente de
   `WDK_USDT_EVM` como `PRODUCTION-INELIGIBLE`/custodial-de-servidor
   (`docs/PROVIDER_SUBSTITUTION_INVARIANCE_EVIDENCE.md`), ou exige
   remediação independente antes de qualquer autorização de produção
   futura para este rail?

**Fix recomendado (propriedade, não mecanismo):** nenhum prescrito
aqui — as 7 perguntas acima precisam de uma investigação real e
dedicada antes de qualquer decisão de implementação. Não criar um
mecanismo de idempotência, deduplicação, ou reconciliação por
suposição.

**Não corrigido por este registro. Nenhum mecanismo criado. Nenhuma
mudança de comportamento em `lockFunds()`/`escrow.service.ts` feita ou
autorizada por este registro.**

**Update (Mission #56 — Unknown-Outcome / Retry-Safety Investigation,
2026-09-07).** As 7 perguntas acima foram investigadas de verdade — leitura
direta do código real (`escrow.service.ts`, `escrow-lifecycle.ts`,
`wdk-settlement.provider.ts`) e do pacote `@tetherto/wdk-wallet-evm`
instalado (`1.0.0-beta.16`), mais um teste adversarial real
(`tests/wdkLockFundsRetrySafety.test.ts`) exercitando a orquestração real
e não-mockada. Resultado, no nível de confiança correto — não mais um gap
de evidência, agora um achado DEMONSTRADO: `provider.lockFunds()`'s
`transfer()` retorna assim que `eth_sendRawTransaction` é aceito pelo nó
(não espera confirmação); nonce é sempre lido fresco via
`getTransactionCount(from, 'pending')`, nunca cacheado; nenhuma chave de
idempotência existe em nenhuma camada (WDK, provider, rota HTTP). Um teste
real contra a orquestração não-mockada demonstra: uma transferência externa
genuinamente bem-sucedida seguida por UMA FALHA LOCAL POSTERIOR (ex:
`updateLockResult()` falhando por um problema comum de conexão com o
Postgres — não algo exótico) reverte o escrow para `CREATED` sem persistir
o `txId` real em lugar nenhum, e um retry subsequente invoca o provider
uma SEGUNDA vez. Não se afirma "fundos definitivamente drenáveis" — a
descoberta precisa é: **DEMONSTRATED RETRY-SAFETY GAP**, delimitado
exatamente à janela entre "a chamada ao provider resolveu" e "o estado
resultante foi persistido de forma durável" — a janela de concorrência
(dois chamadores simultâneos) já era e continua protegida pelo
`claimEscrowTransition` atômico existente (2026-07-20). Duas descobertas
novas e independentes também registradas, fora do escopo original das 7
perguntas: (a) `WDK_USDT_EVM` não tem NENHUM timeout configurado no seu
provider RPC (diferente de `SAFE_GUARD_EVM`, já remediado pelo F1) — o F1
nunca cobriu este arquivo; (b) `lockFunds()` nunca verifica um
recibo/confirmação on-chain — uma transferência que reverte on-chain mas é
aceita pelo nó (`eth_sendRawTransaction` bem-sucedido) seria hoje
registrada como um lock bem-sucedido, com um `txLockId` real, mesmo que
nenhum USDT tenha de fato se movido. Nenhuma das três descobertas foi
corrigida — nenhum mecanismo de idempotência, estado UNKNOWN, ou
verificação de recibo foi implementado ou autorizado por esta missão.
`WDK_USDT_EVM` permanece `PRODUCTION-INELIGIBLE`, inalterado. Evidência
completa, incluindo a matriz de janelas de falha (10 cenários), a análise
de nonce EVM, a árvore de chamada real rastreada linha a linha, e os
candidatos de mecanismo (não autorizados, apenas registrados para uma
futura missão): `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`. BACKLOG DELTA:
DETECTED AND SYNCED (ver `docs/BACKLOG.md`'s próprio registro correspondente).**

**CTO Gate Correction (mesmo dia, 2026-09-07) — 5 imprecisões corrigidas,
achado central preservado.** (1) O texto acima descreveu o teste como "uma
transferência externa genuinamente bem-sucedida" — impreciso: o provider foi
mockado no teste, nenhuma chamada de rede real ocorreu. Corrigido: a
orquestração real do Sails (`claimEscrowTransition` → chamada ao provider →
catch → `revertEscrowStatus` → retry) é DEMONSTRADA de verdade, não-mockada;
o efeito colateral externo em si é SIMULADO. Um segundo teste adversarial foi
adicionado (`tests/wdkLockFundsRetrySafety.test.ts`, agora 4 testes) modelando
o cenário exato de "submit then throw"/lost-response pedido pela missão: o
provider fake registra que seu efeito colateral (simulado) ocorreu e SÓ
DEPOIS lança um erro, nunca retornando um `txId` ao chamador — provando que a
mesma operação lógica alcança o provider uma segunda vez mesmo quando o
provider nunca retorna sucesso algum. Claim permitido: "Sails orchestration
demonstrates retry after a simulated post-submission unknown outcome."
Claim proibido, não feito: "real on-chain duplicate transfer" — nenhuma rede
real foi usada em nenhum teste. (2) A afirmação "`WDK_USDT_EVM` não tem
NENHUM timeout configurado" foi corrigida — o `ethers@6.17.0` instalado
define um timeout padrão de `FetchRequest` de 300000ms (5 minutos)
(confirmado por leitura direta de `node_modules/ethers/lib.commonjs/utils/fetch.js:402`),
herdado sem override específico do Sails. Classificação correta: **NO
SAILS-SPECIFIC TIMEOUT CONFIGURED**, não **UNBOUNDED RPC**. Rebaixado de
"nova descoberta independente" para observação — não abre por si só um novo
gap de produção sem uma propriedade concreta demonstrada. (3) A janela de
falha "claim FUNDS_LOCKED persistido mas o provider nunca é chamado" havia
sido tratada como impossível — incorreto: um crash pode ocorrer entre
QUAISQUER dois `await`s sequenciais, inclusive os dois dentro do próprio
corpo de `lockFunds()`; reclassificada como REPOSITORY-OBSERVED CRASH
WINDOW (raciocinada a partir da estrutura do código, não reproduzida via
kill de processo real). (4) Um restart seguido de nova chamada a
`POST .../lock` NÃO causa automaticamente uma segunda transferência quando o
escrow ficou em `FUNDS_LOCKED` sem `txLockId` — `assertEscrowTransition`
bloqueia essa chamada (agora comprovado por um teste dedicado). Dois cenários
distintos foram separados: Cenário A (crash deixa `FUNDS_LOCKED`, travado,
não retryable pelo fluxo normal) vs. Cenário B (exceção capturada + revert
para `CREATED`, genuinamente retryable — é aqui, e só aqui, que a segunda
invocação do provider pode ocorrer). (5) A afirmação de que o endereço do
escrow re-derivável mais uma janela de tempo aproximada seria "suficiente"
para reconciliação manual foi corrigida — é apenas material de correlação/
pista de busca, não uma identidade de operação durável. Estado correto:
**Durable operation identity: ABSENT / NOT DEMONSTRATED**. Candidatos
analíticos (hash de transação, `(sender, nonce, chainId)`, um
`logicalOperationId` próprio do Sails) apenas registrados, nenhum escolhido
ou autorizado. Nenhuma das correções altera o veredito final: **C —
STRUCTURAL GAP**, confirmado pelo CTO. Evidência completa corrigida:
`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`.**

**Remediation (Bounded Remediation, WDK Fund-Moving Safety, 2026-09-08).**
O achado acima permanece verbatim — esta nota registra o que foi
construído contra ele, não uma reescrita. Uma nova camada de execution
truth local ao provider (`wdk-execution-truth.ts` +
`wdk-transfer-attempt-repository.ts`, novo modelo Prisma
`WdkTransferAttempt`) agora envolve `lockFunds()` (e, no mesmo pass,
`releaseFunds()`/`refundFunds()`/`splitFunds()` — ver #58's própria nota
paralela): antes de cada `transfer()` real, identidade durável é
persistida (Property A); um outcome `SUBMITTED`/`SUBMISSION_UNKNOWN`
anterior bloqueia uma nova submissão até reconciliação real via
`getTransactionReceipt()` (Property B); sucesso econômico só é declarado
após um recibo real com `status===1`, nunca por um hash apenas retornado
(Property C). Evidência: `tests/wdkExecutionTruth.test.ts` (11 testes,
provider real, apenas conta WDK e banco mockados) demonstra bloqueio de
retry cego, recibo revertido nunca vira sucesso, e reuso durável de um
attempt travado em `PREPARED` após um crash simulado — sem depender de
estado em memória. Suíte de regressão completa (9 suites, 197 testes)
passa sem alteração, incluindo o teste original de #56
(`tests/wdkLockFundsRetrySafety.test.ts`), que permanece válido como
descrição do comportamento de `escrow.service.ts` (camada não alterada) —
a nova proteção vive uma camada abaixo, dentro do provider real.
Residuais explicitamente registrados, não corrigidos: classificação
pré/pós-submissão permanece conservadora (todo throw após `PREPARED` vira
`SUBMISSION_UNKNOWN`, mesmo quando genuinamente pré-submissão);
`SUBMISSION_UNKNOWN` não tem reconciliação automática (requer operador);
apenas 1 confirmação, não profundidade N; janela de poll de recibo
limitada (~30s por padrão); `chainId` não populado; **migração Prisma
(`prisma/migrations/20260908000000_wdk_transfer_attempt`) validada
localmente apenas via `prisma validate`/`prisma generate` (nenhum Postgres
acessível nesta sessão) — mas o próprio workflow de CI (`build`/`test`,
Postgres efêmero real) rodou `prisma migrate deploy` contra esta migração
exata e passou, DEMONSTRANDO que ela aplica corretamente contra um
Postgres real** (nenhum teste ainda exercita as próprias queries de
`WdkTransferAttempt` contra esses dados reais). `WDK_USDT_EVM` permanece
`PRODUCTION-INELIGIBLE`, inalterado — esta remediação fecha um bloqueador
de propriedade, não constitui uma revisão de elegibilidade de produção.
Evidência completa: `docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §22.

**CTO Gate Correction (2026-09-08).** Um gap real na remediação acima — a
janela de crash `PREPARED → transfer() → SUBMITTED` — foi encontrado e
fechado (`markSubmissionAttempted()`, reaproveitando o status
`SUBMISSION_UNKNOWN` existente, escrito de forma durável imediatamente
antes de cada `transfer()`, sem novo status/schema/worker). Comparação de
amount corrigida de ponto-flutuante para string decimal exata. 2 novos
testes adversariais + extensão do teste `REVERTED` existente
(`tests/wdkExecutionTruth.test.ts`, 13 testes). Detalhe completo:
`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §22.1. Nenhum novo BACKLOG
DELTA — correção de uma remediação já registrada, não um achado novo.

### 57. Falhas de `buildApp()` sob carga paralela do Jest — evidência de confiabilidade do harness de testes não conclusiva (CTO Gate Follow-up sobre F8, 2026-09-07)

**Classificação: novo delta de backlog / confiabilidade de sistema de
engenharia / qualidade de evidência do harness de testes. Não é uma
regressão do F8** — descoberto durante a validação do F8, mas é um
achado independente sobre o comportamento do harness de testes sob
carga, não sobre o código do F8 em si.

**Propriedade em risco:** uma execução completa da suíte de testes deve
falhar porque código está errado, não porque bootstraps de aplicação
não relacionados excedem orçamentos de tempo sob contenção paralela.

**Achado (fato atual, sem sobre-afirmar em nenhuma direção):** durante
a validação do F8, a suíte completa do Jest sob carga paralela produziu
10 suites não-relacionadas ao F8 falhando (`cors.test.ts`,
`healthLiveReady.test.ts`, `metrics.test.ts`, `securityHeaders.test.ts`,
`fullTradeLifecycle.test.ts`, `joinTradeAuthorization.test.ts`,
`liquidityDiscoverPagination.test.ts`, `proofBundleAccess.test.ts`,
`settlementReadAccess.test.ts`, `suspiciousActivityWiring.test.ts`),
todas com o mesmo sintoma: `beforeAll()`'s `buildApp()` excedendo o
timeout de hook de 30s. Todas as 10 passaram de forma limpa quando
re-executadas isoladamente (`--runInBand`, 86/86 testes). Esse mesmo
padrão já havia aparecido em forma menor em missões anteriores desta
sessão (historicamente citado como "6 suites conhecidas de registro do
swagger-ui flakando sob carga paralela") e agora apareceu em mais
suites.

**Não se afirma:** que a causa raiz é definitivamente o registro do
Swagger/OpenAPI — essa é uma hipótese suportada por observação de
tempo, não um fato arquitetural comprovado. Também não se afirma que a
suíte de CI (que roda sob topologia diferente) reproduz a mesma
distribuição de tempo observada localmente.

**Verdade atual, explícita:**
- as suites afetadas passam isoladamente;
- o CI do PR pode ainda passar normalmente;
- o comportamento local da suíte completa sob paralelismo não é
  determinístico o suficiente para servir como evidência forte e
  independente de regressão;
- a causa raiz não está provada;
- a hipótese de contenção em `swagger-ui`/`buildApp()` é suportada por
  timing observado, não é ainda um fato arquitetural.

**Sete perguntas de investigação futura, nenhuma respondida aqui, nenhuma
por suposição:**

1. Por que `buildApp()` ultrapassa 30s apenas sob carga paralela de
   suites, não isoladamente?
2. O registro do Swagger/OpenAPI é o custo dominante ou apenas
   correlacionado?
3. Inicialização de DB/bootstrap/módulo contribui de forma relevante?
4. A construção repetida da aplicação entre workers do Jest é
   desnecessária?
5. O CI reproduz a mesma distribuição de tempo observada localmente?
6. Uma fronteira de bootstrap exclusiva para testes reduziria a
   contenção sem mascarar um custo real de inicialização?
7. A correção correta é de implementação, de configuração do harness,
   ou de arquitetura de testes?

**Fix recomendado (propriedade, não mecanismo):** nenhum prescrito
aqui — as 7 perguntas acima precisam de investigação dedicada antes de
qualquer decisão de implementação. Explicitamente NÃO autorizado por
este registro: aumentar o timeout do Jest às cegas, reduzir workers às
cegas, desabilitar suites, pular testes, remover o Swagger, adicionar
retries, mudar a topologia de CI, ou criar um novo framework de teste.

**Não corrigido por este registro. Nenhum mecanismo criado. Nenhuma
mudança de configuração de Jest/CI feita ou autorizada por este
registro.**

**Nota de desambiguação (2026-09-08).** Uma missão CTO rotulada
"Test-Harness Reliability #57" investigou e fechou um achado
GENUINAMENTE DIFERENTE — a colisão de Haste module map causada por
`.claude/worktrees/` (registrada como item **#59** abaixo, novo, não
uma correção deste item). As 7 perguntas acima sobre contenção
`buildApp()`/Swagger sob carga paralela permanecem inteiramente
abertas, não respondidas por esta nota nem pela missão que a originou.
Nesta sessão específica, ao re-executar `npm run test:unit` durante a
investigação de #59, nenhuma das 10 suites historicamente citadas
falhou pelo sintoma deste item (dado observacional de uma única
execução, não uma prova de que a causa raiz deste item deixou de
existir — timing sob paralelismo é, pela própria natureza deste
achado, não-determinístico). Full evidence do achado #59:
`docs/TEST_HARNESS_RELIABILITY.md`.

**CAUSA RAIZ DEMONSTRADA (2026-09-10, missão dedicada de discovery).**
Reprodução controlada e direta, não assumida: rodando as mesmas 10
suites historicamente citadas juntas, `--maxWorkers=10`, com Postgres/
Redis locais **inacessíveis** (`localhost:5432`/`localhost:6379`
recusando conexão, condição padrão neste ambiente até então): **9/10
falharam**, cada uma em `beforeAll()`'s `buildApp()`, 84-110s (excedendo
o timeout de 30s em até 3.7x); com `--runInBand` (serial), as mesmas 10
suites: **10/10 passaram, 86/86 testes, 73.1s** — reprodução exata do
sintoma original. Curva de dose-resposta direta por contagem de
workers: 1 worker → 0 falhas/73.1s; 2 workers → 2 falhas/95.4s; 10
workers → 9 falhas/127.4s.

Uma evidência causal direta e adicional foi capturada: múltiplas suites
falhas logaram `ReferenceError: You are trying to require a file after
the Jest environment has been torn down... at fastifySwaggerUi
(node_modules/@fastify/swagger-ui/index.js:14:28)` — essa linha é
`await fsPromises.readFile(...)`, uma leitura de disco assíncrona real
dentro do registro do `@fastify/swagger-ui`, ainda em andamento quando
o Jest já havia encerrado o ambiente do teste. Isso confirma
**Swagger-ui como causa real, não apenas correlacionada** — mas um
experimento de ablação isolado (Redis com `lazyConnect: true`,
diagnóstico, revertido) NÃO eliminou as falhas (9/10 ainda falharam,
tempo total até piorou), indicando que Swagger sozinho não era a causa
dominante.

**Correção decisiva, 2026-09-10 (mesma sessão, descoberta posterior):**
subindo um Postgres local real (`npm run db:local:start`,
`scripts/local-postgres.js`, via `pg_ctl` nativo) e um Redis-compatível
real (`node scripts/local-redis.js start`, Memurai) — ambos scripts
já existentes neste projeto, nunca utilizados durante a investigação
original — e re-executando o EXATO mesmo experimento das 10 suites:
**`--maxWorkers=10`: 10/10 passaram, 86/86 testes, 31.2s.
`--maxWorkers=15`: 10/10 passaram, 86/86 testes, 19.1s — mais rápido
com MAIS paralelismo**, o padrão oposto e esperado quando não há
contenção real. **Isso demonstra que a causa dominante era Postgres/
Redis inacessíveis** (`new Redis(url)` conecta e tenta reconectar
imediatamente no import do módulo, `PrismaPg`/`PrismaClient` são
construídos no import de `common/database`), não o worker count em si
nem o Swagger isoladamente — sob N processos paralelos, cada um
importando `buildApp()` e tentando (e falhando) conexões reais de
rede/DB repetidamente, o event loop de cada worker fica sob pressão
suficiente para que `beforeAll()` estoure 30s ocasionalmente. O
achado do Swagger-ui (acima) permanece real e válido como um segundo
fator contribuinte genuíno, apenas não dominante isoladamente.

**Classificação final: causas múltiplas interagindo, com Postgres/
Redis inacessíveis como fator dominante confirmado por experimento
direto (antes/depois) e Swagger-ui como fator contribuinte confirmado
por evidência causal direta (stack trace).** Nenhuma correção de
código foi implementada nesta passada — o achado é que rodar a suíte
com um banco/Redis local reais (mecanismo já existente no projeto)
elimina o sintoma por completo nas 10 suites históricas, sem qualquer
mudança de timeout, worker count ou arquitetura de teste.

**CTO Gate Correction (2026-09-10) — construction ≠ connection ≠ query;
combined ablation ≠ individual attribution.** A conclusão causal acima
superestimava o que o código real faz. Os NÚMEROS medidos (9/10 falhas
a 10 workers com infra inacessível, 0/10 falhas a 10 e 15 workers com
infra reachable, evidência de stack trace do Swagger-ui, resultado do
diagnóstico `lazyConnect`) permanecem válidos e não são revisados por
esta nota — apenas a interpretação causal é corrigida, por releitura
direta do código-fonte atual, não por suposição:

- **Redis (`src/common/redis/index.ts:14`)**: `export const redis = new
  Redis(config.redis.url, {...})` no escopo de módulo, sem
  `lazyConnect: true` — o `ioredis` por padrão inicia a tentativa de
  conexão TCP imediatamente na construção. **Isto é conexão eager real,
  diretamente evidenciada pelo código-fonte.** Esta parte da alegação
  original está correta.
- **Postgres/Prisma (`src/common/database/index.ts:24,28-33,39-42`)**:
  `new PrismaPg({connectionString})` e `new PrismaClient({adapter,
  log})` no escopo de módulo são **construção de objeto, não conexão de
  rede** — nem o `pg.Pool` que `PrismaPg` envolve nem o query engine do
  Prisma abrem socket na construção. A conexão real só ocorre em
  `prisma.$connect()`, chamado exclusivamente dentro de
  `connectDatabase()`, que por sua vez só é chamado por `startServer()`
  (`src/app.ts:371-372`) — **nunca por `buildApp()`**, confirmado por
  leitura direta (`grep` de `connectDatabase\|connectRedis` em
  `src/app.ts`: únicas ocorrências nas linhas 371-372, dentro de
  `startServer()`). Nenhuma das 13 chamadas de teste reais a
  `buildApp()` passa por `startServer()`. A frase original "PrismaPg/
  PrismaClient são construídos no import... conecta eagerly" conflava
  construção com conexão — **corrigido: PrismaPg/PrismaClient são
  construídos no import; a conexão real não é evidenciada como eager
  para o caminho `buildApp()`-apenas que estas suites exercitam.**

- **Auditoria de mocking (achado adicional, não solicitado pela missão
  original de discovery, encontrado ao verificar a alegação acima
  contra o código real das 10 suites):** das 10 suites históricas,
  **10/10 fazem `jest.mock('../src/common/database', ...)`** (9 de
  forma estática + `healthLiveReady.test.ts` via `jest.doMock()` por
  teste) e **9/10 também fazem `jest.mock('../src/common/redis', ...)`**
  — apenas `fullTradeLifecycle.test.ts` deixa o módulo real de Redis
  ativo. Como `jest.mock()` substitui o módulo inteiro no registro de
  módulos do Jest para qualquer importador subsequente dentro daquele
  arquivo de teste — incluindo `src/app.ts`, que importa
  `common/database`/`common/redis` no escopo de módulo — **o `new
  Redis(...)` e o `new PrismaPg(...)`/`new PrismaClient(...)` reais
  nunca executam dentro de 9 das 10 suites (e o Prisma real nunca
  executa em nenhuma das 10).** Isso significa que "esta suite tenta
  conectar e falha" não pode ser o mecanismo mecânico de por que 9/10
  destas suites especificamente falharam com Postgres/Redis
  inacessíveis — o módulo real nem é carregado nelas. Consistente com
  isto: o diagnóstico `lazyConnect: true` em Redis não eliminou as
  falhas — resultado esperado se 9 das 10 suites nem carregam o módulo
  Redis real para começar, então mudar sua config não poderia afetá-las.

- **Consequência para a classificação — combined ablation ≠ individual
  attribution:** a melhoria de 9/10→0/10 falhas ao subir Postgres/Redis
  locais reais permanece um fato medido e real, não contestado por esta
  nota. Mas o experimento subiu AMBOS juntos — não isola a contribuição
  marginal de cada um — e o MECANISMO pelo qual isso beneficiou as 9
  suites que mockam ambos os módulos não está isolado nem demonstrado.
  Hipótese plausível, explicitamente rotulada como especulativa e NÃO
  testada: efeito de sistema/processo cruzado — outras suites não
  citadas aqui, rodando em OUTROS workers paralelos do mesmo `npm run
  test:unit` (não mockadas, tentando conexões reais repetidas contra
  Postgres/Redis inacessíveis) — poderiam gerar contenção de CPU/rede/
  timers a nível de sistema operacional que atrasa `beforeAll()` em
  processos irmãos, incluindo os das 10 suites nomeadas. Não comprovada
  nesta nota.

**Reclassificação (substitui a "Classificação final" acima; números
medidos preservados sem revisão):**

> A falha histórica é um fenômeno multi-fator de ambiente de teste/
> bootstrap. Infraestrutura local inalcançável amplifica materialmente
> a assinatura de falha de `buildApp()` sob paralelismo. O
> comportamento de conexão/retry eager do Redis é diretamente
> evidenciado pelo código-fonte, mas só é mecanicamente exercitado por
> 1 das 10 suites históricas (as outras 9 mockam o módulo inteiro). A
> contribuição marginal de Postgres versus Redis — e o mecanismo exato
> pelo qual a alcançabilidade de infraestrutura afeta suites que mockam
> ambos os módulos — não foi isolada. Swagger-UI é demonstrado
> independentemente como um custo real de registro assíncrono e fator
> contribuinte, mas não provado dominante.

**Item #57 permanece ABERTO / parcialmente compreendido — não CLOSED.**
Nenhuma correção de código foi feita por esta nota (correção de
registro/interpretação apenas, mesma disciplina de "Corrigido/
Implementado [data]" já usada neste arquivo).

**CTO Gate Correction (2026-09-10, rodada 2) — retratação da hipótese
cross-worker inválida + precisão causal do Swagger-UI.** Duas
inconsistências de claim-integrity na rodada 1 acima, corrigidas por
releitura da própria evidência já coletada (nenhum experimento novo
executado ou exigido):

- **Hipótese cross-worker inválida, retratada.** A rodada 1 propôs
  "outras suites não citadas aqui, rodando em OUTROS workers paralelos
  do mesmo `npm run test:unit`" como mecanismo especulativo. Isso
  contradiz a própria evidência documentada duas seções acima: a
  "Correção decisiva" re-executou **"o EXATO mesmo experimento das 10
  suites"** (`--maxWorkers=10`/`15`, 86/86 testes — contagem que só
  bate com as 10 suites nomeadas, não com a suíte completa). Não havia
  suites-irmãs não nomeadas rodando naquele experimento específico —
  determinado a partir do comando e da contagem de testes já registrados,
  não por suposição. **Hipótese retratada, substituída pela versão
  permitida e estreita:** dentro do PRÓPRIO experimento de 10 suites,
  `fullTradeLifecycle.test.ts` é a única das 10 que exercita o módulo
  real de Redis (auditoria de mocking, rodada 1 acima); é PLAUSÍVEL —
  não comprovado — que o comportamento de conexão/retry eager do Redis
  real dentro do worker que executa `fullTradeLifecycle.test.ts`
  gere pressão de CPU/event-loop/rede suficiente para atrasar
  `beforeAll()` em processos-irmãos que executam as outras 9 suites
  (mockadas) no mesmo `--maxWorkers=10`. Rotulado explicitamente como
  hipótese não testada, não promovida a fato.

- **Precisão causal do Swagger-UI.** O stack trace (`ReferenceError...
  at fastifySwaggerUi`, linha 2112-2117 acima) prova que o
  `@fastify/swagger-ui` executa trabalho assíncrono real de bootstrap
  (`fsPromises.readFile`) e que essa operação ainda estava em andamento
  quando o Jest encerrou o ambiente — ou seja, **aparece no caminho de
  falha observado**. Isso NÃO prova, por si só, que o Swagger-UI causou
  o timeout, nem que contribuiu materialmente para ele — a própria
  operação assíncrona pode ter sido atrasada por uma fonte de contenção
  subjacente diferente (ex.: a mesma pressão de sistema do parágrafo
  acima). As frases "confirma **Swagger-ui como causa real, não apenas
  correlacionada**" (texto original, 2026-09-10) e "Swagger-ui como
  fator contribuinte confirmado por evidência causal direta (stack
  trace)" (Classificação final, texto original) e "Swagger-UI é
  demonstrado independentemente como um custo real de registro
  assíncrono e fator contribuinte" (Reclassificação, rodada 1 acima)
  superestimavam o que o stack trace prova. **Substituídas por:**
  Swagger-UI é demonstrado como um custo real de bootstrap assíncrono e
  aparece no caminho de falha observado; sua contribuição causal
  marginal para o timeout não foi isolada. Isto não invalida a
  remediação bounded do PR #115 (`docs/TECHNICAL_DEBT_AUDIT.md` #57,
  nota de remediação Swagger-UI) — testes que não precisam do Swagger UI
  não deveriam registrá-lo continua sendo uma justificativa
  arquitetural válida por si só, independente da causalidade do timeout
  histórico, e a cobertura de regressão explícita (`tests/
  swaggerUiRegistration.test.ts`) protege o caminho real do `/docs`.

**Declaração final de causa-raiz (substitui a "Reclassificação" da
rodada 1; números medidos preservados sem revisão em ambas as
rodadas):**

> TD #57 é um fenômeno de confiabilidade de teste/bootstrap paralelo
> multi-fator. A falha histórica sensível a worker count é reproduzível.
> Tornar a infraestrutura local alcançável se correlaciona com/altera
> experimentalmente o resultado da falha sob a configuração testada, mas
> o mecanismo não está isolado. A maioria das suites nomeadas mocka
> database e Redis por completo. O comportamento de conexão eager do
> Redis existe no código de produção, mas apenas 1 das 10 suites
> nomeadas exercita mecanicamente o módulo real de Redis. A construção
> do Prisma não é uma conexão de rede eager em `buildApp()`. O
> Swagger-UI executa trabalho real de bootstrap assíncrono e aparece no
> caminho de falha observado, mas sua contribuição causal marginal não
> foi isolada.

**Backlog: nenhum item novo criado ou recomendado por esta nota.** O
item #57 já é o dono desta pergunta em aberto — não há obrigação
duplicada a registrar.

**Bounded Remediation (Swagger-UI Test Bootstrap, PR #115, 2026-09-10).**
Escopo estritamente limitado à Pergunta 2 do achado original acima ("o
registro do Swagger/OpenAPI é o custo dominante ou apenas
correlacionado?"). PR #114 (mesclado, commit `0953da1`) e suas duas
rodadas de CTO Gate Correction acima estabeleceram que TD #57
permanece um fenômeno de confiabilidade de teste/bootstrap paralelo
multi-fator cujo mecanismo exato não está isolado — esta remediação
bounded **não afirma resolver esse fenômeno completo**; ela remove o
trabalho de bootstrap do Swagger-UI dos chamadores de teste que não o
exercitam, mantendo cobertura dedicada para o caminho real/default de
documentação.

`@fastify/swagger` (gerador de spec OpenAPI, registro sem custo
relevante, usado por todo schema de rota) e `@fastify/swagger-ui`
(servidor real de `/docs`, cujo próprio `index.js:14` faz um
`fs.readFile` assíncrono real do `logo.svg` a cada registro —
demonstrado acima como custo real de bootstrap assíncrono que aparece
no caminho de falha observado, contribuição causal marginal NÃO
isolada) são arquiteturalmente distintos. Fix implementado: nova opção
aditiva `BuildAppOptions.registerSwaggerUi` (`src/app.ts`), default
`true` (comportamento de `startServer()` e de qualquer chamador que
omita a opção fica byte-idêntico ao anterior). Classificação dos ~18
arquivos de teste que mencionam `buildApp` feita por evidência, não por
comentário: apenas 13 realmente chamam `buildApp()`; busca direta
(`grep`) confirmou **zero** asserções contra `/docs`/`/documentation`
em todo `tests/` antes desta mudança — logo os 13 são Classificação C e
foram atualizados para `{ registerSwaggerUi: false }` em seus call
sites reais. Gap de cobertura real fechado:
`tests/swaggerUiRegistration.test.ts` (novo) é o primeiro teste deste
repositório a de fato afirmar que `/docs` é servido por padrão, que a
opção de opt-out o remove, e que `@fastify/swagger` continua gerando a
spec OpenAPI corretamente em ambos os modos.

**Evidência adversarial pós-rebase (mesmo protocolo de 10 suites/1-2-10
workers desta entrada, Postgres+Redis locais reais e alcançáveis
durante a coleta, re-executado após o rebase sobre `main` pós-#114):**
1 worker (`--runInBand`) — 10/10 suites, 86/86 testes, 11.8s. 2
workers — 10/10 suites, 86/86 testes, 10.4s. 10 workers — 10/10 suites,
86/86 testes, 24.6s. Regressão completa (`npm run test:unit`): **156/156
suites, 2006/2006 testes, zero falhas** — melhor que o 155/156 relatado
antes do rebase; a falha anterior em `tests/integration/docker.test.ts`
não se reproduziu nesta execução, consistente com o próprio CI (que já
havia passado no mesmo teste Docker duas vezes nas rodadas de PR #114).

**Condição de infraestrutura durante esta coleta, registrada com
precisão:** Redis local real esteve alcançável. Postgres local real
ficou indisponível durante parte desta sessão por um crash real e
pré-existente do `embedded-postgres` no Windows (worker de autovacuum
terminado por `exception 0xC0000142`, mesma classe do incidente já
registrado em memória de sessão de 2026-07-31) — irrelevante para
estas 10 suites especificamente, já que a auditoria de mocking (achado
do #114 acima) confirma que as 10 mockam `common/database` por
completo; nenhuma delas precisa de Postgres real para passar.

**Dado adicional, não solicitado, observado durante esta coleta:**
`tests/swaggerUiRegistration.test.ts` isolado, `--runInBand` (zero
paralelismo), reproduziu na primeira tentativa o exato
`ReferenceError: You are trying to require a file after the Jest
environment has been torn down... at fastifySwaggerUi
(@fastify/swagger-ui/index.js:14)` histórico — enquanto processos
`postgres.exe` presos num loop de crash/reinicialização (do incidente
acima) ainda consumiam recursos do sistema em segundo plano. Após
encerrar esses processos presos, a mesma suite isolada passou 3/3 em
5.4s. Dado real, não re-executado múltiplas vezes para confirmar
robustez estatística, mas diretamente relevante à pergunta de
Correction 3: é consistente com contenção de recursos a nível de
sistema (não contagem de workers do Jest) sendo capaz de disparar esta
race mesmo em execução única, sem paralelismo — apoia, sem provar, a
hipótese de que o Swagger-UI "aparece no caminho de falha" sob
condições de pressão de sistema mais amplas que apenas worker count.

**Perguntas de investigação, status (cross-referenciado a PR #114
mesclado, `0953da1`, não duplicado aqui):**
1. Ainda ABERTA — ver achado #114/CTO Gate Correction acima.
2. Refinada — Swagger-UI é demonstrado como custo real de bootstrap
   assíncrono e aparece no caminho de falha observado; contribuição
   causal marginal não isolada (ver "Precisão causal do Swagger-UI",
   CTO Gate Correction rodada 2 acima).
3. Respondida parcialmente — infraestrutura alcançável altera o
   resultado experimentalmente, mas o mecanismo não está isolado (ver
   #114 acima); não se afirma dominância de Postgres/Redis isoladamente.
4. Fora do escopo desta missão — nenhum refactor de singleton
   Prisma/Redis ou fronteira de bootstrap compartilhada foi autorizado
   ou feito.
5. Não verificada nesta remediação.
6. Parcialmente respondida — a nova opção é exatamente essa fronteira,
   e não mascara custo real: `@fastify/swagger` permanece incondicional,
   e `tests/swaggerUiRegistration.test.ts` prova que ambos os modos
   continuam corretos.
7. Respondida para a fatia Swagger-UI — correção de implementação
   (opção aditiva em `buildApp()`), não de configuração de Jest/CI nem
   de arquitetura de testes.

**Status: PARCIALMENTE REMEDIADO (bounded) — candidata a FREEZE, evidência
sobreviveu ao rebase pós-#114 verificada em 2026-09-10 (0/10 falhas em
1/2/10 workers, regressão completa 156/156, `tsc --noEmit` limpo,
`swaggerUiRegistration.test.ts` 3/3).** A propriedade estreita demonstrada é
"`buildApp()` não registra mais `@fastify/swagger-ui` em nenhum dos 13
call sites de teste Classificação C, sem perda de cobertura." Não se
afirma "contenção de `buildApp()` sob carga paralela resolvida" de
forma genérica. Nenhuma mudança de timeout do Jest, de contagem de
workers, retries, ou remoção global de Swagger/OpenAPI foi feita ou
autorizada — consistente com os limites explícitos desta missão.

**TD #57 (o fenômeno mais amplo): permanece ABERTO / parcialmente
compreendido — não CLOSED.** Distinto da remediação bounded do
Swagger-UI acima: TD #57 em si não é fechado por este item; apenas a
fatia estreita do registro de Swagger-UI em testes é tratada.

**CTO Gate FREEZE (2026-09-10).** PR #115 (`registerSwaggerUi`, HEAD
`1509690`) aprovado e mesclado — commit de merge `8e12ffa`. Um último
overclaim causal foi encontrado e corrigido antes do freeze: o
comentário de `BuildAppOptions` em `src/app.ts` dizia que o Swagger-UI
"is the demonstrated, measured-expensive boundary" e que seu registro
"is what produced the demonstrated worker-count-driven contention" —
excedia a fronteira de evidência congelada acima; corrigido para
"performs real asynchronous bootstrap work and appears on the observed
TD #57 failure path... marginal causal contribution... not isolated"
(mesma correção replicada em dois comentários equivalentes em
`tests/cors.test.ts`/`tests/securityHeaders.test.ts`). Mudança
comment-only, zero diff funcional, verificado por diff completo antes
do merge.

**Status final: remediação bounded do Swagger-UI (PR #115) —
CLOSED/FROZEN.** A propriedade estreita demonstrada e agora congelada é
"`buildApp()` não registra mais `@fastify/swagger-ui` em nenhum dos 13
call sites de teste Classificação C, sem perda de cobertura, com
`tests/swaggerUiRegistration.test.ts` protegendo o caminho real de
`/docs`." **TD #57, o fenômeno mais amplo de confiabilidade de
teste/bootstrap paralelo, permanece explicitamente ABERTO / parcialmente
compreendido — NÃO fechado por este freeze.** Nenhuma alegação de causa
raiz completa foi feita ou é autorizada por esta nota.

### 58. `WDK_USDT_EVM`'s `releaseFunds()`/`refundFunds()`/`splitFunds()` — sweep de segurança de fund-moving operations, veredito por método (2026-09-08)

**Classificação: investigação de produção-safety, obrigação derivada de
#56 (`docs/BACKLOG.md`'s "WDK Fund-Moving Operations Safety Sweep",
registrada 2026-09-08). Estende #56 (que cobriu apenas `lockFunds()`) às
três outras chamadas auto-iniciadas de `transfer()` real do mesmo
provider.**

**Achado, com evidência real (não suposição):** as três chamadas
compartilham exatamente a mesma forma estrutural de `escrow.service.ts`
que `lockFunds()` já tinha (claim atômico antes da chamada ao provider,
`catch` que reverte incondicionalmente o status em qualquer falha). Um
novo teste adversarial real (`tests/wdkFundMovingOperationsSafety.test.ts`,
7 testes, orquestração real e não-mockada, efeito colateral externo
sempre SIMULADO — nenhuma chamada de rede real em lugar nenhum) demonstra,
para `releaseFunds()` e `refundFunds()`, o mesmo padrão exato de
"submit then throw" que #56 já demonstrou para `lockFunds()`.
`splitFunds()` carrega um achado adicional e independente: seu provider
(`wdk-settlement.provider.ts`) faz DUAS chamadas `transfer()` sequenciais
e não-atômicas, sem canal de resultado parcial — um teste demonstra que
o sucesso (simulado) da perna 1 seguido de uma falha na perna 2 nunca
persiste nada (nem a perna 1), e um retry subsequente repete o efeito
colateral (simulado) da perna 1 uma segunda vez; um segundo teste
demonstra que a perna 2 também ter seu próprio efeito colateral simulado
antes de lançar erro produz o EXATO MESMO resultado observável para
`escrow.service.ts` — ou seja, **o Sails não consegue distinguir "a perna
2 nunca foi tentada" de "a perna 2 foi tentada e seu resultado se
perdeu."**

**Vereditos por método, não forçados a um resultado uniforme:**
- `releaseFunds()`: **C — gap estrutural demonstrado**
- `refundFunds()`: **C — gap estrutural demonstrado**
- `splitFunds()`: **C — gap estrutural demonstrado**, estritamente maior
  que os outros dois (carrega também o gap de execução parcial multi-leg)
- Receipt/confirmação (Property C, transversal às quatro chamadas
  incluindo `lockFunds()`): **C — gap estrutural demonstrado** — nenhuma
  das quatro chamadas espera ou verifica um recibo on-chain

**Nova superfície de retry registrada:** `dispute.service.ts`'s
`applyRuling()` reverte `ruling`/`resolvedAt` para `null` em qualquer
falha de release/refund/split, com seu próprio comentário afirmando "the
arbiter must re-submit" — um "dispute resolution replay" real e
documentado, distinto das superfícies HTTP/auto-settle que #56 já havia
registrado (`splitFunds()` não tem rota HTTP direta — só é alcançável via
ruling de disputa).

**Não se afirma:** "fundos definitivamente duplicados", "double payment
real", ou "perda parcial real" — nenhum teste ao vivo foi executado.
Claim permitido e demonstrado: "Sails orchestration permits a repeated
provider invocation after a simulated post-submission unknown outcome"
e, para `splitFunds()`, "Sails orchestration permits partial simulated
multi-leg execution without durable knowledge sufficient to safely
resume."

**Fix recomendado (propriedade, não mecanismo):** nenhum prescrito aqui —
nenhum mecanismo de idempotência, journal de operação, polling de recibo,
reserva de nonce, motor de reconciliação, máquina de estados por perna,
transação de compensação, bundler, multicall, split atômico via
smart-contract, middleware de retry, ou framework genérico de operação
econômica foi criado ou autorizado. Propriedade primeiro, mecanismo
depois — mesma disciplina de #56.

`WDK_USDT_EVM` permanece `PRODUCTION-INELIGIBLE`, inalterado. Evidência
completa: `docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md`.

**Não corrigido por este registro. Nenhum mecanismo criado. Nenhuma
mudança de comportamento em `releaseFunds()`/`refundFunds()`/
`splitFunds()`/`escrow.service.ts` feita ou autorizada por este
registro.**

**Remediation (Bounded Remediation, WDK Fund-Moving Safety, 2026-09-08).**
Os vereditos acima permanecem verbatim. A mesma camada de execution truth
descrita na nota de remediação de #56 agora envolve `releaseFunds()` e
`refundFunds()` identicamente, e `splitFunds()` foi redesenhado ao redor
dela para Property D (Safe Multi-Leg Resume): as pernas buyer/seller são
rastreadas como duas operações lógicas independentes
(`SPLIT_BUYER`/`SPLIT_SELLER`, linhas `WdkTransferAttempt` separadas) — a
perna seller nunca é tentada até a perna buyer ter um `txHash`
confirmado por recibo real; um `CONFIRMED` anterior faz a operação
retomar (resume) sem repetir a chamada `transfer()`; um `REVERTED`
anterior permite uma nova tentativa segura da MESMA perna, sem tocar a
outra. Os 4 casos nomeados na missão original (buyer CONFIRMED + seller
não iniciado; buyer CONFIRMED + seller UNKNOWN; buyer UNKNOWN; buyer
CONFIRMED + seller REVERTED anterior) estão todos resolvidos por design,
não apenas documentados. Evidência:
`tests/wdkExecutionTruth.test.ts` (11 testes, incluindo 3 específicos de
`splitFunds()`) contra o provider real, não-mockado. Suíte de regressão
completa (9 suites, 197 testes) passa sem alteração, incluindo o teste
original de #58 (`tests/wdkFundMovingOperationsSafety.test.ts`), que
permanece válido como descrição de `escrow.service.ts` (camada não
alterada). Residuais idênticos aos registrados na nota de remediação de
#56 (não repetidos aqui para evitar duplicação/desvio entre duas cópias —
o mecanismo é o mesmo código compartilhado pelos quatro métodos).
`WDK_USDT_EVM` permanece `PRODUCTION-INELIGIBLE`, inalterado. Evidência
completa: `docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md` §15,
`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §22.

**CTO Gate Correction (2026-09-08).** A mesma correção da janela de crash
`PREPARED → transfer() → SUBMITTED` registrada na nota de remediação de
#56 se aplica identicamente aqui — `executeTransfer()` é o mecanismo
compartilhado por `lockFunds()` e pelas três chamadas deste item,
incluindo cada perna de `splitFunds()`. Detalhe completo:
`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md` §22.1,
`docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md` §15.1. Nenhum novo BACKLOG
DELTA.

### 59. Colisão de Haste module map do Jest via `.claude/worktrees/` — CLOSED (2026-09-08)

**Classificação: confiabilidade de sistema de engenharia / harness de
testes — não é uma regressão de código de produto, e não é o mesmo
achado do item #57 (contenção de `buildApp()` sob carga paralela) —
achados genuinamente distintos, ver nota de desambiguação em #57 acima.**

**Propriedade em risco:** uma execução completa da suíte de testes deve
falhar porque código está errado, não porque worktrees locais não
relacionados ou artefatos de descoberta de testes colidem.

**Achado, DEMONSTRADO por experimento controlado, não suposto:**
`.claude/worktrees/agent-*` (worktrees git reais e vinculados, deixados
por invocações anteriores da feature `isolation: "worktree"` da Agent
tool que fizeram alterações) contêm cada um um checkout completo,
incluindo seu próprio `packages/sails-sdk/package.json` — declarando o
mesmo `"name": "@satsails/p2p-trading-sdk"` do arquivo real. O
`jest-haste-map` do Jest indexa todo `package.json` sob `roots` por seu
campo `"name"`; `jest.config.js`'s `modulePathIgnorePatterns` excluía
apenas `<rootDir>/dist/` (adicionado antes para a MESMA classe exata de
problema). Confirmado por experimento direto: excluir 3 dos 4 worktrees
via flag de CLI e deixar apenas 1 ainda reproduz a colisão idêntica com
exatamente 2 candidatos — um único worktree remanescente já é
suficiente. Um segundo efeito, também confirmado por contagem direta:
cada worktree contém sua própria cópia (mais antiga) de `tests/*.test.ts`
(148 arquivos cada), que o `testMatch` do Jest também descobria como
suítes adicionais fantasmas — explicando por que o total pré-correção
era ~742 suítes (154-155 reais + 4×148 duplicatas de worktree) em vez
das 154-155 suítes reais.

**Por que o CI nunca reproduziu:** `.claude/worktrees/` é um artefato
puramente local desta máquina (nunca commitado, nunca listado em
`.gitignore` mas simplesmente nunca adicionado por ninguém) — um
checkout limpo do CI (`actions/checkout`) nunca o possui.

**Fix implementado, mínimo, localizado:** um item adicionado ao array
`modulePathIgnorePatterns` já existente em `jest.config.js`, ao lado da
entrada `dist/` pré-existente, reaproveitando o mesmo mecanismo já
estabelecido e comentado neste arquivo para a mesma classe de problema.
Nenhuma nova chave de configuração, nenhum framework novo, nenhum
worktree apagado ou movido (toda a investigação usou apenas flags de
CLI, nunca mutação do sistema de arquivos).

**Evidência antes/depois:** `npm run test:unit` antes: `442 failed, 300
passed, 742 total` suítes. Depois: **`154 passed, 154 total` suítes;
`1923 passed, 1923 total` testes — zero falhas.** Nenhuma cobertura real
perdida (Cobra Check): as 154 suítes finais correspondem quase
exatamente à contagem real de arquivos `tests/*.test.ts` (155,
verificado por busca direta no filesystem) — a redução de 742 para 154
é inteiramente explicada pelo desaparecimento das quatro duplicatas de
worktree (742 − 154 = 588 ≈ 4×148), não pela remoção de nenhum teste
real.

**Residual, não corrigido:** a razão interna exata pela qual o
`moduleNameMapper` de `jest.config.js` (que já mapeia
`@satsails/p2p-trading-sdk` explicitamente) não previne esta colisão
específica é INFERIDA, não rastreada até o código-fonte do
`jest-resolve`/`jest-haste-map` — não enfraquece a correção (que remove
os provedores duplicados independentemente da ordem interna do
resolver), mas é um detalhe de mecanismo não totalmente compreendido,
registrado como tal. `.claude/` ainda não está em `.gitignore` (achado
lateral, não corrigido neste registro, fora do escopo desta
investigação). Um checkout limpo em outro local não foi reproduzido
(julgado sem necessidade dado o próprio CI já servir como evidência
real repetida de "zero worktrees presentes").

**Não é o item #57.** As 7 perguntas de #57 sobre contenção
`buildApp()`/Swagger sob carga paralela permanecem totalmente abertas,
não respondidas por este item.

Evidência completa: `docs/TEST_HARNESS_RELIABILITY.md`.

### 60. `docs/CRYPTOGRAPHIC_MODEL.md` §1 — claim desatualizada sobre identidade Pears/HyperDHT — CLOSED (encontrado 2026-09-08, Identity Architecture Discovery; corrigido 2026-09-08, Institutional Cold Sweep)

**Classificação: current-truth documentation drift, não uma nova
vulnerabilidade de segurança.** Descoberto de passagem durante a
missão Identity Architecture Discovery (`docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`
§2) — não era o objetivo da investigação, mas apareceu diretamente ao
verificar o modelo de identidade atual do Sails contra o código real.

**Achado:** `docs/CRYPTOGRAPHIC_MODEL.md` §1 (escrito 2026-07-19) ainda
afirma: *"the same keypair IS the node's HyperDHT/Hyperswarm identity
(`infrastructure/p2p/pear.service.ts`'s `PearNode.start(secretKeyHex)`;
the derived `peerId` is literally `publicKey.toString('hex')`). There
is no separate 'network key' — this is one primitive, not two,
confirmed by grep."` Isso não é mais verdade. O fix de custódia de
chave de `pear.service.ts` (2026-08-09), já corretamente divulgado em
`docs/TRUST_BOUNDARY.md` Boundary 1b e em `docs/BACKLOG.md` (entrada de
2026-09-06), mudou `PearNode.start()` para não receber nenhuma chave do
caller — `async start(): Promise<string>` (verificado diretamente,
`src/infrastructure/p2p/pear.service.ts:119-123`) não tem argumentos e
chama `HyperDHT.keyPair()` sem seed, gerando um par de chaves novo e
efêmero a cada sessão, nunca persistido. Consequência dupla, confirmada:
(1) `User.peerId` é hoje criptograficamente independente de
`User.publicKey` — não é mais "um primitivo, não dois", é literalmente
dois; (2) `peerId` nem sequer é estável entre sessões hoje — é
regenerado a cada `start()`.

**Por que isso não foi pego antes:** `docs/TRUST_BOUNDARY.md` e
`docs/BACKLOG.md` já corrigiram a mesma informação em seus próprios
contextos (2026-09-06) — mas `docs/CRYPTOGRAPHIC_MODEL.md` §1, o
documento que originalmente fez a afirmação "one primitive, not two",
nunca recebeu a correção correspondente. Um exemplo real de uma
correção não se propagar para todos os documentos que repetem a mesma
claim.

**Não corrigido pelo registro original** — fora do escopo daquela
missão de discovery (sem implementação/edição de documentos além do
próprio `docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`).

**Correção aplicada (2026-09-08, Institutional Cold Sweep / Production
Readiness).** `docs/CRYPTOGRAPHIC_MODEL.md` §1 recebeu uma nota
"Corrigido/Current-truth update (2026-09-08)" datada, preservando o
texto original de 2026-07-19 verbatim acima dela — não uma edição
silenciosa. A nota declara corretamente o estado atual: identidade
econômica = `User.publicKey`; identidade de transporte = `User.peerId`,
uma chave Ed25519 separada e efêmera; a associação entre as duas é
server-mediated (linha de banco de dados, verificada por
`verifyHandshakeIdentity()`), não um vínculo criptográfico
independente; a chave Pears não está hoje criptograficamente vinculada
à identidade do participante. Aponta para `docs/TRUST_BOUNDARY.md`
Boundary 1b como a fonte já corrigida. Não resolve a arquitetura de
identidade em si (isso permanece rastreado separadamente em
`docs/BACKLOG.md`'s "Identity Root & Multi-Protocol Identity UX" e
`docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`) — apenas corrige o drift de
documentação.

**Status: CLOSED.** A documentação está consistente entre
`docs/CRYPTOGRAPHIC_MODEL.md`, `docs/TRUST_BOUNDARY.md`, e
`docs/BACKLOG.md`.

Evidência completa: `docs/IDENTITY_ARCHITECTURE_DISCOVERY.md` §2;
correção em `docs/CRYPTOGRAPHIC_MODEL.md` §1.


### 61. Public OfferDetail returns raw `paymentDetails` + broad participant row — OPEN (found 2026-09-09, Day-0 Completeness Cold Sweep)

> **Nota de clarificação (2026-11-11).** O `OPEN` deste cabeçalho registra o estado do item **quando foi descoberto** (2026-09-09) e é mantido como histórico. O estado vigente é **`CLOSED (bounded)`**, conforme o status ao fim deste item: correção de privacidade da PR #117 (merge `2ffb6715`, 2026-09-10). Nada abaixo foi alterado.

**Classification: current implementation privacy defect / Partner Beta
blocker.** This item was not part of the original 2026-08-07 technical
debt survey; it was found by inspecting the actual public route during
the Day-0 institutional cold sweep.

**Repository-observed path:**

`GET /v1/liquidity/offers/:id`
→ unauthenticated route in `liquidity.routes.ts`
→ `liquidityRouter.getOffer(id)`
→ raw Prisma `Offer` row plus a broad `User` projection.

The raw `Offer` contains `paymentDetails`. The included user shape
contains `id`, `publicKey`, `displayName`, `peerId`,
`reputationScore`, `totalTrades`, `disputeCount`,
`totalVolumeBtc`, `verified`, and `createdAt`.

This is a direct privacy-surface inconsistency with the aggregate
`GET /v1/liquidity/offers` path, whose purpose-built
`LiquidityOffer` intentionally omits `paymentDetails`, and with the
repository's already-established pattern of fixing public raw-row leaks
via purpose-built projections (`PublicPaymentAccountView`,
`PublicPayoutAddressView`, public participant projection).

**Property:**

> **Public Offer View ≠ Raw Offer Row.**

> **Offer Discovery Data ≠ Payment Execution Data.**

> **Payment Destination Commitment ≠ Public Payment Destination.**

Knowing an Offer id must not be sufficient to retrieve raw PIX/bank
payment instructions or unrelated participant bookkeeping. Public
fields must be justified field-by-field. The actual counterparties
still need an authorized pairwise path to receive the committed payment
instruction after trade-open — removing public disclosure must not make
legitimate execution impossible.

**Multi-node significance:** ADR-001's public signed OfferEnvelope
correctly omits `paymentDetails`. A future gossip implementation must
not serialize the current raw DB row and thereby turn this local privacy
defect into network-wide disclosure.

**Required evidence before closure:**
- unauthenticated OfferDetail response excludes raw payment details;
- public projection exposes only justified public fields;
- network OfferEnvelope excludes private payment instructions;
- actual trade parties can still retrieve/verify the committed payment
  instruction through the authorized pairwise flow.

Full sweep evidence:
`docs/DAY0_COMPLETENESS_COLD_SWEEP.md` §13.

**Remediation (Bounded, 2026-09-10).** Missão CTO de bounded
implementation, precedida por duas passadas de discovery/arquitetura
(seller-field-by-field disclosure matrix, comparação `LiquidityOffer`
vs. `PublicOfferDetail` dedicado, matriz de campos do Offer).

Fix implementado em `src/modules/open-liquidity/liquidity.service.ts`:
`getOffer()` não faz mais `prisma.offer.findUnique` sem `select` — usa
um `select` explícito (Offer: `id, asset, side, priceUsd, priceBrl,
minAmount, maxAmount, paymentMethod, status, network, description,
createdAt, updatedAt`; User: `id, publicKey, displayName, peerId,
verified, reputationScore, totalTrades, disputeCount`) mapeado através
de uma nova função `mapOfferToPublicDetail()` — mesmo padrão já
estabelecido por `mapOfferToLiquidityOffer()` neste mesmo arquivo —
para um novo tipo dedicado `PublicOfferDetail`/`PublicOfferSeller`,
deliberadamente separado de `LiquidityOffer` (que continua servindo
apenas discovery agregado/multi-provider). Nunca um raw Prisma row
alcança a resposta HTTP; `select` explícito falha fechado contra
expansão futura do schema — um novo campo do Prisma nunca é buscado, e
mesmo que fosse, o mapper explícito nunca o incluiria na saída.

**Propriedade nova, congelada por esta remediação:**

> **PublicOfferDetail seller disclosure ≤ Canonical Public Identity +
> Canonical Public Reputation disclosure.**

A disclosure do vendedor em `PublicOfferDetail` nunca excede a união
de `identity.service.ts`'s `getPublicView()` (`id/publicKey/
displayName/peerId/verified`, `GET /v1/identity/participants/:id`) e
`reputation.service.ts`'s `getScore()` (`reputationScore/totalTrades/
disputeRate`, `GET /v1/reputation/:participantId`) — nunca uma
terceira definição, mais ampla, de "perfil público de participante".
`disputeCount` é buscado (necessário para derivar `disputeRate` pela
mesma fórmula de `getScore()`) mas nunca incluído na saída;
`totalVolumeBtc` e `User.createdAt` foram removidos por completo —
nenhuma das duas views canônicas os expõe, e nenhuma decisão de
produto separada os autorizou. Qualquer expansão futura requer decisão
explícita de produto/protocolo, não uma adição silenciosa.

**As três propriedades originais, verificadas como corrigidas para
esta rota específica:**
- *Public Offer View ≠ Raw Offer Row* — corrigida.
- *Offer Discovery Data ≠ Payment Execution Data* — corrigida.
- *Payment Destination Commitment ≠ Public Payment Destination* — corrigida.

**`paymentDetails` — caminho autorizado confirmado, inalterado:**
`GET /v1/openp2p/trades/:id` (`requireAuth` + checagem explícita
`participantId === trade.buyerId || trade.sellerId`,
`SECURITY_AUDIT_REPORT.md §2`) continua entregando `paymentDetails`
real a um comprador/vendedor autenticado e real, e continua rejeitando
um não-participante autenticado (403) e um chamador não-autenticado
(401) — nenhuma mudança de comportamento nesse caminho.

**Evidência real, testes adversariais novos
(`tests/publicOfferDetailDisclosure.test.ts`, 11 testes):**
`paymentDetails` nunca aparece mesmo quando o mock da persistência o
inclui deliberadamente (prova que a fronteira é o `select`/mapper, não
"o mock nunca manda"); `userId`/`moduleId`/`protocolVersion`/
`intentType`/`intentId` nunca aparecem; `disputeCount`/
`totalVolumeBtc`/`createdAt` do vendedor nunca aparecem; os 8 campos
canônicos do vendedor aparecem exatamente, com `disputeRate` derivado
corretamente; todos os campos de discovery esperados continuam
presentes; allowlist exata de chaves no nível superior e do `seller`
(prova de fail-closed contra expansão futura do schema); discovery
agregado (`GET /offers`) inalterado; os 4 cenários de `GET /trades/:id`
(comprador real, vendedor real, não-participante autenticado,
não-autenticado) — todos corretos. Regressão completa (`npm run
test:unit`): **157/157 suites, 2017/2017 testes, zero falhas.**
`tsc --noEmit` limpo. `git diff --check` limpo.

**Não se afirma:** que a arquitetura de privacidade mais ampla do
protocolo está resolvida, nem que toda superfície pública futura segue
automaticamente esta mesma disciplina — apenas que esta rota
específica (`GET /v1/liquidity/offers/:id`) agora tem uma fronteira de
disclosure explícita, testada e fail-closed.

**Status: CLOSED (bounded) — evidência completa, ver retorno da missão
para detalhes de PR/CI.**

**Consumer migration (2026-09-10).** O único consumidor real deste
endpoint — `packages/sails-ui`'s `OfferDetail.tsx`, via
`@satsails/p2p-trading-sdk`'s `liquidity.getOffer()` — migrou
atomicamente no mesmo PR, no mesmo commit que o contrato do backend:
`getOffer()` do SDK agora tipa seu retorno como `PublicOfferDetail`
(não mais `Offer & { user: Participant }`); `OfferDetail.tsx` lê
`seller.*` em vez de `user`/`userId`; `raw.paymentDetails` não é mais
lido em lugar nenhum. Exibições que dependiam de campos removidos
("Membro desde", contagem crua de disputas, volume BTC) foram
removidas, não reconstruídas — substituídas por Total de Trades / Taxa
de Disputas (`disputeRate`, canônico) / Reputação, a mesma hierarquia
desta nota. Nenhuma alegação de privacidade acima foi alterada por esta
adenda — apenas registra que produtor e consumidor de primeira parte
ficaram consistentes no mesmo merge, evitando `main` num estado
conhecidamente inconsistente.

### 62. `User.reputationScore` renderizado como percentual 0-100 na UI — mas é uma soma corrida ilimitada, não uma escala fechada (encontrado 2026-09-10, CTO review do PR #117)

**Classificação: Product / Reputation semantic debt — pré-existente,
fora do escopo do TD #61.** Achado de passagem durante a revisão do
PR #117 (migração de `OfferDetail.tsx` para `PublicOfferDetail`); não
verificado como duplicata de nenhum item já registrado (busca direta em
`docs/BACKLOG.md`/`docs/TODO.md`/`docs/TECHNICAL_DEBT_AUDIT.md`, nenhum
achado equivalente encontrado).

**Achado:** `reputation.service.ts`'s próprio comentário de cabeçalho
documenta `User.reputationScore` como uma soma corrida e sem limite
superior (+2/-5 por trade, `recordOutcome()`), explicitamente **não**
uma escala 0-100 ou uma razão 0-1. `packages/sails-ui/src/pages/
OfferDetail.tsx`, porém, renderiza esse mesmo campo como se fosse
fechado: `{offer.seller.reputationScore.toFixed(1)} / 100` e usa o
valor bruto diretamente como `width` percentual de uma barra de
progresso CSS (`style={{ width: `${offer.seller.reputationScore}%` }}`)
— para qualquer participante cuja soma corrida já tenha ultrapassado
100 (matematicamente inevitável com uso real e prolongado do
protocolo), a barra estoura 100% de largura e o texto mostra algo como
"142.0 / 100", sem sentido para o usuário final.

**Não corrigido nesta nota, não corrigido no PR #117** — a instrução
explícita da missão que encontrou isto foi não redesenhar reputação
dentro dessa correção bounded. Nenhuma mudança de comportamento feita.

**Fix recomendado (propriedade, não mecanismo):** nenhum prescrito
aqui — decisão de produto genuína (normalizar/clampar visualmente,
trocar a barra por outra representação, ou expor um campo derivado
0-100 no backend) requer entrada de produto, não apenas engenharia.

**Status: OPEN.**

### 63. `packages/sails-ui` não tem nenhum framework de teste executável (achado 2026-09-10, CTO review do PR #117)

**Classificação: evidence/tooling gap — pré-existente, não introduzido
pelo TD #61.** Não verificado como duplicata (mesma busca do item #62
acima, nenhum achado equivalente encontrado).

**Achado, confirmado diretamente:** `packages/sails-ui/package.json`
não tem script `"test"`; busca por `*.test.*`/`*.spec.*` no pacote não
retorna nenhum arquivo; nenhuma configuração de Vitest/Jest/Testing
Library presente. Toda a superfície de UI deste pacote (incluindo
`OfferDetail.tsx`, migrado no PR #117) é verificada hoje apenas por
`tsc --noEmit` + `vite build` (prova de tipo/compilação) e, quando
disponível, checagem manual em navegador — nunca por um teste de
comportamento automatizado e executável.

**Não corrigido nesta nota** — instalar um framework de teste é
trabalho genuíno e não-trivial (escolha de framework, configuração,
primeiro teste real), explicitamente fora do escopo de uma correção
bounded que já estava em andamento quando isto foi encontrado.

**Fix recomendado (propriedade, não mecanismo):** nenhum prescrito
aqui — decisão de ferramenta (Vitest é o encaixe natural dado o uso de
Vite já existente, mas não decidido aqui) requer sua própria missão
dedicada.

**Status: OPEN.**

### 64. `recordTradeCompletion()` mistura unidades de asset diferentes em `totalVolumeBtc` (achado 2026-09-10, Institutional Scope & Product Truth Sweep, F15)

**Classificação: cross-asset volume semantic debt — pré-existente.** Não
duplicata do item #42 acima (`totalVolumeBtc` — semântica de volume após
invalidação de settlement), que trata de uma questão diferente
(timing/reconhecimento de volume relativo a reorg), não de conflação de
unidade entre assets.

**Achado, confirmado diretamente:**
`src/common/events/handlers.ts:106-133,279,376` — `recordTradeCompletion()`
é chamado incondicionalmente para todo trade completado,
independentemente de `trade.asset`, somando `trade.amount` bruto numa
coluna literalmente chamada `totalVolumeBtc`. Para BTC/`LN_BTC` a escala
é satoshi; para `USDT_ERC20` (liquidado via `WdkSettlementProvider`) a
escala é 6 decimais — sem nenhuma conversão ou comentário disclosing a
mistura. Confirmado via grep: nenhum consumidor lê esse campo hoje em
`src/` — limita o raio de explosão atual, mas é uma armadilha de
correção real assim que qualquer leitor futuro existir.

**Não corrigido nesta nota** — escolher a métrica/schema de substituição
requer revisão semântica/arquitetural própria (ex: colunas por asset,
normalização para uma unidade de referência, ou remoção do campo em
favor de agregação por asset), explicitamente fora do escopo desta
sweep de institucionalização (documentação apenas).

**Fix recomendado (propriedade, não mecanismo):** nenhum prescrito
aqui — decisão de schema requer sua própria missão dedicada.

**Status: OPEN.**

### 65. QVAC intent schemas ficaram fora de sincronia com `AssetType` (achado 2026-09-10, Institutional Scope & Product Truth Sweep, F16)

**Classificação: contract drift — pré-existente.**

**Achado, confirmado diretamente:**
`src/modules/open-agents/qvac-agent.provider.ts:127-137,172-177` —
`TRADE_INTENT_SCHEMA`/`OFFER_INTENT_SCHEMA` têm um comentário afirmando
que o enum é "kept in sync with `common/types/index.ts`'s `AssetType`...
by hand," mas o enum do schema tem 7 valores contra os 10 reais do
`AssetType` — faltam `SPARK` (Day-0-required, ver `docs/BACKLOG.md` item
20), `STACKS`, e `RSK_BTC`. Toda outra cópia manual deste mesmo enum no
código (`intent.routes.ts`, `liquidity.routes.ts`, `agent.routes.ts`,
`offer-envelope.ts`) lista corretamente os 10 valores — este arquivo é o
único outlier confirmado.

**Não corrigido nesta nota — intencionalmente.** A decisão arquitetural
sobre Asset/Network (`docs/BACKLOG.md` item 20's própria obrigação de
arquitetura em aberto) pode mudar a própria forma do enum antes que
valha a pena sincronizá-lo mecanicamente. **Não corrigir mecanicamente
antes dessa decisão**, a menos que uma missão futura autorize
explicitamente um fix interino.

**Fix recomendado (propriedade, não mecanismo):** nenhum prescrito
aqui — sincronizar após a decisão de arquitetura Asset/Network, não
antes.

**Status: OPEN.**

## Ações Recomendadas por Prioridade

### P0 — Antes de qualquer apresentação (1-2 dias)

| # | Item | Esforço |
|---|------|---------|
| 10 | Silent error swallowing (.catch(() => {})) | Baixo |
| 17 | Versão da API duplicada → constante | Baixo |
| 18 | Pagination defaults → constantes | Baixo |
| 24 | Magic numbers → protocol-constants.ts | Médio |

### P1 — Antes de beta público (1 semana)

| # | Item | Esforço |
|---|------|---------|
| 9 | Logging → pino padronizado | Médio |
| 11 | `as any` → eliminação | Médio |
| 12 | Config accessor → padronizar | Baixo |
| 15 | `participantId()` → util compartilhado | Baixo |
| 16 | Regex pré-compilada | Baixo |

### P2 — Antes de GA (1 mês)

| # | Item | Esforço |
|---|------|---------|
| 5 | Config → injetável | Alto |
| 6 | Prisma/Redis → injetáveis | Alto |
| 19 | Event names → constantes | Médio |
| 20 | Status strings → enums | Médio |
| 25 | SDK → interfaces abstratas | Médio |
| 28 | SDK → API_BASE constante | Baixo |

### P3 — Refatoração Arquitetural (trimestre)

| # | Item | Esforço |
|---|------|---------|
| 1 | handlers.ts → split per module | Alto |
| 2 | escrow.service.ts → extrair sub-módulos | Alto |
| 3 | Singletons → DI container | Alto |
| 4 | handlers.ts → respeitar fronteiras | Alto |
| 7 | RedisStreamsEventStore → implementar | Alto |

---

## Referência

Cada item inclui:
- **Arquivo:linha** exata
- **Código atual** (snippet)
- **Por que bloqueia** (maintenance, scalability, onboarding, SDK evolution, tests, modularization)
- **Fix recomendado** (padrão, não implementação)

---

> **Autor:** CTO (Auditor)
> **Data:** 2026-08-07
> **Próximo passo:** Claude Code implementa P0 (1-2 dias), depois P1 (1 semana)
