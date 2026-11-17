# Privacy Policy

**AdaptAI · Version 1.0 · Last updated: 17 November 2026**

## 1. Introduction

AdaptAI is a student software project (Software Project 2026/27, Team 2, ISEC, Portugal) that recommends a suitable AI model for a given task, lets you run that task in a chat, and helps you build better prompting and model-selection habits over time.

This policy explains what personal data AdaptAI processes, why, who receives it, how long it is kept, and how you can exercise your rights under the General Data Protection Regulation (EU) 2016/679 ("GDPR"). We have written it to be read by users, not only by lawyers.

## 2. Data controller and contact

- **Controller:** the AdaptAI Team 2 project team, ISEC, Portugal.
- **Privacy contact:** [maximcapinus@gmail.com](mailto:maximcapinus@gmail.com). Please write to this address for any request or question about your personal data.
- **Data protection officer:** none has been appointed, because AdaptAI does not carry out the large-scale or systematic monitoring that requires one. The privacy contact answers data protection questions.

## 3. Summary

- **Metadata by default.** We store complexity scores, the model recommended, the model you chose, and timestamps. We do not store the text of your tasks unless you switch that on.
- **You are in control.** Saving task text, saving and using memory, and automatic learning suggestions are all off until you enable them in Profile. You can disable each of them again at any time.
- **Data leaves the service only on request.** Your task or chat text is sent to a model provider only when you press **Analyse** or **Send**, and only to the provider you selected.
- **No selling, no advertising, no tracking.** We do not sell personal data, display advertising, or use analytics or advertising trackers.
- **No model training.** We do not use your data to train any AI model.
- **Your rights are available in the app.** You can export your data, delete most of it, or delete your whole account yourself (see section 9).

## 4. Personal data we process

| Data | When it is processed | Purpose |
| --- | --- | --- |
| Email address and password | You create an account | To authenticate you. Passwords are stored only as a salted hash (local accounts) or are managed by Supabase Auth (cloud accounts). |
| Sign-in session | You sign in | To keep you signed in (see section 8). |
| Policy acceptance: the version you accepted and the time | You accept this policy | To be able to show that you were informed and, where consent is needed, that you gave it. |
| Complexity scores, recommended model, chosen model, completeness, timestamps and opaque session labels | Each analysis | To show your progress and compare your choices with the recommendations. |
| Task feedback: verdict (resolved, resolved with refinement, not resolved, skipped), optional reason from a fixed list, model identifiers, and numeric levels and counts of answers, retries and stops | You give feedback on a task | To improve recommendations and your learning dashboard. This record contains no free text. |
| Learned memory: derived profile values and tier choices | Only if **Save memory** is on | To personalise later recommendations. |
| Preferences you type in Profile | Only if you save them | To tailor explanations to you. Please do not enter sensitive information. |
| Task text, extra context and the AI's full assessment response | Only if **Save task text and AI responses** is on | To let you review them and, if **Use memory** is also on, to reuse up to five short excerpts. |
| Chat messages and model answers | While the chat exists | A chat cannot display its history otherwise. Deleting the chat deletes these messages. |
| Model configurations and provider API keys | You add them in LLM config | To call the provider you chose. Keys are stored encrypted. |
| Personal API tokens (stored only as a hash) | You create one in Profile | To let tools such as the VS Code extension sign in as you. You can revoke a token at any time. |
| Prompt Coach setting | One on/off value | To remember whether you want the Prompt Coach. |

Please do not enter passwords, API keys, health data, financial data or other sensitive personal data in tasks, chats or preferences.

## 5. Recipients and international transfers

Your task or chat text is sent to a model provider only when you press **Analyse** or **Send**. The recipient depends on the model you select:

- **Project-provided model (Groq).** Used for Auto mode, for the Educator's learning suggestions and, if you enable it, for automatic suggestions. Suggestions are generated from derived metadata (scores and choices), not raw task text, unless you have turned on both task-text saving and Use memory, in which case up to five short excerpts may be included.
- **Providers you configure yourself** (for example OpenAI, Anthropic or OpenRouter). Your task text, and your memory if enabled, is sent to the provider you chose and is governed by that provider's terms and privacy policy. You supply your own API key.
- **Local models (Ollama, LM Studio).** Processing takes place on the machine that runs the backend. Nothing is sent to a third-party service.
- **Prompt Coach.** If you switch it on and request tips, the task text you are editing is sent to the same provider as your analysis. Nothing the Prompt Coach receives or returns is stored or logged.

