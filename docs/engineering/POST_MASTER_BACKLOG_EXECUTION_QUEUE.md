# CTO — Fila de execução e gates pós-Master Backlog

> **Status:** proposta operacional do CTO para revisão institucional; **não** é autorização de implementação, merge, deploy, Beta ou freeze.  
> **Baseline de reconciliação:** `main` `71c0d8b69925d616d577f95d574407389970ec93` (2026-10-17).  
> **Autoridade:** `docs/BACKLOG.md`, `docs/ROADMAP.md`, ADRs e Issues canônicas continuam governando o escopo. O GitHub Project e os HEADs atuais devem ser reconsultados no momento de execução.  
> **Princípio:** terminar o Master Backlog **antes de promover novas frentes futuras**; distinguir gates de Beta de expansões. Não fechar Issues por mera documentação.

## CTO — reconciliação Day 0 Pubky-first e Paykit (2026-10-26)

**Pós-Master Backlog não significa pós-Day 0.** Obrigações desta fila podem continuar após o fechamento do Master Backlog, mas devem estar homologadas **antes do GO Day 0** quando classificadas como Day 0. Não iniciar trabalho paralelo antes dos gates atuais; não confundir CI com homologação. Owner arquitetural existente: #276. Sincronizar com `docs/BACKLOG.md`, `docs/ROADMAP.md`, PR #531 e Project #3 na etapa de execução; esta nota não altera a sequência canônica nem autoriza merge/deploy.

**Escopo Day 0 (decisão de produto, não evidência de implementação):**

1. **OpenIdentity:** Pubky como único provider inicial, via interface neutra; prova de posse, grants, revogação e recuperação. Pubky Ring para gestão de chaves; Passport e Google Login são **opções de UX**, não obrigações. **Nostr não é requisito Day 0** e permanece provider futuro possível.
2. **PortableData:** Pubky Homeserver como provider inicial substituível de armazenamento/descoberta; dados publicados não são automaticamente provas válidas; proteger privacidade, portabilidade e recuperação.
3. **Pear:** comunicação privada na experiência de referência, chaves de transporte separadas, autorização de sessão revogável pela persona. Sem vinculação automática a seeds financeiras e sem dependência constitucional no Sails Core.
4. **OpenProof/OpenReputation:** provas econômicas assinadas e verificáveis independentemente, anti-replay/deduplicação, correção/revogação e mitigação de reputação fabricada; reputação derivada de fatos, não score central. E2E entre **Satsails Wallet · Sails Market · Outros integradores**, sem depender da API ou banco exclusivo da Satsails.
5. **Paykit/OpenSettlement:** incluir no Day 0 **um incremento mínimo de integração** para descoberta de métodos de pagamento e payment requests/autorização, sujeito a validação de API, compatibilidade multi-rail, segurança e conformance. Integração pública de referência não substitui homologação Sails; registrar avisos upstream de WIP. Paykit não é autoridade sobre fundos ou settlement.

**Decisão arquitetural confirmada pelo CTO (registrada em 2026-10-31; decisão de desenho, não evidência de implementação):**

