// WS4 L5: one advice card per pattern of the engine (backend/app/learning_engine.py). Static
// content written by the team; no language model. English for now; L19 adds Portuguese.

export type EducatorCard = { why: string; how: string; before?: string; after?: string }

export const EDUCATOR_CARDS: Record<string, EducatorCard> = {
  missing_dimension: {
    why: 'A model fills a gap you leave with its own guess, so the answer drifts from what you needed and you spend turns correcting it.',
    how: 'Before you send, add one sentence for the missing part. The Coach can point it out on your next task.',
    before: 'Write a summary of the meeting notes.',
    after: 'Write a summary of the meeting notes for the board, in 5 bullet points, so they can approve the budget on Friday.',
  },
  over_sizing: {
    why: 'A bigger model than the task needs costs more and is often slower, for the same result.',
    how: 'Try the recommended model first; switch up only if the answer falls short.',
  },
  under_sizing: {
    why: 'A model below what the task needs may miss steps or context, so the task stays unsolved.',
    how: 'For tasks like these, start with the recommended model. If the request was vague, the Coach can help too.',
  },
  coach_ignored: {
    why: 'The Coach found gaps that usually make answers miss: leaving them costs extra turns later.',
    how: 'Read the rewrite before you dismiss it; you can keep only the parts you agree with.',
  },
  long_chats: {
    why: 'Many answers for one task usually mean the first request lacked something the model needed.',
    how: 'When a chat runs long, note what you had to add, and put it in the first message next time.',
  },
  model_switching: {
    why: 'Switching model mid-chat restarts its understanding and makes the result harder to judge.',
    how: 'Analyse the task first and stay with the recommended model unless it clearly falls short.',
  },
  improving_dimension: { why: 'You now describe this part of your tasks more clearly than before.', how: 'Keep doing it: it makes answers land faster.' },
  good_model_choice: { why: 'Following the recommendation solved your tasks without paying for more model than needed.', how: 'Keep analysing before you send.' },
  coach_pays_off: { why: 'In your tasks, accepting the Coach went together with solving more of them.', how: 'Keep using it on tasks that matter.' },
}

export const GOAL_TEXT: Record<string, string> = {
  state_objective: 'State the result you want in 3 tasks',
  state_context: 'Give the background the model needs in 3 tasks',
  state_constraints: 'State your limits (scope, tools, time, style) in 3 tasks',
  state_risks: 'Say what could go wrong or is sensitive in 3 tasks',
  state_ambiguity: 'Resolve or flag the open points in 3 tasks',
  state_success_criteria: 'Say how you will judge the answer in 3 tasks',
  state_audience_format: 'Say who the answer is for and its format in 3 tasks',
  follow_recommendation: 'Use the recommended model in 3 tasks',
  one_model_per_chat: 'Stay with one model in 3 chats',
}
