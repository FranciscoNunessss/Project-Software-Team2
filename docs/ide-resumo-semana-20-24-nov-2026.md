# WS2 (IDE): o que foi feito de 20 a 24 de novembro de 2026

Resumo, por assunto, de tudo o que entrou no PR #85 (`feature/ide-newfeatures`) desde a primeira versão. Tudo está em `vscode-extension/` e em `docs/`; o backend não foi alterado. Os requisitos e os testes de cada ponto estão em `docs/vscode-extension.md`.

Método seguido em cada funcionalidade: requisito escrito primeiro, depois o teste visto a falhar, depois o código, um commit por funcionalidade.

## 1. Assistente de código no chat (20 nov)

* **Seleção no chat** (`04354dc`): o botão Selection envia o código selecionado no editor com a mensagem. Se estiver ligado e não houver seleção, nada é enviado e a caixa explica porquê.
* **Suggest a change** (`04354dc`): o utilizador descreve uma alteração e o modelo propõe novas linhas para o código selecionado.
* **Botões do chat, mensagem sem ligação, títulos limpos** (`508be2c`, `dc64887`, `71e5aa5`): correções que saíram da primeira execução em janela real.
* **Estabilidade** (`038517e`, `bb9e5e7`, `e0c7902`): o ecrã já não desce sozinho enquanto se lê; "My progress" diz quando o backend falha; a lista de modelos, o Coach e a lista de chats voltaram a abrir; a configuração do modelo deixou de ter "Use for chat".
* **Tabs e cache do chat** (`79813d6`, Francisco, integrado em `9b7c13e`): o conteúdo dos separadores mantém-se quando o chat atualiza.

## 2. Rever uma alteração no diff do VS Code (E1)

* **Decisão** (`38a7e57`): a proposta deixou de ser escrita no ficheiro com marcas vermelhas e verdes. Abre-se no editor de diff do VS Code (ficheiro à esquerda, proposta à direita) e o ficheiro só muda no Accept.
* **Accept** é um único `WorkspaceEdit`: um Ctrl+Z desfaz. Os fins de linha (CRLF) mantêm-se. **Reject** fecha o diff e não muda nada.
* **Accept encontra o sítio** (`daf4800`, APP-03): se foram acrescentadas ou removidas linhas acima da seleção, o Accept aplica no código certo, desde que esse código apareça uma só vez. Defeito real, apanhado pelo auto-teste longo (C09).
* **Ask again** (`18a11ae`, APP-07): se o código mudou depois da proposta, nada é aplicado e um botão volta a fazer a pergunta com a instrução já preenchida.
* **Medição** (`cd3d640`): 10 pedidos de alteração de exemplo e um programa que mede um modelo. Em 5 corridas com o modelo local: 48 de 50 respostas bem formadas, 45 de 50 com a alteração pedida. Só um modelo foi medido.

## 3. Privacidade do que sai da máquina (E2)

* **Pré-visualização** (`906000c`, SEL-08): uma linha por cima da caixa diz o que vai ser enviado, e "Show" abre o texto exato antes de carregar em Send.
* **Ficheiros com segredos** (`a785160`, SEL-09): código em `.env`, chaves, `.npmrc` e semelhantes nunca é oferecido nem enviado. O botão Selection não mostra nada e o Send explica porquê.

## 4. Contexto do projeto na análise (E4)

