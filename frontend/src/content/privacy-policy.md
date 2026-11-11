# Privacy Policy

**AdaptAI · Version 0.2 (draft for team review) · Last updated: 11 November 2026**

> **Status: draft.** This policy describes how AdaptAI handles personal data in its current implementation. It has not yet been approved by the Architecture Owner and the Product Owner. Items marked **[TO CONFIRM]** require a team decision before the policy is published. This document is informational and does not constitute legal advice.

## 1. Introduction

AdaptAI is a student software project (Software Project 2026/27, Team 2) that recommends a suitable AI model for a given task, lets you run that task in a chat, and helps you build better prompting and model-selection habits over time.

This policy explains what personal data AdaptAI processes, why, who receives it, how long it is kept, and how you can exercise your rights under the General Data Protection Regulation (EU) 2016/679 ("GDPR"). We have written it to be read by users, not only by lawyers.

## 2. Data controller and contact

- **Controller:** the AdaptAI Team 2 project team **[TO CONFIRM: legal entity or institution responsible for the service]**.
- **Privacy contact:** **[TO CONFIRM: team email address for privacy requests]**.
- **Data protection officer:** none appointed **[TO CONFIRM]**.

## 3. Summary

- **Metadata by default.** We store complexity scores, the model recommended, the model you chose, and timestamps. We do not store the text of your tasks unless you switch that on.
- **You are in control.** Saving task text, saving and using memory, and automatic learning suggestions are all off until you enable them in Profile. You can disable each of them again at any time.
- **Data leaves the service only on request.** Your task or chat text is sent to a model provider only when you press **Analyse** or **Send**, and only to the provider you selected.
- **No selling, no advertising, no tracking.** We do not sell personal data, display advertising, or use analytics or advertising trackers.
- **No model training.** We do not use your data to train any AI model.
- **Your rights are available in the app.** You can export your data and delete most of it yourself (see section 9).

## 4. Personal data we process

| Data | When it is processed | Purpose |
| --- | --- | --- |
| Email address and password | You create an account | To authenticate you. Passwords are stored only as a salted hash (local accounts) or are managed by Supabase Auth (cloud accounts). |
| Sign-in session | You sign in | To keep you signed in (see section 8). |
| Complexity scores, recommended model, chosen model, completeness, timestamps and opaque session labels | Each analysis | To show your progress and compare your choices with the recommendations. |
| Task feedback: verdict (resolved, resolved with refinement, not resolved, skipped), optional reason from a fixed list, model identifiers, and numeric levels and counts of answers, retries and stops | You give feedback on a task | To improve recommendations and your learning dashboard. This record contains no free text. |
| Learned memory: derived profile values and tier choices | Only if **Save memory** is on | To personalise later recommendations. |
| Preferences you type in Profile | Only if you save them | To tailor explanations to you. Please do not enter sensitive information. |
| Task text, extra context and the AI's full assessment response | Only if **Save task text and AI responses** is on | To let you review them and, if **Use memory** is also on, to reuse up to five short excerpts. |
| Chat messages and model answers | While the chat exists | A chat cannot display its history otherwise. Deleting the chat deletes these messages. |
| Model configurations and provider API keys | You add them in LLM config | To call the provider you chose. Keys are stored encrypted. |
| Prompt Coach setting | One on/off value | To remember whether you want the Prompt Coach. |

Please do not enter passwords, API keys, health data, financial data or other sensitive personal data in tasks, chats or preferences.

## 5. Recipients and international transfers

Your task or chat text is sent to a model provider only when you press **Analyse** or **Send**. The recipient depends on the model you select:

- **Project-provided model (Groq).** Used for Auto mode, for the Educator's learning suggestions and, if you enable it, for automatic suggestions. Suggestions are generated from derived metadata (scores and choices), not raw task text, unless you have turned on both task-text saving and Use memory, in which case up to five short excerpts may be included.
- **Providers you configure yourself** (for example OpenAI, Anthropic or OpenRouter). Your task text, and your memory if enabled, is sent to the provider you chose and is governed by that provider's terms and privacy policy. You supply your own API key.
- **Local models (Ollama, LM Studio).** Processing takes place on the machine that runs the backend. Nothing is sent to a third-party service.
- **Prompt Coach.** If you switch it on and request tips, the task text you are editing is sent to the same provider as your analysis. Nothing the Prompt Coach receives or returns is stored or logged.

