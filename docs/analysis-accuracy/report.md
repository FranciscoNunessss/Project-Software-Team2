# Task profile accuracy and stability (rubric-2.0)

Rows: 288 analyses, 4 failed. Tasks: 24. Assessors: gemma-local, groq-gpt-oss-120b, groq-gpt-oss-20b, groq-qwen3.8-27b.

Expected levels are my own reading of the rubric text (1-3); only clear-cut dimensions are labelled. They are a reference to discuss, not ground truth.

## 1. Accuracy against the expected level (labelled dimensions only)

| assessor | n | exact | within 1 | mean abs err | bias (+ = over-rates) | undetermined |
|---|---|---|---|---|---|---|
| gemma-local | 255 | 83% | 100% | 0.17 | -0.00 | 0 |
| groq-gpt-oss-120b | 255 | 85% | 100% | 0.15 | +0.13 | 0 |
| groq-gpt-oss-20b | 246 | 83% | 99% | 0.17 | +0.09 | 2 |
| groq-qwen3.8-27b | 255 | 86% | 99% | 0.14 | +0.04 | 2 |

Exact match per dimension:

| assessor | reasoning | context | ambiguity | domain | risk | tools |
|---|---|---|---|---|---|---|
| gemma-local | 85% | 81% | 89% | 71% | 76% | 100% |
| groq-gpt-oss-120b | 79% | 83% | 89% | 69% | 88% | 100% |
| groq-gpt-oss-20b | 79% | 83% | 100% | 61% | 84% | 100% |
| groq-qwen3.8-27b | 87% | 93% | 91% | 69% | 84% | 98% |

## 2. Is the stated confidence justified? (exact match by confidence, labelled dimensions)

| assessor | high | medium | low | share of all scored cells that say high |
|---|---|---|---|---|
| gemma-local | 85% (n=248) | 14% (n=7) | n/a (n=0) | 91% |
| groq-gpt-oss-120b | 87% (n=247) | 25% (n=8) | n/a (n=0) | 86% |
| groq-gpt-oss-20b | 86% (n=237) | 0% (n=6) | 100% (n=1) | 89% |
| groq-qwen3.8-27b | 89% (n=223) | 47% (n=17) | 92% (n=13) | 78% |

## 3. Stability: the same task analysed 3 times by the same assessor

| assessor | cells | identical in all runs | range 1 | range 2 | any undetermined in a run |
|---|---|---|---|---|---|
| gemma-local | 144 | 73% | 35 | 4 | 0 |
| groq-gpt-oss-120b | 144 | 77% | 26 | 2 | 5 |
| groq-gpt-oss-20b | 144 | 66% | 32 | 11 | 6 |
| groq-qwen3.8-27b | 144 | 62% | 40 | 6 | 9 |

## 4. Agreement between assessors (most common score per task and dimension)

| pair | cells | same | within 1 |
|---|---|---|---|
| gemma-local vs groq-gpt-oss-120b | 143 | 76% | 99% |
| gemma-local vs groq-gpt-oss-20b | 144 | 67% | 97% |
| gemma-local vs groq-qwen3.8-27b | 144 | 74% | 99% |
| groq-gpt-oss-120b vs groq-gpt-oss-20b | 143 | 83% | 100% |
| groq-gpt-oss-120b vs groq-qwen3.8-27b | 143 | 78% | 97% |
| groq-gpt-oss-20b vs groq-qwen3.8-27b | 144 | 76% | 97% |

## 5. Per task: expected vs most common score by assessor (r c a d k t)

