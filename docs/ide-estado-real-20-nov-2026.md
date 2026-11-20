# AdaptAI · Estado real da extensão para IDE (VS Code)

Nov 20, 2026 · @José Moura, com o Claude (agente de IA)

Mesma estrutura do relatório "Estado real do produto" de 17 nov, só para o WS2 (extensão VS Code). Cada número diz de onde vem. Onde não verifiquei, está escrito.

## Resumo executivo

1. Das 8 tarefas do WS2 no Release Plan (semanas 12 a 15), **4 estão feitas e testadas** (E1, E2, E4, E8), **2 não foram feitas por dependerem de outras pessoas** (E5 e E0) e **2 são Plus e ainda não começadas** (E3, E6).
2. Corri um **teste longo numa janela real de VS Code**, neste PC, com o backend a sério (Postgres) e o modelo local do LM Studio: **38 de 38 verificações passam** na última corrida. Antes dessa corrida houve duas corridas com falhas; uma delas era um defeito real da extensão (ponto 3) e a outra era do meu teste.
3. O teste encontrou **um defeito real** no diff novo, já corrigido e com teste: se se acrescentava uma linha acima do código selecionado com o diff aberto, o Accept recusava. Agora encontra o código onde ele está agora (commit daf4800).
4. A qualidade do modelo na tarefa E1 (mudança pedida em código): **1 modelo medido** (o do LM Studio, `gemma4-12b`), 3 corridas de 10 amostras: bem formadas 10, 10 e 9 em 10; faz mesmo a mudança 9, 9 e 8 em 10. **Os modelos grátis pequenos do critério E1 não foram medidos**: só havia este carregado.
5. **O que continua a falhar ou por provar:** o Accept/Reject nunca foram clicados com o rato por uma pessoa (foram acionados pelo comando; os ícones ✓ e ✗ vi-os numa captura da janela); a análise (Analyse) não corre com um modelo real porque este backend não tem assessor (precisa de chave Groq, OpenAI ou Claude); o Codex run 4 (a passagem de uma pessoa/agente a clicar na página) ainda não foi feito; há uma lacuna em E2 (ficheiros `.env`, ponto 4.3).
6. Nada do que está em `feature/ide-ws2` foi enviado: são 8 commits à frente do PR #85, só locais.

## 1. Estado das tarefas do Release Plan (WS2)

| Tarefa | Prioridade | Estado | O que existe | O que falta |
| --- | --- | --- | --- | --- |
| E1 · Mudanças de código: diff e aplicar | Essencial | **Feito, medido num só modelo** | A proposta abre no diff do VS Code; **Accept** escreve numa só edição (um Ctrl+Z); se o código mudou, não aplica e oferece "Ask again"; uma resposta sem exatamente um bloco de código é rejeitada inteira | Medir mais modelos (critério: 10 amostras); clique humano nos botões; o nome no plano é "Apply", na extensão é "Accept" |
| E2 · Seleção como contexto | Essencial | **Feito** | Envia ficheiro, linguagem e linhas; antes de enviar mostra o texto exato; avisa quando corta (limite 8000); padrões de chave pedem confirmação | Lacuna: ficheiros `.env` (4.3); a pré-visualização na página só foi testada em Chromium, não por uma pessoa |
| E8 · Rapidez do painel | Essencial | **Feito antes desta fase; não mexi** | Separadores com estado guardado, token em SecretStorage; testes de página passam | Não medi o p95 do I1 (não sei qual é o alvo na minha cópia do plano) |
| E4 · Contexto do projeto | Essencial | **Feito** | Deteta linguagem, framework e executor de testes a partir de `package.json`, `tsconfig`, etc.; vai na análise como "Project: TypeScript, React, Vitest"; setting para desligar; nenhum conteúdo de ficheiro sai | Não vai como enum: vai como texto no `task_context` (≤ 4000 caracteres). O plano diz "enums"; falta decidir com o WS4 (ponto 3) |
| E5 · Coach para pedidos de código | Essencial | **Não feito, depende de outros** | Nada | Ver 3.1 |
| E0 · Eventos de uso e aprendizagem | Essencial | **Não feito, bloqueado** | Nada | Ver 3.2 |
| E3 · "Fix with AdaptAI" nos Problemas | Plus | Não começado | A base (E1 e E2) já existe | Tempo; é M e é Plus |
| E6 · Gerar testes da seleção | Plus | Não começado | A base (E1 e E4) já existe | Tempo; é M e é Plus, semana 14 |

