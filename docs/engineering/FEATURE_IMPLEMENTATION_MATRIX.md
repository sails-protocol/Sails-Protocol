# Sails Protocol — Matriz de execução por recurso (handoff para desenvolvedores)

> **Status:** índice operacional / template de reconciliação; **não** é nova fonte normativa, aprovação de stack, certificado de completude, autorização de implementação, merge ou produção.
> **Baseline da preparação:** main `fc86c365c9292a7e10a969edaf623776ab2ef91a` (2026-10-17). **Antes de executar, reconcilie o HEAD e GitHub Project/Issues vivos.**
> **Regra:** documentação não substitui código, testes reais, evidências de produção ou decisões aceitas. Se fontes divergirem, **STOP**, escalar ao owner canônico e não adivinhar.

## 1. Caminho de leitura obrigatório

1. [AGENTS.md](../../AGENTS.md) → [onboarding](AI_SESSION_ONBOARDING.md) → [router](../00-INDEX.md).
2. **Produto e requisitos:** [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md), [ROADMAP.md](../ROADMAP.md), [API_REFERENCE.md](../API_REFERENCE.md) quando aplicável. `BACKLOG.md` **não é backlog de produto**.
3. **Semântica e contratos:** [SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md), [SEMANTIC_KERNEL.md](../SEMANTIC_KERNEL.md), [PROTOCOL_SPECIFICATION.md](../PROTOCOL_SPECIFICATION.md), [PROTOCOL_INVARIANTS.md](../PROTOCOL_INVARIANTS.md), [CORE_ARCHITECTURE.md](../CORE_ARCHITECTURE.md), [CORE_IMPLEMENTATION_ARCHITECTURE.md](../CORE_IMPLEMENTATION_ARCHITECTURE.md), ADRs e RFCs aceitos.
4. **Execução:** [BACKLOG.md](../BACKLOG.md), [ENGINEERING_GOVERNANCE.md](../ENGINEERING_GOVERNANCE.md), [GITHUB_PROJECT.md](../GITHUB_PROJECT.md), Issues/PRs/CI atuais, [CONTRIBUTING.md](../../CONTRIBUTING.md) e [CODE_STYLE.md](../CODE_STYLE.md).
5. **Depois do Master Backlog:** [POST_MASTER_BACKLOG_EXECUTION_QUEUE.md](POST_MASTER_BACKLOG_EXECUTION_QUEUE.md). A fila não permite antecipar itens bloqueados.

## 2. Ferramentas: descobrir e fixar, não inventar

- **Inventário executável:** `package.json`, `package-lock.json`, workspaces `packages/*`, `examples/*`, `contracts`; scripts de build, test, conformance e CI. **Versões efetivas vêm do lockfile e do HEAD, não deste texto.**
- **Referência de persistência:** Prisma 7 + PostgreSQL (`prisma/schema.prisma`, `prisma.config.ts`, `common/database/index.ts`). Redis aparece na topologia de deployment; verifique contratos reais antes de assumir atomicidade/distribuição.
- **Referência de implementação:** TypeScript/Node no runtime de referência, pacotes SDK/Core separados. Não impor a mesma stack a integradores ou ao protocolo puro.
- **Ferramentas de testes:** use os comandos e suites existentes; integração real PostgreSQL, testes de concorrência/restart, conformance e CI no HEAD exato quando o risco exigir. Mocks/stubs isolados **não** comprovam invariantes econômicos.
- **Escolha de nova biblioteca/framework/serviço:** registrar necessidade, alternativa existente, compatibilidade, manutenção/licença, superfície de segurança, custo, lockfile, benchmark e ADR/RFC se mudar contrato. Sem aprovação, **não substituir a stack por preferência do agente**.
- **IA desenvolvedora:** import/export e APIs devem existir no código e versões instaladas; compilar, testar, inspecionar falhas e distinguir evidência de afirmação. IA não tem autoridade de merge, freeze, deploy ou movimentação econômica.

## 3. Matriz inicial de recursos e autoridades

Esta matriz **é um mapa de navegação**, não uma declaração de feature pronta. Cada linha exige preenchimento do formulário da seção 4 e reconciliação do owner vivo.

| Recurso / vertical | Requisito de produto a detalhar | Contrato / implementação a localizar | Owner / gate de partida | Estado de especificação nesta matriz |
| --- | --- | --- | --- | --- |
| Identidade / participantes | identidade, autenticação, vínculos e consentimento | Semantic Kernel, Protocol Spec, OpenIdentity, schemas e auth | BACKLOG / Issues vivas | **A reconciliar por requisito** |
| Liquidez / ofertas | criação, revisão, descoberta, disponibilidade e expiração | OpenLiquidity, OpenP2P, invariantes e multioperador | #105, BACKLOG | **A reconciliar** |
| Negociação P2P / trades | negociação, abertura, cancelamento, estados e retomada | OpenP2P, protocolos de trade, API Reference | #105, #165 | **A reconciliar** |
| Escrow / settlement | travamento, liberação, reembolso, prova e resultado econômico | OpenSettlement, Provider/Adapter contracts, authority/recovery | #453, #220, PR #436 | **Gate crítico; não modificar sem autorização** |
| Disputas / apelações | abertura, evidência, ruling, revisão, autoridade de execução | Dispute/Appeal, ADR/RFC, recovery, provenance | #453, PR #436, PR #443 | **Gate crítico; não modificar sem autorização** |
| Provas / evidências | claims, verificação, upload, retenção e acesso | OpenProof, storage e API | #234, #265, #267 | **Lacunas Day 0** |
| Reputação / eventos | efeitos econômicos, projeções e idempotência | OpenReputation, event store, handlers | #253, BACKLOG | **Lacunas Day 0** |
| Rede / nós | bootstrap, identidade de nós, descoberta e convergência | ADR-001, P2P, deployment | #105, #361 | **Gate Day 0** |
| SDK / integradores | integração neutra, capacidade por adapter e conformance | packages SDK/Core, Protocol Spec | #75, #152, #165 | **Distinguir atual vs futuro** |
| UI / Sails Market | estados e jornadas sem falsear verdade econômica | PROJECT_CONTEXT §2D, #217 e handoff de design (localização a confirmar no HEAD) | #217, BACKLOG itens 22–25 | **Master Backlog, não postergar** |
| IA / QVAC | recomendações limitadas sem autoridade econômica implícita | AI Harness e guardrails | #155, #309, #165 | **Discovery/validação separadas** |
| Operação / observabilidade | métricas, logs, tracing, rate limits e recuperação | config, deployment, DB schema, métricas | #306, #307, #343, #473 | **Gaps Day 0 vs escala** |
| Segurança / Red Team | prevenir abuso e testar composições adversariais | security audit, incident corpus, Red Team | #297, #420, #77, #487 | **Owners distintos** |
| Pós-backlog / expansão | wallet-kit, rails, DX, playground e research | POST_MASTER_BACKLOG_EXECUTION_QUEUE | #86, #75, #78, #121, #438 | **Não implementado por listagem** |