**Infrastructure providers (processors)** that host or process data on our behalf in the hosted service:

| Provider | Role | Location |
| --- | --- | --- |
| Supabase | Sign-in and the PostgreSQL database | European Union (West Europe, Ireland) |
| Render | Backend | European Union (Frankfurt, Germany) |
| Netlify | Frontend (static files only; it does not receive your account data) | Global content delivery network |

In a local installation, everything runs on the machine operated by you or by the team.

Some model providers are located outside the European Economic Area, most commonly in the United States. Where you send data to such a provider, the transfer is made at your request and is subject to that provider's own safeguards, such as the European Commission's Standard Contractual Clauses or the EU–US Data Privacy Framework. We do not control how model providers retain or use data, so please choose your provider accordingly.

## 6. Legal bases (GDPR Article 6)

- **Contract (Art. 6(1)(b)):** providing your account and the core service you asked for.
- **Consent (Art. 6(1)(a)):** saving task text, saving and using memory, automatic suggestions, the Prompt Coach, and sending data to an external model provider. You may withdraw consent at any time in Profile. Withdrawal does not affect processing carried out before it.
- **Legitimate interests (Art. 6(1)(f)):** keeping the service secure, and retaining non-text technical metadata about model usage for reproducibility. We have weighed these interests against your rights and consider the impact on you to be low.

## 7. Retention

- **Sign-in sessions** expire after 7 days by default.
- **Account and usage data** is kept until you delete it or delete your account. Inactive accounts are not deleted automatically at present. If we introduce automatic deletion of inactive accounts (we expect 24 months without use), we will email you before deleting anything and update this policy first.
- **Account deletion** removes your account and all data linked to it from the live database straight away.
- **Backups and exports.** Deleting data removes it from the live database. Database or provider backups, and copies you have exported yourself, may still contain earlier data until they expire under the provider's schedule. We do not promise erasure from backups.

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
| Erasure of your account and all data (Art. 17) | Profile → **Delete my account**. This deletes the account and everything stored for it in AdaptAI. All your sign-ins on every device stop working. Where you sign in through the hosted sign-in service, the sign-in itself (email and password) is held by that service: it is deleted as well when the installation is set up for it, and otherwise the app tells you right after the deletion that it was kept, and you can email the privacy contact to have it removed. Backups are not erased (section 7). |
| Restriction, objection and other questions (Arts. 18 and 21) | Email the privacy contact. |

We aim to respond to requests within one month. You also have the right to lodge a complaint with a supervisory authority: in Portugal, the Comissão Nacional de Proteção de Dados (CNPD, [cnpd.pt](https://www.cnpd.pt)), or the authority of the country where you live or work.

## 10. Automated processing

AdaptAI uses AI models to produce recommendations and suggestions. These are advisory only. They do not produce legal or similarly significant effects on you, and you decide which model to use and whether to follow a suggestion.

## 11. Security

We protect personal data with technical and organisational measures, including salted password hashing, encryption of provider keys, per-account access checks on every request, and HTTPS in deployed environments. No system is completely secure, so please use a strong and unique password.

If a personal data breach is likely to put your rights at risk, the privacy contact will notify the CNPD within 72 hours of becoming aware of it (GDPR Art. 33) and will tell affected users without undue delay when the risk to them is high (Art. 34).

## 12. Children

AdaptAI is not intended for anyone under the age of 16, and you confirm that you are at least 16 when you accept this policy. If you believe a child has provided personal data, contact the privacy contact and we will delete it.

## 13. Changes to this policy

We will update this page whenever the product or its data handling changes, and we will revise the version and date at the top. When a change is material, the app will ask you to read and accept the new version before you continue, and we will keep a record of the version you accepted and when.
