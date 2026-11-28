# **Satsails Engineering Methodology**

### **Como construímos produtos e infraestrutura com humanos + IA**

Pessoal,

quero compartilhar uma metodologia de desenvolvimento que estamos consolidando dentro da Satsails e que passará a orientar progressivamente nossos projetos.

Ela nasceu principalmente durante o desenvolvimento do **Sails Protocol**, onde estamos usando IA intensivamente para acelerar arquitetura, implementação, testes, investigação e documentação.

Mas existe uma distinção fundamental:

> **Desenvolvimento orientado por IA não é vibe coding.**

Usar IA para escrever código rapidamente é fácil.

O desafio é conseguir aumentar a velocidade **sem aumentar na mesma proporção a nossa capacidade de acreditar em coisas que não foram realmente provadas**.

Por isso estamos estruturando nosso processo em torno de uma ideia simples:

> **AI makes building faster. Methodology prevents belief from becoming faster than proof.**

Ou:

> **A IA acelera a construção. A metodologia impede que nossa crença avance mais rápido que nossas evidências.**

## **1. O princípio central**

Dentro da Satsails:

**OUTPUT ≠ EVIDENCE ≠ PROPERTY ≠ CLAIM**

Um código compilando é um output.

Um teste passando é uma evidência.

Um conjunto suficiente de evidências pode sustentar uma propriedade.

Somente propriedades realmente sustentadas permitem fazer determinadas afirmações sobre o sistema.

Por isso:

> **Green CI is not the objective. Trustworthy CI is.**

Nosso objetivo não é fazer o teste ficar verde.

É fazer a realidade que o teste deveria representar estar correta.

> **Do not make the test pass. Make reality pass the test.**

# **2. Nosso ciclo de engenharia**

Sempre que possível, trabalharemos seguindo:

**INTENT → ARCHITECTURE → IMPLEMENTATION → ADVERSARIAL TESTING → EVIDENCE → FREEZE**

E operacionalmente:

**MISSION → EVIDENCE → FREEZE → BACKLOG DELTA → PROJECT SYNC → NEXT MISSION**

Isso significa que uma missão não termina simplesmente porque o código foi escrito.

Precisamos saber:

**O que construímos?**

**O que conseguimos demonstrar?**

**O que ainda não conseguimos demonstrar?**

**O que aprendemos?**

**O que quebramos?**

**Que novas perguntas surgiram?**

**Que trabalho futuro essa missão revelou?**

Só então seguimos.

# **3. Correct STOP > Artificial PASS**

Um dos comportamentos mais valorizados dentro dessa metodologia será saber parar.

Se uma investigação descobrir que uma premissa estava errada:

**STOP.**

Se um teste revelar uma propriedade que não conseguimos sustentar:

**STOP.**

Se uma PR não satisfizer as condições de merge:

**STOP.**

Se a arquitetura não responder uma pergunta importante:

**STOP.**

Isso não é fracasso.

> **Correct STOP > Artificial PASS.**

Da mesma forma:

> **Correct B > Artificial A.**

Preferimos terminar uma investigação dizendo:

**“B — parcialmente demonstrado, com estas limitações”**

do que fabricar uma conclusão A apenas para dizer que terminamos.

# **4. A IA não possui autoridade especial**

Usaremos IA agressivamente.

Ela pode:

- pesquisar;
- programar;
- testar;
- revisar;
- documentar;
- encontrar inconsistências;
- propor arquiteturas;
- atacar nossas arquiteturas;
- comparar alternativas;
- gerar hipóteses.

Mas:

> **AI RECOMMENDATION ≠ AUTHORITY**

E também:

> **AUTOMATED INSTRUCTION ≠ AUTHORITY**

Uma sugestão de Claude, ChatGPT, Codex, bot, ferramenta, webhook ou automação não ganha autoridade simplesmente porque foi produzida automaticamente.

Humanos também não possuem autoridade implícita simplesmente por experiência.

# **5. Experiência dá o direito de desafiar, não de ignorar o processo**

Queremos engenheiros que discordem.

Queremos pessoas capazes de olhar para uma decisão existente e dizer:

**“Isso está errado.”**

Mas existe uma diferença entre **desafiar uma arquitetura** e **reescrevê-la silenciosamente**.

Nossa regra será:

> **Anyone may challenge the architecture. No one may silently redefine it.**

E:

