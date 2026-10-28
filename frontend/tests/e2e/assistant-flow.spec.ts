import { expect, test } from "@playwright/test"

interface CapturedRequest {
  path: string
  body?: Record<string, unknown>
}

const analysis = {
  id: "synthetic-analysis-001",
  mode: "demonstration",
  provider: "demo",
  assessment_model: null,
  usage: null,
  profile: {
    reasoning: {
      score: 2,
      confidence: "low",
      evidence: "Synthetic reasoning evidence.",
    },
    context: {
      score: 1,
      confidence: "low",
      evidence: "Synthetic context evidence.",
    },
    ambiguity: {
      score: null,
      confidence: "undetermined",
      evidence: "Not assessed in demo mode.",
    },
    domain: {
      score: null,
      confidence: "undetermined",
      evidence: "Not assessed in demo mode.",
    },
    risk: {
      score: null,
      confidence: "undetermined",
      evidence: "Not assessed in demo mode.",
    },
    tools: {
      score: null,
      confidence: "undetermined",
      evidence: "Not assessed in demo mode.",
    },
    modality: {
      required: ["text"],
      confidence: "low",
      evidence: "Synthetic text-only task.",
    },
    explanation: "Synthetic profile for browser acceptance testing.",
  },
  profile_version: "test-profile",
  recommendation_provisional: true,
  clarification_questions: [],
  guidance: [],
  recommendation: {
    id: "tier-medium",
    name: "Medium tier",
    capacity: 2,
    capabilities: ["text"],
  },
  alternatives: [
    {
      id: "tier-small",
      name: "Small tier",
      capacity: 1,
      capabilities: ["text"],
    },
    {
      id: "tier-large",
      name: "Large tier",
      capacity: 3,
      capabilities: ["text"],
    },
  ],
  rationale: "Synthetic rationale for acceptance testing.",
  warnings: ["Synthetic data only."],
  confidence_basis: "Synthetic fixture",
  latency_ms: 1,
  catalogue_version: "test-catalogue",
  policy_version: "test-policy",
}

test("user analyses a task, chooses an eligible tier, and confirms the choice", async ({
  page,
}) => {
  const requests: CapturedRequest[] = []
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const body = request.postDataJSON() as Record<string, unknown> | undefined
    requests.push({ path, body })

    if (path === "/api/health") return route.fulfill({ json: { status: "ok" } })
    if (path === "/api/providers") {
      return route.fulfill({
        json: [
          {
            id: "demo",
            label: "Demonstration · local heuristic",
            model: null,
            enabled: true,
            external: false,
          },
        ],
      })
    }
    if (path === "/api/analyze") return route.fulfill({ json: analysis })
    if (path === "/api/decisions") {
      return route.fulfill({
        json: {
          status: "acknowledged",
          candidate_id: body?.candidate_id,
          persistence: "none",
        },
      })
    }
    return route.fulfill({ status: 404, json: { detail: "not_found" } })
  })

  await page.goto("/")
  await expect(
    page.getByRole("status").filter({ hasText: "API online" }),
  ).toBeVisible()
  await page
    .getByRole("textbox", { name: "Describe your task" })
    .fill("Synthetic task: compare two API designs and explain trade-offs.")
  await page.getByRole("button", { name: "Analyse" }).click()

  await expect(
    page.getByRole("heading", { name: "Provisional recommendation" }),
  ).toBeVisible()
  await expect(page.getByRole("heading", { name: "Medium" })).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Complexity profile" }),
  ).toBeVisible()

  await page
    .getByRole("group", { name: "Choose a model tier" })
    .getByRole("button", { name: "Small" })
    .click()
  await expect(page.getByText("Your choice is set to Small.")).toBeVisible()
  await page.getByRole("button", { name: "Confirm choice" }).click()

  await expect(
    page.getByRole("button", { name: "Choice acknowledged" }),
  ).toBeDisabled()
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "No task execution or persistent learning" }),
  ).toBeVisible()
  expect(
    requests.find((request) => request.path === "/api/analyze")?.body,
  ).toMatchObject({
    provider: "demo",
    allow_external: false,
    task: "Synthetic task: compare two API designs and explain trade-offs.",
  })
  expect(
    requests.find((request) => request.path === "/api/decisions")?.body,
  ).toMatchObject({
    analysis_id: "synthetic-analysis-001",
    candidate_id: "tier-small",
  })
})

