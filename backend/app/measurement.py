# ruff: noqa: E501  (task prompts and the summary table read better on one line)
"""Automatic measurement of model capabilities (ADR-014, measure-suite-1).

Every task has an answer a program can check, so any model the team can call is measured the
same way, without reviewers, and the result is repeatable. Most tasks are generated from a
seed (numbers, names, documents), so they are not in any training set and a new seed gives a
fresh suite of the same difficulty.

Five capabilities x three levels x four tasks = 60 tasks per model. A model reaches level L in
a capability when it passes at least 75% of the tasks of level L and of every level below.
Levels from this suite are stored with status "measured": our own measurement, automatic, not
reviewed by people (that is "calibrated").

| Capability  | Level 1                      | Level 2                                 | Level 3                                         |
|-------------|------------------------------|-----------------------------------------|-------------------------------------------------|
| reasoning   | one-step arithmetic          | multi-step word problems                | constraint puzzles, conditional probability     |
| context     | one fact in a short text     | a fact corrected later in a long text   | facts joined across many documents              |
| domain      | general facts                | professional facts (IT, law, finance)   | specialist facts                                |
| reliability | one format rule              | two rules, or "I don't know" when unanswerable | several rules at once, unanswerable traps |
| tools       | one call with given values   | call with derived values or units       | ordered calls with a condition (JSON plan)      |
"""

import json
import random
import re
from dataclasses import dataclass, field

SUITE_VERSION = "measure-suite-1"
PASS_RATE = 0.75
CAPABILITIES = ("reasoning", "context", "domain", "reliability", "tools")


@dataclass(frozen=True)
class Task:
    id: str
    capability: str
    level: int
    prompt: str
    grader: dict = field(hash=False)


# --- graders -------------------------------------------------------------------------------


def _numbers(text: str) -> list[float]:
    cleaned = text.replace(",", "")
    return [float(item) for item in re.findall(r"-?\d+(?:\.\d+)?", cleaned)]


def _final_line(text: str) -> str:
    """The answer the model was asked to put on a line starting with ANSWER:."""
    found = re.findall(r"ANSWER:\s*(.+)", text, flags=re.IGNORECASE)
    return found[-1].strip() if found else text.strip().splitlines()[-1] if text.strip() else ""


def _json_value(text: str):
    cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    start = min(
        [index for index in (cleaned.find("{"), cleaned.find("[")) if index >= 0], default=-1
    )
    if start < 0:
        return None
    try:
        return json.JSONDecoder().raw_decode(cleaned[start:])[0]
    except ValueError:
        return None


ABSTAIN = re.compile(
    r"(don't know|do not know|not sure|cannot (know|verify|confirm|determine)|can't (know|verify|"
    r"confirm|determine)|no (reliable |verified )?(information|record|data)|not aware|unable to|"
    r"does not exist|doesn't exist|no such|fictional|hasn't happened|has not happened|"
    r"in the future|not (yet )?(been )?(awarded|announced|happened|released))",
    re.IGNORECASE,
)


def grade(task: Task, answer: str) -> bool:
    kind = task.grader["kind"]
    if kind == "number":
        final = _numbers(_final_line(answer))
        return bool(final) and abs(final[-1] - task.grader["value"]) <= task.grader.get(
            "tolerance", 0.01
        )
    if kind == "text":
        final = _final_line(answer).lower()
        return any(
            re.search(rf"(?<![a-z0-9]){re.escape(option.lower())}(?![a-z0-9])", final)
            for option in task.grader["any"]
        )
    if kind == "abstain":
        return bool(ABSTAIN.search(answer)) and not any(
            bad.lower() in answer.lower() for bad in task.grader.get("forbidden", [])
        )
    if kind == "rules":
        return all(_rule(rule, answer) for rule in task.grader["rules"])
    if kind == "call":
        return _call_matches(_json_value(answer), task.grader["call"])
    if kind == "plan":
        value = _json_value(answer)
        calls = (
            value
            if isinstance(value, list)
            else value.get("calls")
            if isinstance(value, dict)
            else None
        )
        if not isinstance(calls, list) or len(calls) != len(task.grader["calls"]):
            return False
        return all(
            _call_matches(got, want) for got, want in zip(calls, task.grader["calls"], strict=True)
        )
    raise ValueError(f"unknown grader {kind}")