* `6fd5863` (PRJ-01 a PRJ-03): a linguagem, a framework e o executor de testes do projeto são lidos dos ficheiros de manifesto (`package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `pom.xml`...) e vão numa só linha curta no contexto da análise. Só saem nomes de uma lista fixa, nunca conteúdo nem nomes de pacotes. Desliga-se com `adaptai.projectContext`.

## 5. Prompt Coach (IMP-01 e IMP-02)

* **Apply e Dismiss** (`5d5ae21`): botões no diff do "Improve the prompt".
* **Uma só coisa** (`400f745`, IMP-02): o Coach e o Improve passaram a ser o mesmo. Ctrl+K Ctrl+E pergunta Rewrite, Edits ou Tips (o último usado vem primeiro), reaproveita a análise do mesmo texto e Tips não mexe no ficheiro. O botão Improve prompt separado foi removido.

## 6. Como descreveste o pedido (E5)

* `967040a` (RQ-01 a RQ-04): quando o backend envia `request_quality` (WS4, rubrica 2.2), a análise mostra "How you described it": uma linha por parte (objetivo, contexto, restrições, riscos, pontos em aberto, critérios de sucesso, público e formato) como Missing, Partial ou Clear, com o motivo, mais a dica do Educator. Aparece no documento da análise e no painel do chat. Se o backend não enviar, nada aparece. A rubrica 2.2 ainda não está ativa, por isso hoje não se vê.

## 7. Proposta para o E0 (só proposta)

* `304718f`, `docs/ide-e0-proposal.md`: não existe contrato C1/C2 nem endpoint de eventos nos PRs do WS4 (#91 a #95). A proposta mínima é uma coluna `surface` em `analyses` (derivada da autenticação, não de um campo do cliente), uma tabela `coach_uses` sem texto e um `PUT` para o "accepted". Nada foi implementado. Faltam decisões do Ricardo (WS4), do Architecture Owner e do Fishcake99 (WS3).

## 8. Testes

* Testes unitários com um stand-in do VS Code; hoje são **288 a passar, 0 a falhar** (11 saltados), mais os três testes de página em Chromium.
* **Auto-teste em janela real** (`src/selftest.ts`, só para desenvolvimento, ativado por `ADAPTAI_SELFTEST*`): corre dentro de um VS Code com perfil limpo, com backend local e LM Studio. A última corrida longa deu 38 de 39; a falha foi um 502 do backend na análise (o modelo não seguiu o formato). Inclui chat, análise, Coach, 11 pedidos de alteração, renomear e apagar um chat (`ce9ef6c`, `4b4f653`, `7b9d770`).
* **Execuções do Codex** (`5b03290` a `101333d`): três execuções em janela real. A quarta foi cancelada e substituída pelo teste manual do José e pelo auto-teste longo.

## 9. Revisão do PR e correções de 24 nov

Os quatro pontos da revisão foram confirmados no código e corrigidos, cada um com o teste escrito primeiro:

1. **Diff antigo com o lado direito vazio** (`bb24c4c`): uma segunda proposta no mesmo ficheiro deixava o separador da primeira aberto contra texto vazio. Agora fecha-se o separador da proposta que sai; Accept e Reject fecham o separador da própria proposta e já não dependem de ser o editor ativo.
2. **Escrita falhada** (`bb24c4c`): o Accept já não descarta a proposta antes do `applyEdit`. Se a escrita falhar, o diff continua aberto e pode-se tentar outra vez.
3. **Falsos positivos na deteção do projeto** (`0e11820`): `flask-cors`, `django-filter` ou `spring-*` já não marcam Flask, Django ou Spring. O `pyproject.toml` lê os nomes exatos (listas PEP 621 e tabelas Poetry).
4. **Auto-teste no `.vsix`** (`f468283`): `dist/selftest.js` deixou de ir no pacote e é carregado com `import()` só quando o auto-teste corre; um teste (`packaging.test.js`) garante as duas coisas.

## 10. Documentação

* Documentos do Drive EXT-09 a EXT-12 (requisitos, arquitetura, testes, manual) atualizados a 24 de novembro com tudo o que está acima.
* Comentário "Para o PO e para quem revê" no PR #85, com as decisões e o que ficou de fora.

## O que ainda não está feito

* **E0**: só a proposta; espera decisões de WS4, do AO e de WS3.
* **E3 e E6 (Plus)**: não começados.
* **Revisões G2 e G3**: pendentes.
* **Entrada no registo de alterações de IA** e o relatório `docs/ide-estado-real-20-nov-2026.md`, que ainda tem frases desatualizadas.