test("external assessment stays blocked until the user grants consent", async ({
  page,
}) => {
  let analysisRequest: Record<string, unknown> | undefined
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/health") return route.fulfill({ json: { status: "ok" } })
    if (path === "/api/providers") {
      return route.fulfill({
        json: [
          {
            id: "demo",
            label: "Demonstration · local heuristic",
            model: null,
            enabled: true,
            external: false,
          },
          {
            id: "groq",
            label: "Groq",
            model: "synthetic-model",
            enabled: true,
            external: true,
          },
        ],
      })
    }
    if (path === "/api/analyze") {
      analysisRequest = (route
        .request()
        .postDataJSON() as Record<string, unknown>)
      return route.fulfill({
        json: { ...analysis, mode: "semantic", provider: "groq" },
      })
    }
    return route.fulfill({ json: { status: "acknowledged" } })
  })

  await page.goto("/")
  await page.getByLabel("Assessment provider").selectOption("groq")
  const analyseButton = page.getByRole("button", { name: "Analyse" })
  await expect(
    page.getByLabel(/I allow this task to be sent to Groq/),
  ).not.toBeChecked()
  await expect(analyseButton).toBeDisabled()
  expect(analysisRequest).toBeUndefined()

  await page.getByLabel(/I allow this task to be sent to Groq/).check()
  await expect(analyseButton).toBeEnabled()
  await analyseButton.click()
  await expect(
    page.getByRole("heading", { name: "Provisional recommendation" }),
  ).toBeVisible()
  expect(analysisRequest).toMatchObject({
    provider: "groq",
    allow_external: true,
  })
})

test("provider failure is shown clearly without falling back to the demo", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/health") return route.fulfill({ json: { status: "ok" } })
    if (path === "/api/providers") {
      return route.fulfill({
        json: [
          {
            id: "groq",
            label: "Groq",
            model: "synthetic-model",
            enabled: true,
            external: true,
          },
        ],
      })
    }
    if (path === "/api/analyze") {
      return route.fulfill({
        status: 502,
        json: { detail: "invalid_provider_output" },
      })
    }
    return route.fulfill({ json: { status: "acknowledged" } })
  })

  await page.goto("/")
  await expect(page.getByLabel("Assessment provider")).toHaveValue("groq")
  await page.getByLabel(/I allow this task to be sent to Groq/).check()
  await page.getByRole("button", { name: "Analyse" }).click()

  await expect(page.getByRole("alert")).toHaveText(
    "The provider returned an invalid assessment. No recommendation was generated.",
  )
  await expect(
    page.getByRole("heading", { name: "Your recommendation will appear here" }),
  ).toBeVisible()
})

test("live Groq user journey works end to end", async ({ page }) => {
  test.skip(
    process.env.RUN_LIVE_GROQ !== "1",
    "requires an explicitly configured Groq API key",
  )
  test.setTimeout(90_000)

  await page.goto("/")
  const provider = page.getByLabel("Assessment provider")
  await expect(provider).toHaveValue("groq")
  const consent = page.getByLabel(/I allow this task to be sent to Groq/)
  const analyseButton = page.getByRole("button", { name: "Analyse" })
  await expect(consent).not.toBeChecked()
  await expect(analyseButton).toBeDisabled()

  await page
    .getByRole("textbox", { name: "Describe your task" })
    .fill(
      "Compare two API designs for a small library catalogue. Explain trade-offs.",
    )
  await consent.check()
  const analysisResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/analyze",
  )
  await analyseButton.click()
  const response = await analysisResponse
  expect(response.status()).toBe(200)

  await expect(
    page.getByRole("heading", { name: "Complexity profile" }),
  ).toBeVisible()
  await expect(page.getByText(/semantic · groq ·/)).toBeVisible()
  const tierChoices = page
    .getByRole("group", { name: "Choose a model tier" })
    .getByRole("button")
  let alternative
  for (let index = 0; index < (await tierChoices.count()); index += 1) {
    const candidate = tierChoices.nth(index)
    if (
      (await candidate.isEnabled()) &&
      (await candidate.getAttribute("aria-pressed")) !== "true"
    ) {
      alternative = candidate
      break
    }
  }
  expect(alternative).toBeDefined()
  await alternative!.click()
  await page.getByRole("button", { name: "Confirm choice" }).click()
  await expect(
    page.getByRole("button", { name: "Choice acknowledged" }),
  ).toBeDisabled()
})
