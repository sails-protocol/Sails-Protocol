# CTO — Fila de execução e gates pós-Master Backlog

> **Status:** proposta operacional do CTO para revisão institucional; **não** é autorização de implementação, merge, deploy, Beta ou freeze.  
> **Baseline de reconciliação:** `main` `71c0d8b69925d616d577f95d574407389970ec93` (2026-10-17).  
> **Autoridade:** `docs/BACKLOG.md`, `docs/ROADMAP.md`, ADRs e Issues canônicas continuam governando o escopo. O GitHub Project e os HEADs atuais devem ser reconsultados no momento de execução.  
> **Princípio:** terminar o Master Backlog **antes de promover novas frentes futuras**; distinguir gates de Beta de expansões. Não fechar Issues por mera documentação.

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
| **B — Beta Readiness** | B1. Reality Validation, multioperador, conformance e matriz de capacidades | [#165](https://github.com/sails-protocol/Sails-Protocol/issues/165), [#105](https://github.com/sails-protocol/Sails-Protocol/issues/105) | Master Backlog encerrado com evidência, sem pendência econômica ou de segurança bloqueante | Registro de cenários reais, adaptadores/rails/capabilities efetivamente testados, resultados e falhas | Gate de evidência; **não** homologação presumida |
| **B — Beta Readiness** | B2. Corpus de incidentes → Red Team → ensaio econômico / controles | [#420](https://github.com/sails-protocol/Sails-Protocol/issues/420), [#77](https://github.com/sails-protocol/Sails-Protocol/issues/77) | B1 suficientemente demonstrado; trilha de produção materialmente completa | Precedente externo → condição Sails → invariante → teste falsificável; depois casos adversariais | #420 antecede Red Team; #77 é horizonte, não autorização imediata |
| **C — Expansão** | C1. Multi-Wallet-Kit + Multi-Rail | [#86](https://github.com/sails-protocol/Sails-Protocol/issues/86), [#152](https://github.com/sails-protocol/Sails-Protocol/issues/152) | Core/contratos estáveis; conformance e regras de lifecycle/revalidação definidos; prioridade por demanda real | Selecionar **um** kit + rail elegível, implementar integração vertical e demonstrar falha/recovery e limites de autoridade | Nove alvos **planejados**: BDK, WDK, Breez, Spark, LDK, Ethers/EVM, Tron, Solana, TON. WalletAdapter ≠ SettlementProvider |
| **C — Expansão** | C2. SDK/DX, interfaces e outras plataformas | [#75](https://github.com/sails-protocol/Sails-Protocol/issues/75), [#152](https://github.com/sails-protocol/Sails-Protocol/issues/152) | Superfície canônica de API/SDK e contrato de conformance definidos | Comparar CLI, MCP, WebMCP, Web/mobile, Swift/Kotlin, Rust/Go por menor integração correta; escolher um recorte com testes | Rust/Go não são traduções automaticamente equivalentes; agente não adquire autoridade por acessar ferramenta |
| **C — Expansão** | C3. Sandbox, Test Harness e Playground | [#78](https://github.com/sails-protocol/Sails-Protocol/issues/78), [#165](https://github.com/sails-protocol/Sails-Protocol/issues/165) | Contratos reais e cenários de validação utilizáveis; isolamento de valor econômico | Harness programático com cenário reproduzível; sandbox e UI somente sobre semântica real | Playground não deve simular protocolo alternativo; mocks isolados não provam produção |
| **C — Expansão** | C4. Reference Components, Design System e UI | [#217](https://github.com/sails-protocol/Sails-Protocol/issues/217); `docs/BACKLOG.md` itens 22–25 | Chegada efetiva à etapa de UI na ordem do Master Backlog; contratos de produto/SDK revalidados | Auditar `packages/sails-ui/DESIGN.md`, reconciliar protótipos e implementar **uma** jornada vertical com Storybook, acessibilidade e verdade econômica | Handoff de design é pré-trabalho, não implementação; Sails Market ≠ componente reutilizável |
| **D — Discovery / condicionais** | D1. Escalabilidade multi-integrador (acompanhamento) | [#473](https://github.com/sails-protocol/Sails-Protocol/issues/473) | Execução do workstream **já aberto no Master Backlog**, sem antecipar Claude | Modelo de capacidade 10k/100k/1M/10M MAU com hipóteses explícitas; testes que separem medida de projeção | Não alegar prontidão para 1M MAU sem prova |
| **D — Discovery / condicionais** | D2. Taproot threshold, mercados adjacentes e automação de agentes | [#121](https://github.com/sails-protocol/Sails-Protocol/issues/121), [#438](https://github.com/sails-protocol/Sails-Protocol/issues/438), [#155](https://github.com/sails-protocol/Sails-Protocol/issues/155), [#231](https://github.com/sails-protocol/Sails-Protocol/issues/231) | Decisão de arquitetura/produto específica, risco e orçamento delimitados | Discovery com alternativas, threat model e evidência de necessidade | Não implementar por constarem na fila; DePix Terminal é Sails Market, não Core |
| **E — Radar** | E1. Atualização QVAC e pesquisa de routing | [#84](https://github.com/sails-protocol/Sails-Protocol/issues/84), [#124](https://github.com/sails-protocol/Sails-Protocol/issues/124) | Gatilho upstream/evidência ou autorização CTO explícita | Reabrir avaliação limitada com HEAD e compatibilidade reais | Sem promoção automática |

## Bloqueios de promoção

- **Não** iniciar C/D/E apenas porque A tem checks verdes: conclusão do Master Backlog e gates de Beta são decisões distintas.
- **Não** converter pesquisa, handoff ou radar em implementação sem decisão registrada.
- **Não** promover adapter/rail/SDK a `supported` por existir nome, interface, mock ou pacote vazio.
- **Não** usar números de escala projetados como evidência de throughput.
- **Não** inferir `settled` de ruling, `verified` de payment sent, `FAILED` de UNKNOWN, nem autoridade de recomendação de agente.
- **Não** reordenar `docs/BACKLOG.md` itens 22–25: C4 reentra quando a sequência canônica chegar a eles, ainda que a fila de expansão apresente outra ordem de leitura.

## Próximo checkpoint do CTO

Após evidência formal de fechamento do Master Backlog: (1) revisar a matriz de bloqueios A; (2) verificar a sequência B de Beta Readiness; (3) reconciliar o GitHub Project live; (4) escolher **um** incremento elegível da classe C; (5) emitir missão de execução delimitada, com aceite e STOP. Até lá, manter a fila como **planejamento**, sem trabalho de Gatekeeper/Claude provocado por este documento.