- **Provider de identidade:** Pubky é o primeiro provider externo priorizado de OpenIdentity na implementação de referência. Para a implementação inicial, a decisão Pubky-first substitui a opção anterior "Nostr ou Pubky" registrada na issue #276. Nostr permanece como possível adaptador futuro, sem obrigação de implementação no Day 0. A decisão é consistente com o item 1 acima. `SYSTEM_DESIGN.md` §14.3 permanece válido: Pubky e Nostr não são camadas de identidade obrigatórias do protocolo.
- **`Participant`:** no plano semântico e contratual do Sails Protocol, `Participant` é o sujeito econômico abstrato, independente de Pubky, Nostr, carteira ou transporte (`SYSTEM_DESIGN.md` §14.1; `Identity ≠ Authority`). Isso descreve a separação prevista pelo contrato; não afirma que toda a implementação atual já a cumpra integralmente.
- **Vínculo `Participant ↔ Pubky`:** explícito, consentido e criptograficamente verificável (prova de posse, separação de audience/domínio, expiração, anti-replay e revogação, já registrados em #276 em 2026-10-08). O vínculo não cria autoridade econômica. Formato e mecanismo **não** são decididos aqui.
- **Transporte:** Pear/HyperDHT é o provider de transporte da implementação de referência, não uma exigência do protocolo (RFC-002; `SYSTEM_DESIGN.md` §14.2). `TransportProvider` continua sendo o contrato de substituibilidade. **Lacuna existente (`main` `456d3e52`):** três módulos de `src/modules/open-p2p/` (`chat.routes.ts`, `negotiation.service.ts` e `trade.routes.ts`) importam `pearNodeRegistry` diretamente em vez de passar por `TransportProvider`. A direção domínio→infraestrutura está registrada na emenda "join-trade" do RFC-002, mas a substituibilidade do transporte não está completa. Nenhuma remediação é decidida nesta nota.
- **#543 e #545 são evidência experimental** (drafts, somente em `experiments/pubky-pear-recovery/`), não homologação de produção. O que provam e o que permanece UNKNOWN está nas seções "Claims" dos próprios PRs; nada aqui promove essas evidências a GO Day 0.

### CTO spike obrigatório — raiz de recuperação P2P determinística (sem bloquear Gate 2/3)

**Problema:** um único backup/acesso P2P pode restaurar a identidade Pubky e autorizar novas sessões Pear, como UX análoga a uma HD wallet, mas sem misturar a raiz financeira WDK. O estado atual do Sails gera `HyperDHT.keyPair()` sem seed no `PearNode.start()` e **não** prova recuperação determinística nem vínculo Pubky↔Pear. Ver `docs/IDENTITY_ARCHITECTURE_DISCOVERY.md` e `docs/CRYPTOGRAPHIC_MODEL.md`.

**Decisão de direção:** estudar raiz P2P independente, com derivação *domain-separated* e versionada. **Não fixar agora BIP-39, KDF, caminhos, import/export ou esquema de assinatura.** Não reutilizar diretamente a chave privada Pubky como chave de transporte; não usar seed financeira como fonte silenciosa. Pubky = identidade econômica estável; Pear = chaves de dispositivo/sessão autorizadas, rotacionáveis e revogáveis. Recuperação de identidade ≠ recuperação de conteúdo de chats. Alternativa admissível se a derivação Pubky não for suportada: recuperar a chave Pubky pelo mecanismo nativo e criar/reautorizar chaves Pear independentes, com UX unificada, sem falsa promessa de uma única seed.

**Evidência upstream inicial:** HyperDHT documenta `DHT.keyPair([seed])` e Hyperswarm documenta seed determinística de 32 bytes; Pubky SDK documenta autenticação por chave pública e grants, mas ainda **não há prova de interoperabilidade determinística conjunta** nem formato de recuperação cruzada homologado. Ver https://docs.pears.com/p2p/reference/building-blocks/hyperdht/ , https://github.com/holepunchto/hyperswarm , https://github.com/pubky/pubky-core . Conferir versões/pins exatos no spike.

**Protocolo de prova, sem produção:**

1. Reproduzir geração/restauração de identidade Pubky com vetor fixo e versão de SDK pinada, sem expor segredos em logs; verificar assinaturas e endereço/ID resultante.
2. Gerar chaves Pear distintas com vetor determinístico ou efêmero autorizado, demonstrar que a mesma raiz não produz a mesma chave entre domínios e que chaves financeiras não participam.
3. Definir binding assinado Pubky→chave Pear com audience/app, purpose, nonce, expiry, versão, device e revogação; verificar assinatura e rejeitar replay, expiração, spoof e downgrade.
4. Simular apagar app/reinstalar/outro dispositivo: restaurar persona, autorizar nova sessão Pear e acessar provas econômicas portáteis entre **Satsails Wallet · Sails Market · Outros integradores** sem API exclusiva.
5. Negativos: seed errada, dispositivo revogado, sessão Pear comprometida, homeserver indisponível, dados não replicados, perda de backup, correlation/privacy, múltiplos dispositivos simultâneos e migração de versão.
6. Separar resultados **identidade recuperada / provas recuperadas / chats recuperados**; chats só passam se houver persistência e recuperação E2EE comprovadas. Nunca prometer restauração de chats por derivação de chaves.

**Critério de saída:** ADR de decisão após spike com vetores, compatibilidade SDK e matriz RED/GREEN; Gatekeeper revisa isolamento de segredos e autorização. Até então **DESIGN/SPIKE ONLY, NO-GO para afirmar seed única homologada**, sem implementação produtiva ou alteração de Core/schema. Não criar issue duplicada; registrar evidência no owner existente e reconciliar execução após gates atuais.

**Roadmap futuro (fora do caminho crítico):** Nostr como provider adicional, Pubky Nexus como indexador opcional, Blocktank como provider LN opcional, Atomicity, Pubky Noise e extras avançados não essenciais; não apagar obrigações anteriores sem reconciliação.

**Pubky × Nostr:** comparar censura, interoperabilidade, rails, requests/assinaturas/permissões, ferramentas e maturidade com fontes e testes. Não afirmar que Nostr carece absolutamente de abertura, interoperabilidade ou resistência à censura; a preferência Pubky-first decorre da adequação de identidade, grants e portable data e da redução de complexidade inicial. Não registrar tamanho de equipe sem prova.

**Status:** decisão registrada; implementação, evidências, Gatekeeper e GO pendentes. Gate 2 Redis e Gate 3 P4 seguem NO-GO. Não criar issues duplicadas nem declarar 100% sem denominador auditado.

## Como usar a fila

1. Reconciliar `main`, Master Backlog, Issues e GitHub Project no exato momento de reentrada.
2. Verificar **gate de entrada**, autoridade/owner, contratos semânticos e evidência, antes de atribuir implementação.
3. Desdobrar apenas o **primeiro incremento vertical** em missão limitada; não abrir pacotes vazios ou anunciar suporte sem testes.
4. Exigir evidência reproduzível de conformance, segurança, falha/recovery e realidade de integração conforme o risco.
5. CTO decide priorização e aceite; Gatekeeper valida limites críticos; Claude só recebe execução quando a frente atual e o gate de autorização permitirem.
6. Revisar esta fila quando a verdade operacional mudar. A ordem abaixo é **recomendação de dependências**, não substitui a sequência congelada do Master Backlog.

## Fila e decisões de entrada

| Classe | Ordem sugerida / frente | Issue(s) canônica(s) | Gate de entrada | Primeiro incremento verificável | Autoridade / estado |
| --- | --- | --- | --- | --- | --- |
| **A — Agora, não pós-backlog** | A0. Fechar obrigações econômicas, temporais, recovery, segurança e documentação Day 0 | [#453](https://github.com/sails-protocol/Sails-Protocol/issues/453), [#461](https://github.com/sails-protocol/Sails-Protocol/issues/461), [#105](https://github.com/sails-protocol/Sails-Protocol/issues/105), [#125](https://github.com/sails-protocol/Sails-Protocol/issues/125), [#474](https://github.com/sails-protocol/Sails-Protocol/issues/474), [#473](https://github.com/sails-protocol/Sails-Protocol/issues/473) | Gates atuais de cada Issue e evidência no HEAD exato | Resolver e provar cada bloqueio no respectivo owner, sem alegar conclusão global | **OPEN**; não mover para a expansão futura; #473 já é workstream do Master Backlog |
| **A — Agora, na ordem do Master Backlog** | A1. Reference Components, Design System e UI (itens 22–25) | [#217](https://github.com/sails-protocol/Sails-Protocol/issues/217); `docs/BACKLOG.md` itens 22–25 | Chegada efetiva aos itens 22–25 do Master Backlog, com dependências anteriores satisfeitas; contratos de produto/SDK revalidados | Auditar `packages/sails-ui/DESIGN.md`, reconciliar protótipos e implementar **uma** jornada vertical com Storybook, acessibilidade e verdade econômica | Handoff de design é pré-trabalho, não implementação; Sails Market ≠ componente reutilizável |
| **A — Agora, workstream do Master Backlog** | A2. Escalabilidade multi-integrador (acompanhamento) | [#473](https://github.com/sails-protocol/Sails-Protocol/issues/473) | Execução do workstream **já aberto no Master Backlog**, sem antecipar Claude | Modelo de capacidade 10k/100k/1M/10M MAU com hipóteses explícitas; testes que separem medida de projeção | Não alegar prontidão para 1M MAU sem prova |
| **B — Beta Readiness** | B1. Reality Validation, multioperador, conformance e matriz de capacidades | [#165](https://github.com/sails-protocol/Sails-Protocol/issues/165), [#105](https://github.com/sails-protocol/Sails-Protocol/issues/105) | Master Backlog encerrado com evidência, sem pendência econômica ou de segurança bloqueante | Registro de cenários reais, adaptadores/rails/capabilities efetivamente testados, resultados e falhas | Gate de evidência; **não** homologação presumida |
| **B — Beta Readiness** | B2. Corpus de incidentes → Red Team → ensaio econômico / controles | [#420](https://github.com/sails-protocol/Sails-Protocol/issues/420), [#77](https://github.com/sails-protocol/Sails-Protocol/issues/77) | B1 suficientemente demonstrado; trilha de produção materialmente completa | Precedente externo → condição Sails → invariante → teste falsificável; depois casos adversariais | #420 antecede Red Team; #77 é horizonte, não autorização imediata |
| **C — Expansão** | C1. Multi-Wallet-Kit + Multi-Rail | [#86](https://github.com/sails-protocol/Sails-Protocol/issues/86), [#152](https://github.com/sails-protocol/Sails-Protocol/issues/152) | Core/contratos estáveis; conformance e regras de lifecycle/revalidação definidos; prioridade por demanda real | Selecionar **um** kit + rail elegível, implementar integração vertical e demonstrar falha/recovery e limites de autoridade | Nove alvos **planejados**: BDK, WDK, Breez, Spark, LDK, Ethers/EVM, Tron, Solana, TON. WalletAdapter ≠ SettlementProvider |
| **C — Expansão** | C2. SDK/DX, interfaces e outras plataformas | [#75](https://github.com/sails-protocol/Sails-Protocol/issues/75), [#152](https://github.com/sails-protocol/Sails-Protocol/issues/152) | Superfície canônica de API/SDK e contrato de conformance definidos | Comparar CLI, MCP, WebMCP, Web/mobile, Swift/Kotlin, Rust/Go por menor integração correta; escolher um recorte com testes | Rust/Go não são traduções automaticamente equivalentes; agente não adquire autoridade por acessar ferramenta |
| **C — Expansão** | C3. Sandbox, Test Harness e Playground | [#78](https://github.com/sails-protocol/Sails-Protocol/issues/78), [#165](https://github.com/sails-protocol/Sails-Protocol/issues/165) | Contratos reais e cenários de validação utilizáveis; isolamento de valor econômico | Harness programático com cenário reproduzível; sandbox e UI somente sobre semântica real | Playground não deve simular protocolo alternativo; mocks isolados não provam produção |
| **D — Discovery / condicionais** | D2. Taproot threshold, mercados adjacentes e automação de agentes | [#121](https://github.com/sails-protocol/Sails-Protocol/issues/121), [#438](https://github.com/sails-protocol/Sails-Protocol/issues/438), [#155](https://github.com/sails-protocol/Sails-Protocol/issues/155), [#231](https://github.com/sails-protocol/Sails-Protocol/issues/231) | Decisão de arquitetura/produto específica, risco e orçamento delimitados | Discovery com alternativas, threat model e evidência de necessidade | Não implementar por constarem na fila; DePix Terminal é Sails Market, não Core |
| **E — Radar** | E1. Atualização QVAC e pesquisa de routing | [#84](https://github.com/sails-protocol/Sails-Protocol/issues/84), [#124](https://github.com/sails-protocol/Sails-Protocol/issues/124) | Gatilho upstream/evidência ou autorização CTO explícita | Reabrir avaliação limitada com HEAD e compatibilidade reais | Sem promoção automática |

## Bloqueios de promoção

- **Não** iniciar C/D/E apenas porque A tem checks verdes: conclusão do Master Backlog e gates de Beta são decisões distintas.
- **Não** converter pesquisa, handoff ou radar em implementação sem decisão registrada.
- **Não** promover adapter/rail/SDK a `supported` por existir nome, interface, mock ou pacote vazio.
- **Não** usar números de escala projetados como evidência de throughput.
- **Não** inferir `settled` de ruling, `verified` de payment sent, `FAILED` de UNKNOWN, nem autoridade de recomendação de agente.
- **Não** reordenar `docs/BACKLOG.md` itens 22–25: A1 reentra quando a sequência canônica chegar a eles; não transferir esses itens para uma expansão posterior ao fechamento do Master Backlog.

## Próximo checkpoint do CTO

Após evidência formal de fechamento do Master Backlog: (1) revisar a matriz de bloqueios A; (2) verificar a sequência B de Beta Readiness; (3) reconciliar o GitHub Project live; (4) escolher **um** incremento elegível da classe C; (5) emitir missão de execução delimitada, com aceite e STOP. Até lá, manter a fila como **planejamento**, sem trabalho de Gatekeeper/Claude provocado por este documento.
