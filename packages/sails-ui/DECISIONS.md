# Sails UI: decisões fechadas

Registro das decisões que o Product Owner (Alan) fechou, mais as ordens do CTO e do EPM que afetam a interface. **Todo agente e toda pessoa que mexer na Sails UI segue este arquivo.** Para mudar uma decisão daqui, é preciso uma nova decisão do Product Owner, registrada aqui com data. Nunca se muda por conveniência de implementação.

O "como" (tokens, componentes, estados, contraste) está em `DESIGN_SYSTEM.md`. Este arquivo guarda o "o quê", depois de decidido. Quando um item do `DESIGN_SYSTEM.md` ainda está marcado como provisório (aguardando o Design System Architect), ele continua provisório. Este arquivo não o homologa.

## Regras de trabalho
- **Modo consolidação** (2026-11-20): nenhuma funcionalidade nova até a visão do usuário fechar no modelo ideal. O trabalho segue o plano de consolidação, nesta ordem:
  1. fechar o que está aberto;
  2. ratificar o Design System com o Architect;
  3. verificar fora das capturas (versão de produção, testes de ponta a ponta, acessibilidade manual, aparelho real, backend real);
  4. criar travas executáveis para que nenhum agente erre;
  5. publicar em Draft.
  - Descobertas novas vão para o registro de requisitos, não para a tela.
