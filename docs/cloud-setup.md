# Configuração cloud: Netlify + Render + Supabase

**Atualização, 11 de novembro de 2026:** o job `deploy` do CI publicou a `main` (`e207fd9`)
no Render e no Netlify a 7 de novembro de 2026, com o health check `/api/health` a passar no CI.
A `main` ainda não tem o trabalho do ADR-014 (PRs #37, #43, #47). O texto abaixo descreve o
estado antes desse deploy. `render.yaml` não declara `ADAPTAI_EVALUATION_OPENROUTER_KEY`: sem
ela, a avaliação com a key do projeto (ADR-014 A10) não corre em produção.

Estado em 7 de novembro de 2026: integração escrita na branch
`feature/infra-postgres`; 462 testes backend passaram e o frontend compila.
Ainda não foi validado um login contra um projeto Supabase real nem realizado
um deploy cloud. Os ficheiros locais ainda não foram publicados no GitHub.

A ligação ao Supabase via Session pooler foi validada a partir do container
Linux, com TLS confirmado no cliente. As migrations 1 e 2 foram aplicadas no
schema privado `adaptai`: 12 tabelas, inicialmente sem utilizadores ou sessões.
O histórico local ainda não foi importado para esta base cloud.

## Serviços reservados para o primeiro deploy

- Render: [adaptai-team2-api](https://dashboard.render.com/web/srv-dbnm3mmc6qcc73e93vc0),
  ID `srv-dbnm3mmc6qcc73e93vc0`, Free/Frankfurt/Docker, branch `main`, auto-deploy Off.
  URL reservada: `https://adaptai-team2-api.onrender.com`.
  Variáveis runtime Supabase, Groq, Auth, origem frontend e Fernet foram gravadas.
  Os builds iniciais falharam porque a main ainda não tem `backend/Dockerfile`.
  O HTTP health check `/api/health` foi confirmado pela API autenticada.
- Netlify: [adaptai-team2](https://app.netlify.com/projects/adaptai-team2),
  ID `aebecfdb-e729-4c0c-b3b0-319051d2a181`, equipa Free `kikonuesnnene`.
  URL reservada: `https://adaptai-team2.netlify.app`. Ainda sem deploy.
  O projeto foi criado vazio para publicação CLI pelo GitHub Actions; não é
  necessário ativar builds Git nem duplicar aí as variáveis do build Actions.
  A gravação de variáveis pelo conector Netlify devolveu HTTP 403; não ficou aplicada.
- GitHub: variáveis/segredos ainda não foram configurados. Os valores públicos
  e os campos dos tokens estão preparados em `.env.deploy` (ignorado pelo Git),
  juntamente com a chave Fernet de produção. Os tokens `RENDER_API_KEY` e
  `NETLIFY_AUTH_TOKEN` já foram criados e validados por consultas autenticadas
  aos dois serviços (HTTP 200); falta guardá-los como GitHub Actions Secrets.

Os serviços estão reservados, não publicados. Não criar outro Blueprint por cima
deste serviço existente: `render.yaml` mantém a definição para reprodução, enquanto
o GitHub Actions aponta para os IDs acima e não faz Blueprint sync.

## 1. Identificar os projetos existentes

Usar os projetos já criados; não criar duplicados. Confirmar o plano Free nos
três serviços. Anotar os URLs públicos Supabase, Netlify e Render e os IDs de
site/serviço. Os URLs públicos podem ser partilhados; passwords e tokens ficam
nos painéis ou em ficheiros locais ignorados pelo Git.

## 2. Supabase

1. Em Connect, copiar a ligação PostgreSQL **Session pooler**. Substituir a
   password, codificando caracteres reservados, e adicionar `sslmode=require`
   aos parâmetros. O pooler permite ligação IPv4 sem comprar o add-on IPv4.
2. Obter o Project URL (`https://<ref>.supabase.co`) e a **publishable key** em
   API Keys/Connect. Não usar secret key ou service_role no frontend.
3. Em Authentication, manter o fornecedor Email ativo e confirmação de email.
   Em URL Configuration, definir Site URL e Redirect URLs para o URL exato do
   frontend Netlify. Adicionar o URL local apenas se for testar Auth cloud localmente.
4. Para utilizadores fora da equipa Supabase, configurar SMTP próprio. O envio
   incluído só serve endereços de membros da equipa; confirmação de registo e
   recuperação de password dependem disso. Não desativar confirmação para
   contornar a configuração de email.
5. Não adicionar `adaptai` aos schemas expostos na Data API. O frontend só usa
   Supabase Auth; os dados da aplicação são acedidos pelo backend via PostgreSQL.

As migrations `backend/migrations/*.sql` são aplicadas pelo backend no arranque.
Não copiar o SQL para o painel manualmente. O histórico local não é transferido
automaticamente: combinar uma importação controlada antes de criar dados cloud.
A associação de contas preserva o histórico já presente na base de dados destino
e exige a sessão Supabase e a password AdaptAI anterior.

## 3. Render

Configurar o serviço existente como Web Service / Docker, plano Free, região
Frankfurt se ainda estiver por criar. Repo: Project-Software-Team2. Branch final:
`main`. Dockerfile: `backend/Dockerfile`; build context: raiz do repositório;
health check: `/api/health`. Não definir Root Directory como `backend`, pois o
Dockerfile também precisa dos manifests na raiz. Auto-deploy: **Off**.

| Variável runtime | Valor |
| --- | --- |
| `ADAPTAI_AUTH_MODE` | `supabase` |
| `ADAPTAI_DATABASE_URL` | URL Session pooler com password e SSL; segredo |
| `ADAPTAI_DATABASE_SCHEMA` | `adaptai` |
| `ADAPTAI_SUPABASE_URL` | Project URL |
| `ADAPTAI_SUPABASE_PUBLISHABLE_KEY` | Publishable key |
| `ADAPTAI_BROWSER_ORIGIN` | Origem HTTPS exata do frontend, sem barra final |
| `ADAPTAI_CREDENTIALS_KEY` | Fernet key estável; segredo |
| `ADAPTAI_GROQ_MODEL` | `openai/gpt-oss-20b`, se for usar o modelo do projeto |
| `ADAPTAI_GROQ_API_KEY` | Chave do projeto, se houver; segredo |

Sem uma chave/modelo acessível, o modo demonstração continua disponível, mas não
equivale a uma avaliação semântica por IA. Ollama num portátil não fica acessível
automaticamente a partir do Render.

Para uma base cloud nova sem credenciais encriptadas, gerar a Fernet key localmente:

```powershell
uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Guardar o resultado apenas no segredo Render. Ao importar credenciais encriptadas
existentes, conservar a chave correspondente em vez de gerar uma nova.

`render.yaml` descreve este serviço. Só usar o Blueprint depois de o ficheiro e
todo o código necessário estarem no GitHub, através de feature -> develop -> main.
Não tentar publicar a main antiga que ainda não contém esta integração.

## 4. Netlify

Configuração de build: base `frontend`, comando `pnpm build`, publish `dist`,
Node 22. O `netlify.toml` na raiz já contém estes valores, fallback SPA e headers.
Nunca publicar o código fonte ou a pasta raiz como diretório de publicação.

| Variável pública de build | Valor |
| --- | --- |
| `VITE_AUTH_MODE` | `supabase` |
| `VITE_API_ORIGIN` | Origem HTTPS exata do backend Render, sem `/api` |
| `VITE_SUPABASE_URL` | Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable key |

Todas as variáveis `VITE_*` ficam públicas no JavaScript. Não colocar nelas URL
PostgreSQL, passwords, tokens de deploy ou chaves de fornecedores de IA.

Para o fluxo GitHub Actions, o build acontece no runner: as variáveis necessárias
têm também de estar no GitHub, não basta configurá-las no painel Netlify. Evitar
builds/publicações Git automáticos em paralelo com Actions: usar um site de
deploy manual/CLI ou desligar builds Git automáticos na configuração do projeto.
O deploy Actions usa o site existente, identificado por `NETLIFY_SITE_ID`.

## 5. GitHub Actions: ativar só no fim

No GitHub, criar/usar o Environment `production`. Em Settings -> Secrets and
variables -> Actions (ou no Environment `production`), configurar:

| Tipo | Nome | Valor |
| --- | --- | --- |
| Variable | `API_ORIGIN` | URL HTTPS backend |
| Variable | `SUPABASE_URL` | Project URL |
| Variable | `SUPABASE_PUBLISHABLE_KEY` | Publishable key pública |
| Variable | `RENDER_SERVICE_ID` | ID `srv-...` do serviço |
| Variable | `NETLIFY_SITE_ID` | Project/Site ID Netlify |
| Secret | `RENDER_API_KEY` | Token API Render |
| Secret | `NETLIFY_AUTH_TOKEN` | Token de deploy Netlify |

Só depois de todos os passos estarem prontos, criar a **Repository Variable**
`CLOUD_DEPLOY_ENABLED=true` (deve existir a nível do repositório, pois controla
o agendamento do job antes de o Environment ser carregado).

O workflow `.github/workflows/ci.yml` valida todas as branches. O job deploy só
executa em **push para main**, com a variável de ativação, depois de todos os
checks passarem. Faz build cloud do frontend, publica o commit testado no Render,
espera pelo estado live, verifica health e só depois publica no Netlify.

## 6. Verificação final

1. Backend `/api/health` responde com `{"status":"ok"}`.
2. Frontend abre, confirma email e faz login, refresh e logout.
3. Sessões/histórico ficam isolados por utilizador e sobrevivem a novo login.
4. Análise, decisão e chat/streaming funcionam com o modelo configurado.
5. Requests do frontend passam CORS; pedidos de outras origens são rejeitados.
6. Confirmar consumo dos planos Free e o tempo de arranque após suspensão Render.

## Ligações e validação de latência

O FastAPI reutiliza até quatro ligações PostgreSQL por processo. O pool abre
ligações à medida que são necessárias e funciona com o Session pooler do
Supabase. Define `ADAPTAI_DATABASE_POOL_SIZE=0` para desativar temporariamente
a reutilização de ligações PostgreSQL durante um diagnóstico.

Depois do deploy, com a API ativa, compara o tempo de resposta da lista de
chats e de **My Progress** no separador Network do browser. Usa a mesma conta
de teste e repete cada pedido cinco vezes. Para **Analyse** e o chat, usa o
mesmo texto sintético e o mesmo modelo em cada tentativa. Regista também o
tempo até aparecer o primeiro texto do chat.

## Referências oficiais

- [Supabase PostgreSQL connections](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase email/SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render Free limits](https://render.com/docs/free)
- [Netlify file-based configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/)
- [Netlify deploy CLI](https://cli.netlify.com/commands/deploy/)
