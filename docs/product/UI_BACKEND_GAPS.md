# Lacunas entre a interface e o backend/SDK

> Espelho de leitura do registro [PRODUCT_REQUIREMENTS_REGISTRY.md](PRODUCT_REQUIREMENTS_REGISTRY.md); em caso de divergência, o registro prevalece. IDs originais (A1, B1, C1, C12...) mapeiam para UX-NNN no registro. Issues: C1 #737, C2 #738, C3 #739, C12 #740, B1 #741, D1 #742, E1 #743; A3 #735; A4 #734; fios soltos #729.

Levantado durante o trabalho de UI e UX (2026-11-20), base `ui/design-system` @ 9eb13d1a. Cada item foi conferido contra o SDK (`packages/sails-sdk`) e as rotas do servidor.

A UI já mostra todos esses itens de forma honesta, como "Em breve" ou sem número inventado, e eles estão ligados à lista de fios soltos (`lib/looseWires.ts`, issue #729). Nada aqui pede merge, migração ou ativação: são pedidos de especificação.

Prioridade sugerida:
- **P1:** afeta a decisão ou a segurança do usuário no fluxo principal.
- **P2:** melhora a confiança e a clareza.
- **P3:** conveniência.

## A. Já aprovado no Despacho 039 (só acompanhar)

| # | Item | Situação |
|---|---|---|
| A1 | Ler avaliações (média, quantidade, comentários recentes) | Só existe `reputation.rate()` para gravar. A UI simula na demonstração e mostra "★ 4,8 (126)" na lista assim que o dado existir. |
| A2 | Data de cadastro (mês/ano) nos dados públicos do anunciante | `PublicOfferSeller` não tem `createdAt`. |
| A3 | Vários métodos de pagamento (até 5) e escolha do método no trade | Issue #735. `openp2p.trade()` não recebe método. |
| A4 | Catálogo de 14 pares e trava de provider na publicação | Issue #734. Só 4 pares existem no enum e só BTC on-chain tem rail de produção. |

## B. Market e ofertas

| # | Prio | O que falta | Por que importa na tela | Contrato sugerido |
|---|---|---|---|---|
| B1 | P1 | A listagem de ofertas (`discover`) não devolve quem é o anunciante (id/chave pública) | A lista não consegue mostrar o avatar da pessoa nem abrir o perfil dela; aparece um avatar genérico | `makerId` e `makerPublicKey` (ou `PublicParticipant` resumido) no resumo da oferta |
| B2 | P2 | Presença (online) fora do chat do trade | Exchanges P2P mostram "online agora" na lista; hoje só existe dentro da sala do trade | Sinal de presença público e opcional, com consentimento |
| B3 | P3 | Moeda de exibição (BRL e outras) | Hoje só USD é preço real; quem pensa em reais converte de cabeça | Fonte de câmbio no SDK, sempre exibida como referência e nunca como preço do trade |

## C. Trade

| # | Prio | O que falta | Por que importa na tela | Contrato sugerido |
|---|---|---|---|---|
| C1 | P1 | Horário de "Pagamento marcado como enviado" (e de cada etapa) | A etapa mais sensível do trade aparece sem hora; prazo e disputa dependem dela | `paymentMarkedAt` no Escrow, ou confirmar que a timeline do trade traz as transições do escrow |
| C2 | P1 | Dados de recebimento do vendedor numa oferta de COMPRA | Quando quem anuncia compra, o vendedor não tem onde informar como quer receber; hoje só "combine pelo chat" | `sellerPaymentDetails` no nível do trade, gravado pelo vendedor e lido pelo comprador |
| C3 | P1 | Quem age depois que todas as assinaturas chegam | O trilho fica sem "vez de ninguém" e o usuário não sabe se precisa fazer algo | Estado ou evento de broadcast exposto ao cliente |
| C4 | P2 | Depósito visto antes do bloqueio (MULTISIG) | A etapa "Depósito" fica parada até o bloqueio registrar a saída; o vendedor não sabe se o depósito foi visto | Estado "depósito observado" (com profundidade de confirmação) antes de FUNDS_LOCKED |
| C5 | P2 | Profundidade de confirmação da transação de pagamento | Hoje só existe o txid; a UI nunca pode dizer "confirmada" | Campo de confirmações/estado de broadcast da `txReleaseId` |
| C6 | P2 | `custodyModel` some nas respostas de criar/bloquear o escrow | A linha "Modelo de custódia declarado" pisca até a próxima leitura | Devolver `custodyModel` também em create/lock |
| C7 | P2 | Unidade da taxa de apelação (`appealFeeRequired` é texto sem unidade) | A confirmação de apelação não pode mostrar o valor sem a unidade | Campo de unidade/ativo junto do valor |
| C8 | P2 | Recuperação por prazo no EXPIRED (`settlement.initiateExpiryRecovery`) | O SDK já tem a função, mas a tela não oferece a ação porque ela abre uma disputa | OK do CTO no texto e no fluxo |
| C9 | P3 | Prova do trade (`getTradeEvidenceBundle`): `timelineDurable` e `timelineStore` | O servidor devolve esses campos, mas o tipo do SDK os omite | Acrescentar ao tipo `TradeEvidenceBundle` |
| C10 | P3 | Progresso da aprovação dupla (RFC-015, `getReleaseApprovals`) | Só faz sentido se a opção estiver ligada no deploy | Confirmar se o Day 0 liga `requireDualApprovalForRelease` |
| C12 | P1 | Temporizador do trade no estilo Binance: janela de pagamento | Hoje o único prazo é o do escrow (`expiresAt`/`timelockHours`, horas). Não existe prazo curto para pagar, nem cancelamento automático, nem prazo para o vendedor liberar, nem espera antes de apelar. O usuário fica sem saber quanto tempo tem em cada fase | Na oferta, `paymentWindowMinutes`, escolhido pelo anunciante entre opções fixas (ex.: 15/30/45/60). No trade, `paymentDeadline` (horário-limite). Cancelamento automático no backend se o pagamento não for marcado a tempo. Prazo de liberação do vendedor e horário em que a apelação abre (`appealAvailableAt`). Todos os horários vêm do servidor |
| C11 | P1 | Assinatura MULTISIG pela interface em HOLD | Depende da correção da unidade de `fundedAmount` (Despacho 033), com o Principal | Correção + VERIFY do GK, depois liberar o HOLD na UI |

## D. Conta, identidade e segurança

| # | Prio | O que falta | Por que importa na tela | Contrato sugerido |
|---|---|---|---|---|
| D1 | P1 | Backup e recuperação da chave | Quem perde a chave perde o acesso; hoje não há fluxo de exportar ou importar | Exportação e importação cifradas e fluxo de recuperação (com revisão de segurança, como o Despacho 037 pediu) |
| D2 | P2 | Bloqueio da sessão por inatividade | Proteção básica num app financeiro | Política de bloqueio sobre a sessão local (pedir a senha de novo) |
| D3 | P2 | Endereço de recebimento padrão por ativo | O usuário digita o endereço a cada trade | Campo no perfil (SDK + backend) |
| D4 | P3 | Avatar público escolhido pelo usuário | Hoje o avatar é gerado da chave e só a pessoa vê o estilo escolhido | Campo de perfil no servidor |
| D5 | P2 | Conectores de wallet: Satsails Wallet e WalletConnect | Aparecem como "Em breve" na tela de conectar | Conectores `WalletAdapter` |

## E. Plataforma

| # | Prio | O que falta | Por que importa na tela | Contrato sugerido |
|---|---|---|---|---|
| E1 | P1 | Notificações (novo trade, mudança de estado, mensagem, disputa, prazo) | Sem notificação, o usuário perde prazos e mensagens se não estiver com a tela aberta | Sistema de notificações (PROJECT_CONTEXT §2E, "Future") |
| E2 | P2 | Lista de nós Sails públicos/privados e nó manual | A seção Nó Sails só mostra "Automático" | Catálogo de endpoints e reinicialização do `SailsClient` |
| E3 | P3 | Diagnóstico de conexão (saúde e latência do nó) | Ajuda o suporte e dá confiança | Chamada de saúde no SDK |
| E4 | P3 | Comunidades e mercados restritos | Aparece como "Em breve" | Contrato de associação no SDK |

## F. Decisões que dependem do CTO

1. **Enum de ativos:** STACKS, RSK_BTC e SPARK continuam no `AssetType`? Estão fora dos 14 (issue #734).
2. **Recuperação por prazo (C8):** OK no texto e no fluxo, que abre uma disputa.
3. **Formato do dólar em português:** "US$ 97.800,00" (adotado) ou "$97,800.00".
4. **Limites padrão por rede:** por exemplo, Lightning com teto menor. Hoje valem os limites de cada oferta, e Lightning está fora do Day 0.