## 2. O teste longo, por verificação

Ambiente: VS Code 1.147.0 neste PC (perfil descartável, sem Copilot), a extensão da pasta `vscode-extension` compilada hoje, backend local com PostgreSQL (Docker), modelo `gemma4-12b-qat-uncensored-hauhaucs-balanced` no LM Studio. Código do teste: `vscode-extension/src/selftest.ts` (só corre com variáveis de ambiente). Não clica na página do AdaptAI.

Última corrida: **38 de 38**. Tempo total: cerca de 5 minutos.

| Grupo | Verificações | Resultado |
| --- | --- | --- |
| Arranque | Barra de estado; os 32 comandos e atalhos registados; entrar com token | PASS |
| Chat | Responder (R2); Stop mantém o que já estava escrito (R3); Retry dá nova resposta (R4); código selecionado vai com a mensagem e a resposta é sobre ele (N2); títulos dos chats sem a seleção (regressão B4) | PASS (5 de 5) |
| Análise | Analyse com o modelo (R5); sem manifesto não há contexto de projeto; com manifesto vai "Project: TypeScript, React, Vitest" (N14); `adaptai.projectContext=false` desliga | PASS (4 de 4), com uma ressalva em 4.2 |
| Improve prompt | Diff, Apply, um Ctrl+Z repõe (R12); Dismiss deixa o texto | PASS (2 de 2) |
| Mudança sugerida | 5 pedidos diferentes, cada um com Accept e **um** Undo; Reject; Ctrl+S com o diff aberto guarda só o original e o Accept continua a funcionar (N9); letra escrita dentro das linhas: Accept não faz nada e avisa (N10); linha acrescentada em cima: substitui as linhas certas (N11); sem seleção não faz pedido (N12) | PASS (10 de 10) |
| Diff, modo mínimo | O ficheiro fica intacto e sem alterações por guardar; Accept mantém CRLF; Reject fecha o diff | PASS (5 de 5) |
| Endereço do backend | `http://example.com` é recusado com a razão (R14); backend desligado dá erro claro e volta a funcionar (R13) | PASS (2 de 2) |

Outros testes corridos hoje:

| Teste | Resultado |
| --- | --- |
| Testes unitários da extensão | 271 testes: 260 passam, 0 falham, 11 saltam (os que precisam de backend) |
| Testes de página em Chromium (`page.browser.cjs`, `page-layout.browser.cjs`) | Passam, sem erros na página |
| Integração contra um backend em modo demonstração | 11 de 11 |
| Integração contra o backend com o LM Studio configurado | 8 de 11: as 3 que falham pedem uma análise e este backend não tem assessor (Groq, OpenAI ou Claude). É do ambiente, não da extensão: a mesma suite passa 11 de 11 sem o LM Studio |
| Medição das 10 amostras (3 corridas) | 4.1 |

### 2.1 Falhas que o teste mostrou durante a sessão (e o que eram)

| Falha | Causa | Estado |
| --- | --- | --- |
| C09: com uma linha acrescentada acima, o Accept não aplicava | **Defeito real** da extensão: o Accept procurava o código nas linhas originais | Corrigido e com 2 testes novos (+1 de ambiguidade); commit daf4800 |
| L05 e C08 numa corrida anterior | Defeito do meu teste (esperava 2 chats; o buffer do ficheiro não era reposto) | Corrigido no teste |
| L08 (contexto de projeto) falhou **uma vez** na corrida completa e passou em todas as outras, também isolada | **Não encontrei a causa.** Nas corridas seguintes passou sempre | Aberto: fica como possível teste instável |