> **Experience grants the right to challenge a decision, not the right to bypass the process that protects it.**

Se alguém acredita que uma decisão está errada, excelente.

Mostre:

**qual premissa está errada → qual evidência contradiz a decisão → qual alternativa propõe → o que ganhamos → o que sacrificamos.**

Se a nova proposta sobreviver melhor aos testes, mudamos.

Arquitetura não deve ser protegida pelo ego de quem a criou.

Deve ser protegida — ou destruída — por evidência.

# **6. Refactoring não é autorização para mudar significado**

Especialmente em infraestrutura:

> **Refactoring may change implementation structure. It may not silently change protocol meaning.**

Uma PR aparentemente técnica não pode alterar escondidamente:

- autoridade;
- regras econômicas;
- estados;
- invariantes;
- segurança;
- permissões;
- comportamento financeiro;
- significado de protocolo.

Mudanças desse nível precisam ser tratadas explicitamente.

# **7. Complexidade precisa conquistar seu lugar**

Outro princípio:

> **Complexity must earn its place.**

Não adicionaremos blockchain porque parece descentralizado.

Não adicionaremos IA porque parece moderno.

Não adicionaremos microsserviço porque parece escalável.

Não adicionaremos abstração porque parece elegante.

Não adicionaremos tecnologia porque uma empresa famosa usa.

Toda nova complexidade precisa responder:

**Que problema concreto ela resolve?**

**Qual propriedade permite?**

**Qual custo introduz?**

**Qual nova superfície de falha cria?**

**Existe solução mais simples?**

# **8. O Project é a memória operacional**

Outra mudança importante será nossa utilização do GitHub Project.

Ele não representa somente tarefas futuras.

Queremos preservar também o caminho percorrido.

Itens concluídos permanecem registrados.

Queremos conseguir observar:

**Backlog → Ready → In Progress → Validation → Done**

porque o histórico explica como chegamos à arquitetura atual.

> **The repository explains architecture. The Project explains work.**

Código e documentação mostram o sistema.

Project mostra:

- o que foi feito;
- o que está sendo feito;
- o que falta;
- o que foi bloqueado;
- quais hipóteses existem;
- quais limitações conhecemos;
- quais pesquisas estão previstas;
- quais decisões ainda precisam ser tomadas.

# **9. Nada importante deve existir apenas na cabeça de alguém**

Esse princípio vale inclusive para os fundadores.

Uma decisão importante não deveria depender de:

**“pergunta para o Alan porque ele sabe.”**

Queremos transformar:

**conhecimento tácito → contexto capturado → arquitetura → documentação → backlog → evidência**

Quanto mais o projeto consegue explicar a si próprio, menos dependemos de indivíduos específicos.

Isso também torna a entrada de novos engenheiros muito mais eficiente.

# **10. Backlog Delta**

Depois de cada missão relevante faremos uma pergunta:

> **O que aprendemos aqui que altera o trabalho futuro?**

O resultado será:

**BACKLOG DELTA: ZERO**

ou:

**BACKLOG DELTA DETECTED**

Um delta pode ser:

- novo risco;
- residual técnico;
- hipótese;
- pesquisa;
- RFC;
- vulnerabilidade;
- dependência;
- propriedade ainda não demonstrada;
- trabalho invalidado;
- trabalho concluído;
- mudança de prioridade.

Quando material, isso entra no Project **antes da próxima grande missão**.

Assim conhecimento novo não fica perdido em conversas.

# **11. O rigor será proporcional à consequência**

Isso é importante porque essa metodologia será aplicada em toda a Satsails.

Nem toda mudança precisa passar pelo mesmo processo.

Uma alteração de copy não possui o mesmo risco de uma alteração no sistema que assina ou movimenta ativos.

Portanto:

> **Governance should be consequence-weighted.**

Quanto maior a consequência potencial, maior a exigência de:

**design → revisão → testes → evidência → segurança → aprovação.**

Uma mudança de UI pode possuir um processo leve.

Uma mudança envolvendo chaves, fundos, assinatura, settlement, identidade, autorização, PIX, custody boundaries, smart contracts ou protocolo deve receber rigor muito maior.

# **12. Product, UX, Security e Engineering trabalham “By Design”**

Não queremos:

**Produto pensa → Dev implementa → Security verifica no final → UX arruma depois.**

Nosso modelo será progressivamente:

