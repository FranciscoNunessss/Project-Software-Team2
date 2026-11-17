# Per-person limits on the shared models

Risk R2 of the product audit (16 November 2026): the project has one free Groq key, 8000 tokens a
minute and 200 000 a day for everybody. An analysis costs about 2400 tokens, so the whole project
fits about 3 analyses a minute and 83 a day. One person could use all of it. Prepared with AI
assistance (Claude, Anthropic); human review pending.

## What is limited, and what is not

Limited: a request answered by a **server model of a hosted provider** (a `server:` configuration of
Groq, OpenAI, Claude or OpenRouter, the project's key). Never limited: a person's own key, a local
model (LM Studio, Ollama, the relay), the demonstration model. Those spend nothing shared.

Not covered, and said so: the learning suggestions (Educator) and the Coach also call the server
model; they are not blocked, because blocking them would break My progress for a person who only
chatted. They are small next to analyses.

| Limit | Default | Setting |
|---|---|---|
| Analyses per minute, per person | 4 | `ADAPTAI_USER_ANALYSES_PER_MINUTE` |
| Analyses per day (24 hours), per person | 30 | `ADAPTAI_USER_ANALYSES_PER_DAY` |
| Chat answers per minute, per person | 10 | `ADAPTAI_USER_MESSAGES_PER_MINUTE` |
| Chat answers per day, per person | 150 | `ADAPTAI_USER_MESSAGES_PER_DAY` |

0 switches a limit off. With 30 analyses a person a day, the 83 a day of the free plan are used up by
three people: the per-person limit shares the quota, it does not enlarge it. For 20 people the
quota has to grow (a second server model, a paid plan) or the daily default has to drop.

## How it works

* A refusal is HTTP 429 with a code the app words (`user_rate_limit`, `analysis_daily_limit`,
  `message_daily_limit`) and a `Retry-After` header. Nothing is stored about it.
* **Per minute**: a sliding window in memory, per backend instance. A restart forgets it (one extra
  burst at most).
* **Per day**: counted from stored data, so it survives restarts and needs no table or migration:
  analyses with a `server:` configuration of a hosted provider in the last 24 hours, and chat
  answers by hosted provider. A person who uses both a server model and their own key of the same
  provider is counted for both chat answers (a small over-count, never an under-count).
* The check runs after the model is chosen and consent is checked, before the provider is called, so
  a refused analysis leaves no session behind.

## Decisions that belong to the team

1. The defaults above are the author's proposal, not a decision of the Product Owner. Change them in
   the environment, not in code.
2. Whether a person who hits the daily limit should be offered "add your own key" in the interface
   (the message says so; there is no button yet).
3. The in-memory minute window assumes one backend instance, like the rest of the rate-limit memory.
   More instances would need the window in the database.