**Infrastructure providers (processors)** that host or process data on our behalf **[TO CONFIRM: final hosting choices]**: Supabase (authentication and PostgreSQL database), Render (backend) and Netlify (frontend). We prefer EU regions. In a local installation, everything runs on the machine operated by you or by the team.

Some model providers are located outside the European Economic Area. Where you send data to such a provider, the transfer is made at your request and is subject to that provider's safeguards. We do not control how model providers retain or use data, so please choose your provider accordingly.

## 6. Legal bases (GDPR Article 6)

- **Contract (Art. 6(1)(b)):** providing your account and the core service you asked for.
- **Consent (Art. 6(1)(a)):** saving task text, saving and using memory, automatic suggestions, the Prompt Coach, and sending data to an external model provider. You may withdraw consent at any time in Profile. Withdrawal does not affect processing carried out before it.
- **Legitimate interests (Art. 6(1)(f)):** keeping the service secure, and retaining non-text technical metadata about model usage for reproducibility. We have weighed these interests against your rights and consider the impact on you to be low.

## 7. Retention

- **Sign-in sessions** expire after 7 days by default.
- **All other data** is kept until you delete it or your account is removed. There is currently no automatic expiry **[TO CONFIRM: retention period for inactive accounts]**.
- **Backups and exports.** Deleting data removes it from the live database. Database or provider backups, and copies you have exported yourself, may still contain earlier data. We do not promise erasure from backups.

## 8. Cookies and browser storage

- **Sign-in cookie** (strictly necessary; HttpOnly; SameSite=Lax) in local mode. In cloud mode, the Supabase session token is kept in your browser's storage.
- **Preference storage** in your browser: light or dark theme, the last page you viewed, and a timestamp used to refresh the progress page across tabs.

We do not use analytics, advertising or tracking cookies. Because the items above are strictly necessary or purely functional, we do not show a cookie banner.

## 9. Your rights

Under the GDPR you have the following rights. This table shows how to exercise each one.

| Right | How to exercise it |
| --- | --- |
| Access and portability (Arts. 15 and 20) | My progress → **Export** (a JSON file with preferences, coaching and sessions). |
| Rectification (Art. 16) | Edit your preferences in Profile. |
| Withdraw consent (Art. 7(3)) | Turn the relevant switches off in Profile. |
| Erasure of learned memory (Art. 17) | Profile → **Clear learned memory**. |
| Erasure of saved conversation text and generated coaching (Art. 17) | Profile → **Delete saved conversations**. |
| Erasure of one session (Art. 17) | My progress → delete the session. |
| Erasure of all usage history (Art. 17) | My progress → **Delete**. Your account, preferences and LLM configurations remain. |
| Erasure of your account and all data (Art. 17) | Email the privacy contact. Self-service account deletion is not yet available **[TO CONFIRM: add before release]**. |
| Restriction, objection and other questions (Arts. 18 and 21) | Email the privacy contact. |

We aim to respond to requests within one month. You also have the right to lodge a complaint with a supervisory authority. In Portugal this is the Comissão Nacional de Proteção de Dados (CNPD, cnpd.pt) **[TO CONFIRM: authority for the operating country]**.

## 10. Automated processing

AdaptAI uses AI models to produce recommendations and suggestions. These are advisory only. They do not produce legal or similarly significant effects on you, and you decide which model to use and whether to follow a suggestion.

## 11. Security

We protect personal data with technical and organisational measures, including salted password hashing, encryption of provider keys, per-account access checks on every request, and HTTPS in deployed environments. No system is completely secure, so please use a strong and unique password. If a personal data breach is likely to put your rights at risk, we will notify the competent authority and affected users as required by law **[TO CONFIRM: breach-handling owner]**.

## 12. Children

AdaptAI is not intended for anyone under the age of 16 **[TO CONFIRM: minimum age]**. If you believe a child has provided personal data, contact the privacy contact and we will delete it.

## 13. Changes to this policy

We will update this page whenever the product or its data handling changes, and we will revise the version and date at the top. Where a change requires your consent, we will ask for it in the app before the change applies.
