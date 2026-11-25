# AdaptAI · Estado real da extensão para IDE (VS Code)

Nov 20, 2026 · @José Moura, com o Claude (agente de IA)

Mesma estrutura do relatório "Estado real do produto" de 17 nov, só para o WS2 (extensão VS Code). Cada número diz de onde vem. Onde não verifiquei, está escrito.

## Resumo executivo

1. Das 8 tarefas do WS2 no Release Plan (semanas 12 a 15), **4 estão feitas e testadas** (E1, E2, E4, E8), **2 não foram feitas por dependerem de outras pessoas** (E5 e E0) e **2 são Plus e ainda não começadas** (E3, E6).
2. Corri tudo o que consigo automatizar, neste PC: 283 testes unitários, 3 testes de página em Chromium, a integração contra o backend, a medição do modelo e um **teste longo numa janela real de VS Code** com o backend a sério (Postgres) e o modelo local do LM Studio. **Resultado: 0 falhas nos unitários, nas páginas e na integração; no teste longo 38 de 39 verificações passam.** A que falha (L11, Dismiss do Improve prompt) falhou porque o backend devolveu 502 na análise desse pedido (o modelo local não deu uma resposta estruturada válida); a extensão tratou-o como erro, não como resposta. Passou nas 3 corridas anteriores.
3. O teste encontrou **um defeito real** no diff novo, já corrigido e com teste: se se acrescentava uma linha acima do código selecionado com o diff aberto, o Accept recusava. Agora encontra o código onde ele está agora (commit daf4800).
4. A qualidade do modelo na tarefa E1 (mudança pedida em código): **1 modelo medido** (o do LM Studio, `gemma4-12b`), 5 corridas de 10 amostras: 48 de 50 bem formadas (96%) e 45 de 50 fazem a mudança (90%). **Os modelos grátis pequenos do critério E1 não foram medidos**: só havia este carregado.
5. **O que continua por provar:** nada foi clicado com o rato por uma pessoa (os botões Accept/Reject foram acionados por comando; os ícones ✓ e ✗ vi-os numa captura da janela); a análise com o assessor real (precisa de chave Groq, OpenAI ou Claude); o Codex run 4 (a passagem a clicar na página) ainda não foi feito.
6. Nada do que está em `feature/ide-ws2` foi enviado: são 10 commits à frente do PR #85, só locais. O commit do Francisco (79813d6, "preserve tab content during chat updates") já está fundido neles: um conflito pequeno, 283 testes e os 3 testes de página passam (ponto 4.6).

## 1. Estado das tarefas do Release Plan (WS2)

| Tarefa | Prioridade | Estado | O que existe | O que falta |
| --- | --- | --- | --- | --- |
| E1 · Mudanças de código: diff e aplicar | Essencial | **Feito, medido num só modelo** | A proposta abre no diff do VS Code; **Accept** escreve numa só edição (um Ctrl+Z); se o código mudou, não aplica e oferece "Ask again"; se só se acrescentaram ou tiraram linhas acima, aplica nas linhas certas; uma resposta sem exatamente um bloco de código é rejeitada inteira | Medir mais modelos (critério: 10 amostras); clique humano nos botões; o nome no plano é "Apply", na extensão é "Accept" |
| E2 · Seleção como contexto | Essencial | **Feito** | Envia ficheiro, linguagem e linhas; antes de enviar mostra o texto exato; avisa quando corta (limite 8000); padrões de chave pedem confirmação; código de `.env`, chaves e similares nunca é oferecido nem enviado (SEL-09) | A pré-visualização na página só foi testada em Chromium, não por uma pessoa |
| E8 · Rapidez do painel | Essencial | **Feito antes desta fase; o Francisco melhorou-o** (79813d6) | Separadores com estado guardado, token em SecretStorage; testes de página passam | Não medi o p95 do I1 (não sei qual é o alvo na minha cópia do plano) |
| E4 · Contexto do projeto | Essencial | **Feito** | Deteta linguagem, framework e executor de testes a partir de `package.json`, `tsconfig`, etc.; vai na análise como "Project: TypeScript, React, Vitest"; setting para desligar; nenhum conteúdo de ficheiro sai | Não vai como enum: vai como texto no `task_context` (≤ 4000 caracteres). O plano diz "enums"; falta decidir com o WS4 |
| E5 · Coach para pedidos de código | Essencial | **Não feito, depende de outros** | Nada | Ver 3.1 |
| E0 · Eventos de uso e aprendizagem | Essencial | **Não feito, bloqueado** | Nada | Ver 3.2 |
| E3 · "Fix with AdaptAI" nos Problemas | Plus | Não começado | A base (E1 e E2) já existe | Tempo; é M e é Plus |
| E6 · Gerar testes da seleção | Plus | Não começado | A base (E1 e E4) já existe | Tempo; é M e é Plus, semana 14 |