- **Refinar, nunca refazer.** O que já foi aprovado fica como está. Muda só o que foi pedido. Nenhuma funcionalidade some da tela: se mudar de lugar, é reencaixada (2026-11-20).
- **Verdade antes de visual (CTO 437).** Nada inventado: nenhum estado, prazo, taxa, contador, escala de reputação ou custódia que o protocolo não tenha. "Pagamento enviado" não é "pagamento verificado". "Concluído" não é finalidade de liquidação. USD é a única unidade real de preço. `fundedAmount` nunca aparece. Nenhum texto genérico de "não custodial".
- **Funcionalidade futura aparece como "Em breve"**, desabilitada e ligada à lista de fios soltos (`LOOSE_WIRES` em `lib/looseWires.ts`, issue #729), nunca com dado falso (2026-11-20).
- **Toda descoberta relevante de UX entra no registro de requisitos antes de ser dada como encerrada** (Despachos 052 e 053, regra do processo SEM). O registro mestre é `docs/product/PRODUCT_REQUIREMENTS_REGISTRY.md`, mantido pelo EPM. A UI propõe; o checkbox só é marcado depois da homologação.
- **Publicação no GitHub** só com inspeção e OK do EPM, sempre como Draft. Merge de mudança econômica, migração e produção: HOLD (Despachos 033, 037 e 039).

## Ordens do CTO sobre lacunas da interface (Despacho 051 e Complemento 051-A, 2026-11-20)
- **Nenhuma funcionalidade levantada pela interface é descartada** só porque o backend ou o SDK ainda não a suportam. Cada uma fica registrada e rastreável, com prioridade, dependências, proposta de contrato e situação, na lista de fios soltos (`lib/looseWires.ts`, issue #729) e no registro de requisitos `docs/product/PRODUCT_REQUIREMENTS_REGISTRY.md` (PR #744, índice na issue #745, rótulo `product-ux` no Project #3). O EPM coordena esse backlog.
- **A experiência do usuário orienta a evolução dos módulos**, respeitando segurança, descentralização, portabilidade e autocustódia.
- **Frentes em especificação:**
  - Trade P1: horários das transições (C1), dados de recebimento do vendedor (C2), broadcast e próximo ator (C3), janela de pagamento, prazos, cancelamento e apelação (C12);
  - identidade portátil do anunciante (B1) e recuperação de chaves sem custódia centralizada (D1);
  - notificações (E1).
  - Até o contrato existir, a interface não inventa prazo nem dado. O cancelamento automático nunca pode invalidar fundos bloqueados ou pagamentos em andamento.
- **Avaliações portáteis:** nota de 1 a 5 estrelas, **comentário opcional de até 280 caracteres** (com contador na tela), assinatura do avaliador, vínculo com a identidade portátil e com um trade elegível, proteção contra duplicadas e consulta de média e quantidade pelo SDK.
- **Gates:** descoberta, especificação, protótipo e testes não econômicos. Merge, migração, deploy e ativação econômica continuam em HOLD. A cadeia F4b → M-1b continua prioritária.

## Navegação e layout
- Menu com 5 itens. A escolha do nó fica em Configurações (2026-11-20).
- **Reorganização pela visão do usuário** (2026-11-20, substitui o item acima quando implementada). Nada sai da tela e as rotas antigas redirecionam para o lugar novo.
  - **Menu:** Market · Trades · Perfil · Configurações. No celular a barra inferior fica com 4 itens.
  - **Trades:** Ativos · Histórico · Minhas ofertas · Disputas. Disputas sai do menu principal e vira aba, com um contador quando há disputa aberta. "Minhas ofertas" reúne criar, pausar e cancelar as próprias ofertas. O Perfil continua sendo a vitrine pública.
  - **Configurações, em ordem de uso:** Wallet, Aparência, Idioma, Notificações, Segurança, Nó Sails, Comunidades, Ajuda e Sobre.
  - **Árbitros:** o item próprio "Arbitragem" entra na fase da visão do árbitro (ver "Visões por papel"). Até lá, a lista de casos continua acessível pelo mesmo endereço.
- **Visões por papel** (2026-11-20): primeiro fecha-se toda a interface da visão do usuário. Depois vêm, em fases separadas:
  - a **visão do árbitro**, com a lista de arbitragem e a condução dos casos;
  - a **visão white-label**, para uma wallet integrar a Sails UI com a sua marca;
  - a **visão do operador de nó Sails**, para a equipe que mantém um dos servidores do protocolo;
  - outras visões que surgirem.
  - Cada visão nova segue este registro e o Design System.
- Desktop primeiro, denso e profissional. Uma única interface responsiva de 320 a 1440 px, sem perder a organização (2026-11-20).
- Menu lateral recolhível no desktop. O item Perfil mostra o avatar da pessoa (2026-11-20).
- **Posição do menu no desktop** (2026-11-20): em Configurações → Aparência, "Posição do menu: Lateral | Superior", com uma miniatura de cada opção. A escolha fica salva no navegador e não há botão de alternar na barra.
  - O padrão é **lateral**, com o recolher e expandir de hoje.
  - **Superior:** logo à esquerda, os 5 itens no centro, avatar e menu da conta à direita.
  - Abaixo de 1024 px vale o layout de hoje.
  - No celular a barra inferior continua igual, qualquer que seja a escolha.
  - Os dois layouts são testados em todas as larguras e nos dois temas.
- **Nó não é mercado** (2026-11-20; ADR-001 e issues #147 e #361):
  - O nó Sails mantém a rede: é infraestrutura e serviço. O mercado público é da rede inteira, e trocar de nó nunca troca as ofertas.
  - Mercado privado (grupo, empresa, família, OTC) é um conceito separado. Pode rodar num nó compartilhado ou num nó próprio, porque "quem hospeda o nó não define quem pertence ao mercado".
  - Na interface, o **seletor de nó** fica em Configurações → Nó Sails. O **seletor de mercado** fica no topo do Market (protótipo D1, PR #727), e a gestão dos mercados em Configurações → Comunidades.
  - O nome oficial de mercados e servidores públicos e privados ainda está em aberto no backlog. Até decidir, a tela usa "Mercado público" e o nome dado pelo grupo.
  - **Orientação do CTO (2026-11-20, issue #147):**
    - nó privado **não é obrigatório** para um mercado fechado, e os dois modelos continuam (nó compartilhado ou próprio);
    - a experiência prioriza a combinação natural nó privado + mercado fechado: o nó privado aparece junto dos mercados que hospeda;
    - "o mercado define a comunidade e suas permissões; o nó fornece comunicação, descoberta e disponibilidade".
  - **Garantias que a tela nunca pode contradizer:**
    - os participantes continuam controlando suas chaves e seus fundos;
    - hospedar o mercado não dá acesso às chaves nem autoridade unilateral sobre a liquidação;
    - o administrador pode remover alguém do mercado sem apagar a identidade portátil nem a reputação global da pessoa;
    - o operador do nó não pode falsificar a autorização de membros nem acessar fundos;
    - as permissões são verificadas no backend e no protocolo, não só escondidas na tela.
  - **Fluxo previsto na interface ("Meus mercados"):** criar mercado, escolher quem participa, configurar regras, escolher a infraestrutura e gerar convites. O participante entra com a identidade portátil e vê só as ofertas a que tem acesso.
  - Requisito preservado no registro e no Project #3, ligado à #147. **Ainda sem autorização de implementação.**
  - **Princípios definitivos (CTO, 2026-11-20, registrados na #147):**
    1. **Autonomia dos mercados:** quem cria o mercado escolhe as regras de participação e de publicação. Pode ser só a empresa publicando, membros negociando entre si ou outro formato.
    2. **Neutralidade do Sails:** o protocolo fornece capacidades técnicas e não controla os negócios. As permissões são configuráveis e verificadas no backend e no protocolo, nunca só na tela.
    3. **Soberania dos usuários:** o administrador pode revogar o acesso ao próprio mercado, mas não apaga a identidade, a reputação global nem toma fundos.
    4. **Infraestrutura independente:** o mercado fechado usa nó privado ou compartilhado.
  - **Modelos iniciais de experiência (reforço do CTO, 2026-11-20, #147).** São atalhos opcionais para configurar permissões verificáveis, **não limitações do protocolo nem modelos comerciais impostos**. Ninguém é obrigado a usá-los:

    | Modelo | Quem publica ofertas | Quem negocia |
    |---|---|---|
    | **Vitrine** | Administrador ou participantes autorizados | Clientes e membros autorizados |
    | **Comunidade** | Todos os membros autorizados | Todos os membros autorizados |
    | **Personalizado** (futuro) | Conforme as permissões configuradas | Conforme as permissões configuradas |

    O Principal especifica o modelo técnico de permissões, e o GK valida os limites de autoridade antes da implementação. Nenhum GO de implementação ou de ativação econômica está implícito.
- **Nós e mercados privados: identidade e convites próprios do Sails** (diretriz do CTO para a Sails UI e Complemento ao Despacho 055, 2026-11-20, issue #147).
  - **Sem Nostr.** Nada de `npub`, chave Nostr, relays ou convites geridos por serviço externo. A experiência é própria do Sails, e não copia a Mostro.
  - **Três elementos**, com os formatos a especificar pelo Principal:
    - **Sails Node ID:** identifica o nó;
    - **Sails Market ID:** identifica o mercado, independente do nó que o hospeda;
    - **Sails Market Invite:** credencial verificável, nativa do protocolo (OpenP2P com OpenIdentity).
  - **Quem faz o quê:** Pubky e Pears fazem parte da stack planejada, para identidade e descoberta, mas não recebem a autoridade dos mercados. O Sails Node hospeda o mercado sem autoridade econômica. **Uma chave pública, sozinha, nunca é autorização de acesso.**
  - **A interface nunca inventa** prefixo, chave ou formato definitivo, nunca usa senha compartilhada como autorização e nunca cria formato criptográfico próprio.
  - **Dois fluxos separados:**
    - **Adicionar nó Sails:** nó público, privado ou hospedado; campo "Endereço ou identificador do nó Sails"; nome local opcional; informações de conexão e avisos de privacidade. Conectar ao nó não dá acesso aos mercados hospedados nele.
    - **Entrar em mercado privado:** ação independente; informar o convite ou credencial Sails; preparado para convite compartilhável e QR Code; estados validando, autorização pendente, acesso concedido, expirado e revogado. Conhecer um identificador público não basta.
  - **Casos de uso visíveis:**
    - comunidade: amigos ou conhecidos que negociam entre si;
    - empresa: mercado restrito para clientes, parceiros ou distribuidores;
    - mercado hospedado: comunidade que usa a infraestrutura de um operador independente.
  - **Vitrine e Comunidade** como configurações iniciais (ver acima).
  - **Portabilidade:** estados preparados para reconhecer os mercados ligados à identidade portátil, mesmo depois de trocar de aplicativo ou de nó, quando houver suporte verificável. Nunca prometer recuperação automática antes da especificação.
  - **Entregável da UI:** telas de adicionar nó, entrar em mercado privado, ver os mercados autorizados e os estados de convite e acesso, com as dependências de backend explícitas. Os controles que dependem do backend ficam "Em breve" ou indisponíveis até os contratos existirem.
  - **Autorizado:** layouts, componentes, textos, estados e protótipos. Implementação e ativação seguem os gates técnicos e de segurança.
- Configurações tem as seções: Nó Sails, Wallet, Aparência, Idioma, Notificações, Segurança, Comunidades e Ajuda e Sobre. O ícone de paleta ("Aplicativo") saiu (2026-11-20).

## Identidade
- Logo: direção A, "Vela dupla" (vela laranja, bujarrona azul, linha d'água). Assinatura com o símbolo e o nome "Sails Market" na horizontal. "Conectar wallet" não faz parte da logo (2026-11-20).
- Avatares próprios, gerados a partir da chave pública, nos estilos Vela, Maré e Grade. Cada pessoa escolhe o estilo em que vê os avatares (2026-11-20).
- Em toda a interface, a palavra é **"Nó Sails"** / "nó Sails", nunca "servidor". Exemplo: "Depósito registrado pelo nó Sails" (2026-11-20).
- Nomes fictícios na demonstração: Alice e Bob, com as empresas Boreal OTC e Kestrel Câmbio, Frank como árbitro, Mediare Arbitragem como painel de apelação e Erin como observadora (2026-11-20).

## Visual
- Nada de bordas genéricas: **um único limite visível por elemento**, sem caixa dentro de caixa e sem anel deslocado em volta do foco (2026-11-20).
- Tipografia e tamanhos refinados. Nada grosseiro nem superdimensionado (2026-11-20).
- **Comprar e Vender coloridos:** na lista, fundo suave verde ou vermelho com o texto na mesma cor. No detalhe da oferta, botão sólido verde ou vermelho. "Sua oferta" fica neutro. Todos os estados são mostrados e medidos (repouso, mouse em cima, pressionado, foco, desativado, carregando), nos dois temas (2026-11-20).
- **Aparência:** padrão do sistema, escuro ou claro. Até o Architect decidir, o app abre no escuro (2026-11-20).
- **Idiomas:** padrão do sistema, Português (Brasil), English, Español, Français e Deutsch. Números, moedas e datas seguem o idioma escolhido (2026-11-20).
- Referências de qualidade: Apple HIG, Material 3 e WCAG 2.2 AA. Para padrões de mercado P2P: Binance P2P e Hodl Hodl. Nunca copiar nenhuma delas (2026-11-20).

## Market e ofertas
- Ofertas ordenadas pela reputação Sails, em tabela no desktop e em lista no celular (2026-11-20).
- **Reputação** sempre explicada: "Reputação N" é uma soma sem teto (+2 por trade concluído, −5 por disputa perdida). Nunca "/100", porcentagem ou estrelas. Cada informação tem o seu ícone ao lado. A explicação também aparece em Configurações (2026-11-20).
- **Avaliações** (1 a 5 estrelas) ficam separadas da reputação e nunca entram nela (2026-11-20, revisado no mesmo dia; Despacho 039).
  - Quando o dado existir, aparecem já na **primeira vista, na lista do Market**, depois da reputação e mais discretas: "★ 4,8 (37)", com estrela, média e quantidade. Nunca "/5" nem número solto ao lado da reputação. No celular vão para a linha de baixo.
  - No detalhe e no Perfil, a forma completa: "★ 4,8 · 37 avaliações · desde jan. de 2025".
  - A explicação "Como a reputação é calculada" deixa claro que as estrelas são avaliações das pessoas e não entram na reputação.
  - Enquanto o dado não existir, nada aparece na lista. No detalhe e no Perfil aparece "Em breve".
- **Sem dinheiro em espécie:** o app não oferece "Dinheiro em espécie" como forma de pagamento. Ela sai do filtro, da tela de publicar e da demonstração. Ofertas antigas que já tenham esse método continuam mostrando o nome (2026-11-20).
  - Também saem "Dinheiro por correio" e "Depósito em lotérica". Para depósito, fica só o **boleto bancário** (2026-11-20).
- **"Membro desde"** aparece com mês e ano ("nov. de 2026"). É a data de cadastro, nunca a da oferta ou a da wallet (2026-11-20, Despacho 039).
- **Métodos de pagamento:** na lista, até 3 métodos seguidos de "+N" (no celular, 2 + "+N"). No detalhe, todos. O método escolhido fica preso aos termos aceitos do trade (2026-11-20, revisado no mesmo dia; Despacho 039).
- **Máximo de 5 métodos de pagamento por oferta** (decisão do Product Owner, 2026-11-20). A tela de publicar não deixa passar de 5, mas o limite precisa virar regra do contrato, validada no backend e no SDK (frente de vários métodos do Despacho 039, com o Principal; issue #735).
- **Modo demonstração:** algumas ofertas simulam de 3 a 5 métodos para mostrar o "+N". Isso fica só na demonstração (dados fictícios). Os dados reais continuam com 1 método por oferta até o contrato existir (2026-11-20).
- **Catálogo de ativos:** exatamente os **14 pares oficiais** (ADR-002 §5A): BTC em On-chain e Liquid; USDT em Ethereum, Polygon, Base, Arbitrum, TON, Tron e Solana; USDC em Ethereum, Polygon, Base, Arbitrum e Solana.
  - Cada rede é uma **opção separada**, agrupada pelo ativo, porque valores, limites e taxas mudam de rede para rede.
  - Ícone: a logo oficial do ativo, com uma bolinha no canto com a logo oficial da rede e o nome da rede ao lado.
  - Só fica disponível o que tem rail de liquidação real. O resto aparece como "Em breve".
  - **Lightning fica fora, sem exceção**, até entrar no compromisso (EPM, 2026-11-20).
  - Origem das logos: web3icons (MIT, commit `172f57f`) e o kit oficial da Liquid (Blockstream). Ver `ui-refs/logos-download-2026-11-20/SOURCE.txt` (2026-11-20).

## Trade
- O "Trilho do trade" mostra as etapas e de quem é a vez. Só aparece etapa ou vez que um dado real sustente. Se a interface não pode agir, nunca diz "Sua vez" (2026-11-20, auditoria de verdade).
- O Sails Agent e "Alterar endereço" ficam em "Ferramentas", sem sumir (2026-11-20).
- **Temporizador no fluxo do trade, inspirado na Binance P2P** (2026-11-20). A tela só mostra prazos que o protocolo realmente tem (CTO 437):
  - **agora:** o prazo do escrow (`expiresAt`) vira uma contagem regressiva visível no cartão da etapa atual, que fica âmbar quando falta pouco, com aviso para leitor de tela em momentos-chave e sem piscar;
  - **depois do contrato:** a janela de pagamento escolhida pelo anunciante, o cancelamento automático, o prazo de liberação e a espera antes de apelar. Foi pedido ao CTO, item C12 da lista de lacunas do backend;
  - no modo demonstração a janela de pagamento pode ser simulada, com dados fictícios.
- **O avanço do trade tem cor** (2026-11-20). Nunca verde, porque "concluído" não é finalidade de liquidação (CTO 437):
  - etapa concluída: círculo azul da marca com check, e a linha até a próxima etapa preenchida em azul;
  - etapa atual com ação sua: anel laranja com pulso suave (parado quando o sistema pede menos movimento) e "Sua vez";
  - etapa atual esperando a outra parte: anel azul, sem pulso;
  - etapa atual bloqueada ou indisponível: âmbar de atenção;
  - etapa futura: contorno neutro;
  - em disputa ou com prazo encerrado: o trilho para naquela etapa, em âmbar;
  - final ("Escrow marcado como concluído"): o trilho fica todo azul, sem verde e sem comemoração;
  - o cartão da etapa atual tem uma faixa de cor no topo, com o mesmo código: laranja (sua ação), azul (esperando), âmbar (atenção), neutra (encerrado);
  - o trilho compacto do celular usa as mesmas cores.

## Pendente de decisão (não tratar como fechado)
- Formato do dólar: "US$ 97.800,00" (adotado) ou "$97,800.00". Aguarda o OK do Product Owner.
- As decisões provisórias do Design System listadas no `DESIGN_SYSTEM.md` e no README do artefato aguardam o Design System Architect.
- As 7 perguntas do Trade Workspace (cor do marcador de vez, "Partes podem contestar até o prazo", etapas concluídas em cinza, trilho compacto no tablet, Ferramentas em dois cliques, recurso de teste no modo demonstração, sua própria linha no bloco da contraparte) e os rótulos dos tipos de escrow aguardam o Architect.
