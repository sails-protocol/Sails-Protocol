# Market Spaces (CTO 31): mercados P2P independentes e personalizáveis

> **Implementation status (English summary):** this document is a design direction and a UI demonstration. No market model, route or service exists in the reference implementation yet. Ownership and recovery are specified in [ADR-008](../../adr/ADR-008-portable-identity-market-ownership.md) and summarized in the last section. The rest of this file is still in Portuguese; a translation pass is planned.

> **Status:** visão aprovada conceitualmente pelo CTO (2026-11-22). **Decisão do PO (2026-11-22): Market Spaces entra no escopo Day 0; a ratificação formal do CTO do recorte Day 0 vem com a proposta técnica. Não implementado.** Este documento registra a decisão de produto e arquitetura; o mapeamento técnico (o que já existe, o que é reaproveitável, o que é novo) e a proposta de escopo são entregas separadas. Rastreabilidade: GitHub Project #3 (cartão "Market Spaces").

## 1. Visão
Market Spaces são mercados P2P independentes e personalizáveis criados sobre o Sails Protocol. O **Sails Market** é a primeira implementação de referência, mas a capacidade **não é exclusiva da sua interface**: integradores dos SDKs poderão criar e administrar mercados nas próprias aplicações.

É uma camada comercial e de experiência **sobre** a arquitetura existente. Preserva integralmente: arquitetura P2P e permissionless; autocustódia e garantias econômicas; SDKs portáteis e módulos plugáveis; identidade e reputação portáteis; escrow, disputas, arbitragem e liquidação; independência entre protocolo, nós, operadores e aplicações; Design System e padrões de experiência.

## 2. Capacidades a prever nos contratos e serviços
Identidade e metadados do mercado; administrador e permissões administrativas; mercado público ou privado; categorias e descoberta; associação de ofertas a mercados; participação, convites e políticas de acesso; políticas opcionais de verificação de identidade (KYC feito pelo administrador ou por seus provedores); referências de reputação; marca, ícone e banner; possibilidade futura de serviços comerciais pagos.

Reutilizar os módulos existentes (OpenP2P, OpenIdentity, OpenReputation e demais) sempre que possível. Não criar um módulo novo (por exemplo, "OpenMarkets") antes de avaliar a composição.

## 3. Limites de segurança (invariantes)
As regras definidas por um administrador de mercado **não podem**: alterar unilateralmente o destino de fundos em escrow; contornar assinaturas ou regras de liquidação; invalidar direitos de participantes em negociações já estabelecidas; transformar credenciais autodeclaradas em autorização econômica privilegiada; impor dependência obrigatória da Satsails para usar o protocolo. Mercados privados exigem **controle real de acesso e de distribuição de informação**, não apenas ocultação visual na interface.

Limites adicionais (revisão do Gatekeeper):
- **Arbitragem:** ser administrador de um mercado **não dá papel de árbitro**. A designação e a decisão do árbitro seguem **somente as regras do protocolo (ADR-005)**; o administrador não designa a si mesmo, a afiliados nem um árbitro escolhido por ele. Motivo: o árbitro participa da liquidação do escrow; o poder sobre ela não pode ser concentrado em quem administra o mercado.
- **Taxas:** as taxas são **informadas e vinculadas aos termos antes do compromisso**. O administrador não acrescenta saída nem perna de taxa à liquidação; a perna de taxa permanece exatamente a do protocolo.

A especificar (recomendações do Gatekeeper para a especificação técnica): a reputação local do mercado não escreve na reputação portável; o administrador não acessa chaves, endereços, mensagens nem dados privados, e o KYC fica com ele ou com o provedor dele, nunca no protocolo; as negociações abertas continuam se o mercado fechar; o controle de acesso do mercado privado vale no nó, na API e no relay, e uma revogação não apaga o que já foi compartilhado.

## 4. Modelo comercial
- **Sails Protocol:** infraestrutura aberta e reutilizável.
- **Satsails / Sails Market:** produtos comerciais de criação, hospedagem, descoberta, personalização e operação de mercados.
- **Compra do espaço:** a compra é **definitiva, por pagamento único, sem mensalidades** (decisão de produto do CTO).
- **Independência:** a compra de um espaço na Satsails **não é requisito** para utilizar o protocolo permissionless. Qualquer pessoa ou integrador pode usar o protocolo e criar mercados por conta própria, sem a Satsails.
- **Preços:** os preços exibidos na demonstração são **fictícios, apenas de demonstração**, e **não** são os preços comerciais definitivos, que serão definidos separadamente.
- **Pagamentos futuros** em BTC, USDT e USDC previstos; **nenhuma cobrança real** nesta etapa. Oferta futura de nós Sails gerenciados.

### 4.1 Decisão CTO 36 (2026-11-22)
- **Compra única, sem assinatura.** Preços de demonstração **fictícios**: US$ 497 / US$ 997 / US$ 1.997; não aprovados para cobrança real. A compra não é requisito para implementações independentes do protocolo.
- **Três modalidades de infraestrutura:** Public Network (hospedagem compartilhada), Self-Hosted (nó próprio) e Managed Node White Label (contratação semestral ou anual, nunca mensal). Contratar um nó não gera direito automático a taxas.
- **Merchant Program** (Merchant / Pro / Elite; nomes e critérios a homologar): sem vantagem em arbitragem, disputas ou segurança; a compra de um espaço não concede o nível máximo.
- O selo "Mercado ativo" mede atividade, não identidade.
- O Merchant Program permanece **proposta**: não há taxas nem descontos homologados; qualquer benefício depende da política econômica global.

