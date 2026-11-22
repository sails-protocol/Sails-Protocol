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
- **Simular ao máximo para entender o todo** (Product Owner, 2026-11-21): quanto mais fluxos completos puderem ser percorridos, melhor se entende o produto e se ajustam a tela e o Design System.
  - **No modo demonstração:** os fluxos são simulados de ponta a ponta, com dados fictícios realistas e marcados como fictícios.
  - **Com dados reais:** a pessoa percorre o fluxo inteiro, e o resultado que depende de um contrato aparece como **prévia** marcada, nunca como coisa feita.
  - O que a simulação ensinar vira ajuste no Design System e entra no registro de requisitos.
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
- Menu com 5 itens (versão de 2026-11-20, substituída pela "Reorganização pela visão do usuário" abaixo, que deixou 4 itens). A escolha do nó fica em Configurações.
- **Reorganização pela visão do usuário** (2026-11-20, substitui o item acima quando implementada). Nada sai da tela e as rotas antigas redirecionam para o lugar novo.
  - **Menu:** Market · Trades · Perfil · Configurações. No celular a barra inferior fica com 4 itens.
  - **Trades:** Ativos · Histórico · Minhas ofertas · Disputas. Disputas sai do menu principal e vira aba, com um contador quando há disputa aberta. "Minhas ofertas" reúne criar, pausar e cancelar as próprias ofertas. O Perfil continua sendo a vitrine pública.
  - **Configurações, em ordem de uso:** Wallet, Aparência, Idioma, Notificações, Segurança, Rede e nós (antes "Nó Sails"), Mercados (antes "Comunidades"), Ajuda e Sobre.
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
  - **Superior:** logo à esquerda, os itens do menu no centro, avatar e menu da conta à direita.
  - Abaixo de 1024 px vale o layout de hoje.
  - No celular a barra inferior continua igual, qualquer que seja a escolha.
  - Os dois layouts são testados em todas as larguras e nos dois temas.
