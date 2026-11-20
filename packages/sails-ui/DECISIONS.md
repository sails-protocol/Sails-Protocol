# Sails UI: decisões fechadas

Registro das decisões que o Product Owner (Alan) fechou, mais as ordens do CTO e do EPM que afetam a interface. **Todo agente e toda pessoa que mexer na Sails UI segue este arquivo.** Para mudar uma decisão daqui, é preciso uma nova decisão do Product Owner, registrada aqui com data. Nunca se muda por conveniência de implementação.

O "como" (tokens, componentes, estados, contraste) está em `DESIGN_SYSTEM.md`. Este arquivo guarda o "o quê", depois de decidido. Quando um item do `DESIGN_SYSTEM.md` ainda está marcado como provisório (aguardando o Design System Architect), ele continua provisório. Este arquivo não o homologa.

## Regras de trabalho
- **Refinar, nunca refazer.** O que já foi aprovado fica como está. Muda só o que foi pedido. Nenhuma funcionalidade some da tela: se mudar de lugar, é reencaixada (2026-11-20).
- **Verdade antes de visual (CTO 437).** Nada inventado: nenhum estado, prazo, taxa, contador, escala de reputação ou custódia que o protocolo não tenha. "Pagamento enviado" não é "pagamento verificado". "Concluído" não é finalidade de liquidação. USD é a única unidade real de preço. `fundedAmount` nunca aparece. Nenhum texto genérico de "não custodial".
- **Funcionalidade futura aparece como "Em breve"**, desabilitada e ligada à lista de fios soltos (`LOOSE_WIRES` em `pages/Settings.tsx`, issue #729), nunca com dado falso (2026-11-20).
- **Publicação no GitHub** só com inspeção e OK do EPM, sempre como Draft. Merge de mudança econômica, migração e produção: HOLD (Despachos 033, 037 e 039).

## Navegação e layout
- Menu com 5 itens. A escolha do nó fica em Configurações (2026-11-20).
- Desktop primeiro, denso e profissional. Uma única interface responsiva de 320 a 1440 px, sem perder a organização (2026-11-20).
- Menu lateral recolhível no desktop. O item Perfil mostra o avatar da pessoa (2026-11-20).
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
- **Avaliações** (1 a 5 estrelas) ficam separadas da reputação e nunca entram nela. Quando o dado existir, aparecem numa linha própria, mais discreta: "★ 4,8 · 37 avaliações · desde jan. de 2025". Enquanto não existir, mostram "Em breve" no detalhe e no Perfil, nunca na lista (2026-11-20, Despacho 039).
- **"Membro desde"** aparece com mês e ano ("nov. de 2026"). É a data de cadastro, nunca a da oferta ou a da wallet (2026-11-20, Despacho 039).
- **Métodos de pagamento:** na lista, até 2 métodos seguidos de "+N" (no celular, 1 + "+N"). No detalhe, todos. O método escolhido fica preso aos termos aceitos do trade (2026-11-20, Despacho 039).
- **Catálogo de ativos:** exatamente os **14 pares oficiais** (ADR-002 §5A): BTC em On-chain e Liquid; USDT em Ethereum, Polygon, Base, Arbitrum, TON, Tron e Solana; USDC em Ethereum, Polygon, Base, Arbitrum e Solana.
  - Cada rede é uma **opção separada**, agrupada pelo ativo, porque valores, limites e taxas mudam de rede para rede.
  - Ícone: a logo oficial do ativo, com uma bolinha no canto com a logo oficial da rede e o nome da rede ao lado.
  - Só fica disponível o que tem rail de liquidação real. O resto aparece como "Em breve".
  - **Lightning fica fora, sem exceção**, até entrar no compromisso (EPM, 2026-11-20).
  - Origem das logos: web3icons (MIT, commit `172f57f`) e o kit oficial da Liquid (Blockstream). Ver `ui-refs/logos-download-2026-11-20/SOURCE.txt` (2026-11-20).

## Trade
- O "Trilho do trade" mostra as etapas e de quem é a vez. Só aparece etapa ou vez que um dado real sustente. Se a interface não pode agir, nunca diz "Sua vez" (2026-11-20, auditoria de verdade).
- O Sails Agent e "Alterar endereço" ficam em "Ferramentas", sem sumir (2026-11-20).

## Pendente de decisão (não tratar como fechado)
- Formato do dólar: "US$ 97.800,00" (adotado) ou "$97,800.00". Aguarda o OK do Product Owner.
- As decisões provisórias do Design System listadas no `DESIGN_SYSTEM.md` e no README do artefato aguardam o Design System Architect.
- As 7 perguntas do Trade Workspace (cor do marcador de vez, "Partes podem contestar até o prazo", etapas concluídas em cinza, trilho compacto no tablet, Ferramentas em dois cliques, recurso de teste no modo demonstração, sua própria linha no bloco da contraparte) e os rótulos dos tipos de escrow aguardam o Architect.