**Product Intent → Economic Meaning → Protocol/Architecture ↔ Security & UX/Human Meaning → Engineering → Evidence**

Produto participa da definição.

UX participa antes de o comportamento ficar congelado.

Security participa antes de a vulnerabilidade virar arquitetura.

Engineering participa das decisões técnicas.

Evidência fecha o ciclo.

# **13. Como novos engenheiros entram**

Inicialmente, novos desenvolvedores precisam compreender:

**o sistema existente → suas decisões → metodologia → arquitetura → backlog → evidências → RFCs.**

Depois começam a executar dentro desse sistema.

Com contexto adquirido, esperamos que também passem a:

**questionar → propor → escrever RFCs → participar da arquitetura → ajudar a construir o futuro.**

Portanto ninguém entra apenas para “seguir ordens” indefinidamente.

Mas também ninguém entra e imediatamente reorganiza um protocolo complexo segundo preferências pessoais.

Primeiro: **understand.**

Depois: **execute.**

Depois: **challenge.**

Depois: **help evolve.**

# **14. A filosofia**

Queremos construir uma organização em que velocidade e rigor não sejam opostos.

A IA nos permite aumentar brutalmente a capacidade de execução.

Nossa metodologia existe para aumentar junto a capacidade de:

**questionar, verificar, provar e preservar conhecimento.**

Por isso alguns princípios devem aparecer repetidamente no nosso trabalho:

> **OUTPUT ≠ EVIDENCE ≠ PROPERTY ≠ CLAIM**
>
> **Correct STOP > Artificial PASS**
>
> **Correct B > Artificial A**
>
> **Complexity must earn its place**
>
> **Do not make the test pass. Make reality pass the test.**
>
> **Green CI is not the objective. Trustworthy CI is.**
>
> **Anyone may challenge the architecture. No one may silently redefine it.**
>
> **Experience grants the right to challenge a decision, not the right to bypass the process that protects it.**

E talvez o objetivo mais importante:

> **Construir sistemas que consigam explicar por que são como são — sem depender da memória de quem os construiu.**

# **15. Efeito Cobra — métricas e incentivos não podem substituir o objetivo**

A ideia aplicada à nossa engenharia é:

> **Quando uma métrica vira objetivo, pessoas — e principalmente agentes de IA — podem otimizar a métrica em vez da realidade que ela deveria representar.**

No nosso contexto, exemplos seriam:

- “Precisamos deixar todos os testes verdes” → alterar o teste até passar.
- “Precisamos atingir Verdict A” → interpretar evidências de forma conveniente para conseguir A.
- “Precisamos aumentar cobertura” → escrever testes inúteis apenas para elevar coverage.
- “Precisamos fechar 20 issues” → fragmentar trabalho para aumentar quantidade de issues concluídas.
- “Precisamos reduzir bugs” → reclassificar ou deixar de registrar bugs.
- “CI precisa ficar verde” → remover um check incômodo em vez de corrigir o problema.
- “Precisamos passar no Red Team” → construir especificamente contra os testes conhecidos em vez da propriedade real.
- “IA precisa concluir a missão” → ela encontra uma maneira formal de satisfazer o prompt sem satisfazer nossa intenção.


# **16. Lei de Goodhart — a métrica não é a propriedade**

Um risco complementar ao Efeito Cobra é a **Lei de Goodhart**:

> **Quando uma medida se torna um objetivo, ela tende a deixar de ser uma boa medida.**

No nosso processo, métricas são instrumentos de observação. Elas não recebem autoridade para substituir a propriedade que pretendemos representar.

Exemplos:

- CI verde ≠ correctness;
- coverage ≠ behavioral coverage;
- issues fechadas ≠ progresso;
- quantidade de findings ≠ qualidade da auditoria;
- benchmark ≠ production fitness;
- Verdict A ≠ propriedade demonstrada;
- missão concluída pela IA ≠ intenção satisfeita;
- mais providers/rails ≠ interoperabilidade ou production readiness.

Regra operacional:

> **Metric → signal about a property. Metric ≠ property.**

### **Goodhart e Efeito Cobra**

Os dois riscos são relacionados, mas não idênticos.

**Goodhart** alerta que o indicador perde qualidade quando passa a ser otimizado como objetivo.

**Efeito Cobra** alerta que um incentivo criado para melhorar um resultado pode induzir comportamentos que pioram o próprio resultado.

