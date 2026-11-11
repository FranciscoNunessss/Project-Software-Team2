import json, collections, statistics as st, itertools, sys
S = r"C:\Users\josem\AppData\Local\Temp\claude\ed0c5eadc5fda9ac\35ee3b3f-0d32-4908-9683-23992d1a05b1\scratchpad"
data = json.load(open(S + r"\accuracy_data.json"))
exp, rows = data["expected"], data["rows"]
D = ["reasoning", "context", "ambiguity", "domain", "risk", "tools"]
ok = [r for r in rows if "profile" in r]
bad = [r for r in rows if "profile" not in r]
A = sorted({r["assessor"] for r in rows})
out = []
w = out.append


def pct(a, b):
    return f"{100 * a / b:.0f}%" if b else "n/a"


w("# Task profile accuracy and stability (rubric-2.0)\n")
w(f"Rows: {len(rows)} analyses, {len(bad)} failed. Tasks: {len(exp)}. Assessors: {', '.join(A)}.\n")
w("Expected levels are my own reading of the rubric text (1-3); only clear-cut dimensions are labelled. They are a reference to discuss, not ground truth.\n")

# --- accuracy
w("## 1. Accuracy against the expected level (labelled dimensions only)\n")
w("| assessor | n | exact | within 1 | mean abs err | bias (+ = over-rates) | undetermined |")
w("|---|---|---|---|---|---|---|")
per_dim = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0]))
conf_acc = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0]))
for a in A:
    n = ex = w1 = und = 0; errs = []
    for r in ok:
        if r["assessor"] != a: continue
        for d in D:
            e = exp[r["task"]][d]
            s, c = r["profile"][d]
            if e is None: continue
            if s is None:
                und += 1; n += 1; continue
            n += 1; ex += s == e; w1 += abs(s - e) <= 1; errs.append(s - e)
            per_dim[a][d][0] += s == e; per_dim[a][d][1] += 1
            conf_acc[a][c][0] += s == e; conf_acc[a][c][1] += 1
    scored = len(errs)
    w(f"| {a} | {n} | {pct(ex, n)} | {pct(w1, n)} | {st.mean(abs(x) for x in errs):.2f} | {st.mean(errs):+.2f} | {und} |")
w("")
w("Exact match per dimension:\n")
w("| assessor | " + " | ".join(D) + " |")
w("|---|" + "---|" * len(D))
for a in A:
    w(f"| {a} | " + " | ".join(pct(*per_dim[a][d]) for d in D) + " |")
w("")

# --- confidence
w("## 2. Is the stated confidence justified? (exact match by confidence, labelled dimensions)\n")
w("| assessor | high | medium | low | share of all scored cells that say high |")
w("|---|---|---|---|---|")
for a in A:
    allc = collections.Counter(c for r in ok if r["assessor"] == a for d in D for _, c in [r["profile"][d]])
    tot = sum(allc.values())
    cells = [f"{pct(*conf_acc[a][c])} (n={conf_acc[a][c][1]})" for c in ("high", "medium", "low")]
    w(f"| {a} | " + " | ".join(cells) + f" | {pct(allc['high'], tot)} |")
w("")

# --- stability
w("## 3. Stability: the same task analysed 3 times by the same assessor\n")
w("| assessor | cells | identical in all runs | range 1 | range 2 | any undetermined in a run |")
w("|---|---|---|---|---|---|")
for a in A:
    cells = ident = r1 = r2 = und = 0
    for t in exp:
        rr = [r for r in ok if r["assessor"] == a and r["task"] == t]
        if len(rr) < 2: continue
        for d in D:
            vals = [r["profile"][d][0] for r in rr]
            cells += 1
            if None in vals: und += 1; continue
            rg = max(vals) - min(vals)
            ident += rg == 0; r1 += rg == 1; r2 += rg == 2
    w(f"| {a} | {cells} | {pct(ident, cells)} | {r1} | {r2} | {und} |")
w("")

# --- agreement between assessors (mode of each)
def mode(vals):
    vals = [v for v in vals if v is not None]
    return collections.Counter(vals).most_common(1)[0][0] if vals else None

w("## 4. Agreement between assessors (most common score per task and dimension)\n")
w("| pair | cells | same | within 1 |")
w("|---|---|---|---|")
M = {a: {(t, d): mode([r["profile"][d][0] for r in ok if r["assessor"] == a and r["task"] == t]) for t in exp for d in D} for a in A}
for x, y in itertools.combinations(A, 2):
    n = s = w1 = 0
    for k in M[x]:
        if M[x][k] is None or M[y][k] is None: continue
        n += 1; s += M[x][k] == M[y][k]; w1 += abs(M[x][k] - M[y][k]) <= 1
    w(f"| {x} vs {y} | {n} | {pct(s, n)} | {pct(w1, n)} |")
w("")

# --- per task table
w("## 5. Per task: expected vs most common score by assessor (r c a d k t)\n")
w("| task | expected | " + " | ".join(A) + " |")
w("|---|---|" + "---|" * len(A))
for t in exp:
    e = " ".join(str(exp[t][d] or "-") for d in D)
    cols = []
    for a in A:
        cols.append(" ".join(str(M[a][(t, d)] or "?") for d in D))
    w(f"| {t} | {e} | " + " | ".join(cols) + " |")
w("")

# --- biggest misses
w("## 6. Largest disagreements with the expected level (mode of runs, difference of 2, or a miss on every assessor)\n")
for t in exp:
    for d in D:
        e = exp[t][d]
        if e is None: continue
        ms = {a: M[a][(t, d)] for a in A}
        if all(v is not None and v != e for v in ms.values()) or any(v is not None and abs(v - e) >= 2 for v in ms.values()):
            w(f"- **{t} / {d}**: expected {e}, got {ms}")
w("")

# --- completeness, questions, modality, recommendation
w("## 7. Other fields\n")
w("| assessor | median seconds | failed | modality text-only | asks clarification questions on the 3 vague tasks |")
w("|---|---|---|---|---|")
for a in A:
    rr = [r for r in ok if r["assessor"] == a]
    sec = st.median(r["seconds"] for r in rr) if rr else 0
    fl = len([r for r in bad if r["assessor"] == a])
    mod = [r for r in rr if r["modality"][0] == ["text"]]
    vague = [r for r in rr if r["task"] in ("make-better", "summarise-missing", "job-offer")]
    asks = len([r for r in vague if r["questions"] > 0])
    w(f"| {a} | {sec:.1f} | {fl} | {pct(len(mod), len(rr))} | {pct(asks, len(vague))} |")
w("")
w("Recommendation by task (name of the most common recommendation; stability = share of runs equal to it):\n")
w("| task | " + " | ".join(A) + " |")
w("|---|" + "---|" * len(A))
for t in exp:
    cols = []
    for a in A:
        rr = [r["recommendation"][0] for r in ok if r["assessor"] == a and r["task"] == t]
        if not rr: cols.append("-"); continue
        m, c = collections.Counter(rr).most_common(1)[0]
        cols.append(f"{m} ({c}/{len(rr)})")
    w(f"| {t} | " + " | ".join(cols) + " |")
w("")
if bad:
    w("## Failures\n")
    for r in bad: w(f"- {r['assessor']} {r['task']} rep {r['rep']}: {r['error']}")
text = "\n".join(out)
open(S + r"\accuracy_report.md", "w", encoding="utf8").write(text)
print(text)
