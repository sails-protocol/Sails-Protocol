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
- **Indicadores (recomendação do CTO):** 46 requisitos descobertos (UX-001 a UX-046), 0 homologados.

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
    - Interface implementada: o cartão "Avaliar" no fim do trade já usa a escrita real. O limite de 280 caracteres e o contador já estão aplicados no cartão "Avaliar" (50bc33f6).
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

## Interface (descobertas resolvidas só na UI; sem contrato novo, exceto UX-030)

Origem: sessão de UI, branch `ui/design-system` (sem PR publicada), decisões do Product Owner em `packages/sails-ui/DECISIONS.md`. Registradas aqui para rastreabilidade.

- [ ] **UX-026: Posição do menu no desktop (lateral ou superior), em Aparência**
  - Origem: UI. Módulo: interface. Contrato: nenhum.
  - Estado: implementado na interface (64cc664a); auditoria 264/264. Não homologado.
  - Aceite: a preferência persiste por usuário e funciona em todas as larguras.

- [ ] **UX-027: Aparência: padrão do sistema, escuro ou claro**
  - Origem: UI. Módulo: interface. Contrato: nenhum.
  - Estado: implementado (eb4e11b0). Não homologado.

- [ ] **UX-028: Interface em 5 idiomas (pt-BR, en, es, fr, de)**
  - Origem: UI. Módulo: interface. Contrato: nenhum. Fio solto: `language`.
  - Estado: escolha de idioma implementada; tradução em andamento. Precisa de revisão nativa dos textos de dinheiro e de disputa.
  - Aceite: nenhum texto de dinheiro ou disputa é publicado sem revisão nativa.