## 2. Tudo o que corri hoje

Ambiente: VS Code 1.147.0 neste PC (perfil descartável, sem Copilot), a extensão da pasta `vscode-extension` compilada hoje, backend local com PostgreSQL (Docker), modelo `gemma4-12b-qat-uncensored-hauhaucs-balanced` no LM Studio.

| Teste | Resultado |
| --- | --- |
| Testes unitários da extensão (`node --test test/*.test.js`) | 283 testes: 272 passam, 0 falham, 11 saltam (os que precisam de backend) |
| Testes de página em Chromium (`page`, `page-layout` e o `navigation` do Francisco) | Passam, sem erros na página |
| Integração contra um backend em modo demonstração (11 testes) | **11 de 11** |
| Integração contra o backend com o LM Studio configurado | 8 de 11: as 3 que falham pedem uma análise e este backend não tem assessor (Groq, OpenAI ou Claude). É do ambiente, não da extensão |
| Medição das 10 amostras de mudança de código | 5 corridas, ver 4.1 |
| **Teste longo na janela real de VS Code** (`src/selftest.ts`) | **38 de 39** (ver abaixo) |

### 2.1 O teste longo, por grupo

O que faz: abre uma janela real de VS Code com a extensão, entra com um token no backend real e usa os comandos e a API como uma pessoa faria. **Não clica na página do AdaptAI nem com o rato.**

| Grupo | Verificações | Resultado |
| --- | --- | --- |
| Arranque | Barra de estado; os 32 comandos e atalhos registados; entrar com token; o estado funciona só com o token | PASS (4 de 4) |
| Diff, modo mínimo | O diff abre e o ficheiro fica intacto e limpo; Accept escreve e mantém CRLF; um Undo repõe; Reject não altera | PASS (5 de 5) |
| Fluxo completo com o modelo | Modelo local escolhido; pedido de mudança → diff → Accept → um Undo | PASS (5 de 5) |
| Chat | Responder (R2); Stop mantém o escrito (R3); Retry dá nova resposta (R4); código selecionado vai na mensagem e a resposta é sobre ele (N2); títulos dos chats sem a seleção (regressão B4); renomear e apagar um chat (R7) | PASS (6 de 6) |
| Análise e contexto do projeto | Analyse com o modelo (R5); sem manifesto não há contexto; com manifesto vai "Project: TypeScript, React, Vitest" (N14); `adaptai.projectContext=false` desliga | PASS (4 de 4) |
| Improve prompt | Diff, Apply e um Ctrl+Z repõe (R12) | PASS |
|  | **Dismiss deixa o texto (R12)** | **FAIL (L11)**: o backend deu 502 na análise (ver 2.2) |
| Mudança sugerida | 5 pedidos diferentes, cada um com Accept e **um** Undo (C01 a C05); Reject (C06); Ctrl+S com o diff aberto guarda só o original e o Accept continua (C07, N9); letra dentro das linhas: Accept não faz nada e avisa (C08, N10); linha acrescentada em cima: substitui as linhas certas (C09, N11); sem seleção não faz pedido (C10, N12); código de um `.env` nunca é enviado (C11) | PASS (11 de 11) |
| Endereço do backend | `http://example.com` é recusado com a razão (R14); backend desligado dá erro claro e volta a funcionar (R13) | PASS (2 de 2) |

### 2.2 Falhas durante a sessão e o que eram