- **Nó não é mercado** (2026-11-20; ADR-001 e issues #147 e #361):
  - O nó Sails mantém a rede: é infraestrutura e serviço. O mercado público é da rede inteira, e trocar de nó nunca troca as ofertas.
  - Mercado privado (grupo, empresa, família, OTC) é um conceito separado. Pode rodar num nó compartilhado ou num nó próprio, porque "quem hospeda o nó não define quem pertence ao mercado".
  - Na interface (versão final, 2026-11-21): os nós ficam em Configurações → Rede e nós, com a lista na área Avançado. Os mercados ficam no Market: seletor no topo (protótipo D1, PR #727), Explorar mercados, Meus mercados, Criar mercado e Entrar com convite. Ver "Decisão final" abaixo.
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
    - **Como a tela diz isso** (Product Owner, 2026-11-21, auditoria de copy): estas garantias são metas do modelo de mercados (#147), e a tela não as afirma de forma genérica. O nó pode guardar a chave do árbitro e, na implementação de referência, ter custódia (CTO 437). Por isso a tela diz "Cada trade mostra quem guarda cada chave e quem pode assinar a liberação." e "Quem hospeda o mercado não recebe as chaves de assinatura das partes."; as permissões verificadas aparecem como "Em breve" até existirem.
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
  - **Decisão final: a experiência gira em torno dos mercados, não dos nós** (CTO 28, ajustes finais, 2026-11-21, issue #147). Substitui as versões anteriores desta seção, que eram centradas no nó.
    - **O princípio:**
      - Sails Node = infraestrutura;
      - Sails Market = produto;
      - público ou privado = visibilidade **do mercado**;
      - Rede Sails ou nó próprio = escolha de infraestrutura.
      - O usuário comum interage com mercados. A gestão de nós fica nas configurações avançadas e, no futuro, na visão do operador.
    - **Rede Sails nos bastidores:** é a experiência padrão. Escolher nó nunca é etapa obrigatória para usar o mercado público.
    - **Configurações → Rede e nós** (antes "Nó Sails"):
      - mostra o estado da conexão, as informações verificadas dos operadores e "Adicionar nó manualmente" (campo "Endereço ou identificador do nó Sails", com aviso de privacidade). Conectar a um nó não dá acesso aos mercados hospedados nele;
      - a lista de nós, os operadores e o diagnóstico ficam numa área **Avançado**;
      - Public Node e Private Node são perfis de implantação da infraestrutura, **nunca tipos de mercado**. Se aparecerem, é só nos detalhes avançados do nó.
    - **Mercados no centro, dentro do Market** (o menu principal não muda): quatro ações ou visões:
      - **Explorar mercados**;
      - **Meus mercados**;
      - **Criar mercado**;
      - **Entrar com convite**.
    - **Mercado público:** acessível publicamente, com marca própria, vitrine e regras de publicação do criador. **Pode haver vários mercados públicos.** Uma empresa cria o seu, com marca e regras, sem operar infraestrutura.
    - **Mercado privado:** acesso restrito a participantes autorizados, para grupos, comunidades, empresas e parceiros.
    - **A visibilidade não define quem publica ofertas.** São configurações separadas.
    - **Criar mercado, nesta ordem:**
      1. nome, descrição e identidade visual;
      2. visibilidade: Público ou Privado;
      3. participação e permissões: Vitrine, Comunidade ou Personalizado;
      4. infraestrutura, como configuração secundária: Rede Sails (padrão, quando houver suporte de hospedagem) ou nó próprio. Só essas duas opções: o nó público compartilhado faz parte da Rede Sails;
      5. revisão e criação;
      6. para mercados privados, a gestão de participantes e convites Sails.
    - **Exemplos das quatro combinações:**

      | Mercado | Hospedagem | Exemplo |
      |---|---|---|
      | Público | Rede Sails | Empresa com vitrine e marca própria |
      | Público | Nó próprio | Operador com mercado aberto independente |
      | Privado | Rede Sails | Grupo de amigos ou comunidade fechada |
      | Privado | Nó próprio | Empresa com mercado exclusivo para parceiros |

    - **Entrar com convite:** o fluxo do Sails Market Invite, com convite verificável, QR Code e os estados validando, autorização pendente, acesso concedido, expirado e revogado. Sem Nostr e sem credencial improvisada. Conhecer um identificador público não basta.
    - **Criar mercado, fluxo completo com dados reais** (Product Owner, 2026-11-21): com dados reais, a pessoa percorre os 6 passos, incluindo participantes e convites nos privados. No fim aparece uma **prévia do mercado criado**: a página do mercado como os participantes vão ver e, nos privados, a tela de convites. A prévia é marcada "Prévia: a criação real depende do protocolo", com o contrato de que depende. Nada é gravado e nada é inventado.
    - **Configurações → "Mercados"** (antes "Comunidades"; Product Owner, 2026-11-21). A seção guarda **preferências** sobre mercados, não os mercados, que vivem no Market:
      - qual mercado abre por padrão (o Mercado aberto ou um dos seus);
      - convites recebidos e pendentes;
      - privacidade da participação, quando o protocolo definir;
      - atalhos para "Meus mercados" e "Entrar com convite".
      - O que depende do backend fica "Em breve". O id da seção continua o mesmo, para o endereço `?section=` não quebrar.
    - **Modelo "mundo aberto"** (aprovado pelo Product Owner, 2026-11-21):
      - **O mercado aberto é o padrão, sem atrito:** o app abre direto nele, ninguém escolhe nada e o menu principal continua com 4 itens. A maior parte dos usuários fica aqui.
      - **O portal:** no topo do Market, ao lado do título, um botão discreto com ícone, "Mercado aberto ▾". Ele abre um painel com:
        - os mercados da pessoa (públicos que acompanha e privados de que participa), em primeiro;
        - Explorar mercados;
        - Entrar com convite;
        - Criar mercado.
        - Quem só usa o mercado aberto nunca é incomodado. Quem participa de comunidades troca de mercado em dois toques.
      - **A vitrine "Explorar mercados":** uma página com os mercados públicos em destaque (marca, descrição, participantes, Vitrine ou Comunidade), com endereço próprio para compartilhar. É o marketing da abordagem do Sails: "crie o mercado da sua comunidade ou empresa, sem precisar de servidor".
      - **Descoberta na hora certa:** um cartão discreto que dá para fechar e aparece de vez em quando no Market. Os mesmos convites aparecem nos lugares naturais: lista vazia, Perfil e Configurações → Mercados (antes Comunidades). Um mercado privado em que a pessoa entrou por convite passa a aparecer logo depois do "Mercado aberto", que continua sempre em primeiro.
      - **Ícones obrigatórios:** cada tipo de mercado e cada ação do portal tem o seu ícone (lucide, dos tokens): mercado aberto, mercado público com marca, mercado privado, explorar, convite e criar. A marca de um mercado público, quando existir, substitui o ícone genérico.
      - **Promoção futura:** se os mercados específicos virarem hábito, "Mercados" pode subir para o menu principal. Por enquanto fica no portal, para não haver mudança brusca.
      - **Nome:** "**Mercado aberto**" é a proposta do Product Owner para o mercado público padrão do Sails, junto com "sala privada". O nome oficial ainda está em aberto; a tela já usa "Mercado aberto".
    - **Seletor de mercados, no topo do Market:**
      - o mercado público padrão do Sails ("Mercado aberto"), primeiro;
      - outros mercados públicos que a pessoa acompanha ou administra;
      - os mercados privados dos quais participa.
      - O nó que hospeda cada mercado aparece só nos detalhes técnicos.
    - **Sem exagero:** "nós independentes" ou "descentralizada" só com o dado de operadores independentes (issue #361). Nada afirma sincronização entre nós, disponibilidade ou garantias de segurança não homologadas. A sincronização entre nós ainda não foi especificada (Pears, UX-046).
    - **Distribuições oficiais do Sails Node:** um só software com os perfis Public Node e Private Node, pré-configurado e white-label. O Sails controla instalação, atualizações verificáveis, compatibilidade, identificação, diagnóstico e templates, mas nunca autoriza operadores centralmente nem desliga mercados (UX-047). Selo de "distribuição oficial" só com verificação real.
    - **Nome:** "sala privada" é a proposta do Product Owner. O nome oficial ainda está em aberto; até lá, a tela usa "mercado privado".
    - **Portabilidade:** estados preparados para reconhecer os mercados ligados à identidade portátil, mesmo depois de trocar de aplicativo ou de nó, quando houver suporte verificável. Nunca prometer recuperação automática antes da especificação.
    - **Entregável da UI:** Explorar mercados, Meus mercados, Criar mercado (fluxo completo) e Entrar com convite (estados), mais Configurações → Rede e nós (estado, adicionar manualmente, Avançado). Tudo com as dependências de backend explícitas e os controles "Em breve" até os contratos existirem; dados de demonstração marcados como fictícios.
  - **Autorizado:** layouts, componentes, textos, estados e protótipos. Implementação e ativação seguem os gates técnicos e de segurança.
- Configurações (versão de 2026-11-20, substituída pela "Reorganização pela visão do usuário" acima): o ícone de paleta ("Aplicativo") saiu, e a seção "Nó Sails" virou "Rede e nós" em 2026-11-21. A ordem válida é a da reorganização: Wallet, Aparência, Idioma, Notificações, Segurança, Rede e nós, Comunidades, Ajuda e Sobre.

## Identidade
- Logo: direção A, "Vela dupla" (vela laranja, bujarrona azul, linha d'água). Assinatura com o símbolo e o nome "Sails Market" na horizontal. "Conectar wallet" não faz parte da logo (2026-11-20).
  - Versões em uma cor (Product Owner, 2026-11-22): branca #FFFFFF (`sails-mark-white.svg`, `sails-logo-white.svg`) para fundos escuros, e cinza neutro #8A919E (`sails-mark-gray.svg`, `sails-logo-gray.svg`) para usos discretos nos dois temas. Em `public/brand/` e no Design System (Logos).
- Avatares próprios, gerados a partir da chave pública, nos estilos Vela, Maré e Grade. Cada pessoa escolhe o estilo em que vê os avatares (2026-11-20).
  - **Escolher o próprio avatar no Perfil** (Product Owner, 2026-11-22): tocar no avatar abre o baralho (Dialog no desktop, Sheet no celular) com Vela / Maré / Grade e 8 variações cada, geradas da própria chave (a variação 1 é o avatar padrão). A escolha vale para o seu avatar em todas as telas que você vê. Por enquanto, aparece só para você, neste aparelho: as contrapartes continuam vendo o avatar gerado da sua chave até o nó Sails guardar o avatar público (`LOOSE_WIRES.publicAvatar`, em breve), e o baralho diz isso. O estilo de Configurações → Aparência continua valendo para os avatares das contrapartes (e para o seu, até você escolher um).
  - Dentro de um diálogo modal, a ação de confirmar é o laranja sólido daquela camada ("Usar este avatar"); a regra de um laranja por tela vale por camada visível.
- Em toda a interface, a palavra é **"Nó Sails"** / "nó Sails", nunca "servidor". Exemplo: "Depósito registrado pelo nó Sails" (2026-11-20).
- Nomes fictícios na demonstração: Alice e Bob, com as empresas Boreal OTC e Kestrel Câmbio, Frank como árbitro, Mediare Arbitragem como painel de apelação e Erin como observadora (2026-11-20).

## Visual
- Nada de bordas genéricas: **um único limite visível por elemento**, sem caixa dentro de caixa e sem anel deslocado em volta do foco (2026-11-20).
- Tipografia e tamanhos refinados. Nada grosseiro nem superdimensionado (2026-11-20).
- **Comprar e Vender coloridos:** na lista, fundo suave verde ou vermelho com o texto na mesma cor. No detalhe da oferta, botão sólido verde ou vermelho. "Sua oferta" fica neutro. Todos os estados são mostrados e medidos (repouso, mouse em cima, pressionado, foco, desativado, carregando), nos dois temas (2026-11-20).
- **Aparência:** padrão do sistema, escuro ou claro. O padrão segue o tema do aparelho; quando o aparelho não informa, abre no escuro (item 43, avaliação do Architect feita nesta sessão por ordem do PO (Alan, 21/11; Issue #217)). Substitui "até o Architect decidir, o app abre no escuro" (2026-11-20).
- **Idiomas:** padrão do sistema, Português (Brasil), English, Español, Français e Deutsch. Números, moedas e datas seguem o idioma escolhido (2026-11-20).
  - **Formato do dólar** (Product Owner, 2026-11-21): cada idioma mostra no formato local, pelas normas CLDR do navegador. Em português, "US$ 97.800,00"; em inglês, "$97,800.00"; em alemão, "97.800,00 USD", porque o "$" sozinho ali seria ambíguo (item 38 da avaliação do Architect).
  - **Textos de dinheiro e de disputa sem revisão nativa ficam fora da publicação** (2026-11-21). As chaves de dinheiro, disputa, prazo, reputação, custódia e confirmação em inglês, espanhol, francês e alemão só vão para produção depois de um falante nativo revisar (lista `NEEDS_NATIVE_REVIEW`, DESIGN_SYSTEM.md §7.3).
- Referências de qualidade: Apple HIG, Material 3 e WCAG 2.2 AA. Para padrões de mercado P2P: Binance P2P e Hodl Hodl. Nunca copiar nenhuma delas (2026-11-20).
- **Um só laranja sólido por tela** (Product Owner, 2026-11-21). Sem sessão, o laranja sólido é o "Conectar wallet" do topo, porque ele destrava todas as ações; o "Nova oferta" do Market fica tonal até a pessoa entrar e volta a ser laranja sólido com sessão.
- **Ícone de 14 px oficial** (`size-icon-xs`), só ao lado de texto de 12 px: selos, chips e linhas de meta. A escala fica 14/16/20/24 (Product Owner, 2026-11-21; aplicado, o Architect pode ajustar na ratificação).
- **Textos honestos, com o tom do Sails** (Product Owner, 2026-11-21):
  - nenhuma promessa que o protocolo não garante (árbitro "sempre", prazo, reembolso); quando a regra depende do tipo de escrow, o texto diz que cada trade mostra a regra;
  - sem comparação com outros produtos ("igual ao Keet") e sem linguagem informal ("pra", "dá pra");
  - entrar com a chave é como nas wallets de DeFi: o texto diz o que a assinatura faz e o que não faz ("não move fundos nem aprova nenhum trade") e o que o nó Sails recebe (assinatura e chave pública), em vez de afirmações absolutas como "nunca sai do seu dispositivo".
- **Auditoria de copy, itens graves** (Product Owner, 2026-11-21; relatório `ui-auditoria-copy-2026-11-21.md`):
  - sem pagamento: a tela diz "Não pague até os dados aparecerem aqui" em vez de "combine pelo chat", que contradizia o aviso de segurança;
  - disputa: "Decisão registrada" em vez de "resolvida", porque a liberação pode ainda depender de assinaturas; divisão "entre as partes", nunca "50/50", porque o contrato aceita qualquer proporção;
  - selo "Verificado" escondido, inclusive na demonstração, até existir um critério de verificação (o backend nunca marca `verified`); o código do selo continua;
  - "Volume" do Perfil mostra "Em breve": o total somava ativos diferentes, sem unidade;
  - os filtros de bloqueio e de "já negociei" dizem que, por enquanto, só funcionam na demonstração;
  - sem nomes internos (RFC-021, MULTISIG, AES-256-GCM, "o serviço") nem caixa alta para ênfase.
- **Dados de pagamento no trade** (EPM, verificado pelo Principal na main 37dcd0d1, 2026-11-21): as listas públicas e a proposta do Sails Agent não expõem `paymentDetails`, e só comprador e vendedor do trade os veem. Dentro do trade os dados chegam ao vivo e o vendedor ainda pode editá-los, porque o snapshot e o congelamento estão em STOP (#735 §14.3). A tela nunca diz que os dados de pagamento ficam fixos ou verificados, e a ajuda do PIX não promete nada além do que a tela mostra.
- **Escolha de lado colorida** (Product Owner, 2026-11-21): nos seletores "Vender / Comprar" (publicar oferta) e "Todos / Comprar / Vender" (filtro do Market), cada lado tem a sua seta colorida (↙ verde Comprar, ↗ vermelho Vender) e o lado escolhido fica com o texto na cor do lado, em negrito, sobre o botão elevado. Sem fundo tingido, que sumia no tema claro. Nos formulários, os seletores de ativo e moeda têm a mesma aparência dos outros campos (borda e fundo de campo).
- **Auditoria de cores** (2026-11-21; relatório `ui-auditoria-cores-2026-11-21.md`, regras em DESIGN_SYSTEM.md §2):
  - avisos de um estado registrado (bloqueio, pagamento marcado como enviado, rodada encerrada, liberação, escrow concluído, decisão de disputa) são informativos, nunca de sucesso verde; o verde fica para confirmações da própria interface (copiado, salvo, publicado);
  - disputa com decisão registrada é neutra, com ícone; o contador de disputas abertas usa perigo;
  - laranja nunca é link nem seleção: links em azul de link, "escolhido" em azul de seleção, etapas concluídas do publicar em azul com check;
  - o seu papel no trade (Comprador/Vendedor) aparece com a cor e a seta do lado; o seletor de lado do Sails Agent segue o do publicar;
  - bloqueado = atenção (âmbar) em todos os cartões; assinatura feita e aval já dado = azul; ícone de erro = perigo; wallets "Em breve" do login com os tokens de desativado;
  - pendentes com o Architect: cor do selo "Verificado" e tom de oferta ativa x trade ativo.
- **Auditoria de copy, itens médios e baixos** (2026-11-21): aplicados nas cinco línguas, com o glossário da auditoria. Termos fixados: "devolução" (não "reembolso") para fundos que voltam ao vendedor, "não disponível" (não "indisponível"), "Não foi possível…" para erros, "anunciante" para quem publica a oferta.
- **"Conectar wallet" dentro das páginas é tonal** (2026-11-21): com sessão vazia, o laranja sólido é o do topo; os botões de conexão no meio de Trades, Histórico, Ofertas, Disputas, Configurações e da página de um trade ficam tonais.
- **Chave pública no Perfil:** começo e fim sempre visíveis ("5be90dfe1d…b50ee0e9"), com o botão "Ver chave completa" que abre a chave inteira no lugar, em qualquer tela (o toque não depende de tooltip). O "Copiar" continua ao lado (Product Owner, 2026-11-21).

## Market e ofertas
- Ofertas ordenadas pela reputação Sails, em tabela no desktop e em lista no celular (2026-11-20).
- **Reputação** sempre explicada: "Reputação N" é uma soma sem teto (+2 por trade concluído, −5 por disputa perdida). Nunca "/100", porcentagem ou estrelas. Cada informação tem o seu ícone ao lado. A explicação também aparece em Configurações (2026-11-20).
  - **Sails Agent, "reputação mínima" (UX-048, decisão do CTO; contrato do SDK aprovado e na main 46d1a8a9, 2026-11-21):** campo "Pontuação mínima de reputação da contraparte (opcional)", número inteiro sem teto que aceita negativos (`minReputationScore`; o alias `minReputationRating` fica obsoleto e a UI não o envia). O texto de ajuda explica a soma (+2 por trade concluído, −5 por disputa perdida) e que, com um mínimo definido, ofertas de quem ainda não tem pontuação ficam de fora. Nunca estrelas, porcentagem nem escala de 0 a 5.
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
    - A bolinha da rede some quando repete a logo do ativo (BTC na rede Bitcoin); o nome da rede continua escrito ao lado. Nos outros pares (BTC na Liquid, USDT e USDC em cada rede) a bolinha fica (Product Owner, 2026-11-21, item 13 da avaliação do Architect).
  - Só fica disponível o que tem rail de liquidação real. O resto aparece como "Em breve".
  - **Lightning fica fora, sem exceção**, até entrar no compromisso (EPM, 2026-11-20).
  - **CTO 28 e Despacho 062 (2026-11-21, issues #734, #588 e #147 comentário 7065257657):** Lightning nativo, Spark/Lightning e Arkade ficam no roadmap, sem ativação no Day 0 e sem data prometida.
    - "Lightning direto" como forma de pagamento aparece como "Em breve" na tela de publicar e nunca pode ser escolhido; sai do filtro e da demonstração. O Sails Agent nunca o propõe. Uma oferta cujo único método é futuro não abre trade: o botão fica desativado, com aviso.
    - O escrow `LIGHTNING_HODL` (que usa Arkade por dentro) nunca aparece como disponível ou homologado; quando o backend o informa num trade, o rótulo continua "Bitcoin via Arkade (rede de teste)".
    - A categoria de pagamento passa a se chamar "Cripto" (era "Cripto / Lightning").
  - Origem das logos: web3icons (MIT, commit `172f57f`) e o kit oficial da Liquid (Blockstream). Ver `ui-refs/logos-download-2026-11-20/SOURCE.txt` (2026-11-20).

## Trade
- O "Trilho do trade" mostra as etapas e de quem é a vez. Só aparece etapa ou vez que um dado real sustente. Se a interface não pode agir, nunca diz "Sua vez" (2026-11-20, auditoria de verdade).
- O Sails Agent e "Alterar endereço" ficam em "Ferramentas", sem sumir (2026-11-20).
- **Temporizador no fluxo do trade, inspirado na Binance P2P** (2026-11-20). A tela só mostra prazos que o protocolo realmente tem (CTO 437):
  - **agora:** o prazo do escrow (`expiresAt`) vira uma contagem regressiva visível no cartão da etapa atual, que fica âmbar quando falta pouco, com aviso para leitor de tela em momentos-chave e sem piscar;
    - com o pagamento pendente ou em disputa, o prazo não encerra o escrow: aparece só a data, em texto, sem contagem, sem âmbar, sem barra e sem aviso para leitor de tela (item 29, avaliação do Architect feita nesta sessão por ordem do PO (Alan, 21/11; Issue #217));
  - **depois do contrato:** a janela de pagamento escolhida pelo anunciante, o cancelamento automático, o prazo de liberação e a espera antes de apelar. Foi pedido ao CTO, item C12 da lista de lacunas do backend;
  - no modo demonstração a janela de pagamento pode ser simulada, com dados fictícios.
- **O avanço do trade tem cor** (2026-11-20). Nunca verde, porque "concluído" não é finalidade de liquidação (CTO 437):
  - etapa concluída: círculo azul da marca com check, e a linha até a próxima etapa preenchida em azul;
  - etapa atual com ação sua: anel laranja com pulso suave (parado quando o sistema pede menos movimento) e "Sua vez";
    - o selo "Sua vez" é neutro, com um ponto laranja, padrão de status de mercado; o laranja sólido da tela fica só no botão da etapa (Product Owner, 2026-11-21).
  - etapa atual esperando a outra parte: anel azul, sem pulso;
  - etapa atual bloqueada ou indisponível: âmbar de atenção;
  - etapa futura: contorno neutro;
  - em disputa ou com prazo encerrado: o trilho para naquela etapa, em âmbar;
  - final ("Escrow marcado como concluído"): o trilho fica todo azul, sem verde e sem comemoração;
  - o cartão da etapa atual tem uma faixa de cor no topo, com o mesmo código: laranja (sua ação), azul (esperando), âmbar (atenção), neutra (encerrado);
  - o trilho compacto do celular usa as mesmas cores.
- **Chat do trade** (Product Owner, 2026-11-21): a ação da etapa ("Marcar pagamento enviado") é o único laranja sólido da tela; o "Enviar" do chat é tonal. Os seus balões são azuis sólidos (azul de informação, 6,7:1 no claro e 7,3:1 no escuro), porque laranja é a cor de ação; os da outra parte ficam neutros. O comprovante continua com o fundo suave de informação e o rótulo, e nunca usa verde.
- **Coluna da contraparte e do chat com largura ajustável, só no desktop** (Product Owner, 2026-11-21). Um divisor entre as colunas, arrastável, de 320 a 640 px, sem deixar a coluna do trade abaixo de 520 px. O padrão é 400 px (era fixo em 360). Funciona pelo teclado (setas de 16 px, Home e End, Enter volta ao padrão) e com duplo clique, e cada pessoa guarda a sua largura neste navegador. No celular e no tablet nada muda.
  - No desktop, a coluna fica fixa na tela ao rolar (abaixo da barra do topo) e o chat ocupa toda a altura que sobra abaixo da contraparte, com mínimo de 352 px (2026-11-21).

- **Pacote de ratificação do Design System Architect** (Despacho 062; responsável alterado pelo Product Owner, Alan, 21/11, e formalizado pelo CTO na Issue #217): a própria sessão de UI avalia e executa os 43 itens, o selo "Verificado" e o tom de oferta ativa, dentro de `packages/sails-ui`. O Architect é apoio quando necessário. Só sobe ao CTO (via EPM) o que afetar arquitetura, contratos, segurança, fluxos econômicos ou escopo aprovado. Método: revisão independente contra Apple HIG, Material 3 e WCAG 2.2, sem partir das recomendações do PM; cada veredito aplicado é registrado aqui como "avaliação do Architect feita nesta sessão por ordem do PO (Alan, 21/11; Issue #217)". Concluído em 21/11 (ver o item abaixo).
- **Avaliação do pacote do Architect** (avaliação do Architect feita nesta sessão por ordem do PO (Alan, 21/11; Issue #217); respostas em `ui-ratificacao-architect-respostas-2026-11-21.md`): 45 itens, 28 ratificados, 15 ajustados, 2 decididos pelo Product Owner (13 e 37), nenhum rejeitado.
  - Ajustes aplicados: prazo só como data quando não encerra o escrow (29); oferta ativa em azul de informação, como trade ativo (N2); camadas de estado mais fortes nos botões Comprar/Vender tonais no escuro, 16 % e 24 % (6); botão "Simular" da demonstração tonal e sem minúscula forçada (27); anel da bolinha da rede visível no claro (9); tema segue o aparelho (43); barra de progresso com tom de atenção (30); temporizador plano no cartão (31); dólar com o código "USD" em alemão (38); estrelas só de leitura em cinza, azul só nas que a pessoa escolhe (7); selo "Em breve" em texto secundário (34); ícone próprio da seção Mercados (35); variável própria do valor em destaque (11); traço da forma de pagamento neutro, laranja nunca é enfeite.
  - Selo "Verificado" (N1): continua escondido; quando houver critério, volta como pílula de informação com ícone, rótulo visível e explicação do critério.
  - **Rótulos dos tipos de escrow (item 32)**, com as garantias confirmadas pelo Principal na main 979bb78b: "Bitcoin com 2 de 3 assinaturas (você, a contraparte e um árbitro)" (único disponível); "Arkade (rede de teste, não disponível)"; "Liquid (em breve)"; "USDT sob custódia (não disponível)"; "USDT/EVM 2 de 3 (rede de teste, não disponível)". Nenhum promete reembolso automático no prazo; "Lightning", "Covenant", "WDK" e "Guard" não aparecem como promessa.

- **Contestação de disputa (C12, CTO e Principal, 2026-11-21):** dois blocos separados.
  - "Contestar a decisão do árbitro": o botão só aparece quando o backend diz que a pessoa pode contestar (`canCurrentUserAppeal`). Sem esse dado (Day 0, nenhuma rota), aparece só "A decisão do árbitro está registrada. A contestação desta decisão não está disponível neste trade.", sem prazo, contagem ou botão. O antigo botão "Apelar", que aparecia para qualquer parte e no MULTISIG terminava em erro, saiu. Sem rótulo de "justificativa" (o campo não existe). Em português, "contestação" substitui "apelação".
  - "Contestar a sugestão automática": só quando a disputa está em sugestão automática com prazo vindo do backend; contagem pelo relógio do servidor (header Date), âmbar com menos de 1 h; ao zerar, o botão desliga e a tela relê. O chip do trilho "Partes podem contestar até o prazo" só aparece nesse caso, com prazo real (antes pendente; resolvido).
  - Console do árbitro: "Se ninguém contestar até {data}, a sugestão automática não é aplicada e o caso volta ao árbitro humano para decisão." Corrige o texto anterior ("passa a valer"), que era falso e contradizia a regra da tela das partes (GK, 2026-11-21).
  - Erros 400/403/404 ou falha de rede: a tela relê a disputa e mostra o estado novo, nunca reenvia sozinha; falha depois do envio diz "Não sabemos se a contestação foi registrada. Atualizando…".
  - Estados disponível, enviada, expirada e resolvida só na demonstração, com selo "Demonstração". Especificação: `EPM-registros/ESPEC_COMPARTILHADA_C12_CONTESTACAO.md`.
- **Revisão de idioma por IA** (Product Owner, 2026-11-21; pacote `ui-revisao-nativa-2026-11-21/`): os 607 textos sensíveis revisados em en, es, fr e de com os termos públicos de plataformas P2P; 134 correções aplicadas. Exemplos: "passphrase" em inglês, "ruling" para a decisão do árbitro, "Quantity" para a cripto; "hasta el" (inclui a data) e "monto" em espanhol; "conservation" para custódia em francês. A revisão humana nativa continua desejável antes de cada língua ir para produção.
- **Trilho de teste do Arkade** no seletor de ativo (desenvolvimento): visível só para ler dados antigos, nunca escolhível ("fechado no Day 0"; GK, D064).
- **Conexão com o nó Sails (homologação, CTO 29, 2026-11-21):** o endereço do nó vem de `VITE_API_BASE_URL` no build (`.env.example`, seção "Homologação" do README). A interface só mostra "Não foi possível conectar ao nó Sails" quando a conexão falha de fato (o pedido nem chega); resposta de erro do backend não conta como sem conexão. "Tentar de novo" refaz uma leitura real e recarrega a página, exceto o formulário de publicar, que mantém o que foi preenchido. Em Configurações → Rede e nós aparecem o endereço configurado e o estado da conexão (Conectado, Sem conexão, Ainda não verificado). Nunca na demonstração.
- **Termos da negociação, versionados (diretriz do CTO, C12/#740, 2026-11-21):** o Sails começa pelas práticas consolidadas do mercado P2P, com parâmetros configuráveis e versionados, e cada trade guarda os termos com que nasceu.
  - A interface nunca fixa valores no código (janelas de 15/30/45/60 min, prazos, regras de disputa): lê sempre o que o backend informa no trade ou na oferta, incluindo a versão da política.
  - A tela mostra os **termos desta negociação**, não "as regras atuais da plataforma"; um trade antigo pode ter termos diferentes de um novo.
  - A escolha da janela de pagamento no anúncio lista só as opções que o backend permitir.
  - Trade sem política ou versão (legado) aparece com os termos legados, sem inventar prazo.
  - Os dados de demonstração são parametrizados por versão.
  - **Despacho 065 do CTO (#740):** v1 de referência definida (pagamento 15/30/45/60 min, liberação padrão 30 min, disputa imediata, tolerância de reconfirmação 5 min), mas a migração e a publicação da v1 estão em HOLD. Em produção só aparece o que o backend confirma; estados e contadores da v1 só na demonstração, com selo.
    - Depósito em confirmação: estado em que o prazo fica **suspenso** (nada expira), mostrado só quando o backend sinalizar a incerteza.
    - Oferta v0: aviso "publique de novo para novas negociações" só quando o backend informar.
    - "Decisão definitiva" só quando o backend registrar liquidação terminal confirmada.
    - Nenhuma penalidade de reputação aparece como automática por causa do timer; só depois de decisão confirmada.
    - Sem via rápida para quem não aparece: a recuperação continua a existente, com coassinatura; nenhum prazo assume fundos (árbitro indisponível tratado na #293).
  - Contestação (C12) e negociação completa (#740): sem o campo do backend, nada de prazo, janela ou ação presumida; um temporizador nunca move fundos; "Marquei como pago" não comprova o recebimento nem libera nada; no MULTISIG, "Cancelar e devolver" só inicia a rodada de assinaturas ("Devolução iniciada, aguardando a assinatura do comprador"), e "Devolvido" só aparece com o escrow REFUNDED.

## Mercados (Market Spaces): diretriz do CTO, 2026-11-22
Origem: áudios do PO (22/11) organizados pela sessão de UI (`ui-mercados-audios-2026-11-22.md`) e aprovados pelo CTO. "Market Spaces" é só o nome técnico provisório da capacidade; a interface usa Mercado aberto, Comunidades e Mercados privados. O EPM registra a capacidade futura (ex.: "OpenMarkets") sem criar módulo novo agora.
- **Princípio:** o Sails Protocol fornece a infraestrutura; cada mercado define experiência e regras de participação, sem enfraquecer escrow, liquidação, assinatura nem disputas. O administrador pode restringir novas negociações, nunca alterar um trade já em escrow.
- **Três tipos oficiais:** **Mercado aberto** (a praça pública da rede, gratuito, padrão, não é listado como "público"); **Comunidades** (mercados públicos criados por qualquer pessoa, trader ou empresa, com nome, ícone, banner, descrição, categoria, regras e administração própria; aparecem em Explorar mercados); **Mercados privados** (por convite ou autorização; ofertas só para participantes). Qualquer pessoa pode administrar um mercado: Comunidade não é sinônimo de empresa.
- **Navegação:** Mercado aberto · Explorar mercados · Meus mercados (grade ou lista) · Criar mercado · Entrar com convite. Cada mercado tem página própria (identidade visual, ofertas, participantes, regras de participação).
- **Criar mercado:** nome, descrição, categoria, ícone quadrado (1:1), banner horizontal 3:1 (padrão; 3:4 só como capa adicional), público ou privado, regras de entrada, política de KYC opcional, prévia e tela "Mercado criado".
- **Perfil do mercado (ideia do PO):** o administrador escolhe "P2P" ou "Empresa / OTC" e o mercado mostra esse selo. Um selo "Verificado" por metas (avaliações, número e volume de negociações) só na demonstração, com critérios fictícios e explicados; critérios reais dependem do CTO e do protocolo (o selo "Verificado" real continua escondido, N1).
- **KYC e regras próprias:** regra comercial do administrador; a verificação é do próprio operador ou do provedor que ele escolher (ex.: o dono envia o link do formulário de KYC só acima de um valor, como US$ 10 mil, para não criar barreira de entrada); login com redes sociais como requisito opcional (ideia do PO, referência p2p.me). O Sails não guarda documentos e a interface não promete que isso elimina responsabilidade legal de operadores ou provedores.
- **Compra de espaço (somente demonstração, produto comercial da Satsails):** pagamento único, sem mensalidade: Comunidade pública US$ 497, Mercado privado US$ 997, Mercado empresarial / OTC US$ 1.997 (preços fictícios). BTC, USDT e USDC como formas futuras, valor de referência em USD. Direito de uso vinculado à identidade do dono, transferência futura; não é propriedade da infraestrutura nem controle das regras do protocolo. Sempre marcado "Demonstração · nenhum pagamento é processado". Sem token novo. O protocolo continua permissionless: quem usa os SDKs não precisa comprar nada.
- **Nó Sails gerenciado:** aparece em Rede e nós como "Em breve"; nada de provisionamento simulado nem promessa comercial.
- **Chat:** chat em grupo do mercado = demonstração/roadmap, separado do chat do trade (o único real). Nunca apresentar o chat em grupo como implementado.
- **Mercados privados:** na demonstração as ofertas privadas só aparecem para quem entrou; o controle real de acesso aos dados é do protocolo e dos SDKs, não da interface.
- **Mídia:** arquitetura híbrida (identidade do mercado com referências e hashes; nó com metadados; mídia em armazenamento de objetos ou distribuído). A interface só mostra a prévia local da imagem escolhida, sem depender de um armazenamento específico.
- **Dados:** contratos e SDKs quando existirem; até lá, fixtures marcados como demonstração. Nenhuma lógica econômica paralela na interface. Nada de pagamento, KYC, provisionamento ou transação reais nesta etapa.
- **Rascunho de contrato do Principal (2026-11-22; proposta, aguardando o CTO ratificar o corte do Day 0):** tipos `MarketSummary`, `Market` (com `entryPolicy`, `listed`, `state`), "meus mercados" (`admin` / `member` / `follower`) e convite com resgate `pending` / `granted` / falha; ids e chaves são textos opacos, num só módulo local (`lib/marketContract.ts`), para a troca pelo SDK ser mecânica. Nenhum endpoint existe: a interface lê só fixtures.
  - A política de entrada é **declarativa**: "o administrador avalia", nunca "verificado pelo protocolo". Ela limita quem entra e quem começa novas negociações; nunca muda para onde vão os fundos, não autoriza nada econômico e não toca um trade já em escrow (CTO 31).
  - Mercado privado para quem não é membro: o backend responde 404, e a tela diz "Mercado não encontrado ou sem acesso", sem confirmar que o mercado existe.
  - Fora da demonstração: chat em grupo, selos e nó gerenciado ficam "Em breve"; mercados privados e suas ofertas ficam "Em preparação".
  - A compra de espaço é um serviço da Satsails, separado do protocolo e dos SDKs (módulo próprio, `lib/spaceCatalog.ts`), só na demonstração. Preços marcados "Preço de demonstração", não finais; compra única, sem assinatura, plano mensal ou renovação; comprar não é necessário para usar o protocolo.
- **Regras do GK (2026-11-22):**
  - mercado privado vive num só nó no Day 0 (sem replicação, não portátil): "Mercado privado neste nó Sails; outros nós não o enxergam.", na página do mercado e no passo de visibilidade do Criar mercado;
  - `iconRef`, `bannerRef` e `providerUrl` são links do administrador e o nó nunca os busca: aparecem como links externos ("Link do administrador"), e a imagem remota só carrega quando a pessoa pede ("Carregar imagem do administrador"), com o aviso de que isso mostra o endereço IP a quem hospeda a imagem. A prévia local do próprio arquivo no Criar mercado e a arte de tokens da demonstração não precisam de clique;
  - a lista de membros do administrador mostra só chaves públicas (abreviadas, monoespaçadas), sem nomes nem outros dados;
  - falha ao usar um convite (inválido, expirado ou revogado) tem uma única mensagem genérica, "Não foi possível usar este convite", com "Peça um novo convite a quem administra o mercado."; "Autorização pendente" e "Acesso concedido" continuam.
- **Espaço como item único do comprador** (Product Owner, 2026-11-22): quem compra paga uma vez e o espaço passa a ser seu, vinculado à sua identidade (transferência no futuro), e é a pessoa que define o tipo e a configuração. Fluxo: catálogo → "Espaço adquirido (demonstração, nada foi cobrado)" → Criar mercado já preenchido com o tipo. Nunca as palavras NFT ou token, e nunca dizer que um token é emitido.
- **Onde roda o espaço** (Product Owner, 2026-11-22): para mercado privado e empresarial / OTC, a pessoa escolhe entre o nó Sails gerenciado pela Satsails, opcionalmente incluído no preço do espaço (termos comerciais pendentes do CTO), que fica "Em breve" e não pode ser escolhido, e o próprio nó (VPS própria). Aparece no catálogo e no passo de visibilidade do Criar mercado.

- **Imagem remota só com clique, também no banner e no ícone** (GK, 2026-11-22): `MarketBanner` e `MarketIcon` só desenham sem clique uma prévia local (`blob:` ou `data:image/`, via `isLocalPreviewUrl`); qualquer link do administrador passa pelo `AdminImage` (clique para carregar, aviso de IP). Teste: `tests/localImage.test.ts`.
- **Modelo "Comunidade" passa a se chamar "Todos publicam"** (PM por delegação do Product Owner, 2026-11-22): o atalho de participação em que todos os membros autorizados publicam e negociam deixa de colidir com o tipo de mercado "Comunidades". "Vitrine" continua (publica o administrador ou participantes autorizados). Só muda o texto, nas cinco línguas; o id interno `comunidade` continua. A tabela "Modelos iniciais de experiência" acima vale com o nome novo.
- **Nó gerenciado incluído no preço do espaço** (PM por delegação do Product Owner, 2026-11-22): adotado como direção do produto. Continua "Em breve" e não pode ser escolhido; o texto é "incluído no preço do espaço quando estiver disponível". Os termos comerciais dependem de confirmação do CTO.
- **Checkout simulado de "Comprar espaço"** (Product Owner, 2026-11-22), só na demonstração e no módulo da loja (`lib/spaceCatalog.ts`, nunca no código de mercados ou do SDK):
  - Pagamento: BTC, USDT ou USDC, com a rede escolhida entre as que o catálogo de ativos lista; preço de demonstração em USD e "equivalente de demonstração" por uma cotação fixa e fictícia (`demo/spaceShop.ts`), marcada "cotação de demonstração", que não entra em nenhuma lógica econômica;
  - Revisar: espaço, onde roda, ativo e rede, valor, "pagamento único, sem mensalidade" e "comprar não é necessário para usar o protocolo";
  - Aguardando pagamento (simulado): **nunca** endereço, QR Code, botão de copiar ou fatura; um painel diz "Endereço de pagamento aparece aqui quando a compra existir" e um botão de demonstração simula o recebimento (Aguardando pagamento → Confirmando (simulado) → Pagamento confirmado, demonstração, nada foi cobrado), cerca de 1 s, ou na hora com movimento reduzido;
  - Espaço adquirido → "Configurar meu espaço" (Criar mercado preenchido). O aviso "Demonstração · preços fictícios · nenhum pagamento é processado" fica em todos os passos, e voltar ou cancelar funciona até a confirmação simulada.
- **O portal de mercados é navegação** (Product Owner, 2026-11-22): o "Mercado aberto ▾" mostra só o mercado atual (com o check) e depois as ações, cada uma com ícone e uma linha: Explorar mercados, Meus mercados (com a quantidade, por exemplo "4 mercados"), Entrar com convite, Criar mercado e, só na demonstração, Comprar espaço como ação secundária. A lista dos mercados da pessoa vive em Meus mercados; a nota "as ofertas por mercado dependem de uma evolução do protocolo" foi para lá. Mesma anatomia: popover a partir de md, bottom sheet abaixo, linhas de 44 px, atual em azul de seleção com check, sem caixas com borda.
- **Tamanhos das imagens do mercado** (Product Owner, 2026-11-22): ícone 1:1, recomendado 512 × 512 px (mínimo 256 × 256); banner 3:1, recomendado 1500 × 500 px (mínimo 1200 × 400); capa opcional 3:4, recomendado 900 × 1200 px (mínimo 600 × 800). PNG, JPG ou WebP (SVG só no ícone), até 5 MB. Ao escolher, a imagem é conferida no aparelho (`lib/imageCheck.ts`): tipo errado ou acima de 5 MB é erro; menor que o mínimo ou proporção fora de cerca de 5 % é só aviso ("pode ficar borrada", "as bordas serão cortadas"). O texto de ajuda pede o conteúdo importante no centro. O banner mantém 3:1 centrado (object-cover) no cartão, na página e na prévia, com altura limitada na página do mercado em telas largas.

- **A demonstração é uma simulação completa do produto do Day 0** (Product Owner, 2026-11-22): no modo demonstração os fluxos funcionam de ponta a ponta, sem becos de "Em breve"; cada item simulado leva o marcador "Simulado", e toda ação simulada diz "Simulado: nada foi enviado ao nó Sails". O **mapa de ligações** (`/dev/wiring`, `lib/wiringMap.ts`, ligado pela faixa da demonstração e pela página do Design System) é a fonte de verdade do que ainda não está ligado ao backend, com as situações "Ligado ao backend", "Simulado na demonstração" e "Fora do Day 0 (decisão do CTO)". Wallet real, exportação de chave real, endereço de recebimento e pares sem trilho de liquidação ficam como aviso honesto, mesmo na demonstração ("Aviso na demonstração", não simulado). Em produção a tela continua honesta ("Em breve" / "Em preparação", CTO 437). Lightning, Spark e Arkade continuam fechados, e a trava do MULTISIG não muda.
- **Três conversas distintas** (Product Owner, 2026-11-22), no modelo de grupo de mensagens: o **chat do grupo** do mercado é para intenções ("preciso comprar USDT"), a **conversa privada** entre dois membros é para combinar os termos antes do trade, e a negociação sempre acontece num **trade do Sails com escrow**, com o chat do trade (o único real). Toda conversa privada mostra, fixo no topo, "Para negociar, abra uma oferta ou um trade no Sails: o valor fica no escrow. Nunca pague fora do trade." Fora da demonstração, chat do grupo e conversa privada são "Em breve".

- **Comprar espaço faz parte de Criar mercado** (Product Owner, 2026-11-22; substitui a entrada separada "Comprar espaço" do portal e de Explorar): uma só entrada. Na demonstração: 1) **Escolha o tipo**, três cartões com "Preço de demonstração · pagamento único" (Comunidade pública US$ 497, Mercado privado US$ 997, Mercado empresarial / OTC US$ 1.997) e a linha "Desenvolvedores podem criar mercados por conta própria com os SDKs do Sails, sem pagar."; 2) **Configure** (nome, descrição, categoria, perfil, ícone, banner; regras, KYC, login social e hospedagem em "Opções avançadas", recolhidas); 3) **Revisar e pagar** (resumo e checkout simulado: ativo e rede, pagamento simulado); 4) **Mercado criado**, que abre a página do mercado. O portal mostra "Criar mercado: Comunidade ou mercado privado, compra única" e não tem mais "Comprar espaço"; `/markets/space` só redireciona. Fora da demonstração, os tipos e preços aparecem como "Em breve" e o fluxo termina na prévia honesta, nunca num checkout. O código da compra continua num módulo próprio (`lib/spaceCatalog.ts`, `pages/spaces/SpaceCheckout.tsx`).
- **Simples de aprender** (Product Owner, 2026-11-22): um próximo passo óbvio por tela, opções avançadas recolhidas com padrões razoáveis, palavras simples, padrões conhecidos de grupos de mensagens, estado vazio que diz o que fazer, checkout com no máximo 3 passos curtos.
- **Refinamentos de pesquisa (PM, 2026-11-22)**, aplicados só onde mantêm o fluxo simples:
  - intenção estruturada no chat do grupo ("Publicar intenção": tipo, valor, forma de pagamento) com "Conversar no privado" que leva o cartão para a conversa;
  - na conversa privada, a ação principal é "Propor negociação" (lado preenchido pelo cartão), a faixa "Só o trade com escrow protege o valor" fica fixa e um aviso suave aparece quando a mensagem parece levar o pagamento para fora do trade (`lib/offTradeRisk.ts`, nunca bloqueia); dados de pagamento só existem dentro do trade;
  - selo de demonstração renomeado para "Comunidade ativa" (mede atividade, não identidade); o selo de perfil (P2P / Empresa-OTC) é separado; o "Verificado" real continua escondido (N1);
  - a compra diz o que a pessoa tem (o espaço e os direitos de administração) e o que não tem (os fundos dos participantes ficam sempre no escrow de cada trade), "pagamento único, sem renovação", sem níveis que expiram;
  - ainda não feitos nesta etapa, registrados no mapa de ligações: folha "Regras da comunidade" com "Aceito e entrar", pedidos de entrada com aprovação, prévia do link de convite, ordenação "Mais ativas" com entrada e ativos nos cartões, "Meus espaços" com "Transferir" e as ferramentas do administrador (fixar, modo lento, remover citando a regra, denunciar).

- **Ofertas primeiro na página do mercado** (Product Owner, 2026-11-22): cabeçalho (banner, ícone, nome, selos, participantes) e depois as abas **Ofertas** (padrão) | **Chat do grupo** | **Sobre** (regras, entrada, participantes, administração). Em Ofertas, só lado (Todos/Comprar/Vender) e ativo, sem filtros avançados (esses ficam no Market principal); cada oferta tem a ação do lado e "Conversar", que abre a conversa privada com a oferta no topo e a faixa do escrow. Estado vazio: "Ninguém publicou ofertas aqui ainda" e "Publicar oferta neste mercado". O chat é opcional para quem quer interagir. Na demonstração, as ofertas de mercado são fixtures simples (ainda não a `OfferTable` do Market, que depende de `liquidity.discover({ marketId })`); abrir trade e publicar num mercado são simulados e marcados.

- **Segmentado selecionado com limite no tema claro** (PM como dono do Design System, 2026-11-22, WCAG 1.4.11): o item selecionado ganha 1px interno de `text-muted` (#646464), só no claro: 3.80:1 contra o trilho, antes 1.56 só pelo preenchimento. O trilho e as outras superfícies não mudam. No escuro nada muda (thumb vs trilho 1.51–1.54, com preenchimento, elevação, peso e `aria-pressed`). Detalhes e medidas em DESIGN_SYSTEM.md 5.1.
- **Item 11 confirmado** (PM, 2026-11-22): o modo real continua percorrendo os passos de Criar mercado e termina na prévia honesta (decisão do Product Owner de 2026-11-21), com os preços escondidos.

- **Itens 20–24 da pesquisa, versão simples** (PM, 2026-11-22), só na demonstração e marcados "Simulado": entrar numa comunidade aberta abre "Regras da comunidade" com um único "Aceito e entrar"; nas comunidades "Com aprovação", "Solicitar entrada" leva a "Pedido enviado" (cancelável) e quem administra vê "Pedidos de entrada (n)" com Aprovar e Recusar; Explorar ordena por "Mais ativas" (negociações em 30 dias, fictícias) e os cartões mostram o tipo de entrada (Aberta, Com aprovação, Por convite) e os ativos aceitos; em Meus mercados, os mercados que a pessoa administra ou criou mostram "Seu espaço" e "Transferir" (simulado; a transferência ainda não existe); o administrador fixa uma mensagem do grupo e remove um membro citando a regra, sem tocar na identidade, na reputação global nem em trades em escrow. Cada item tem a sua linha no mapa de ligações.

## Pendente de decisão (não tratar como fechado)
- Itens do `DESIGN_SYSTEM.md` ainda marcados como provisórios e que não entraram no pacote de 21/11 seguem provisórios.
