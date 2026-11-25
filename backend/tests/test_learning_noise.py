"""WS4 engine: relative patterns must not appear by chance (PR5, confidence in the patterns).

Histories with no real tendency (independent random values, the same odds before and after)
must almost never produce a pattern that claims a tendency: long chats against the user's own
median, a dimension that improves, and the Coach paying off. Fixed seeds keep it deterministic.
The absolute patterns (a dimension at 0 in 3 of 5, sizing, switching) are thresholds the plan
defines, not claims of change, so they are not part of this test.
"""

import random

from app.learning_engine import DIMENSIONS, CoachUse, TaskRecord, compute

USERS = 1000
MAX_CHANCE = 0.05


def chance(make_tasks, code, seed):
    rng = random.Random(seed)
    hits = sum(code in [p.code for p in compute(make_tasks(rng)).patterns] for _ in range(USERS))
    return hits / USERS


def random_turns(rng):
    return [
        TaskRecord(task_id=str(i), turns=rng.choice([1, 2, 2, 3, 3, 4, 5, 6, 8]), outcome="yes")
        for i in range(rng.randint(5, 40))
    ]


def random_scores(rng):
    odds = [rng.random() for _ in range(3)]
    tasks = []
    for i in range(rng.randint(6, 40)):
        scores = {name: None for name in DIMENSIONS}
        scores["objective"] = rng.choices([0, 1, 2], odds)[0]
        tasks.append(TaskRecord(task_id=str(i), scores=scores))
    return tasks


def random_coach(rng):
    solved = rng.random()
    return [
        TaskRecord(
            task_id=str(i),
            coach=CoachUse(2, rng.random() < 0.5),
            outcome="yes" if rng.random() < solved else "no",
        )
        for i in range(rng.randint(10, 40))
    ]


def test_long_chats_rarely_appear_by_chance():
    assert chance(random_turns, "long_chats", 1) <= MAX_CHANCE


def test_improving_dimension_rarely_appears_by_chance():
    assert chance(random_scores, "improving_dimension", 2) <= MAX_CHANCE


def test_coach_pays_off_rarely_appears_by_chance():
    assert chance(random_coach, "coach_pays_off", 3) <= MAX_CHANCE