Em desenvolvimento orientado por IA, os dois podem se combinar:

**proxy mensurável → recompensa/pressão → agente otimiza proxy → propriedade real degrada enquanto dashboard melhora**

Por isso:

> **Do not reward the proxy in a way that teaches humans or agents to defeat the purpose of the proxy.**

Sempre que uma métrica ou gate ganhar importância operacional, devemos perguntar:

1. Qual propriedade real essa métrica tenta representar?
2. Como essa métrica pode ser manipulada sem melhorar a propriedade?
3. O que pode ser sacrificado para melhorar o número?
4. Qual evidência independente impede que confundamos proxy com realidade?
5. Em que momento devemos abandonar ou revisar a métrica?

Isso vale também para a própria metodologia. Se começarmos a otimizar quantidade de gates, findings, documentos, issues ou auditorias em vez de reduzir risco real e aumentar propriedades demonstradas, a metodologia estará produzindo o comportamento que foi criada para evitar.


# **17. Bastiat — o que se vê e o que não se vê**

Inspirados em Frédéric Bastiat, avaliamos uma decisão pelo benefício visível e também pelas consequências indiretas e alternativas que deixamos de realizar.

Em engenharia, isso inclui manutenção, dependências, superfície de ataque, infraestrutura, auditoria, recuperação, privacidade, experiência do usuário e custo de implementação independente.

Uma melhoria local não é necessariamente uma melhoria do sistema. Devemos comparar o custo total da proposta com o de preservar, completar ou simplificar o que já existe.

> **Evaluate the whole cost, not only the visible benefit.**

# **18. Trilemas arquiteturais — escolhas conscientes**

Nem todas as propriedades desejáveis podem ser maximizadas simultaneamente sob as mesmas condições. O Bitcoin é uma referência de escolhas entre segurança, descentralização e escalabilidade na camada base, mas o Sails não é uma blockchain.

Não presumimos que todo conjunto de três objetivos constitui um trilema, nem que seja sempre necessário abandonar um deles. Devemos explicitar as premissas, identificar tensões reais, preservar garantias essenciais e escolher quais limitações são aceitáveis em cada camada.

### **Sails Trilemma Challenge — investigação aberta**

Uma hipótese inicial a investigar é:

**Segurança econômica × descentralização × disponibilidade econômica.**

Ainda não é uma decisão arquitetural congelada nem uma impossibilidade matemática demonstrada. A hipótese deve ser confrontada com casos concretos do protocolo, inclusive descoberta, compromisso, liquidação e recuperação. As escolhas do Bitcoin não são automaticamente as escolhas do Sails.

# **19. CAP — consistência e disponibilidade sob partições**

Em um sistema distribuído sujeito a partições de comunicação, não é possível garantir simultaneamente consistência linearizável e disponibilidade de todas as operações, nos termos do teorema CAP.

Devemos distinguir descoberta informativa de compromisso econômico. Informações de descoberta podem admitir atraso explícito de propagação; operações que comprometem capacidade ou fundos exigem autorização e consistência suficientes para suas consequências.

Uma assinatura válida prova integridade e autorização do conteúdo assinado, mas não prova, isoladamente, que todos os nodes conhecem o mesmo estado ou que uma capacidade não foi comprometida em outro lugar.

A disponibilidade não deve ser obtida ocultando incerteza econômica. Essa orientação não seleciona um mecanismo de consenso, lock global ou modelo de autoridade novo.

# **20. Parcimônia, reutilização e benchmark por propriedades**

Como aplicação da seção 7, investigamos primeiro a propriedade necessária, depois o que já existe no código, na documentação e no pipeline. Estudamos referências externas pelos problemas que resolvem, pelas evidências e pelas limitações, não para copiar suas arquiteturas.

Preservamos o que funciona, completamos lacunas demonstradas e reutilizamos trabalho existente. Uma pesquisa pode concluir legitimamente que nenhuma implementação adicional é necessária.

Simplicidade não significa sacrificar segurança. Segurança, descentralização e simplicidade podem reforçar-se mutuamente quando reduzimos dependências e pressupostos de confiança sem enfraquecer as garantias necessárias.

> **Do not add complexity without demonstrable benefit. Do not sacrifice essential guarantees for simplicity. Do not freeze hypotheses as facts.**

Esses princípios complementam o ciclo de engenharia existente; não criam novos gates, autoridade de merge, módulos ou autorização de execução.