## 5. Responsabilidades
CTO define e aprova a visão; EPM registra a decisão, mantém a documentação e o Project #3 e acompanha a execução; Principal avalia e implementa contratos, serviços e SDKs; UI implementa a experiência conforme a especificação aprovada; Gatekeeper verifica que a implementação preserva as garantias de segurança do protocolo.

## 6. Demonstração (UI)
A UI pode construir a demonstração completa (Mercado Aberto, Comunidades, Mercados Privados, Meus Mercados, Explorar Mercados, Criar Mercado, convites e regras de entrada, identidade visual e páginas próprias, demonstração de contratação de espaço) com **mocks e fixtures identificados como demonstração**, sem duplicar lógica econômica na interface.

## 7. Escopo
Por decisão do PO, Market Spaces integra o Day 0; a UI constrói a experiência e o Principal a camada de contratos, em diálogo direto. O mapeamento objetivo (implementado, parcialmente reaproveitável, contratos novos, exclusivamente comercial, roadmap) e a proposta técnica enxuta definem o recorte exato do que entra no Day 0 e o que fica em roadmap; o CTO ratifica o recorte. Os limites de segurança da seção 3 valem desde já.

## 8. Nomenclatura e composição
"Market Spaces" é o nome técnico **provisório**. Como capacidade futura do protocolo, o nome sugerido é **OpenMarkets**, **registrado apenas como nome: nenhum módulo novo é criado agora.** Antes de qualquer módulo, avalia-se como a capacidade se compõe com OpenP2P, OpenIdentity, OpenReputation e OpenSettlement (mapeamento do Principal).

## 9. Tipos de mercado e experiência de demonstração (aprovados pelo CTO via PO)
- **Tipos oficiais:** **Mercado aberto** (a rede, gratuito, padrão), **Comunidades** (mercados públicos criados por qualquer pessoa) e **Mercados privados** (por convite).
- **Experiência aprovada:** "Meus mercados" (grade ou lista); página própria por mercado; criação de mercado com ícone 1:1 e banner 3:1; política opcional de KYC com o provedor do próprio administrador; login social opcional (X, LinkedIn, GitHub); selo **P2P** ou **Empresa/OTC** por mercado; selo "Verificado" **somente na demonstração**.
- **Somente demonstração ou roadmap (nada real):** compra de espaço (produto Satsails, pagamento único; **preços fictícios de demonstração: US$ 497 / 997 / 1.997, não são os preços comerciais definitivos**); nó gerenciado ("Em breve"); chat em grupo (roadmap). Nenhum pagamento, KYC ou provisionamento reais nesta etapa.
- Decisões de interface registradas em `packages/sails-ui/DECISIONS.md`.

## Ownership and administrative recovery

A market is owned by an identity, not by the node that hosts it, the device that created it or the wallet that paid for it. Hosting, ownership and data availability are separate responsibilities, and the same contract applies to a public node and to a self-hosted node. The decision, its limits and the user journey are in [ADR-008](../../adr/ADR-008-portable-identity-market-ownership.md); the diagrams are in [SYSTEM_DESIGN.md section 14.5](../../SYSTEM_DESIGN.md).

| Topic | Statement | Label |
| --- | --- | --- |
| Status today | No market model, route or service exists in the reference implementation. The UI shows a demonstration. | Demonstration only (not implemented) |
| Creation and proof | The owner's Sails participant key signs a genesis record, and ownership is the chain of signed revisions from it. A row in a node database is a cache, never the source. | Approved (direction) |
| Administration | Administrators act only within a scope and validity the owner signed. They cannot transfer the market or widen their powers. The node operator has no implicit power. | Approved (direction) |
| Payment | Paying for activation does not make anyone the owner. | Approved (direction) |
| Recovery authority | The owner names a recovery authority before any loss (default: the owner's own Pubky identity; k of n optional). It authorizes a new key. The old key is never reused. | Approved (direction) |
| Waiting period | A recovery, a transfer or a change of the authority takes effect no earlier than 7 days later, and the current key can veto it. This is a minimum security period, not a promise of recovery within 7 days: if the host is unavailable or refuses, the recovery stays blocked. | Approved (direction) |
| Who counts the period | The market host, with an append-only log. The owner's homeserver is a transparency mirror only. | Approved (direction) |
| Validation by the SDK | The SDK verifies the signature chain and the recovery binding, and flags a recovery declared effective earlier than it saw. | Approved (direction) |
| Social data | First release: contacts stay on the device. Recovery of contacts depends on a signer release that delivers scoped encryption keys, verified on real devices. | Unvalidated dependency |
| Moving a market to another host | Export and import of the signed revisions. Until it exists, a host that refuses can block a recovery. | Unvalidated dependency |

**Labels.** *Implemented* exists in code. *Approved (direction)* is accepted product direction that is **not implemented**. *Unvalidated dependency* depends on implementation or upstream support that has not been signed off. *Demonstration only* is shown in the UI and has no backend.