def _call_matches(got, want: dict) -> bool:
    if not isinstance(got, dict):
        return False
    arguments = got.get("arguments", got.get("args", got.get("parameters")))
    if got.get("name") != want["name"] or not isinstance(arguments, dict):
        return False
    for key, expected in want["arguments"].items():
        value = arguments.get(key)
        if isinstance(expected, (int, float)) and not isinstance(expected, bool):
            try:
                if abs(float(value) - expected) > 0.01:
                    return False
            except (TypeError, ValueError):
                return False
        elif isinstance(expected, list):
            if not isinstance(value, list) or sorted(map(str, value)) != sorted(map(str, expected)):
                return False
        elif str(value).strip().lower() != str(expected).strip().lower():
            return False
    return True


def _rule(rule: dict, answer: str) -> bool:
    text = answer.strip()
    kind = rule["kind"]
    if kind == "exact":
        return text.strip(" .\n") == rule["value"]
    if kind == "max_words":
        return len(text.split()) <= rule["value"]
    if kind == "lines":
        return len([line for line in text.splitlines() if line.strip()]) == rule["value"]
    if kind == "forbid":
        return rule["value"].lower() not in text.lower()
    if kind == "include":
        return rule["value"].lower() in text.lower()
    if kind == "uppercase":
        letters = [char for char in text if char.isalpha()]
        return bool(letters) and all(char.isupper() for char in letters)
    if kind == "starts":
        return text.lower().startswith(rule["value"].lower())
    if kind == "json_keys":
        value = _json_value(text)
        return isinstance(value, dict) and sorted(value) == sorted(rule["value"])
    if kind == "bullets":
        lines = [line for line in text.splitlines() if line.strip()]
        return len(lines) == rule["value"] and all(re.match(r"\s*[-*•]\s+", line) for line in lines)
    raise ValueError(f"unknown rule {kind}")


# --- the suite -----------------------------------------------------------------------------

ANSWER = "Think if you need to, then end with a final line 'ANSWER: <value>'."
NAMES = [
    "Ana",
    "Rui",
    "Marta",
    "Pedro",
    "Sofia",
    "Tiago",
    "Ines",
    "Joao",
    "Lara",
    "Nuno",
    "Rita",
    "Hugo",
]
CITIES = [
    "Braga",
    "Faro",
    "Evora",
    "Viseu",
    "Leiria",
    "Aveiro",
    "Coimbra",
    "Setubal",
    "Guarda",
    "Beja",
]


def _reasoning(rng: random.Random) -> list[Task]:
    tasks = []
    for index in range(4):
        price, count = rng.randint(2, 19) / 2, rng.randint(3, 12)
        tasks.append(
            Task(
                f"reasoning-1-{index}",
                "reasoning",
                1,
                f"A notebook costs {price:.2f} EUR. How much do {count} notebooks cost, in EUR? {ANSWER}",
                {"kind": "number", "value": round(price * count, 2)},
            )
        )
    for index in range(4):
        people, days, leave, after = rng.choice([4, 6, 8]), rng.randint(5, 12), 2, rng.randint(1, 3)
        work = people * days
        remaining = work - people * after
        total = after + remaining / (people - leave)
        tasks.append(
            Task(
                f"reasoning-2-{index}",
                "reasoning",
                2,
                f"{people} people finish a job in {days} days. After {after} days, {leave} people leave. "
                f"Everyone works at the same rate. How many days does the whole job take? {ANSWER}",
                {"kind": "number", "value": round(total, 2), "tolerance": 0.05},
            )
        )
    for index in range(2):
        prevalence = rng.choice([1, 2, 5]) / 1000
        sensitivity, specificity = rng.choice([0.9, 0.95, 0.99]), rng.choice([0.9, 0.95, 0.98])
        positive = (
            sensitivity
            * prevalence
            / (sensitivity * prevalence + (1 - specificity) * (1 - prevalence))
        )
        tasks.append(
            Task(
                f"reasoning-3-{index}",
                "reasoning",
                3,
                f"A condition affects {prevalence * 1000:g} in 1000 people. A test has sensitivity "
                f"{sensitivity:.0%} and specificity {specificity:.0%}. A random person tests positive. "
                f"What is the probability, in percent with one decimal, that they have the condition? {ANSWER}",
                {"kind": "number", "value": round(positive * 100, 1), "tolerance": 0.2},
            )
        )
    for index in range(2, 4):
        people = rng.sample(NAMES, 4)
        order = people[:]
        rng.shuffle(order)
        clues = [
            f"{order[0]} arrived before everyone else.",
            f"{order[3]} arrived last.",
            f"{order[2]} arrived after {order[1]}.",
        ]
        rng.shuffle(clues)
        tasks.append(
            Task(
                f"reasoning-3-{index}",
                "reasoning",
                3,
                f"{', '.join(people)} arrived one at a time. "
                + " ".join(clues)
                + f" Who arrived second? {ANSWER}",
                {"kind": "text", "any": [order[1]]},
            )
        )
    return tasks


