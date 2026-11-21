# Requisitos de identidade e portabilidade

> Extraído do [registro](PRODUCT_REQUIREMENTS_REGISTRY.md); em caso de divergência o registro prevalece. Não homologa nada.

## Princípios (a confirmar pelo CTO e pelo GK)
- Servidor não é identidade econômica: a identidade e a reputação pertencem à pessoa e devem ser portáteis e verificáveis fora de um aplicativo ou servidor específico.
- Sem custódia central obrigatória de chaves; recuperação sem expor a chave ao servidor.
- Avaliar Pears/Pubky e os trabalhos existentes (#542, #543, #545) antes de propor infraestrutura nova.
- Exposição pública mínima, com revisão do GK; nenhuma avaliação altera a reputação econômica.

## Requisitos

- [ ] **UX-001: Ler avaliações do anunciante (média, quantidade, comentários recentes)**
  - Origem: A1, Despacho 039 (P1) e Complemento 051-A. Antes de negociar, a pessoa quer ver a experiência que outros tiveram com aquele anunciante. A lista mostra "★ 4,8 (126)" na primeira vista.
  - Módulo: OpenReputation (com OpenIdentity e OpenP2P).
  - Contrato: só existe a escrita, `reputation.rate()` (`POST /v1/reputation/rate`), que é informativa e nunca entra na reputação. Não há leitura.
  - Proposta: consulta paginada por anunciante, com média, quantidade e comentários recentes, ordenação e estado sem avaliações. Ver UX-002.
  - Prioridade: P1. Depende de UX-002 e UX-020.
  - Estado:
    - Requisito aprovado (039 e 051-A).
    - Interface implementada: só simulada no modo demonstração. Com dados reais, nada aparece na lista e "Em breve" aparece no detalhe e no Perfil.
  - Issue: a criar pelo EPM. Fio solto: `readRatings`.
  - Decisão: Despacho 039 e Complemento 051-A.
  - Aceite:
    - o SDK devolve média e quantidade de avaliações reais e verificáveis;
    - a lista mostra a forma compacta e o detalhe mostra a completa;
    - as avaliações nunca alteram a reputação;
    - existe o estado sem avaliações.

- [ ] **UX-002: Avaliações portáteis e verificáveis**
  - Origem: Complemento 051-A. A pessoa leva o seu histórico de avaliações para qualquer aplicativo.
  - Módulo: OpenReputation, OpenIdentity e OpenP2P. Avaliar Pears/Pubky antes de propor infraestrutura nova.
  - Contrato: `rate()` grava de 1 a 5 com comentário, uma avaliação por avaliador e trade, só as partes do trade. Não há assinatura do avaliador, nem portabilidade, nem leitura.
  - Proposta:
    - nota de 1 a 5;
    - comentário opcional de até 280 caracteres;
    - assinatura verificável do avaliador;
    - vínculo com a identidade portátil e com um trade elegível;
    - proteção contra duplicadas e manipulação;
    - consulta pelo SDK;
    - regras de privacidade, disponibilidade e moderação.
  - Prioridade: P1. Depende de UX-020.
  - Estado:
    - Requisito aprovado (051-A).
    - Interface implementada: o cartão "Avaliar" no fim do trade já usa a escrita real. O limite de 280 caracteres e o contador estão em implementação.
  - Issue: a criar.
  - Decisão: Complemento 051-A.
  - Aceite:
    - a avaliação é assinada e verificável fora do app;
    - não aceita duplicadas;
    - o comentário tem no máximo 280 caracteres;
    - a consulta funciona por outro cliente.

- [ ] **UX-003: Data de cadastro pública (mês e ano)**
  - Origem: A2, Despacho 039 (P2). "Desde jan. de 2025" mostra há quanto tempo a pessoa negocia.
  - Módulo: OpenIdentity.
  - Contrato: `Participant.createdAt` existe só para o próprio usuário. `PublicOfferSeller` não tem a data, que foi retirada de propósito.
  - Proposta: só o mês e o ano, com a origem comprovada. Nunca confundir com a data da oferta ou da wallet.
  - Prioridade: P2.
  - Estado:
    - Requisito aprovado (039).
    - Interface implementada: no próprio Perfil, "Membro desde nov. de 2026". Para o anunciante, só simulada no modo demonstração.
  - Issue: a criar. Fio solto: `publicMemberSince`.
  - Decisão: Despacho 039.
  - Aceite: a data pública vem de uma fonte comprovada, em mês e ano, revisada pelo GK quanto à exposição.

- [ ] **UX-006: Identidade do anunciante na listagem de ofertas**
  - Origem: B1 e Despacho 051. A lista não mostra o avatar nem abre o perfil de quem anuncia.
  - Módulo: OpenIdentity e OpenLiquidity.
  - Contrato: `discover` não devolve o id nem a chave do anunciante (`realOffers.ts`).
  - Proposta:
    - identificador público portátil do anunciante no resumo da oferta;
    - perfil verificável, independente do aplicativo;
    - separação entre identidade, credenciais e reputação.
  - Prioridade: P1. Depende de UX-020.
  - Estado: requisito aprovado (051, segunda entrega).
  - Issue: #741.
  - Decisão: Despacho 051.
  - Aceite:
    - a lista mostra o avatar real e abre o perfil;
    - nenhum dado privado é publicado.

- [ ] **UX-020: Backup e recuperação da chave sem custódia central obrigatória**
  - Origem: D1 e Despacho 051, segunda entrega.
  - Módulo: OpenIdentity. Avaliar Pubky/Pear, com os trabalhos anteriores #542, #543 e #545.
  - Contrato: não há fluxo de exportar ou importar a chave.
  - Proposta: recuperação segura, sem custódia central obrigatória, com revisão de senha e de armazenamento de chaves (Despacho 037).
  - Prioridade: P1.
  - Estado: requisito aprovado (051).
  - Aceite: o usuário recupera a identidade sem depender de um custodiante, e o GK aprova.

- [ ] **UX-023: Avatar público escolhido pelo usuário**
  - Origem: D4.
  - Módulo: OpenIdentity.
  - Contrato: o avatar é gerado da chave, e o estilo escolhido vale só para quem escolheu.
  - Prioridade: P3.
  - Estado: identificado.
  - Fio solto: `publicAvatar`.