## 4. Cartão obrigatório por feature (copiar para Issue ou PR)

```yaml
feature_id: "<Issue/identificador canônico>"
nome: "<recurso>"
fase: "Day0 | Master Backlog | Post-Master Backlog | Discovery"
status: "PROPOSED | SPECIFIED | IMPLEMENTED_UNVERIFIED | VERIFIED | BLOCKED"
owner: "<responsável real; não inventar>"
product_requirement:
  user_or_integrator: "<quem usa>"
  job_to_be_done: "<resultado observável>"
  acceptance_scenarios: ["<happy path>", "<falha/recovery>", "<abuso>"]
  out_of_scope: ["<explicitamente fora>"]
technical_contract:
  governing_sources: ["<Spec/ADR/RFC/Issue e seção>"]
  invariants: ["<propriedades que não podem ser quebradas>"]
  authority_boundary: "<quem pode observar/propor/autorizar/executar>"
  data_model: "<modelos, índices, transações, migrations e constraints>"
  api_events: "<endpoints, schemas, idempotência, ordenação e eventos>"
tooling:
  existing_packages_and_versions: ["<caminho + versão verificada no lockfile>"]
  permitted_runtime_services: ["<evidência de aprovação>"]
  new_dependency_decision: "NONE | REQUIRES_ADR | APPROVED:<ref>"
implementation:
  code_locations: ["<paths reais>"]
  prerequisite_issues: ["<IDs e gates>"]
  ordered_steps: ["<incremento limitado e verificável>"]
  rollback_recovery: "<método e prova>"
verification:
  unit_and_typecheck: ["<comandos e resultado>"]
  integration_real_services: ["<Postgres/Redis/provider, quando exigido>"]
  adversarial_negative_tests: ["<concorrência, replay, falhas, mutations>"]
  exact_head_ci: "<SHA e checks>"
  evidence_links: ["<PR/log/artefato verificável>"]
  residual_risks: ["<lacunas não escondidas>"]
decision: "STOP | REVIEW | ADOPT | DEFER | REJECT"
```

## 5. Plano de implementação de uma feature

1. **Intake:** verificar se já há Issue/owner; classificar Day 0, Master, post ou discovery. Não duplicar.
2. **Requisitos:** preencher o resultado de produto, cenários e limites; indicar lacunas explicitamente.
3. **Contrato:** identificar as fontes canônicas e invariantes; decisão nova pede ADR/RFC antes do código.
4. **Stack:** inspecionar arquivos/versões efetivos; preferir ferramentas aprovadas; não inventar API ou capacidade.
5. **Plano:** decompor em mudanças pequenas com dependências e evidências de aceite; identificar impacto econômico, segurança, privacidade e migração.
6. **Implementar:** branch/PR limitados, sem tocar trabalho paralelo protegido; preservar compatibilidade e rollback.
7. **Verificar:** typecheck/build, unitários, integração real, concorrência/restart, conformance, segurança e CI no HEAD exato conforme risco.
8. **Gate:** revisão independente, classificação de achados e aprovação humana/CTO; verde de CI não equivale a produção.
9. **Handoff:** atualizar Issue com o cartão, código, decisões, comandos, SHA, evidências e riscos; sincronizar índice sem reescrever história.

## 6. STOP e limites deste registro

- **Nenhum percentual global de completude** foi inferido desta matriz. Linhas não preenchidas são lacunas de documentação/validação, não prova de ausência de código.
- Não substituir o backlog canônico por uma lista linear, nem redefinir semântica congelada.
- Sem mover correções Day 0 (#253, #267, #306, #307, #343, #461) para a fila pós-backlog.
- Não ativar Claude nem alterar PRs #436/#443 enquanto Gatekeeper não liberar.
- **Próxima fase documental:** preencher cada cartão a partir de código, testes, ADRs e Issues, com evidência; não declarar 100% de cobertura por criar este índice.
- **Revisão CTO 2026-10-17:** links relativos das fontes principais checados na `main`; a referência inicial `sails-ui/DESIGN` não foi localizada no caminho presumido e foi substituída por #217/handoff a confirmar. A matriz ainda **não contém PRDs individuais, inventário de ferramentas aprovado por recurso, responsáveis validados nem planos executáveis preenchidos**. Aprovar a estrutura deste índice não equivale a aprovar a completude funcional.