## 3. As duas tarefas que não fiz, e porquê

Decidi não fazer E5 e E0 porque eu sozinho não as consigo terminar de forma que se possa aceitar. Em ambos os casos não é falta de tempo.

### 3.1 E5 · Coach para pedidos de código

* O que o critério pede: para tarefas de código, o Coach verifica também comportamento esperado, restrições e um teste de aceitação, na mesma interface e com a mesma regra de aplicar com um clique que o Coach da web, e emite o evento C2 `coach_used`.
* Porque não: isto muda **o prompt do Coach no backend** (é do WS4), pode precisar de **um campo novo** na API, tem de ser **publicado** e **avaliado** antes de se poder afirmar que melhora alguma coisa, e **sobrepõe-se à tarefa L1 do WS4**. Se eu mudasse o prompt na extensão ou o duplicasse, haveria dois Coaches diferentes.
* O que preciso: uma decisão do Ricardo/WS4 sobre quem muda o prompt e se o campo `task_kind` (ou equivalente) existe. Do meu lado a ligação na extensão é pequena (S) quando isso estiver pronto.
* Também depende do E0 para o evento `coach_used`.

### 3.2 E0 · Eventos de uso e aprendizagem do IDE

* O que o critério pede: cada ação do IDE emite os registos C1 e C2 com `surface=ide`, verificáveis nas vistas de teste do WS3 e do WS4.
* Porque não: os contratos **C1 e C2 ainda não estão aprovados** (o plano pedia-os até ao dia 2 da semana 12). Sem o formato fechado, qualquer coisa que eu emita seria um palpite que o WS3 e o WS4 teriam de desfazer. Também não existem ainda as vistas onde se verificaria.
* O que preciso: C1 e C2 aprovados e o endpoint de receção.
* Consequência: a regra do plano de que "cada ação do IDE emite os registos" não se cumpre hoje; é o item mais exposto na revisão G1/G2.

### 3.3 O que não é bloqueio mas ficou por fazer

E3 e E6 são Plus e a prioridade era fechar os Essenciais e testar. A base já existe (E1, E2, E4); cada um é M.

## 4. O que ainda falha ou não está provado

### 4.1 Qualidade do modelo na mudança de código (E1)

Três corridas das 10 amostras de `test/edit-samples.cjs` com o modelo do LM Studio:

| Corrida | Bem formadas | Fazem a mudança |
| --- | --- | --- |
| 1 | 10/10 | 9/10 |
| 2 | 10/10 | 9/10 |
| 3 | 9/10 | 8/10 |

* Total: 29/30 bem formadas (97%), 26/30 fazem a mudança (87%).
* A amostra **`early-return` falhou nas 3 corridas** (a resposta é bem formada mas a verificação diz que não faz a mudança): não examinei a resposta; pode ser o modelo ou a verificação ser demasiado estrita. Fica por investigar.
* Na corrida 3 a amostra `list-comprehension` falhou com erro do pedido (57 s): não sei se foi o LM Studio ou o backend.
* O critério do plano fala de modelos grátis pequenos: **só medi um modelo**, o que estava carregado. Para fechar E1 falta correr `test/measure-edits.cjs` com os outros modelos (`ADAPTAI_MODELS=…`).

### 4.2 Análise com modelo real

* O backend local só tem LM Studio; os assessores do projeto são `groq`, `openai` e `claude`. Por isso a **análise correu com o modelo do chat** (como a extensão faz sem assessor), e a recomendação foi "Illustrative balanced model" (o modelo não está avaliado). O fluxo funciona; a **qualidade da análise com o assessor real não foi testada**.
* Falta a chave `GROQ_API_KEY` neste PC para o provar.

### 4.3 Lacuna em E2 (ficheiros `.env`)

