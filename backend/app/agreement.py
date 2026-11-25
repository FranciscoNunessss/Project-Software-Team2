"""Agreement between people who label or judge the same items (M1 labellers, M6 reviewers).

Pure functions, no model and no database. Labels are any hashable values
(levels, model ids, verdicts).
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Hashable, Sequence


def percent(first: Sequence[Hashable], second: Sequence[Hashable]) -> float | None:
    """Share of items on which two raters gave the same label, in percent."""
    if len(first) != len(second):
        raise ValueError("both raters must label the same items")
    if not first:
        return None
    return round(100 * sum(a == b for a, b in zip(first, second, strict=True)) / len(first), 1)


def cohen_kappa(first: Sequence[Hashable], second: Sequence[Hashable]) -> float | None:
    """Cohen's kappa for two raters.

    ``None`` when it is undefined: no items, or both raters used one and the same label for every
    item (chance agreement is then 1). Percent agreement still says what happened in that case.
    """
    if len(first) != len(second):
        raise ValueError("both raters must label the same items")
    n = len(first)
    if n == 0:
        return None
    observed = sum(a == b for a, b in zip(first, second, strict=True)) / n
    left, right = Counter(first), Counter(second)
    expected = sum(left[label] * right[label] for label in left) / (n * n)
    if expected == 1:
        return None
    return round((observed - expected) / (1 - expected), 3)


def weighted_kappa(
    first: Sequence[int], second: Sequence[int], levels: Sequence[int] = (1, 2, 3)
) -> float | None:
    """Cohen's kappa with quadratic weights, for ordinal labels such as levels 1 to 3.

    A 1 against a 3 counts as a larger disagreement than a 1 against a 2, which the plain kappa
    treats the same. ``None`` when it is undefined (no items, or no spread to disagree on).
    """
    if len(first) != len(second):
        raise ValueError("both raters must label the same items")
    n = len(first)
    if n == 0:
        return None
    left, right = Counter(first), Counter(second)
    observed = sum((a - b) ** 2 for a, b in zip(first, second, strict=True)) / n
    expected = sum(left[a] * right[b] * (a - b) ** 2 for a in levels for b in levels) / (n * n)
    if expected == 0:
        return None
    return round(1 - observed / expected, 3)


def fleiss_kappa(items: Sequence[Sequence[Hashable]]) -> float | None:
    """Fleiss' kappa: ``items`` holds, per item, the labels of every rater (same count per item)."""
    if not items:
        return None
    raters = len(items[0])
    if raters < 2 or any(len(labels) != raters for labels in items):
        raise ValueError("every item needs the same number of raters, at least two")
    n = len(items)
    totals: Counter = Counter()
    agreement = 0.0
    for labels in items:
        counts = Counter(labels)
        totals.update(counts)
        agreement += (sum(c * c for c in counts.values()) - raters) / (raters * (raters - 1))
    observed = agreement / n
    expected = sum((count / (n * raters)) ** 2 for count in totals.values())
    if expected == 1:
        return None
    return round((observed - expected) / (1 - expected), 3)
