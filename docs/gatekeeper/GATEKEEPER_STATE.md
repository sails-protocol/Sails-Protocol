# Gatekeeper Compacto — Estado operacional (não normativo)

> Registro de continuidade; não substitui AGENTS.md, docs/engineering/AI_SESSION_ONBOARDING.md, ENGINEERING_GOVERNANCE, BACKLOG, invariantes, especificações, GitHub Project ou decisões do CTO. Estado sujeito à reconciliação live em cada rodada.

## Referência verificada em 2026-10-17
- Repositório: sails-protocol/Sails-Protocol
- PR de integração: #485 (OPEN, DRAFT, NO MERGE), branch `gatekeeper/st1-r2-aud1x-r4-integration-sandbox`
- HEAD observado da PR: `e2e852cae6511b769758e3883630b3fdcd2828f2` (revalidar antes de qualquer ação).
- Preparação: 98% **estimativa herdada**, não homologada nem calculada a partir de critérios fechados.
- Gate 3: **VERMELHO / OPEN**, sem permissão de merge, deploy, freeze ou promoção.
- PRs fonte #436 e #443: preservar sem alteração.
- Issue #453: OPEN; falha de liveness de pending órfão após persistência e throw de dispatch, exige regressões reais PostgreSQL e análise de autorização, geração e concorrência.
- Bloqueios declarados na PR #485: CI combinado no HEAD exato, regressão PostgreSQL, #453 e revisão CTO. Status dos jobs não verificado neste registro.

## Zero pendências ocultas
Nenhum item pode ser removido da lista por silêncio, mudança de sessão ou CI verde isolado. Para encerrar: vincular issue/PR, HEAD, propriedade testada, evidência reproduzível, resultado adversarial e decisão autorizada. Diferenciar UNKNOWN, FAIL e PASS. Se faltarem evidências, manter pendente. Mocks não comprovam semântica transacional PostgreSQL.

## Checklist de conclusão (sem inferir 100%)
- [ ] Reconciliar HEAD, PR, Project, BACKLOG, governança e ownership.
- [ ] CI integral e relevante no HEAD final, com falhas investigadas.
- [ ] #453: recuperação crash/restart-safe, lock D→E, geração/proveniência, autorização econômica, concorrência e idempotência demonstradas em PostgreSQL real.
- [ ] Deadlocks e regressões ST1/AUD1X/R4/C8 pertinentes resolvidos com evidência.
- [ ] Invariantes econômicos, criptográficos e de assinatura demonstrados, sem enfraquecer guardrails.
- [ ] Revisão independente CTO e aprovações formais registradas.
- [ ] Nenhum bloqueio oculto; rastreabilidade e critérios de promoção satisfeitos.

## Operação compacta por rodada
1. Verificar HEAD e estado live; se mudou, invalidar evidências não aplicáveis ao novo HEAD.
2. Selecionar um bloqueio e consultar somente arquivos, steps e trechos de log pertinentes. Logs integrais ficam no GitHub Actions; registrar URLs e conclusões, nunca copiar logs extensos.
3. Investigar → corrigir em missão autorizada → testar em fronteira real → registrar evidência. STOP para autoridade incerta, contradição ou semântica congelada.
4. Responder em até oito campos: preparação (estimativa/medição), HEAD, resolvido, pendente, testes, commits, decisão VERDE/VERMELHO, próxima ação.
5. Atualizar este registro apenas para deltas operacionais verificáveis; a fonte canônica de cada decisão permanece no seu documento/issue/PR.

## Próxima ação
Conferir checks/jobs de #485 no HEAD exato e investigar #453 sem editar as PRs fonte. Não aguardar passivamente enquanto houver trabalho seguro. Sem autorização para merge/deploy/freeze.