* O critério diz que seleções de ficheiros `.env` ou com padrões de chave pedem aviso e confirmação. Os **padrões de chave** pedem confirmação no chat (está em `chat.ts`; não escrevi teste novo hoje). Os **ficheiros `.env`** só são bloqueados no Analyse (`isSecretFile`); no caminho "selecionar código e enviar no chat" e em "Sugerir uma mudança" **não vi essa verificação** no código (`chat.ts`, `codeassist.ts`, `selection.ts`). Um `.env` com valores sem aspeto de chave seguiria sem aviso.
* Não corrigi: é uma regra de privacidade e prefiro que decidas se bloqueia, avisa ou confirma. A correção é pequena.

### 4.4 O que ninguém clicou

* O **Codex run 4** (as verificações N, B, U e R com uma pessoa/agente a clicar na página) **não foi concluído**. O Codex parou a meio na corrida anterior; o guia está atualizado (`docs/vscode-extension-codex-run.md`).
* O teste longo exerce os comandos e a API, **não o rato**. Nunca foi clicado com o rato: os ícones ✓/✗ (Accept/Reject) na barra do diff; a página (botões Selection, Suggest a change, Improve prompt, lista de chats, tamanhos 300 e 600 px, tema claro e escuro).
* Em Chromium (testes de página) estas partes passam; **numa janela real, por uma pessoa, não foi verificado**.

### 4.5 Documentação e processo

* Drive: EXT-09 a EXT-12 **não** refletem SEL-08, APP-07, PRJ, o diff novo nem a medição.
* Registo de alterações de IA (regra do plano): falta entrada para o pedido de mudança e para o contexto do projeto (`task_context`) antes do congelamento.
* Revisão G3 por um par do PR #85: não existe. G2 no preview publicado: não feito.
* O PR #85 ainda não foi verificado no CI nesta sessão; a ligação do PR à sessão foi recusada.

## 5. O que fica na máquina e nos ramos

* Ramo `feature/ide-ws2` (local, **8 commits à frente do PR #85, nada enviado**): E2 preview, Ask again, E4, medição, o diff novo (E1), o teste longo e a correção das linhas deslocadas.
* O VSIX `adaptai-0.3.0.vsix` foi gerado com o diff novo, **antes** da correção das linhas deslocadas: se for instalado para o Codex run 4, convém regenerá-lo (`pnpm run package`).
* Docker Desktop ficou ligado; o contentor do Postgres e o backend foram parados; os perfis, tokens e ficheiros temporários foram apagados. Os utilizadores de teste ficam em esquemas descartáveis da base local, que está parada.

## 6. Riscos e próximos passos, por ordem

1. Decidir como entrega o `feature/ide-ws2` (PR novo para a develop, ou juntar ao #85).
2. Regenerar o VSIX e **completar o Codex run 4** (é a única verificação com rato).
3. Medir `test/measure-edits.cjs` com os outros modelos e olhar para a amostra `early-return`.
4. Decidir a regra dos ficheiros `.env` (4.3).
5. Pedir ao Ricardo/WS4 a decisão do E5 e a aprovação de C1/C2 para o E0.
6. Atualizar o Drive (EXT-09 a EXT-12) e o registo de alterações de IA.

## 7. Método, fontes e hora da verificação

* Hora: 20 nov 2026, entre as 21h30 e as 23h30, neste PC.
* Código verificado: `feature/ide-ws2` em daf4800.
* Janela real: VS Code com `--extensionDevelopmentPath`, perfil novo por corrida. Não usei Copilot.
* Backend: `app.main` com PostgreSQL local (Docker), `ADAPTAI_LMSTUDIO_MODEL` com o modelo carregado. Utilizadores e tokens de teste, descartados.
* A captura da janela mostrou os ícones ✓ e ✗ do Accept e do Reject na barra do separador do diff; foi a única captura que guardei e apaguei-a.
* Não verifiquei: carga, SMTP, a extensão clicada por uma pessoa, a avaliação com Groq, modelos que não o do LM Studio.
* O número "38" é o total de linhas da última corrida do teste longo (inclui verificações de arranque e do diff básico, mais as de L e C).
