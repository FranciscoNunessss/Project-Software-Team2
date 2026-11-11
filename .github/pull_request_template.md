<!--
Pull request report (08 Construction, section 2). The objective, the cases and the plan
stay on the card; this report says what was built. Fill every section: write
"none" or "not applicable" with a reason rather than deleting one.
-->

## What changes

One or two sentences, from the user's point of view.

## Card and plan

- Card: <!-- link -->
- Plan approved (G1) by: <!-- name -->
- Architecture Owner informed: yes / no / not applicable <!-- required when the plan touches stored data, AI input, an external integration or security -->
- Path: full / fix

## Cases covered

| Case (from the brainstorm) | Test that proves it |
|---|---|
|  |  |

Known cases left uncovered, and why:

## Manual test (G2)

What the developer tested by hand, where (local or cloud), and the result.

## Data, privacy and security

Does what is stored change? A migration? New environment variables or keys?
(Never paste a key or `.env` content here.)

## AI

Does a prompt, the rubric, a model or the catalogue change? If so, which evaluation
ran (05 Develop Test and Quality Strategy, 7.6). What did the AI agent generate?

## Docs updated

README, Product Specification, ADR, 05, process documents; or "none, because ...".

## Where to look first

The two or three places in the diff where the logic that matters lives.

## Risks and limitations

What could go wrong, and how to roll back.

<!--
Before asking a colleague: post an LLM review (AI Working Guide, template T-11) as a
comment, with findings rated blocker / major / minor / nit.
Merge (G3) when CI is green, this report is complete, the LLM review has no open
blocker, majors are fixed or justified, and a colleague other than the author has
approved. The approver merges. The LLM never approves.
-->