- [ ] **UX-029: Temporizador do prazo real do escrow (`escrow.expiresAt`) no cartão da etapa**
  - Origem: UI, inspirado na Binance P2P. Módulo: interface. Contrato: usa só o prazo que já existe.
  - Estado: em implementação. A janela de pagamento completa é UX-012 (#740), que é regra de protocolo e depende de decisão do CTO e do GK.
  - Aceite: mostra apenas prazos reais do servidor.

- [ ] **UX-030: Sem pagamento em dinheiro físico (decisão do Product Owner)**
  - Origem: UI e Product Owner. CASH, CASH_BY_MAIL e LOTERICA_DEPOSIT saem da publicação, do filtro e da demonstração; o boleto é o único depósito. Módulo: interface e, se o PO quiser, backend.
  - Estado: implementado na interface (1f0d6ab1, 9eb13d1a). **Pergunta aberta ao Principal e ao CTO:** o backend deve recusar esses métodos em ofertas novas? Hoje seguem no enum para dados antigos. Relacionado a #735 (vários métodos por oferta).
  - Aceite (se aprovado): publicação com esses métodos recusada no backend e no SDK, sem apagar dados antigos.

- [ ] **UX-031: Reorganização da navegação pela visão do usuário**
  - Origem: UI e Product Owner. Módulo: interface. Contrato: nenhum.
  - Proposta: menu Market, Trades, Perfil e Configurações. Trades com abas Ativos, Histórico, Minhas ofertas (criar, pausar e cancelar) e Disputas (sai do menu principal e vira aba com contador). Configurações por ordem de uso: Wallet, Aparência, Idioma, Notificações, Segurança, Nó Sails, Comunidades e Ajuda. As rotas antigas redirecionam.
  - Prioridade: P2 (definida pelo Product Owner; em execução logo após o temporizador UX-029).
  - Estado: aprovado pelo Product Owner, a implementar. Não homologado.

- [ ] **UX-032: Visão do árbitro (lista de arbitragem e condução dos casos)**
  - Origem: UI. Módulo: OpenSettlement / arbitragem. Fase futura, depois de concluir a visão do usuário.
  - Prioridade: P3 (fase futura).
  - Estado: contrato a levantar. 

- [ ] **UX-033: Visão white-label (wallet integradora com a própria marca)**
  - Origem: UI. Módulo: interface e `@satsails/sdk-react`. Tokens e logo por marca. Fase futura.
  - Prioridade: P3 (fase futura).
  - Estado: contrato a levantar. 

- [ ] **UX-034: Visão do operador de nó Sails (saúde, configuração e métricas do servidor)**
  - Origem: UI. Módulo: plataforma. Equipe que mantém um servidor do protocolo. Fase futura.
  - Prioridade: P3 (fase futura).
  - Estado: contrato a levantar. 

- [ ] **UX-035: Janela entre o fim do prazo do escrow e o encerramento registrado pelo nó**
  - Origem: UI, ao construir o temporizador (UX-029, cad602d6). Fonte reportada: `escrow.service.ts` `sweepExpiredEscrows()` e `escrow-lifecycle.ts` (a confirmar pelo Principal).
  - Módulo: OpenSettlement. Ligado a UX-012 (C12, #740).
  - Contrato: entre `escrow.expiresAt` e a próxima varredura o escrow segue FUNDS_LOCKED; o horário da varredura não é exposto e não está definido se `markPaymentSent` é aceito depois de `expiresAt`.
  - Proposta: regra de contrato para ações depois de `expiresAt`, ou um campo `expiryEnforcedAt`.
  - Prioridade: P1.
  - Estado: requisito levantado pela UI, não aprovado. Interface já corrigida (83eecc91): nessa janela o cartão mostra "Prazo do escrow encerrado" e não pede pagamento.
  - Issue: comentário na #740.

- [ ] **UX-036: Desfecho declarado do fim do prazo (reembolso automático ou EXPIRED com recuperação por disputa)**
  - Origem: UI. Módulo: OpenSettlement. Ligado a UX-017 (C8) e UX-012.
  - Contrato: o escrow não declara se o fim do prazo leva a reembolso automático ou a EXPIRED com recuperação por disputa; a UI teria de deduzir pelo tipo.
  - Proposta: campo declarado, por exemplo `expiryOutcome`: `auto_refund` ou `expired_dispute_recovery`.
  - Prioridade: P2.
  - Estado: requisito levantado pela UI, não aprovado.

- [ ] **UX-037: Sem timelock on-chain no script MULTISIG: depois do prazo não há reembolso unilateral**
  - Origem: UI. Módulo: OpenSettlement (MULTISIG). Para UX-012 (C12, #740) e revisão do GK.
  - Contrato (reportado, a verificar): depois do prazo não existe caminho de reembolso unilateral, só a varredura do servidor.
  - Estado: observação de segurança levantada pela UI, a verificar pelo Principal e pelo GK; nenhuma decisão. A UI não promete reembolso (frase sem lastro removida em cad602d6).
  - Prioridade: P2.

- [ ] **UX-038: Ícone de notificações na barra (sino com contador e lista)**
  - Origem: UI e Product Owner. Módulo: interface. Depende de UX-025 (E1, #743).
  - Prioridade: P2.
  - Estado: levantado; sem contador inventado até existir o sistema de notificações.

- [ ] **UX-039: "Novidades" (notas de versão do produto com indicador de não lido)**
  - Origem: UI e Product Owner. Módulo: interface e conteúdo. Botão visível na tela principal.
  - Prioridade: P3.
  - Estado: levantado. Pendência: quem escreve e publica as notas.

- [ ] **UX-040: Anexar arquivo (comprovante no chat do trade e evidência de disputa)**
  - Origem: UI e Product Owner. Módulo: SDK, backend, OpenProof. Revisão de segurança do GK.
  - Contrato: hoje a disputa aceita só `uri`; falta upload no SDK, armazenamento com privacidade e limites de tipo e tamanho.
  - Prioridade: P2.
  - Estado: levantado, não aprovado.

- [ ] **UX-041: Lista de moedas fiduciárias**
  - Origem: UI e Product Owner. Comparar Binance P2P, Airtm, El Dorado e Hodl Hodl e completar o que o backend aceita. Ligado a UX-008 (B3) e #623.
  - Prioridade: P2.
  - Estado: levantado.

- [ ] **UX-042: Métodos de pagamento conforme a moeda**
  - Origem: UI e Product Owner. Mapa moeda para métodos (ex.: PIX só BRL; EUR e USD com muitos métodos; sentido aceita e envia). O Principal avalia a validação no backend. Ligado a UX-004 (#735) e UX-030.
  - Prioridade: P2.
  - Estado: levantado, não aprovado.

- [ ] **UX-043: Seletor de nó Sails em Configurações**
  - Origem: UI e Product Owner, com inspiração Mostro: lista de nós (operador, região, status, taxa, limites, custódia declarada) e "adicionar seu próprio nó" com aviso.
  - Correção (UI, após esclarecimento do Product Owner e leitura de #147, ADR-001 e PROJECT_CONTEXT §2D item 12): mercado fechado NÃO é "nó privado". O nó mantém a rede (infraestrutura e serviço); o mercado público é da rede inteira. Mercado privado é conceito separado (UX-045) e pode rodar em nó compartilhado ou próprio (#147: quem hospeda o nó não define quem pertence ao mercado). O seletor de nó escolhe a infraestrutura e nunca troca de mercado. Regras Sails: ADR-001 "Node choice must not define market membership" e #361; a tela não sugere livro de ofertas por nó.
  - Contrato a levantar: catálogo e descoberta de nós (ADR-001 §6), metadados e identidade do nó. Ligado a UX-034 (E2).
  - Prioridade: P2.
  - Estado: interface prevista como item 1.4 do plano #746, com dados simulados e marcados na demonstração.
  - **CTO 28, Complemento ao Despacho 055 (texto relatado pela UI; original com o Alan):** a arquitetura de identidade e mercados privados fica consolidada: Pubky e Pears fazem parte da stack planejada do Sails Protocol. O mecanismo **Sails Market Invite** será nativo e interno ao protocolo, sob responsabilidade de OpenP2P, integrado ao OpenIdentity. **Não utilizar Nostr, npub nem convites gerenciados por serviços externos.** A UI apresenta uma experiência própria do Sails para adicionar nós e entrar em mercados privados. O Principal especifica o formato de convite e as garantias de autorização, revogação e portabilidade, reutilizando a infraestrutura existente, sem transferir a autoridade dos mercados para Pubky, Pears ou operadores de nós. Elementos: Sails Node ID (identifica o nó), Sails Market ID (o mercado, independente do nó) e Sails Market Invite (credencial verificável); uma chave pública, sozinha, não é uma autorização de acesso. Decisão arquitetural registrada; implementação e ativação seguem sujeitas aos gates técnicos e de segurança. Interface: dois fluxos separados (Adicionar nó Sails; Entrar em mercado privado, com convite ou credencial Sails, QR Code e os estados validando, pendente, concedido, expirado e revogado), sem inventar prefixos ou formatos, sem senha compartilhada e sem criptografia própria; entregável da UI são protótipos com dependências de backend explícitas e controles "Em breve".
  - **Refinamento do Product Owner (via UI; DECISIONS.md da UI):** em Configurações, Nó Sails, a primeira opção, ativa por padrão, é "Rede Sails (pública)": o conjunto de nós que mantêm o mercado aberto, não um único servidor. Abaixo, o número real de nós ativos e de operadores, com a lista de nós como detalhe. Texto sem exagero (#361): "várias equipes" ou "descentralizada" só quando o dado mostrar operadores independentes (vários servidores de um operador é redundância). Mercado privado por dois caminhos: (1) nó privado próprio, numa VPS; (2) rede pública, sem servidor próprio; em ambos a pessoa cria a sua sala ou mercado privado. **Nomenclatura:** "sala privada" é candidato proposto pelo Product Owner; o nome oficial segue em aberto no backlog e a UI usa "mercado privado" até decidir.
  - **Estrutura da seção Nó Sails (referência visual do CTO, via UI; original com o Alan):** (1) "Rede Sails" (Mercado público, Nós independentes, selo Padrão); (2) "Adicionar nó Sails" (conectar a um nó próprio ou de outro operador); (3) "Criar ou entrar em mercado privado" (usar nó próprio ou compartilhado). "Nós independentes" só aparece quando o dado mostrar mais de um operador independente (#361). Mercados privados por dois caminhos (nó privado em VPS ou infraestrutura própria; nó público compartilhado); nos dois, criar comunidade privada, convidar e definir permissões (#147). Identificadores: Sails Node ID (infraestrutura), Sails Market ID (mercado, independente da infraestrutura) e Sails Market Invite (convidar e autorizar).

- [ ] **UX-044: Consultar "minhas disputas como parte" e a contagem de abertas**
  - Origem: UI, descoberto na reorganização da navegação (UX-031). Módulo: OpenSettlement e SDK.
  - Contrato (reportado, a verificar): `listDisputes()` devolve só a fila do árbitro; não há consulta das disputas em que o usuário é comprador ou vendedor, nem contagem de abertas (`total` inclui resolvidas e a página é limitada a 50).
  - Proposta: consulta paginada das disputas do participante e contagem das abertas no SDK.
  - Contorno na UI: a aba Disputas lista os próprios trades com status DISPUTED (dado real) e mostra a fila do árbitro numa seção separada só quando existir.
  - Prioridade: P2.
  - Estado: levantado pela UI, não aprovado.

- [ ] **UX-045: Mercados privados e seletor de mercado**
  - Origem: UI e Product Owner, após o esclarecimento nós x mercados. Módulo: OpenP2P (composição), OpenIdentity (CapabilityGrant, RFC-005) e políticas por implantação.
  - Proposta técnica: composição de visibilidade da descoberta, CapabilityGrant (RFC-005) e políticas por implantação, não uma primitiva nova. Falta prova de composição e, se for insuficiente, decisão de produto antes de arquitetura (CTO).
  - Proposta de interface: seletor de mercado no topo do Market ("Mercado público" e os mercados de que a pessoa participa), retomando o protótipo D1 da PR #727; gestão em Configurações, Comunidades (fio solto `communities`); cada mercado mostra em que nó está hospedado só como informação.
  - Prioridade: P3 ou a decidir pelo CTO. Nome oficial em aberto (BACKLOG: Public/Private Markets/Servers).
  - Estado: levantado, não aprovado. Relacionado a UX-043, UX-034 e UX-005.
  - **Fonte canônica: #147** (Institutional Memory: Private Market ≠ Private Infrastructure), editada diretamente pelo CTO em 2026-11-21. Esta entrada só vincula; não duplica a issue.
  - Princípios definitivos registrados na #147: (1) autonomia dos mercados (o Sails não controla, aprova, cura nem prescreve o comportamento comercial de mercados operados de forma independente); (2) neutralidade do Sails (permissões configuráveis; casos de uso são exemplos, nunca modelos de negócio predefinidos nem padrões); (3) soberania dos usuários (o administrador revoga o acesso ao próprio mercado, mas não apaga a identidade portátil nem a reputação global, nem toma fundos); (4) infraestrutura independente (nó privado ou compartilhado; mercado privado não exige infraestrutura privada).
  - Pergunta "só a empresa publica ou os clientes negociam entre si?": resolvida pelo CTO: o protocolo não decide; cada mercado escolhe.
  - Especificação aberta (checklist de 10 itens na #147): identidade, governança e papéis do mercado; convites (emissão, aceitação, revogação, expiração, recuperação); modelo de autorização neutro e configurável; autorização nas camadas de API, SDK e eventos, não só na UI; descoberta nó-mercado sem vazar membros nem ofertas; isolamento multi-mercado e fronteiras de confiança do operador; portabilidade e migração de nó; contratos de UX e testes de aceitação; vínculo a este registro e ao Project #3 sem issues canônicas duplicadas; revisão de projeto e segurança por Principal, GK e CTO antes de qualquer implementação.
  - Fronteiras: operador de nó, administrador de mercado e participante são papéis distintos; hospedar um nó não dá autoridade para adicionar ou remover membros, assinar pelos usuários, tomar fundos, arbitrar ou liquidar. Mercado privado não é automaticamente privado de ponta a ponta (metadados visíveis ao operador exigem modelo de ameaça).
  - Interface (UI): permissões configuráveis e apenas exemplos de casos de uso, nunca presets impostos.
  - Autorização: nenhuma implementação, migração, deploy ou ativação (gate documental da #147).
  - **Reforço do CTO (2026-11-21; texto relatado pela sessão de UI, original com o Alan):** os modelos de interface **Vitrine** (publicam administradores ou participantes autorizados; negociam clientes e membros autorizados), **Comunidade** (todos os membros autorizados publicam e negociam) e **Personalizado** (evolução futura, regras mais granulares) são propostas de UX iniciais, **não modelos comerciais impostos pelo protocolo**. O Sails fornece mecanismos de autorização configuráveis para que cada comunidade ou empresa defina quem publica ofertas, vê negociações e participa. As permissões são verificadas no backend e no protocolo, nunca só na interface. O administrador gerencia a participação no próprio mercado, mas não controla chaves, fundos, identidade portátil nem reputação global dos participantes. Mercados fechados funcionam em nós privados e compartilhados.
  - Responsabilidades: o Principal especifica o modelo técnico de permissões; o GK valida os limites de autoridade antes de qualquer implementação. Não criar issue nova nem reabrir a discussão; o vínculo é com a #147 e com este registro. Nenhum GO de implementação ou de ativação econômica está implícito.
  - **Conectar a um nó e entrar em um mercado privado são duas operações diferentes** (CTO, via UI; original com o Alan): o nó é infraestrutura, escolhido pela chave pública (inspiração Mostro); o mercado privado se entra por convite ou chave de acesso emitida pelo administrador, válida em qualquer nó que hospede o mercado. A forma exata do convite sai da especificação da #147. Interface (só registro visível, sem mercado fechado funcional): Configurações, Comunidades, com casos de uso, os modelos Vitrine e Comunidade e o botão "Entrar em um mercado com convite" desabilitado ("Em breve"); no seletor de nó, "Adicionar seu próprio nó" fica separado de "Entrar em um mercado". Item 1.4 da #746.
  - **Especificação técnica (rev2, GO documental do GK, 2026-11-21):** https://github.com/sails-protocol/Sails-Protocol/issues/147#issuecomment-7055877448 (rev2, substituída pela rev3 abaixo). É documento, não GO de implementação. Continuam em STOP: implementação (Tier 3), migrações, D1 (adendo datado §1.1 da ADR-001, decisão do CTO) e a auditoria de `ws-auth.ts` e `relay.routes.ts` antes do desenho final do §6.3.
  - **CTO 28, Complemento ao Despacho 055 (texto original conferido pelo EPM):** a arquitetura de identidade e mercados privados fica consolidada: Pubky e Pears fazem parte da stack planejada do Sails Protocol. O mecanismo **Sails Market Invite** será nativo e interno ao protocolo, sob responsabilidade de OpenP2P, integrado ao OpenIdentity. **Não utilizar Nostr, npub nem convites gerenciados por serviços externos.** A UI apresenta uma experiência própria do Sails para adicionar nós e entrar em mercados privados. O Principal especifica o formato de convite e as garantias de autorização, revogação e portabilidade, reutilizando a infraestrutura existente, sem transferir a autoridade dos mercados para Pubky, Pears ou operadores de nós. Elementos: Sails Node ID (identifica o nó), Sails Market ID (o mercado, independente do nó) e Sails Market Invite (credencial verificável); uma chave pública, sozinha, não é uma autorização de acesso. Decisão arquitetural registrada; implementação e ativação seguem sujeitas aos gates técnicos e de segurança. Interface: dois fluxos separados (Adicionar nó Sails; Entrar em mercado privado, com convite ou credencial Sails, QR Code e os estados validando, pendente, concedido, expirado e revogado), sem inventar prefixos ou formatos, sem senha compartilhada e sem criptografia própria; entregável da UI são protótipos com dependências de backend explícitas e controles "Em breve".
  - **CTO 28, Despacho 055 (original, 2026-11-21): identidade de nós e acesso a mercados privados.** Decisões: (1) mercado fechado não exige nó privado; (2) um nó pode hospedar múltiplos mercados independentes; (3) identidade do nó, identidade do mercado e autorização de participação são conceitos distintos; (4) o Sails não adota npub/Nostr como requisito de identificação de nós ou de entrada em mercados; (5) o protocolo oferece identificadores e credenciais Sails verificáveis; (6) Pubky/PKARR são candidatos a apoiar identidade e descoberta, sujeitos à avaliação técnica; (7) administradores definem regras de participação no próprio mercado, sem controle sobre identidade global, reputação ou fundos; (8) Vitrine e Comunidade são modelos opcionais de UX, não restrições arquiteturais.
  - Critérios da proposta técnica: comparar alternativas existentes antes de introduzir novos formatos ou infraestrutura; demonstrar como uma credencial é verificada, revogada e recuperada em outro aplicativo compatível, sem confiar exclusivamente no operador de um nó. Análise de segurança do GK: falsificação de convites, vazamento de informações, isolamento entre mercados e limites de autoridade do operador.
  - Autorização: GO para documentação, análise técnica, prototipação e testes isolados. STOP para implementação produtiva, migrações persistentes, merge e ativação sem gates próprios. F4b/M-1b e demais bloqueadores econômicos mantêm a prioridade.
  - **Status separados (Despacho 055):** [ ] UX (protótipos da UI, #746 item 1.4) | [x] Especificação documental (rev3 com GO documental condicionado do GK; sem GO de implementação) | [ ] Implementação | [ ] Homologação.
  - Dependência declarada pelo Principal: Node ID estável, hoje um gap do Day 0 (ADR-001 §7).
  - **Especificação técnica rev3 (adendo Sails Market Invite, §13; GO documental condicionado do GK a C1, C2 e C3, incluídos):** https://github.com/sails-protocol/Sails-Protocol/issues/147#issuecomment-7055999567. Substitui a rev2. É documento, não GO de implementação. Dois tipos de convite (BOUND, preso à chave da pessoa; REQUEST, um pedido que apenas a governança aprova); Node ID, Market ID e identidade do participante separados; QR Code só como transporte; sem Nostr, npub nem segredo; Pubky e Pears sem autoridade. Resíduo A10: um convite vazado não dá acesso, mas revela que o mercado existe e onde está hospedado. `member.invite` fora da v1. Dependência: Node ID estável (gap do Day 0, ADR-001 §7).
  - **Refinamento do Product Owner (via UI; DECISIONS.md da UI):** em Configurações, Nó Sails, a primeira opção, ativa por padrão, é "Rede Sails (pública)": o conjunto de nós que mantêm o mercado aberto, não um único servidor. Abaixo, o número real de nós ativos e de operadores, com a lista de nós como detalhe. Texto sem exagero (#361): "várias equipes" ou "descentralizada" só quando o dado mostrar operadores independentes (vários servidores de um operador é redundância). Mercado privado por dois caminhos: (1) nó privado próprio, numa VPS; (2) rede pública, sem servidor próprio; em ambos a pessoa cria a sua sala ou mercado privado. **Nomenclatura:** "sala privada" é candidato proposto pelo Product Owner; o nome oficial segue em aberto no backlog e a UI usa "mercado privado" até decidir.
  - **Estrutura da seção Nó Sails (referência visual do CTO, via UI; original com o Alan):** (1) "Rede Sails" (Mercado público, Nós independentes, selo Padrão); (2) "Adicionar nó Sails" (conectar a um nó próprio ou de outro operador); (3) "Criar ou entrar em mercado privado" (usar nó próprio ou compartilhado). "Nós independentes" só aparece quando o dado mostrar mais de um operador independente (#361). Mercados privados por dois caminhos (nó privado em VPS ou infraestrutura própria; nó público compartilhado); nos dois, criar comunidade privada, convidar e definir permissões (#147). Identificadores: Sails Node ID (infraestrutura), Sails Market ID (mercado, independente da infraestrutura) e Sails Market Invite (convidar e autorizar).

- [ ] **UX-046: Estado compartilhado entre os nós da rede pública**
  - Origem: UI e CTO (via Product Owner). Módulo: plataforma e OpenP2P. Ligado a #105 (multioperador), #361 e UX-043.
  - Questão: vários nós disponíveis não significam automaticamente que todos compartilham o mesmo estado. Falta especificar a distribuição e a sincronização de ofertas, a descoberta e as atualizações entre nós, aproveitando o Pears (ADR-001 §6).
  - Regra para a interface: nunca afirmar sincronização que não existe (fio solto `nodeStateSync`).
  - Prioridade: a decidir pelo CTO.
  - Estado: levantado, não aprovado.

## Decisões pendentes do CTO (F)
1. Destino de STACKS, RSK_BTC e SPARK no enum (UX-005).
2. Texto e fluxo da recuperação por prazo (UX-017).
3. Formato do dólar em português.
4. Limites padrão por rede.
