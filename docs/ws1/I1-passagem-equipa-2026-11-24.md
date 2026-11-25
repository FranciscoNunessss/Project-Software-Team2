# I1 — Passagem de trabalho à equipa

Atualizado em 25 de novembro de 2026. Responsável: Francisco Nunes.
Cartão: [I1 · Latency and capacity diagnosis](https://app.clickup.com/t/1an3cktb6h8).
Estado: em progresso. A entrega isolada passou os testes automáticos. A branch está publicada; o PR está preenchido, mas a criação aguarda confirmação explícita para abrir o rascunho antes do G2 manual.

## O que foi feito

- Criado um runner de medições com limites de concorrência, tentativas, tempo e
  quota; calcula p50/p95 e conta erros, cancelamentos, timeouts e rate limits.
- Criada captura automatizada de navegação, análise visível e primeiro texto do
  chat, com 1, 5 e 20 utilizadores isolados e modelos simulados.
- Adicionados testes de estatística, validação, privacidade e limites. Os ficheiros
  de medição aceitam apenas metadados; não incluem passwords, tokens ou prompts.
- Corrigido o fecho da ligação à cópia SQLite durante importações, incluindo testes
  de sucesso e erro. Não foi alterado o esquema nem a informação importada.
- Atualizados o protocolo, o relatório de baseline, a documentação de alojamento
  e as instruções de diagnóstico da extensão.
- Criadas 20 contas sintéticas Supabase; 10 tiveram login/Profile/logout verificados
  na aplicação. As restantes 10 não tiveram essa verificação funcional. Não há
  credenciais neste documento nem nos relatórios publicados.
- Informado o Architecture Owner no cartão. A notificação não equivale a aprovação.
- Isolada a entrega I1 na branch local `agent/i1-delivery`, a partir de
  `develop` `39f4f73`, para evitar incluir 13 commits WS2 ainda não integrados.
  Commit local da implementação: `0100ae8069418233d14908cb8863a2ccb8429c1f`.
  O trabalho original e os rascunhos C1/I2 foram preservados.

## Resultados na branch isolada

| Verificação | Resultado |
|---|---|
| Backend completo | 771 passaram; 0 falhas, erros ou testes ignorados |
| Cobertura | 96% global; 99% nos módulos principais, acima do mínimo de 80% |
| Remoção de chat e Prompt Coach | 613 passaram; originais preservados, teste numa cópia isolada |
| Ruff | Lint e formatação passaram; 103 ficheiros formatados |
| Frontend | Instalação com lockfile e build passaram; mantém aviso existente de bundle grande |
| Extensão: unitários | 191 passaram; 11 integrações ficaram ignoradas nesse comando |
| Extensão: renderização | Passou o script de página existente |
| Contentores | Imagens construídas; backend, frontend e PostgreSQL saudáveis |
| Playwright completo | 53 passaram; 390 amostras simuladas bem-sucedidas |
| Integração da extensão | 11 passaram separadamente, sem testes ignorados |
| Recriação/persistência em contentores | Passou; login e dados sintéticos retidos |

O preview local ficou disponível em [localhost:8080](http://127.0.0.1:8080), no
computador de Francisco, com dados sintéticos e modelos de demonstração. O endereço
não é um preview público e só funciona enquanto os contentores estiverem ligados.
Não foram ativados serviços pagos nem alterado o deploy de produção.

## Medições que já existem e o que permitem concluir

| Medição | Resultado | Limite da conclusão |
|---|---|---|
| HTTP `/api/health` em produção, 1/5/20 pedidos concorrentes | 130/130 HTTP 200; p95 a 20 pedidos = 200,51 ms | Verifica um burst curto de saúde; não prova capacidade de análise/chat, base de dados ou carga sustentada |
| Site publicado, 5 rondas sequenciais | p50/p95: navegação 785,98/1034,65 ms; análise 5599,98/6011,76 ms; primeiro texto do chat 2318,37/2603,52 ms | 15 amostras, 10 ações de modelos autorizadas; inclui overhead da automatização; não é um SLA |
| Navegador com modelos simulados | 390 amostras bem-sucedidas a 1/5/20 utilizadores | Evidência histórica da branch `8313bfe`; repetida com sucesso na entrega isolada em 25/11; não mede capacidade dos fornecedores reais |
| Extensão instalada 0.3.0 | 33 leituras API e 5 reloads do host bem-sucedidos; p50/p95 do reload 1705,5/1789,7 ms | Mede o host; não mede o primeiro carregamento visível da webview |
| Tentativa após 30 minutos sem uso | 6 respostas HTTP 200; primeiro pedido 387,51 ms | INCONCLUSIVA para cold start: logs revelaram tráfego e reinício durante a janela; o pedido foi classificado como warm |

Os testes anteriores da branch `8313bfe` também passaram (691 backend, 534 remoção,
51 Playwright, 257 unitários da extensão e 11 integrações separadas, além dos
contentores). São históricos e não substituem os testes pendentes da nova branch.

Foram registadas três prioridades de investigação: execução/entrega da análise,
leituras de metadados no caminho crítico da extensão e efeito da inatividade no
Render Free. Não são três causas-raiz demonstradas. As opções de alojamento e
custos estão no baseline; a recomendação mantém planos gratuitos, pendente do PO.

## O que ficou por fazer

1. Abrir o PR como rascunho após confirmação explícita da exceção à ordem G2, pelo
   responsável; a branch já está publicada. CI remoto iniciado. G2 permanece pendente.
2. G2 pelo developer: testar a conta sintética, Profile, análise demo, chat e retenção
   após reload no preview local. Registar pass/fail e os problemas encontrados.
3. Decisão do PO (Ricardo): aceitar explicitamente o âmbito reduzido de saúde HTTP
   e as opções/custos ou manter o âmbito original e aprovar o setup necessário.
4. Se for mantido o âmbito original, faltam jornadas reais com 5/20 utilizadores,
   carregamento inicial visível da IDE e ensaio de inatividade com isolamento
   verificável. Não existe preview Render isolado. Health/fakes não substituem estas medições.
5. Publicar revisão LLM no PR. G3 exige aprovação escrita e merge por um colega
   diferente do autor. Só fechar a I1 quando os critérios e decisões estiverem cumpridos.

Os testes automáticos pendentes foram concluídos em 25/11. O limite do serviço de
aprovação que bloqueou a sessão anterior deixou de impedir a execução; não foi
contornado. Foram reutilizados os resultados backend/remoção válidos de 24/11,
sem alterar o código, e concluídos os testes em falta. Nenhuma nova chamada a
modelos de produção foi feita. Este Markdown é entregue localmente.

## Evidência no repositório

- [Baseline](I1-baseline-report.md).
- [Plano aprovado](I1-implementation-plan.md).
- [Relatório funcional](I1-initial-test-report.md).
- [Resultados da entrega isolada](I1-delivery-validation-2026-11-25.json).
- [Captura simulada nova](I1-delivery-browser-fake-capture-2026-11-25.jsonl).

As regras de G2/G3 constam de [AGENTS.md](../../AGENTS.md). Não foi inventado
um resultado manual, uma aprovação do PO ou a aprovação independente de um colega.
