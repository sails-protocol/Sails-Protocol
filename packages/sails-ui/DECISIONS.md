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
- Avatares próprios, gerados a partir da chave pública, nos estilos Vela, Maré e Grade. Cada pessoa escolhe o estilo em que vê os avatares (2026-11-20).
- Em toda a interface, a palavra é **"Nó Sails"** / "nó Sails", nunca "servidor". Exemplo: "Depósito registrado pelo nó Sails" (2026-11-20).
- Nomes fictícios na demonstração: Alice e Bob, com as empresas Boreal OTC e Kestrel Câmbio, Frank como árbitro, Mediare Arbitragem como painel de apelação e Erin como observadora (2026-11-20).

## Visual
- Nada de bordas genéricas: **um único limite visível por elemento**, sem caixa dentro de caixa e sem anel deslocado em volta do foco (2026-11-20).
- Tipografia e tamanhos refinados. Nada grosseiro nem superdimensionado (2026-11-20).
- **Comprar e Vender coloridos:** na lista, fundo suave verde ou vermelho com o texto na mesma cor. No detalhe da oferta, botão sólido verde ou vermelho. "Sua oferta" fica neutro. Todos os estados são mostrados e medidos (repouso, mouse em cima, pressionado, foco, desativado, carregando), nos dois temas (2026-11-20).
- **Aparência:** padrão do sistema, escuro ou claro. Até o Architect decidir, o app abre no escuro (2026-11-20).
- **Idiomas:** padrão do sistema, Português (Brasil), English, Español, Français e Deutsch. Números, moedas e datas seguem o idioma escolhido (2026-11-20).
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
- **"Conectar wallet" dentro das páginas é tonal** (2026-11-21): com sessão vazia, o laranja sólido é o do topo; os botões de conexão no meio de Trades, Histórico, Ofertas, Disputas, Configurações e da página de um trade ficam tonais.
- **Chave pública no Perfil:** começo e fim sempre visíveis ("5be90dfe1d…b50ee0e9"), com o botão "Ver chave completa" que abre a chave inteira no lugar, em qualquer tela (o toque não depende de tooltip). O "Copiar" continua ao lado (Product Owner, 2026-11-21).

## Market e ofertas
- Ofertas ordenadas pela reputação Sails, em tabela no desktop e em lista no celular (2026-11-20).
- **Reputação** sempre explicada: "Reputação N" é uma soma sem teto (+2 por trade concluído, −5 por disputa perdida). Nunca "/100", porcentagem ou estrelas. Cada informação tem o seu ícone ao lado. A explicação também aparece em Configurações (2026-11-20).
  - **Sails Agent, "reputação mínima" (UX-048, decisão do CTO, 2026-11-21):** a reputação é pontuação acumulativa, sem teto, e pode ser negativa (+2/−5). Não é nota de 0 a 5; as estrelas de 1 a 5 são outra coisa.
    - **HOLD:** o campo atual "Reputação mínima da contraparte (0–5)" em `components/agent/AgentIntentionPanel.tsx` não é corrigido só na tela.
    - **Ordem:** primeiro o Principal alinha o contrato do SDK (novo `minReputationScore` numérico, que aceita negativos; o `minReputationRating` fica obsoleto como alias) e o GK valida a semântica.
    - **Depois do aviso do EPM** de que o contrato foi aprovado, a UI corrige o campo e os testes: campo numérico sem teto; rótulo "pontuação de reputação" com unidade clara; nunca como estrelas nem porcentagem; uma classificação visual só como apoio.
    - **Até lá:** nenhuma escala nova inventada.
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
- **Chat do trade** (Product Owner, 2026-11-21): a ação da etapa ("Marcar pagamento enviado") é o único laranja sólido da tela; o "Enviar" do chat é tonal. Os seus balões são azuis sólidos (azul de informação, 6,7:1 no claro e 7,3:1 no escuro), porque laranja é a cor de ação; os da outra parte ficam neutros. O comprovante continua com o fundo suave de informação e o rótulo, e nunca usa verde.
- **Coluna da contraparte e do chat com largura ajustável, só no desktop** (Product Owner, 2026-11-21). Um divisor entre as colunas, arrastável, de 320 a 640 px, sem deixar a coluna do trade abaixo de 520 px. O padrão é 400 px (era fixo em 360). Funciona pelo teclado (setas de 16 px, Home e End, Enter volta ao padrão) e com duplo clique, e cada pessoa guarda a sua largura neste navegador. No celular e no tablet nada muda.

## Pendente de decisão (não tratar como fechado)
- Formato do dólar: "US$ 97.800,00" (adotado) ou "$97,800.00". Aguarda o OK do Product Owner.
- As decisões provisórias do Design System listadas no `DESIGN_SYSTEM.md` e no README do artefato aguardam o Design System Architect.
- As 7 perguntas do Trade Workspace (cor do marcador de vez, "Partes podem contestar até o prazo", etapas concluídas em cinza, trilho compacto no tablet, Ferramentas em dois cliques, recurso de teste no modo demonstração, sua própria linha no bloco da contraparte) e os rótulos dos tipos de escrow aguardam o Architect.