| Falha | Causa | Estado |
| --- | --- | --- |
| C09: com uma linha acrescentada acima, o Accept não aplicava | **Defeito real** da extensão: o Accept procurava o código nas linhas originais | Corrigido e com 3 testes novos; commit daf4800 |
| L05 e C08 numa corrida anterior | Defeito do meu teste (esperava 2 chats; o buffer do ficheiro não era reposto) | Corrigido no teste |
| L08 (contexto de projeto) falhou **uma vez** e passou em todas as outras | **Não encontrei a causa.** Passou em 4 corridas seguidas | Aberto: possível teste instável |
| Na primeira corrida completa de hoje, todos os pedidos ao modelo falharam a partir do L11 e o teste não chegou ao fim | O modelo local passou a demorar mais de 30 s por pedido (o limite do backend): o GPU estava ocupado por outra coisa neste PC (uma verificação direta mostrou 59% de uso e 12 GB ocupados com o meu teste parado). Repetida com o GPU livre, passou | Não é da extensão. Repetida |
| L11 na corrida final | O log do backend mostra `POST /api/analyze` com **502** nesse pedido (o modelo local não devolveu uma análise estruturada válida). Não vi o Coach a ser chamado depois. A extensão mostrou o erro, como deve | Falha de modelo, não de código. Ver 4.1 |

### 2.3 Mapa de todas as funcionalidades da extensão e como foram verificadas hoje

Legenda: **Real** = janela real de VS Code, backend e modelo reais; **Int** = integração contra o backend; **Pág** = Chromium; **Unit** = testes unitários com o VS Code simulado; **Não** = não verificado hoje.

| Funcionalidade | Real | Int | Pág | Unit | Observação |
| --- | --- | --- | --- | --- | --- |
| Analyse: texto escrito, seleção, ficheiro, área de transferência | texto e seleção (L06 a L09) | sim | — | sim | O resultado em Markdown, as ações (Use this model, Task solved?, Copy summary) e o CodeLens só em Unit |
| Prompt Coach na seleção (Ctrl+K Ctrl+E: pergunta Rewrite, Edits ou Tips; diff, Apply, Dismiss, Ctrl+Z) | Apply sim; Dismiss falhou por modelo | sim (Coach) | — | sim | Coach da área de transferência só Unit |
| Chat: enviar, Stop, Retry, continuar | sim (L01 a L04) | sim | sim | sim | Nunca clicado na página |
| Código selecionado no chat, pré-visualização, aviso de corte, `.env` | mensagem e `.env` sim | — | sim | sim | O botão Selection e a linha "Will be sent" só em Pág |
| Sugerir uma mudança: diff, Accept, Reject, Undo, Ctrl+S, linhas mudadas, "Ask again" | sim (C01 a C11) | — | — | sim | Clique nos ícones ✓/✗ não |
| Contexto do projeto (E4) | sim (L07 a L09) | — | — | sim | |
| Lista de chats: abrir, renomear, apagar | renomear e apagar sim | sim | sim | sim | |
| Participante `@adaptai` na vista de chat do VS Code | **Não** | — | — | sim | O perfil de teste não tem a vista de chat do VS Code (sem Copilot) |
| Histórico de análises, My progress, gráficos, Educator | **Não** | sim (relatório) | sim | sim | |
| Profile e definições (interruptores, consentimentos, apagar dados) | **Não** | sim | sim | sim | |
| Exportar os meus dados | **Não** | — | — | sim | Abre um diálogo de guardar |
| Models and evaluations (CRUD, testar ligação, avaliação paga com consentimento, catálogo OpenRouter) | **Não** | sim (CRUD, teste, lista) | — | sim | Avaliação paga e OpenRouter só com simulação |
| Entrar com email e palavra-passe; entrar com token; terminar sessão; tokens | token sim | sim | sim | sim | Supabase Auth não foi testado |
| Atalhos de teclado | comandos e atalhos registados | — | — | sim | "Change" abre o editor de atalhos: só Unit |
| Relay para o LM Studio através de um backend publicado (ADR-015) | **Não** | — | — | sim | É "Won't" nesta versão |
| Endereço do backend: http remoto recusado; backend desligado | sim (L12, L13) | — | sim | sim | |
| Diagnóstico de latência | **Não** | — | — | sim | |

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

### 4.1 Qualidade do modelo (E1 e Coach)

Cinco corridas das 10 amostras de `test/edit-samples.cjs` com o modelo do LM Studio:

| Corrida | Bem formadas | Fazem a mudança | Notas |
| --- | --- | --- | --- |
| 1 | 10/10 | 9/10 | `early-return` bem formada mas não faz a mudança |
| 2 | 10/10 | 9/10 | idem |
| 3 | 9/10 | 8/10 | `list-comprehension` falhou com erro do pedido (57 s); `early-return` como antes |
| 4 (no meio da corrida completa, GPU ocupado) | 9/10 | 9/10 | `early-return` falhou por tempo esgotado |
| 5 (GPU livre) | 10/10 | 10/10 | `early-return` fez a mudança |

* Total: 48/50 bem formadas (96%) e 45/50 fazem a mudança (90%). As falhas de "erro do pedido" coincidem com carga no GPU; a `early-return` falhou a verificação em 2 das 5 corridas e passou na última, por isso é variação do modelo, não uma verificação que nunca possa passar.
* Também há variação na análise: o 502 do L11 (2.2) é do mesmo tipo (o modelo local nem sempre devolve uma resposta estruturada válida).
* O critério do plano fala de modelos grátis pequenos: **só medi um modelo**, o que estava carregado. Para fechar E1 falta correr `test/measure-edits.cjs` com os outros modelos (`ADAPTAI_MODELS=…`).

### 4.2 Análise com modelo real

* O backend local só tem LM Studio; os assessores do projeto são `groq`, `openai` e `claude`. Por isso a **análise correu com o modelo do chat** (como a extensão faz sem assessor), e a recomendação foi "Illustrative advanced model" ou "balanced" (o modelo não está avaliado). O fluxo funciona; a **qualidade da análise com o assessor real não foi testada**.
* Falta a chave `GROQ_API_KEY` neste PC para o provar.

### 4.3 Ficheiros `.env` (E2) · corrigido