| task | expected | gemma-local | groq-gpt-oss-120b | groq-gpt-oss-20b | groq-qwen3.8-27b |
|---|---|---|---|---|---|
| celsius | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 2 1 1 | 1 1 1 1 1 1 |
| typos | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 |
| translate | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 |
| email-supplier | 1 1 - 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 2 1 1 1 |
| rename-var | 1 1 1 1 1 1 | 1 1 1 2 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 |
| mortgage-kid | 1 1 1 1 1 1 | 2 1 1 2 1 1 | 2 1 1 2 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 |
| haiku | 1 1 - 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 |
| laptops | 2 1 - 1 1 1 | 2 1 2 2 1 1 | 2 2 2 2 2 1 | 3 2 1 2 2 1 | 2 1 2 2 1 1 |
| palindrome | - 1 1 2 1 1 | 2 1 1 2 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 | 1 1 1 1 1 1 |
| sql-top10 | - - - 2 1 1 | 2 1 2 2 1 1 | 2 2 2 2 1 1 | 3 1 2 2 2 1 | 2 1 2 2 1 1 |
| debug-none | - 1 1 2 1 1 | 1 1 1 2 1 1 | 2 1 1 2 1 1 | 1 1 1 1 1 1 | 1 1 1 2 1 1 |
| django-leak | 3 3 - - 3 - | 3 2 2 2 2 3 | 3 3 2 2 3 2 | 3 3 3 2 3 2 | 3 3 2 3 3 2 |
| db-schema | 3 - - - - - | 3 2 2 2 2 1 | 3 2 1 2 3 1 | 3 2 1 2 3 2 | 3 2 2 3 3 1 |
| sqrt2-proof | 3 - 1 - - 1 | 3 1 1 2 1 1 | 3 2 1 2 1 1 | 3 1 1 2 1 1 | 2 1 1 3 1 1 |
| itinerary | 2 1 - 1 1 - | 3 2 2 1 1 2 | 3 2 2 2 2 2 | 3 2 2 2 2 2 | 3 2 2 2 2 2 |
| literature | - 3 - - - - | 2 2 3 1 2 1 | 3 3 3 ? 2 3 | 3 2 3 3 2 3 | 3 3 3 2 2 3 |
| spa-clause | - - - 3 3 - | 2 1 2 3 2 1 | 3 3 2 3 3 2 | 3 2 1 3 3 2 | 2 2 2 3 2 1 |
| clinical | - - - 3 3 - | 3 2 3 3 2 2 | 3 2 3 3 3 3 | 3 3 3 3 3 3 | 3 3 3 3 3 3 |
| make-better | - - 3 - - - | 1 1 3 1 1 1 | 1 1 3 1 1 1 | 1 1 3 1 1 1 | 1 1 3 1 1 1 |
| summarise-missing | - - 3 - - - | 2 2 2 2 2 1 | 2 2 3 2 2 2 | 2 1 3 2 2 3 | 2 2 1 1 2 2 |
| job-offer | - - 3 - - - | 2 3 3 1 2 2 | 3 3 3 2 2 2 | 3 2 3 2 2 2 | 1 1 3 1 1 1 |
| fx-live | 1 1 1 1 - 3 | 1 1 1 2 1 3 | 1 1 1 2 2 3 | 1 1 1 1 3 3 | 1 1 1 1 1 3 |
| prod-delete | - - - - 3 3 | 1 2 3 2 3 3 | 2 2 3 2 3 3 | 1 1 3 2 3 3 | 1 1 3 2 3 3 |
| tax-evasion | - - - - 3 - | 2 1 2 2 2 3 | 3 2 1 3 3 3 | 3 2 1 3 3 3 | 1 1 1 3 3 3 |

## 6. Largest disagreements with the expected level (mode of runs, difference of 2, or a miss on every assessor)

- **laptops / domain**: expected 1, got {'gemma-local': 2, 'groq-gpt-oss-120b': 2, 'groq-gpt-oss-20b': 2, 'groq-qwen3.8-27b': 2}
- **itinerary / reasoning**: expected 2, got {'gemma-local': 3, 'groq-gpt-oss-120b': 3, 'groq-gpt-oss-20b': 3, 'groq-qwen3.8-27b': 3}
- **itinerary / context**: expected 1, got {'gemma-local': 2, 'groq-gpt-oss-120b': 2, 'groq-gpt-oss-20b': 2, 'groq-qwen3.8-27b': 2}
- **summarise-missing / ambiguity**: expected 3, got {'gemma-local': 2, 'groq-gpt-oss-120b': 3, 'groq-gpt-oss-20b': 3, 'groq-qwen3.8-27b': 1}

