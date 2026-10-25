"""Synthetic contract fixtures, not independent human assessment labels."""


def profile_data(**scores):
    data = {
        key: {"score": 1, "confidence": "medium", "evidence": "Synthetic test evidence"}
        for key in ("reasoning", "context", "ambiguity", "domain", "risk", "tools")
    }
    for key, score in scores.items():
        data[key] = {
            "score": score,
            "confidence": "undetermined" if score is None else "medium",
            "evidence": "Synthetic test evidence",
        }
    data["modality"] = {
        "required": ["text"],
        "confidence": "medium",
        "evidence": "Synthetic text task",
    }
    data["explanation"] = "Synthetic test assessment"
    return data
