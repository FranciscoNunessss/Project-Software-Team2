# Privacy Policy

**AdaptAI · Version 0.1 (draft for team review) · 11 November 2026**

> **Status: draft.** This policy describes what the AdaptAI code does today. It has not yet been reviewed by the Architecture Owner and Product Owner, and items marked **[TO CONFIRM]** need a team decision before release. It is not legal advice.

## 1. Who we are

AdaptAI is a student software project (Software Project 2026/27, Team 2) that recommends an AI model for a task, lets you run the task in a chat, and helps you choose better over time.

- **Controller:** the AdaptAI Team 2 project team **[TO CONFIRM: legal entity or institution responsible for the service]**.
- **Privacy contact:** **[TO CONFIRM: team email address for privacy requests]**.

## 2. The short version

- We keep **metadata by default**: complexity scores, the model recommended, the model you chose, and timestamps. We do **not** keep your task text unless you switch that on.
- **Saving conversation text, using memory and automatic learning suggestions are all off until you turn them on** in Profile. You can turn each one off again.
- Your tasks leave our servers only when you press **Analyse** or **Send**, and only to the model provider you selected.
- We do not sell your data, show ads, or use analytics or advertising trackers.
- Your data is not used to train any model by us.
- You can export your data and delete it from the app (see section 8).

## 3. What we collect and why

| Data | When | Why |
| --- | --- | --- |
| Email address and password | You create an account | To sign you in. Passwords are stored only as a salted hash (local accounts) or handled by Supabase Auth (cloud accounts). |
| Sign-in session | You sign in | To keep you signed in (see section 7). |
| Complexity scores, recommended model, the model you chose, completeness, timestamps and opaque session labels | Each analysis | To show your progress and compare your choices with the recommendations. |
| Task feedback: verdict (resolved, resolved with refinement, not resolved, skipped), optional reason from a fixed list, model identifiers, numeric levels and counts of answers, retries and stops | When you give feedback on a task | To improve recommendations and your learning dashboard. **Contains no text.** |
| Learned memory: derived profile values and tier choices | Only if **Save memory** is on | To personalise later recommendations. |
| Preferences you type in Profile | Only if you save them | To tailor explanations. Do not enter sensitive information. |
| Task text, extra context and the AI's full assessment response | Only if **Save task text and AI responses** is on | To let you review them and, with **Use memory** on, reuse up to five short excerpts. |
| Chat messages and the model's answers | While a chat exists | A chat cannot show its history otherwise. Deleting the chat deletes them. |
| Your model configurations and provider API keys | If you add them in LLM config | To call the provider you chose. Keys are stored encrypted. |
| Prompt Coach settings | One on/off value | To remember whether you want the Prompt Coach. |

We do not ask for, and you should not enter, passwords, API keys, health data, financial data or other sensitive personal data in tasks, chats or preferences.

## 4. Who receives your data

Your task or chat text is sent to a model provider only when you press **Analyse** or **Send**. Which provider receives it depends on the model you select:

- **Project-provided model (Groq).** Used for Auto mode, the Educator's learning suggestions and, if you enable it, automatic suggestions. Suggestions use derived metadata (scores and choices), not raw task text, unless you have turned on both text saving and Use memory, in which case up to five short excerpts may be included.
- **Providers you configure yourself** (for example OpenAI, Anthropic, OpenRouter): your task text, and memory if enabled, goes to the provider you chose, under their terms and privacy policy. You supply your own key.
- **Local models (Ollama, LM Studio):** processed on the machine running the backend and not sent to a third-party service.
- **Prompt Coach:** if you switch it on and click for tips, the task text you are editing is sent to the same provider as your analysis. Nothing the Prompt Coach receives or returns is stored or logged.

Infrastructure providers that host or process data for us **[TO CONFIRM: final hosting choices]**: Supabase (sign-in and PostgreSQL database), Render (backend) and Netlify (frontend), with EU regions preferred. In local installations everything runs on the machine you or the team operate.

Model providers may keep data under their own policies. We cannot control that, so choose the provider accordingly.

## 5. Legal bases (GDPR)

- **Contract:** your account and the core service you asked for.
- **Consent:** saving task text, saving and using memory, automatic suggestions, the Prompt Coach and sending data to an external provider. You can withdraw consent at any time in Profile. Withdrawing does not affect what happened before.
- **Legitimate interests:** security of the service, and keeping non-text technical metadata about model usage for reproducibility.

## 6. How long we keep data

- **Sign-in sessions** expire after 7 days by default.
- **Everything else** is kept until you delete it or your account is removed. There is no automatic expiry yet **[TO CONFIRM: retention period for inactive accounts]**.
- **Backups and exports:** deleting data removes it from the live database. Database or provider backups, and copies you exported yourself, may still hold earlier data. We do not promise forensic erasure from backups.

## 7. Cookies and browser storage

- A **sign-in cookie** (strictly necessary, HttpOnly, SameSite=Lax) in local mode; in cloud mode the Supabase session token is kept in your browser's storage.
- **Preference storage** in your browser: light or dark theme, the last page you viewed, and a timestamp used to refresh the progress page across tabs.

We use no analytics, advertising or tracking cookies. Because these items are strictly necessary or purely functional, we do not show a cookie banner.

## 8. Your rights and how to use them

| You want to | How |
| --- | --- |
| Access or export your data | My progress → **Export** (JSON file with preferences, coaching and sessions). |
| Correct your data | Edit your preferences in Profile. |
| Stop text saving, memory or automatic suggestions | Turn the switches off in Profile. |
| Delete learned memory | Profile → **Clear learned memory**. |
| Delete saved conversation text and generated coaching | Profile → **Delete saved conversations**. |
| Delete one session | My progress → delete the session. |
| Delete all your usage history | My progress → **Delete**. Your account, preferences and LLM configurations remain. |
| Delete your account and all data | Email the privacy contact. There is no self-service account deletion yet **[TO CONFIRM: add one before release]**. |
| Object, restrict processing or ask any question | Email the privacy contact. We aim to reply within one month. |

You can complain to your data protection authority. In Portugal this is the CNPD (Comissão Nacional de Protecção de Dados, cnpd.pt) **[TO CONFIRM: authority for the operating country]**.

## 9. Security

Passwords are salted and hashed, provider keys are encrypted, access is checked per account on every request, and traffic uses HTTPS when deployed. No system is perfectly secure; please use a strong, unique password.

## 10. Children

AdaptAI is not intended for anyone under 16 **[TO CONFIRM: minimum age]**.

## 11. Changes to this policy

We will update this page when the product or its data handling changes and change the date and version at the top. Material changes that need your consent will be shown in the app before they apply.