## 7. Other fields

| assessor | median seconds | failed | modality text-only | asks clarification questions on the 3 vague tasks |
|---|---|---|---|---|
| gemma-local | 16.3 | 0 | 99% | 78% |
| groq-gpt-oss-120b | 3.5 | 0 | 99% | 89% |
| groq-gpt-oss-20b | 21.7 | 4 | 85% | 100% |
| groq-qwen3.8-27b | 21.7 | 0 | 90% | 78% |

Recommendation by task (name of the most common recommendation; stability = share of runs equal to it):

| task | gemma-local | groq-gpt-oss-120b | groq-gpt-oss-20b | groq-qwen3.8-27b |
|---|---|---|---|---|
| celsius | Illustrative small model (2/3) | Illustrative small model (2/3) | Illustrative balanced model (2/3) | Illustrative small model (2/3) |
| typos | Illustrative small model (2/3) | Illustrative small model (2/3) | Illustrative small model (2/3) | Illustrative small model (2/3) |
| translate | Illustrative small model (3/3) | Illustrative small model (2/3) | GPT-OSS 20B (1/3) | qwen3.8-27b (1/3) |
| email-supplier | Illustrative small model (3/3) | Illustrative small model (2/3) | GPT-OSS 20B (1/3) | Illustrative small model (2/3) |
| rename-var | Illustrative balanced model (3/3) | Illustrative small model (2/3) | Illustrative small model (3/3) | Illustrative balanced model (3/3) |
| mortgage-kid | Illustrative balanced model (3/3) | Illustrative balanced model (3/3) | Illustrative small model (2/3) | Illustrative small model (2/3) |
| haiku | Illustrative small model (3/3) | Illustrative small model (2/3) | Illustrative small model (3/3) | Illustrative small model (3/3) |
| laptops | Illustrative balanced model (2/3) | Illustrative balanced model (2/3) | Illustrative advanced model (3/3) | Illustrative balanced model (3/3) |
| palindrome | Illustrative balanced model (3/3) | Illustrative small model (2/3) | Illustrative small model (2/3) | Illustrative small model (3/3) |
| sql-top10 | Illustrative balanced model (2/3) | Illustrative balanced model (3/3) | Illustrative balanced model (2/3) | Illustrative balanced model (3/3) |
| debug-none | Illustrative balanced model (2/3) | Illustrative balanced model (3/3) | Illustrative small model (2/3) | Illustrative balanced model (2/3) |
| django-leak | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) |
| db-schema | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) |
| sqrt2-proof | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (2/3) | Illustrative advanced model (2/3) |
| itinerary | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (2/3) |
| literature | Illustrative balanced model (2/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) |
| spa-clause | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) |
| clinical | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) |
| make-better | Illustrative small model (1/3) | Illustrative advanced model (1/3) | Illustrative advanced model (2/3) | Illustrative advanced model (2/3) |
| summarise-missing | Illustrative balanced model (3/3) | Illustrative balanced model (2/3) | Illustrative advanced model (1/2) | Illustrative balanced model (2/3) |
| job-offer | Illustrative advanced model (2/3) | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative small model (1/3) |
| fx-live | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (2/2) | Illustrative advanced model (3/3) |
| prod-delete | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (2/2) | Illustrative advanced model (3/3) |
| tax-evasion | Illustrative advanced model (3/3) | Illustrative advanced model (3/3) | Illustrative advanced model (2/2) | Illustrative advanced model (3/3) |

## Failures

- groq-gpt-oss-20b summarise-missing rep 2: 502 {"detail":"provider_rate_limit"}
- groq-gpt-oss-20b fx-live rep 2: 502 {"detail":"provider_rate_limit"}
- groq-gpt-oss-20b prod-delete rep 2: 502 {"detail":"provider_rate_limit"}
- groq-gpt-oss-20b tax-evasion rep 2: 502 {"detail":"provider_rate_limit"}