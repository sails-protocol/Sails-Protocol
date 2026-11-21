# Registro permanente de requisitos de produto e UX

> **Fonte única de requisitos de produto e UX do Sails Protocol** (CTO Despachos 051, 051-A, 052 e 053). Mantido pelo EPM; a UI propõe e o registro permanece. Este arquivo **não** homologa nada: o checkbox `[x]` só é marcado depois de implementado, verificado e homologado. O contador formal do Day 0 (4/54) é independente deste registro e só o CTO o altera. Regra SEM: toda descoberta de UX relevante entra aqui antes de ser considerada encerrada. Nenhum recurso identificado pela UI é descartado por falta de suporte do backend; ele permanece registrado com prioridade, dependências, contrato proposto e estado.
> Documentos irmãos: [UI_BACKEND_GAPS.md](UI_BACKEND_GAPS.md) e [IDENTITY_PORTABILITY_REQUIREMENTS.md](IDENTITY_PORTABILITY_REQUIREMENTS.md). Rastreabilidade: necessidade de UI -> contrato do SDK -> backend -> testes -> homologação.

Origem: `ui-backend-gaps-2026-11-20.md`, o Despacho 039, o Despacho 051 com o Complemento 051-A, e o trabalho de UI na branch `ui/design-system` (fios soltos em `packages/sails-ui/src/lib/looseWires.ts`, issue #729; decisões em `packages/sails-ui/DECISIONS.md`).

## Convenções propostas
- **ID permanente:** `UX-NNN`. O ID original (B1, C12…) fica em "Origem".
- **Checkbox (Despacho 053):**
  - `[ ]` = identificado e ainda não homologado;
  - `[x]` = implementado, verificado e homologado.
  - Os estados intermediários ficam nos campos do Project #3.
- **Estado (sempre explícito, como pede o Despacho 052):**
  - **Requisito aprovado:** um despacho aprovou especificar.
  - **Solução proposta:** existe proposta técnica, ainda não aprovada.
  - **Implementado:** está na interface e/ou no backend.
- **Responsável inicial:** "EPM (a distribuir)", até o EPM atribuir.
- **Indicadores (recomendação do CTO):** 25 requisitos descobertos, 0 homologados nesta proposta.

---

## Market e ofertas (OpenP2P / OpenLiquidity)

- [ ] **UX-001: Ler avaliações do anunciante (média, quantidade, comentários recentes)**
  - Origem: A1, Despacho 039 (P1) e Complemento 051-A. Antes de negociar, a pessoa quer ver a experiência que outros tiveram com aquele anunciante. A lista mostra "★ 4,8 (126)" na primeira vista.
  - Módulo: OpenReputation (com OpenIdentity e OpenP2P).
  - Contrato: só existe a escrita, `reputation.rate()` (`POST /v1/reputation/rate`), que é informativa e nunca entra na reputação. Não há leitura.
  - Proposta: consulta paginada por anunciante, com média, quantidade e comentários recentes, ordenação e estado sem avaliações. Ver UX-002.
  - Prioridade: P1. Depende de UX-002 e UX-020.
  - Estado:
    - Requisito aprovado (039 e 051-A).
    - Interface implementada: só simulada no modo demonstração. Com dados reais, nada aparece na lista e "Em breve" aparece no detalhe e no Perfil.
  - Issue: a criar (EPM; ver #735 e UX-002). Fio solto: `readRatings`.
  - Decisão: Despacho 039 e Complemento 051-A.
  - Aceite:
    - o SDK devolve média e quantidade de avaliações reais e verificáveis;
    - a lista mostra a forma compacta e o detalhe mostra a completa;
    - as avaliações nunca alteram a reputação;
    - existe o estado sem avaliações.

- [ ] **UX-002: Avaliações portáteis e verificáveis**
  - Origem: Complemento 051-A. A pessoa leva o seu histórico de avaliações para qualquer aplicativo.
  - Módulo: OpenReputation, OpenIdentity e OpenP2P. Avaliar Pears/Pubky antes de propor infraestrutura nova.
  - Contrato: `rate()` grava de 1 a 5 com comentário, uma avaliação por avaliador e trade, só as partes do trade. Não há assinatura do avaliador, nem portabilidade, nem leitura.
  - Proposta:
    - nota de 1 a 5;
    - comentário opcional de até 280 caracteres;
    - assinatura verificável do avaliador;
    - vínculo com a identidade portátil e com um trade elegível;
    - proteção contra duplicadas e manipulação;
    - consulta pelo SDK;
    - regras de privacidade, disponibilidade e moderação.
  - Prioridade: P1. Depende de UX-020.
  - Estado:
    - Requisito aprovado (051-A).
    - Interface implementada: o cartão "Avaliar" no fim do trade já usa a escrita real. O limite de 280 caracteres e o contador estão em implementação.
  - Issue: a criar.
  - Decisão: Complemento 051-A.
  - Aceite:
    - a avaliação é assinada e verificável fora do app;
    - não aceita duplicadas;
    - o comentário tem no máximo 280 caracteres;
    - a consulta funciona por outro cliente.

- [ ] **UX-003: Data de cadastro pública (mês e ano)**
  - Origem: A2, Despacho 039 (P2). "Desde jan. de 2025" mostra há quanto tempo a pessoa negocia.
  - Módulo: OpenIdentity.
  - Contrato: `Participant.createdAt` existe só para o próprio usuário. `PublicOfferSeller` não tem a data, que foi retirada de propósito.
  - Proposta: só o mês e o ano, com a origem comprovada. Nunca confundir com a data da oferta ou da wallet.
  - Prioridade: P2.
  - Estado:
    - Requisito aprovado (039).
    - Interface implementada: no próprio Perfil, "Membro desde nov. de 2026". Para o anunciante, só simulada no modo demonstração.
  - Issue: a criar. Fio solto: `publicMemberSince`.
  - Decisão: Despacho 039.
  - Aceite: a data pública vem de uma fonte comprovada, em mês e ano, revisada pelo GK quanto à exposição.

- [ ] **UX-004: Vários métodos de pagamento por oferta (até 5) e escolha no trade**
  - Origem: A3, Despacho 039 (P1). Um anunciante aceita PIX, TED e boleto na mesma oferta.
  - Módulo: OpenP2P e SDK.
  - Contrato: `Offer.paymentMethod` é um só. `openp2p.trade()` não recebe método.
  - Proposta:
    - lista de até 5 métodos, validada no backend e no SDK;
    - escolha de um método ao abrir o trade;
    - o método escolhido fica preso aos termos aceitos, sem troca unilateral.
  - Prioridade: P1.
  - Estado:
    - Requisito aprovado (039).
    - Interface implementada: lista com 3 métodos e "+N" e detalhe completo. A escolha de vários métodos existe só na demonstração.
  - Issue: #735. Fios soltos: `multiPaymentMethods`, `tradePaymentMethodChoice`.
  - Decisão: Despacho 039, máximo de 5 (Product Owner).
  - Aceite:
    - publicar com até 5 métodos;
    - o trade registra o método escolhido;
    - o método não pode ser trocado depois.

- [ ] **UX-005: Catálogo de 14 pares e trava de provider na publicação**
  - Origem: A4 e auditoria do catálogo (B1/B2), Despacho 039.
  - Módulo: OpenSettlement e SDK.
  - Contrato:
    - só 4 dos 14 pares existem no `AssetType`, e só BTC on-chain tem rail de produção;
    - a publicação valida só o enum (`liquidity.routes.ts:44`).
  - Proposta:
    - modelo `Asset + SettlementRail` do ADR-002 (§12, itens 2 e 3);
    - trava de provider na publicação;
    - decisão sobre STACKS, RSK_BTC e SPARK.
  - Prioridade: P1.
  - Estado:
    - Requisito aprovado (039).
    - Interface implementada: seletor com os 14 pares, só BTC on-chain disponível e os outros 13 "Em breve".
  - Issue: #734. Fio solto: `assetCatalogPairs`.
  - Decisão: ADR-002 §5A e Despacho 039.
  - Aceite:
    - cada par disponível tem um rail apto a produção;
    - a publicação recusa ativo sem provider.

- [ ] **UX-006: Identidade do anunciante na listagem de ofertas**
  - Origem: B1 e Despacho 051. A lista não mostra o avatar nem abre o perfil de quem anuncia.
  - Módulo: OpenIdentity e OpenLiquidity.
  - Contrato: `discover` não devolve o id nem a chave do anunciante (`realOffers.ts`).
  - Proposta:
    - identificador público portátil do anunciante no resumo da oferta;
    - perfil verificável, independente do aplicativo;
    - separação entre identidade, credenciais e reputação.
  - Prioridade: P1. Depende de UX-020.
  - Estado: requisito aprovado (051, segunda entrega).
  - Issue: #741.
  - Decisão: Despacho 051.
  - Aceite:
    - a lista mostra o avatar real e abre o perfil;
    - nenhum dado privado é publicado.

- [ ] **UX-007: Presença pública (online)**
  - Origem: B2.
  - Módulo: OpenP2P.
  - Contrato: a presença só existe dentro da sala de chat do trade.
  - Proposta: sinal opcional, com consentimento.
  - Prioridade: P2.
  - Estado: identificado.
  - Issue: a criar.
  - Aceite: a presença aparece só para quem consentiu e nunca é estimada.

- [ ] **UX-008: Moeda de exibição (referência em BRL e outras)**
  - Origem: B3.
  - Módulo: SDK.
  - Contrato: só existe preço em USD.
  - Proposta: fonte de câmbio exibida como referência, nunca como preço do trade.
  - Prioridade: P3.
  - Estado: identificado.
  - Fio solto: `displayCurrency`.
  - Aceite: a referência aparece marcada como tal, e o trade continua em USD.

## Trade (OpenP2P / OpenSettlement)

- [ ] **UX-009: Horários autoritativos das transições econômicas**
  - Origem: C1 e Despacho 051, primeira entrega. "Pagamento marcado como enviado" aparece sem hora.
  - Módulo: OpenSettlement.
  - Contrato: não existe `paymentMarkedAt`. Falta confirmar se a timeline do trade traz as transições do escrow.
  - Proposta: horário do servidor em cada transição.
  - Prioridade: P1.
  - Estado: requisito aprovado (051).
  - Issue: #737.
  - Aceite: cada etapa do trilho mostra o horário que veio do servidor.

- [ ] **UX-010: Dados de recebimento do vendedor numa oferta de compra**
  - Origem: C2 e Despacho 051.
  - Módulo: OpenP2P.
  - Contrato: só existe `offer.paymentDetails`.
  - Proposta: dados gravados pelo vendedor, protegidos e presos ao trade.
  - Prioridade: P1.
  - Estado: requisito aprovado (051).
  - Issue: #738.
  - Aceite: o comprador vê os dados do vendedor só dentro do trade, e o GK revisa a proteção.

- [ ] **UX-011: Estado de broadcast e próximo responsável**
  - Origem: C3 e Despacho 051.
  - Módulo: OpenSettlement.
  - Contrato: depois de todas as assinaturas, nenhum dado diz quem age.
  - Proposta: estado de broadcast e próximo ator expostos ao cliente.
  - Prioridade: P1.
  - Estado: requisito aprovado (051).
  - Issue: #739.
  - Aceite: o trilho mostra o próximo responsável a partir de um dado real.

- [ ] **UX-012: Janela de pagamento, prazos, cancelamento e apelação (estilo Binance P2P)**
  - Origem: C12 e Despacho 051. O usuário precisa saber quanto tempo tem em cada fase.
  - Módulo: OpenP2P e OpenSettlement. É regra de protocolo e de economia (CTO + GK).
  - Contrato: só existem `escrow.expiresAt`/`timelockHours`. Não há janela de pagamento, cancelamento automático, prazo de liberação nem horário de abertura da apelação.
  - Proposta:
    - na oferta, `paymentWindowMinutes`, escolhido entre opções fixas;
    - no trade, `paymentDeadline`;
    - cancelamento automático que nunca invalida fundos bloqueados nem pagamentos em andamento;
    - prazo de liberação;
    - `appealAvailableAt`.
  - Prioridade: P1.
  - Estado:
    - Requisito aprovado (051).
    - Interface: hoje mostra só o prazo real do escrow. A janela de pagamento aparece só na demonstração.
  - Issue: #740.
  - Decisão: Despacho 051 (prazos nunca inventados pela interface).
  - Aceite:
    - todos os prazos vêm do servidor;
    - o cancelamento respeita os fundos bloqueados;
    - o GK aprova.

- [ ] **UX-013: Depósito observado antes do bloqueio (MULTISIG)**
  - Origem: C4.
  - Módulo: OpenSettlement.
  - Contrato: nenhum estado entre o depósito e FUNDS_LOCKED.
  - Proposta: estado "depósito observado", com a profundidade de confirmação.
  - Prioridade: P2.
  - Estado: identificado.
  - Aceite: o trilho mostra o depósito visto antes do bloqueio.

- [ ] **UX-014: Confirmações da transação de pagamento**
  - Origem: C5.
  - Módulo: OpenSettlement.
  - Contrato: só existe `txReleaseId`.
  - Proposta: quantidade de confirmações ou estado de broadcast.
  - Prioridade: P2.
  - Estado: identificado.
  - Aceite: a interface mostra a profundidade real e só diz "confirmada" quando o dado sustenta.

- [ ] **UX-015: `custodyModel` nas respostas de criar e bloquear o escrow**
  - Origem: C6.
  - Módulo: OpenSettlement.
  - Contrato: o campo vem só no `get()`.
  - Proposta: devolver o campo também em create e lock.
  - Prioridade: P2.
  - Estado: identificado.
  - Aceite: a linha do Registro não pisca.

- [ ] **UX-016: Unidade da taxa de apelação**
  - Origem: C7.
  - Módulo: OpenSettlement.
  - Contrato: `appealFeeRequired` é texto sem unidade.
  - Proposta: campo de unidade ou ativo.
  - Prioridade: P2.
  - Estado: identificado.
  - Aceite: a confirmação mostra o valor com a unidade.

- [ ] **UX-017: Recuperação por prazo vencido (EXPIRED)**
  - Origem: C8.
  - Módulo: OpenSettlement.
  - Contrato: `settlement.initiateExpiryRecovery` existe.
  - Proposta: ação na tela, depois do OK do CTO no texto, porque abre uma disputa.
  - Prioridade: P2.
  - Estado: identificado, aguardando decisão do CTO.
  - Aceite: o texto e o fluxo são aprovados e a ação aparece só para quem pode usá-la.

- [ ] **UX-018: Campos `timelineDurable` e `timelineStore` no tipo do pacote de prova**
  - Origem: C9.
  - Módulo: SDK.
  - Contrato: o servidor devolve os campos, mas o tipo do SDK os omite.
  - Prioridade: P3.
  - Estado: identificado.
  - Aceite: o tipo inclui os dois campos.

- [ ] **UX-019: Assinatura MULTISIG pela interface (HOLD)**
  - Origem: C11 e Despacho 033.
  - Módulo: OpenSettlement.
  - Contrato: a unidade de `fundedAmount` está em correção com o Principal.
  - Proposta: a correção, o VERIFY do GK e a liberação do HOLD na UI.
  - Prioridade: P1.
  - Estado: bloqueado (HOLD 033).
  - Aceite: assinatura verificada liberada, com evidência do GK.

## Identidade e segurança (OpenIdentity)

- [ ] **UX-020: Backup e recuperação da chave sem custódia central obrigatória**
  - Origem: D1 e Despacho 051, segunda entrega.
  - Módulo: OpenIdentity. Avaliar Pubky/Pear, com os trabalhos anteriores #542, #543 e #545.
  - Contrato: não há fluxo de exportar ou importar a chave.
  - Proposta: recuperação segura, sem custódia central obrigatória, com revisão de senha e de armazenamento de chaves (Despacho 037).
  - Prioridade: P1.
  - Estado: requisito aprovado (051).
  - Issue: #742.
  - Aceite: o usuário recupera a identidade sem depender de um custodiante, e o GK aprova.

- [ ] **UX-021: Bloqueio da sessão por inatividade**
  - Origem: D2.
  - Módulo: interface e OpenIdentity.
  - Contrato: nenhum.
  - Proposta: política de bloqueio que pede a senha de novo.
  - Prioridade: P2.
  - Estado: identificado.
  - Fio solto: `sessionLock`.

- [ ] **UX-022: Endereço de recebimento padrão por ativo**
  - Origem: D3.
  - Módulo: OpenIdentity e SDK.
  - Contrato: nenhum campo no perfil.
  - Prioridade: P2.
  - Estado: identificado.
  - Fio solto: `defaultReceiveAddress`.

- [ ] **UX-023: Avatar público escolhido pelo usuário**
  - Origem: D4.
  - Módulo: OpenIdentity.
  - Contrato: o avatar é gerado da chave, e o estilo escolhido vale só para quem escolheu.
  - Prioridade: P3.
  - Estado: identificado.
  - Fio solto: `publicAvatar`.

- [ ] **UX-024: Conectores Satsails Wallet e WalletConnect**
  - Origem: D5.
  - Módulo: SDK (`WalletAdapter`).
  - Contrato: nenhum conector.
  - Prioridade: P2.
  - Estado: identificado.
  - Fios soltos: `satsailsWallet`, `walletConnect`.

## Plataforma

- [ ] **UX-025: Notificações de negociação**
  - Origem: E1 e Despacho 051, terceira entrega. Sem notificação, o usuário perde prazos e mensagens.
  - Módulo: plataforma.
  - Contrato: nenhum (PROJECT_CONTEXT §2E, "Future").
  - Proposta: eventos duráveis, sem duplicação, com destinatário autorizado e proteção de dados sensíveis. A notificação nunca substitui o estado autoritativo do protocolo.
  - Prioridade: P1.
  - Estado: requisito aprovado (051).
  - Issue: #743. Fios soltos: `notifyTrades`, `notifyChat`, `notifyDisputes`.

**Também identificados, P2/P3, a registrar pelo EPM:**
- E2: nós Sails públicos, privados e manual (fios soltos `publicPrivateServers`, `manualServer`);
- E3: diagnóstico de conexão (`connectionDiagnostics`);
- E4: comunidades (`communities`);
- tradução da interface (em implementação na UI, `language`);
- central de ajuda (`helpCenter`).

## Decisões pendentes do CTO (F)
1. Destino de STACKS, RSK_BTC e SPARK no enum (UX-005).
2. Texto e fluxo da recuperação por prazo (UX-017).
3. Formato do dólar em português.
4. Limites padrão por rede.