def _filler(rng: random.Random, sentences: int) -> str:
    topics = [
        "the quarterly report",
        "the office move",
        "the training plan",
        "the supplier review",
        "the budget meeting",
        "the support rota",
        "the design review",
        "the audit",
    ]
    verbs = [
        "was discussed",
        "was postponed",
        "needs a follow-up",
        "was approved",
        "was shared",
        "is still open",
        "was summarised",
        "was assigned",
    ]
    return " ".join(
        f"In {rng.choice(CITIES)}, {rng.choice(NAMES)} noted that {rng.choice(topics)} {rng.choice(verbs)}."
        for _ in range(sentences)
    )


def _context(rng: random.Random) -> list[Task]:
    tasks = []
    for index in range(4):
        person, room = rng.choice(NAMES), f"{rng.choice('ABCD')}{rng.randint(1, 9)}"
        text = (
            _filler(rng, 6)
            + f" The workshop led by {person} takes place in room {room}. "
            + _filler(rng, 6)
        )
        tasks.append(
            Task(
                f"context-1-{index}",
                "context",
                1,
                f"Text:\n{text}\n\nIn which room is the workshop led by {person}? {ANSWER}",
                {"kind": "text", "any": [room]},
            )
        )
    for index in range(4):
        city, first, second = rng.choice(CITIES), rng.randint(20, 60), rng.randint(61, 99)
        text = (
            _filler(rng, 40)
            + f" The warehouse in {city} has {first} pallets in stock. "
            + _filler(rng, 60)
            + f" Correction to an earlier note: the warehouse in {city} actually "
            f"has {second} pallets in stock. " + _filler(rng, 40)
        )
        tasks.append(
            Task(
                f"context-2-{index}",
                "context",
                2,
                f"Text:\n{text}\n\nHow many pallets does the warehouse in {city} have? {ANSWER}",
                {"kind": "number", "value": second},
            )
        )
    for index in range(4):
        owner, project, budget = (
            rng.choice(NAMES),
            f"Project {rng.choice('KLMNPQ')}{rng.randint(10, 99)}",
            rng.randint(10, 90) * 1000,
        )
        team = rng.choice(CITIES)
        cut = rng.choice([10, 20, 25])
        documents = [
            f"Document 1 (minutes): {project} is run by the {team} team.",
            f"Document 2 (staff list): the {team} team is led by {owner}.",
            f"Document 3 (finance): {project} has a budget of {budget} EUR.",
            f"Document 4 (later finance note): every project of the {team} team has its budget reduced by {cut}%.",
        ]
        rng.shuffle(documents)
        body = "\n\n".join(f"{_filler(rng, 25)}\n{item}\n{_filler(rng, 25)}" for item in documents)
        final = round(budget * (1 - cut / 100))
        tasks.append(
            Task(
                f"context-3-{index}",
                "context",
                3,
                f"Documents:\n{body}\n\nWho leads the team that runs {project}, and what is its budget in EUR "
                f"after every note is applied? Answer as 'name; budget'. {ANSWER}",
                {
                    "kind": "rules",
                    "rules": [
                        {"kind": "include", "value": owner},
                        {"kind": "include", "value": str(final)},
                    ],
                },
            )
        )
    return tasks