* O critério pede aviso e confirmação para seleções de ficheiros `.env` ou com padrões de chave. Os padrões de chave já pediam confirmação no chat (está em `chat.ts`). Os ficheiros `.env` só eram bloqueados no Analyse.
* Corrigi com a mesma regra do Analyse (para ser consistente): código de `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `.npmrc` e semelhantes **nunca é oferecido, pré-visualizado nem enviado**; o botão Selection não mostra nada, o Send diz porquê e o Suggest a change diz porquê e não faz pedido. Requisito SEL-09, 3 testes unitários novos e a verificação C11 na janela real (passa).
* Decisão tua se preferires "avisar e deixar confirmar" em vez de bloquear: é uma mudança pequena em `selection.ts`.

### 4.4 O que ninguém clicou

* O **Codex run 4** (as verificações N, B, U e R com uma pessoa/agente a clicar na página) **não foi concluído**. O Codex parou a meio na corrida anterior; o guia está atualizado (`docs/vscode-extension-codex-run.md`).
* O teste longo exerce os comandos e a API, **não o rato**. Nunca foi clicado com o rato: os ícones ✓/✗ (Accept/Reject) na barra do diff; a página (botões Selection, Suggest a change, Improve prompt, lista de chats, tamanhos 300 e 600 px, tema claro e escuro).
* Em Chromium (testes de página) estas partes passam; **numa janela real, por uma pessoa, não foi verificado**.

### 4.5 Documentação e processo

* Drive: EXT-09 a EXT-12 **não** refletem SEL-08, SEL-09, APP-07, PRJ, o diff novo nem a medição.
* Registo de alterações de IA (regra do plano): falta entrada para o pedido de mudança e para o contexto do projeto (`task_context`) antes do congelamento.
* Revisão G3 por um par do PR #85: não existe. G2 no preview publicado: não feito.
* O PR #85 ainda não foi verificado no CI nesta sessão; a ligação do PR à sessão foi recusada.

### 4.5b O Improve prompt passou a ser o Prompt Coach (depois do relatório inicial)

* Por sugestão tua: o botão "Improve prompt" da caixa do chat foi **removido** (era um duplicado do ✦, que abre a mesma bolha do Coach com os modos Rewrite, Edits e Tips). O Ctrl+K Ctrl+E passou a ser "Prompt Coach: improve the selection" e **pergunta o modo ao abrir** (Rewrite, Edits ou Tips; o último usado, ou o `adaptai.coachMode`, vem primeiro; Escape não envia nada). Tips não mexe no ficheiro e mostra as dicas com a análise. Um atalho ou script pode indicar o modo e então não pergunta.
* A análise continua a ser feita **por baixo** porque o backend exige o `analysis_id` no Coach; passa a ser **reutilizada** quando o mesmo texto já foi analisado, o que poupa um pedido e uma causa de falha (o 502 do L11). O Coach pede então a sua própria confirmação se o modelo for externo.
* Tirar a análise de vez é decisão do WS4 (o Coach da web também depende dela).
* Verificação: 4 testes unitários novos (IMP-02) falharam antes e passam; 287 testes (276 passam, 11 saltam, 0 falham); testes de página passam com o novo teste `btn_02`; na janela real L10 e L11 passam.

### 4.6 O commit do Francisco no PR #85

* Commit 79813d6, "fix(vscode): preserve tab content during chat updates" (com o Codex como coautor). Mexe sobretudo em `dashboard.ts` (139 linhas) e acrescenta 2 ficheiros de teste e atualizações da documentação. O que faz: as abas My progress e Profile mantêm os números antigos enquanto recarregam, o estado e a posição do scroll de cada aba guardam-se em memória (nunca o gestor de tokens aberto), um chat novo não recarrega os modelos, o contador do compositor repõe-se e os níveis aninhados da avaliação mostram-se bem (`models.ts`).
* **É bom e foi fácil de incorporar.** Um só conflito, numa zona do tratador de mensagens da página, onde ele reescreveu `chatStart` e `delta` e eu tinha acrescentado `selection` e `selectionPreview`. Juntei as duas partes. Compilou, os 283 testes passaram e os 3 testes de página (incluindo o `navigation.browser.cjs` dele) também; na janela real o teste longo passa com o código fundido.
* Pontos de atenção, não bloqueantes: (1) é uma mudança grande no código da página e a revisão de um par (G3) continua a fazer falta; (2) `adaptai.chatNew` passa a chamar `dashboard.newChat()`, que recusa começar um chat novo enquanto há uma resposta a correr (com aviso); (3) nada disto foi clicado por uma pessoa: o Codex run 4 é a verificação certa para a navegação entre abas.

## 5. O que fica na máquina e nos ramos

* Ramo `feature/ide-ws2` (local, **10 commits à frente do PR #85, nada enviado**; o commit do Francisco está dentro): E2 preview, Ask again, E4, medição, o diff novo (E1), o teste longo, a correção das linhas deslocadas, a fusão e a regra do `.env`. O teste do renomear/apagar chats (L05b) também está commitado.
* O VSIX `adaptai-0.3.0.vsix` foi regenerado depois da fusão e da regra do `.env` (29 ficheiros); é o que convém dar ao Codex run 4.
* Docker Desktop ficou ligado; o contentor do Postgres e o backend foram parados; os perfis, tokens e ficheiros temporários foram apagados. Os utilizadores de teste ficam em esquemas descartáveis da base local, que está parada.

## 6. Riscos e próximos passos, por ordem

1. Decidir como entrega o `feature/ide-ws2` (PR novo para a develop, ou juntar ao #85).
2. **Completar o Codex run 4** com o VSIX atual (é a única verificação com rato).
3. Medir `test/measure-edits.cjs` com os outros modelos (o critério do E1).
4. Decidir se os ficheiros `.env` bloqueiam (como está) ou só avisam (4.3).
5. Pedir ao Ricardo/WS4 a decisão do E5 e a aprovação de C1/C2 para o E0.
6. Atualizar o Drive (EXT-09 a EXT-12) e o registo de alterações de IA.

## 7. Método, fontes e hora da verificação

* Hora: 20 nov 2026, entre as 21h30 e as 23h45, neste PC.
* Código verificado: `feature/ide-ws2` em a785160, mais o commit do teste L05b.
* Janela real: VS Code com `--extensionDevelopmentPath`, perfil novo por corrida. Não usei Copilot.
* Backend: `app.main` com PostgreSQL local (Docker), `ADAPTAI_LMSTUDIO_MODEL` com o modelo carregado. Utilizadores e tokens de teste, descartados.
* A captura da janela mostrou os ícones ✓ e ✗ do Accept e do Reject na barra do separador do diff; foi a única captura que guardei e apaguei-a.
* Contagens: "38 de 39" são verificações (sem a linha final "done" do ficheiro de resultados). Os números que dei durante a sessão ("38 de 38", "39 de 39") contavam essa linha final, por isso estavam 1 acima.
* Não verifiquei: carga, SMTP, a extensão clicada por uma pessoa, a avaliação com Groq, modelos que não o do LM Studio.
