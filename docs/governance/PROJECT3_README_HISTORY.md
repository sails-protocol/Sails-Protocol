# Project #3 README: registro histórico preservado

> **Status:** preservação documental (docs-only). Não é fonte de verdade operacional, não altera decisões, ADRs, critérios nem contadores. Formal Day 0 **3/54**; CC12–CC17 **0/6**.

**Origem:** campo `readme` do GitHub Project #3 (privado), lido em 2026-11-11 com base na `main` `2c2a9e02`. **Motivo:** o campo `readme` tem limite de 65.536 caracteres e chegou a 65.523. O CTO 24 autorizou aliviar o limite preservando integralmente o parágrafo histórico em registro versionado, com link estável no README ([#105, comentário 6809412018](https://github.com/sails-protocol/Sails-Protocol/issues/105#issuecomment-6809412018)). **Procedimento:** o parágrafo foi copiado literalmente, sem edição, antes de ser substituído no README por um resumo com link para este arquivo.

## Verificação de integridade

| Trecho | Caracteres | SHA-256 (UTF-8, sem quebra de linha final) |
|---|---|---|
| Parágrafo "Decisões vigentes (CTO, 2026-11-04 a 06)" | 2263 | `d32efee7ad4e25ab973ab3169cf06ab3663f95dc80c0c57601b279410e8c7207` |
| Nota datada adjacente (errata EPM de 2026-11-11) | 530 | `f0ea1970e3de44ddc167bb0620f4b406558de3a546a3c250756532719b956161` |
| README completo antes da substituição | 65523 | `1393988830dc481d487538d73ec730cae1fe64becc32a0855e3052293ca8f10a` |

Para conferir: o texto entre as cercas abaixo, sem as linhas de cerca, deve produzir o SHA-256 da tabela.

## 1. Parágrafo "Decisões vigentes (CTO, 2026-11-04 a 06)", texto integral

~~~~markdown
**Decisões vigentes (CTO, 2026-11-04 a 06; [#105](https://github.com/sails-protocol/Sails-Protocol/issues/105)).** (a) **E1 multioperador:** v0.5 em NO-GO para congelamento; E1-B1 a B4 pendentes; sem código ([registro](https://github.com/sails-protocol/Sails-Protocol/issues/105#issuecomment-6637636550)). (b) **[#580](https://github.com/sails-protocol/Sails-Protocol/pull/580)** (ADR-003, Draft): GO condicionado do GK só às duas correções documentais; sem GO de merge. (c) **[#581](https://github.com/sails-protocol/Sails-Protocol/pull/581)** (teste de `eventProjectionClaims`, Draft): parecer limitado ao fixture; não fecha o #341 ([registro](https://github.com/sails-protocol/Sails-Protocol/issues/105#issuecomment-6637578605)). (d) **#341:** [#582](https://github.com/sails-protocol/Sails-Protocol/pull/582) e [#583](https://github.com/sails-protocol/Sails-Protocol/pull/583) mergeadas (só testes); `main` `9c2d3f7b` verde; GK final: **GO condicionado** ([parecer](https://github.com/sails-protocol/Sails-Protocol/issues/341#issuecomment-6648386051)). [#584](https://github.com/sails-protocol/Sails-Protocol/pull/584) (Draft, merge NO-GO): decisões do CTO [D1 a D4](https://github.com/sails-protocol/Sails-Protocol/issues/341#issuecomment-6648677613) e [D5/D6](https://github.com/sails-protocol/Sails-Protocol/pull/584#issuecomment-6663224562); GK NO-GO em `599202b8`; o `build` de `0c1247e4` falhou na tentativa 1 (`eventProjectionClaims`) e passou na reexecução, o que não prova inocência. **B″:** NO-GO pré-implementação do GK ([parecer](https://github.com/sails-protocol/Sails-Protocol/issues/341#issuecomment-6675288389)): falta especificação C1 a C5; Tier 3 em NO-GO até auditoria do GK e autorização do CTO ([CTO 23](https://github.com/sails-protocol/Sails-Protocol/issues/341#issuecomment-6674164743)). Próximo marco: especificação D5 verificável → auditoria do GK → decisão do CTO. **D7/C3.2:** o GK confirmou o defeito WDK como crítico para fundos; a [#585](https://github.com/sails-protocol/Sails-Protocol/pull/585) (Draft, `7bd64f0a`) é a correção, **em auditoria do GK, não homologada**, com `build` vermelho no head ([EPM](https://github.com/sails-protocol/Sails-Protocol/issues/341#issuecomment-6685234381)). #341 aberta; Day 0 e deploy NO-GO.
~~~~

## 2. Nota datada adjacente, texto integral

~~~~markdown
**Nota datada (2026-11-11, errata do EPM; autorização do CTO em [#105](https://github.com/sails-protocol/Sails-Protocol/issues/105#issuecomment-6799538974)).** No parágrafo acima, "Draft" para a [#581](https://github.com/sails-protocol/Sails-Protocol/pull/581) e a [#585](https://github.com/sails-protocol/Sails-Protocol/pull/585) é o status histórico do período, não o estado vigente: a #581 foi mergeada em 2026-11-09 (`b2ca015b`) e a #585 em 2026-11-09 (`c371ffb8`). Mergeada não é homologada. O texto histórico foi preservado.
~~~~

## 3. Leitura

O texto acima é a fotografia do período 2026-11-04 a 06. Estados como "Draft" para #581 e #585 são históricos: ambas foram mergeadas em 2026-11-09 (`b2ca015b` e `c371ffb8`); mergeado não é homologado. As decisões vivas estão na [Issue #105](https://github.com/sails-protocol/Sails-Protocol/issues/105) e nas issues e PRs citadas.