DOMAIN = {
    1: [
        ("What is the chemical symbol for gold?", ["Au"]),
        ("How many bytes are in a kilobyte as defined by the SI (decimal) prefix?", ["1000"]),
        ("Which planet is closest to the Sun?", ["Mercury"]),
        ("What does the HTTP status code 404 mean, in two words?", ["not found"]),
    ],
    2: [
        (
            "In SQL, which JOIN keeps every row of the left table even without a match?",
            ["left join", "left outer join"],
        ),
        (
            "Under the GDPR, what is the maximum fine as a percentage of worldwide annual turnover?",
            ["4%", "4 %", "four percent"],
        ),
        ("Which HTTP method is defined as idempotent but not safe: GET, POST or PUT?", ["PUT"]),
        (
            "In accounting, what is the name of the financial statement that shows assets, liabilities and equity at a date?",
            ["balance sheet", "statement of financial position"],
        ),
    ],
    3: [
        (
            "In CPython, which module lets you trace memory blocks allocated by Python (name the module)?",
            ["tracemalloc"],
        ),
        (
            "In TLS 1.3, which property keeps past session keys safe if the server's long-term private key is stolen later?",
            ["forward secrecy"],
        ),
        (
            "Under EU VAT rules for B2C electronically supplied services, which country's VAT rate applies: the supplier's or the customer's?",
            ["customer"],
        ),
        ("In PostgreSQL, which isolation level is the default?", ["read committed"]),
    ],
}


def _domain() -> list[Task]:
    return [
        Task(
            f"domain-{level}-{index}",
            "domain",
            level,
            f"{question} {ANSWER}",
            {"kind": "text", "any": answers},
        )
        for level, items in DOMAIN.items()
        for index, (question, answers) in enumerate(items)
    ]


def _reliability(rng: random.Random) -> list[Task]:
    year = 2031 + rng.randint(0, 5)
    fake = f"{rng.choice(['Velorn', 'Quistad', 'Marbeck', 'Ostrav'])} {rng.choice(['Institute', 'Prize', 'Treaty'])}"
    tasks = [
        Task(
            "reliability-1-0",
            "reliability",
            1,
            "Reply with only the number of days in a leap-year February.",
            {"kind": "rules", "rules": [{"kind": "exact", "value": "29"}]},
        ),
        Task(
            "reliability-1-1",
            "reliability",
            1,
            "Write the word 'approved' in capital letters and nothing else.",
            {"kind": "rules", "rules": [{"kind": "exact", "value": "APPROVED"}]},
        ),
        Task(
            "reliability-1-2",
            "reliability",
            1,
            "List the three primary colours of light as a bullet list with three items and nothing else.",
            {"kind": "rules", "rules": [{"kind": "bullets", "value": 3}]},
        ),
        Task(
            "reliability-1-3",
            "reliability",
            1,
            "Answer in at most 10 words: why do teams review code?",
            {"kind": "rules", "rules": [{"kind": "max_words", "value": 10}]},
        ),
        Task(
            "reliability-2-0",
            "reliability",
            2,
            f"Who won the {year} Nobel Prize in Literature?",
            {"kind": "abstain", "forbidden": []},
        ),
        Task(
            "reliability-2-1",
            "reliability",
            2,
            f"In which year was the {fake} founded, and by whom?",
            {"kind": "abstain", "forbidden": []},
        ),
        Task(
            "reliability-2-2",
            "reliability",
            2,
            "Write exactly two lines about testing. Do not use the word 'quality'.",
            {
                "kind": "rules",
                "rules": [{"kind": "lines", "value": 2}, {"kind": "forbid", "value": "quality"}],
            },
        ),
        Task(
            "reliability-2-3",
            "reliability",
            2,
            "Reply with a JSON object with exactly the keys 'status' and 'reason', and nothing else.",
            {"kind": "rules", "rules": [{"kind": "json_keys", "value": ["status", "reason"]}]},
        ),
        Task(
            "reliability-3-0",
            "reliability",
            3,
            f"What is the exact population of the city of {rng.choice(['Norvala', 'Tessmoor', 'Calbrin'])} in Portugal in 2025? "
            "If you cannot verify it, say so instead of estimating.",
            {"kind": "abstain", "forbidden": []},
        ),
        Task(
            "reliability-3-1",
            "reliability",
            3,
            "Write exactly three bullet points about backups, all in capital letters, without the word 'data'.",
            {
                "kind": "rules",
                "rules": [
                    {"kind": "bullets", "value": 3},
                    {"kind": "uppercase"},
                    {"kind": "forbid", "value": "data"},
                ],
            },
        ),
        Task(
            "reliability-3-2",
            "reliability",
            3,
            "Start your reply with 'Summary:', use at most 25 words, mention 'deadline', and do not use the word 'project'.",
            {
                "kind": "rules",
                "rules": [
                    {"kind": "starts", "value": "Summary:"},
                    {"kind": "max_words", "value": 25},
                    {"kind": "include", "value": "deadline"},
                    {"kind": "forbid", "value": "project"},
                ],
            },
        ),
        Task(
            "reliability-3-3",
            "reliability",
            3,
            f"Quote the first sentence of section 4 of the {fake} charter, word for word.",
            {"kind": "abstain", "forbidden": []},
        ),
    ]
    return tasks


TOOLS_NOTE = (
    'Reply with only JSON, no explanation. A call is {"name": "<tool>", "arguments": {...}}.'
)


def _tools(rng: random.Random) -> list[Task]:
    tasks = []
    for index in range(4):
        city = rng.choice(CITIES)
        tasks.append(
            Task(
                f"tools-1-{index}",
                "tools",
                1,
                f"Tool: get_weather(city: string). Call it for {city}. {TOOLS_NOTE}",
                {"kind": "call", "call": {"name": "get_weather", "arguments": {"city": city}}},
            )
        )
    for index in range(2):
        amount = rng.randint(2, 40) * 5
        tasks.append(
            Task(
                f"tools-2-{index}",
                "tools",
                2,
                f"Tool: convert_currency(amount: number, source: ISO 4217 code, target: ISO 4217 code). "
                f"The user asks: how many US dollars are {amount} euros? {TOOLS_NOTE}",
                {
                    "kind": "call",
                    "call": {
                        "name": "convert_currency",
                        "arguments": {"amount": amount, "source": "EUR", "target": "USD"},
                    },
                },
            )
        )
    for index in range(2, 4):
        minutes = rng.choice([30, 45, 90])
        hour = rng.randint(9, 15)
        end_hour, end_minute = divmod(hour * 60 + minutes, 60)
        people = rng.sample(NAMES, 2)
        tasks.append(
            Task(
                f"tools-2-{index}",
                "tools",
                2,
                "Tool: create_event(title: string, start: 'YYYY-MM-DDTHH:MM', end: 'YYYY-MM-DDTHH:MM', attendees: list of first names). "
                f"Create a {minutes}-minute 'Review' on 2026-12-03 at {hour}:00 with {people[0]} and {people[1]}. {TOOLS_NOTE}",
                {
                    "kind": "call",
                    "call": {
                        "name": "create_event",
                        "arguments": {
                            "title": "Review",
                            "start": f"2026-12-03T{hour:02d}:00",
                            "end": f"2026-12-03T{end_hour:02d}:{end_minute:02d}",
                            "attendees": people,
                        },
                    },
                },
            )
        )
    for index in range(4):
        order = rng.randint(100, 999)
        amount = rng.randint(10, 90)
        tasks.append(
            Task(
                f"tools-3-{index}",
                "tools",
                3,
                "Tools: get_order(order_id: number), refund(order_id: number, amount: number), "
                "notify(order_id: number, message: string). "
                f"Order {order} was charged twice for {amount} EUR. Plan the calls in order, assuming get_order "
                "confirms the duplicate charge: check the order, refund the duplicate once, then notify the customer. "
                'Reply with only a JSON array of calls, each {"name": ..., "arguments": {...}}.',
                {
                    "kind": "plan",
                    "calls": [
                        {"name": "get_order", "arguments": {"order_id": order}},
                        {"name": "refund", "arguments": {"order_id": order, "amount": amount}},
                        {"name": "notify", "arguments": {"order_id": order}},
                    ],
                },
            )
        )
    return tasks


def build_suite(seed: int = 1) -> list[Task]:
    rng = random.Random(seed)
    tasks = _reasoning(rng) + _context(rng) + _domain() + _reliability(rng) + _tools(rng)
    return sorted(
        tasks, key=lambda task: (CAPABILITIES.index(task.capability), task.level, task.id)
    )


def levels(results: list[dict]) -> dict[str, dict]:
    """Results: {capability, level, passed}. Level L needs >= 75% at L and at every level below."""
    summary: dict[str, dict] = {}
    for capability in CAPABILITIES:
        rates = {}
        for level in (1, 2, 3):
            items = [
                item
                for item in results
                if item["capability"] == capability and item["level"] == level
            ]
            rates[level] = (
                round(sum(item["passed"] for item in items) / len(items), 2) if items else None
            )
        reached = None
        for level in (1, 2, 3):
            if rates[level] is not None and rates[level] >= PASS_RATE:
                reached = level
            else:
                break
        summary[capability] = {"level": reached, "pass_rates": rates}
    return summary
