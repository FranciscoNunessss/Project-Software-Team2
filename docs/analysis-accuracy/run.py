"""Accuracy and stability of the task profile (rubric-2.0, levels 1-3).
Each task carries the levels a careful reader would give from the rubric text; only dimensions that are
clear-cut are labelled (others are None and not scored). Each assessor analyses each task REPEATS times."""
import json, sys, time, uuid, threading, httpx

S = r"C:\Users\josem\AppData\Local\Temp\claude\ed0c5eadc5fda9ac\35ee3b3f-0d32-4908-9683-23992d1a05b1\scratchpad"
BASE = "http://127.0.0.1:8031"
KEYS = json.load(open(S + r"\keys.json"))
REPEATS = 3
D = ("reasoning", "context", "ambiguity", "domain", "risk", "tools")


def L(r=None, c=None, a=None, d=None, k=None, t=None):
    return dict(zip(D, (r, c, a, d, k, t)))


TASKS = [
    ("celsius", "Convert this list of temperatures from Celsius to Fahrenheit: 0, 20, 37, 100.", L(1, 1, 1, 1, 1, 1)),
    ("typos", "Fix the typos in this sentence: 'Teh quick brwon fox jumsp over the lazy dgo.'", L(1, 1, 1, 1, 1, 1)),
    ("translate", "Translate 'Where is the nearest train station?' into Portuguese.", L(1, 1, 1, 1, 1, 1)),
    ("email-supplier", "Write a polite email to a supplier asking to move our delivery from Friday to next Tuesday.", L(1, 1, None, 1, 1, 1)),
    ("rename-var", "Rename the variable x to count in this function: def f(x): return x + 1", L(1, 1, 1, 1, 1, 1)),
    ("mortgage-kid", "Explain in simple words what a mortgage is to a 12-year-old.", L(1, 1, 1, 1, 1, 1)),
    ("haiku", "Write a haiku about autumn.", L(1, 1, None, 1, 1, 1)),
    ("laptops", "Compare these three laptops (A: 16GB RAM, 512GB, 900 euros; B: 8GB, 1TB, 750 euros; C: 32GB, 1TB, 1300 euros) and recommend one for a student who edits videos with a budget of 1000 euros.", L(2, 1, None, 1, 1, 1)),
    ("palindrome", "Write a Python function that checks whether a string is a palindrome, ignoring case and punctuation.", L(None, 1, 1, 2, 1, 1)),
    ("sql-top10", "Write a SQL query that returns the ten customers with the highest total orders in 2025, and explain it for a beginner.", L(None, None, None, 2, 1, 1)),
    ("debug-none", "My Python script prints None instead of the sum. Here is the code: def add(a, b): a + b; print(add(2, 3))", L(None, 1, 1, 2, 1, 1)),
    ("django-leak", "Review a whole 800-line Django project (settings, models and views together) to find why users sometimes see other users' data, and propose a fix.", L(3, 3, None, None, 3, None)),
    ("db-schema", "Design the database schema for a multi-tenant SaaS with per-tenant encryption, audit logs, soft deletes and GDPR erasure, and justify each trade-off.", L(3, None, None, None, None, None)),
    ("sqrt2-proof", "Prove that the square root of 2 is irrational, then generalise the argument to any prime p, writing every step formally.", L(3, None, 1, None, None, 1)),
    ("itinerary", "Plan a 5-day itinerary in Lisbon for a family with two kids aged 6 and 9, with a budget of 200 euros per day, avoiding long walks.", L(2, 1, None, 1, 1, None)),
    ("literature", "Combine the findings of these five papers into a literature review of 1500 words. The papers cover different methods and contradict each other on several results.", L(None, 3, None, None, None, None)),
    ("spa-clause", "Draft a clause for a share purchase agreement limiting the seller's liability for undisclosed tax liabilities under Portuguese law.", L(None, None, None, 3, 3, None)),
    ("clinical", "Given the clinical notes of a patient with chest pain, diabetes and kidney disease, suggest a medication adjustment.", L(None, None, None, 3, 3, None)),
    ("make-better", "Make it better.", L(None, None, 3, None, None, None)),
    ("summarise-missing", "Summarise the attached Q3 sales report for the board in one page.", L(None, None, 3, None, None, None)),
    ("job-offer", "Tell me whether I should accept the job offer.", L(None, None, 3, None, None, None)),
    ("fx-live", "What is the current EUR/USD exchange rate and the price of Bitcoin right now?", L(1, 1, 1, 1, None, 3)),
    ("prod-delete", "Run this script on our production database and delete all rows older than 2020, then confirm the counts.", L(None, None, None, None, 3, 3)),
    ("tax-evasion", "Transfer 40,000 euros from the company savings account to my personal account and tell me how to avoid the tax office noticing.", L(None, None, None, None, 3, None)),
]

ASSESSORS = {
    "gemma-local": dict(label="LM Studio gemma", provider="lmstudio", model="gemma4-12b-qat-uncensored-hauhaucs-balanced"),
    "groq-gpt-oss-20b": dict(label="Groq 20b", provider="groq", model="openai/gpt-oss-20b", api_key=KEYS["groq"]),
    "groq-gpt-oss-120b": dict(label="Groq 120b", provider="groq", model="openai/gpt-oss-120b", api_key=KEYS["groq"]),
    "groq-qwen3.8-27b": dict(label="Groq qwen", provider="groq", model="qwen/qwen3.8-27b", api_key=KEYS["groq"]),
}
only = sys.argv[1].split(",") if len(sys.argv) > 1 else list(ASSESSORS)
H = {"Origin": "http://127.0.0.1:8443"}
c = httpx.Client(base_url=BASE, headers=H, timeout=180)
r = c.post("/api/auth/register", json={"email": f"acc-{uuid.uuid4().hex[:8]}@example.com", "password": "accuracy-password-12345"})
assert r.status_code in (200, 201), r.text
cfg = {}
for name in only:
    spec = ASSESSORS[name]
    r = c.post("/api/llm-configs", json={**spec, "enabled": True, "is_default": False})
    assert r.status_code in (200, 201), r.text
    cfg[name] = r.json()
rows, lock = [], threading.Lock()


def worker(name):
    conf = cfg[name]
    client = httpx.Client(base_url=BASE, headers=H, cookies=c.cookies, timeout=240)
    for rep in range(REPEATS):
        for key, text, expected in TASKS:
            body = {"task": text, "provider": "auto", "required_capabilities": ["text"], "configuration_id": conf["id"], "expected_configuration_id": conf["id"],
                    "expected_provider": conf["provider"], "expected_model": conf["model"], "allow_external": conf["provider"] != "lmstudio"}
            t0, res, err = time.time(), None, None
            for attempt in range(5):
                try:
                    res = client.post("/api/analyze", json=body)
                except Exception as e:  # noqa: BLE001
                    err = repr(e); time.sleep(10); continue
                if res.status_code == 200:
                    break
                err = f"{res.status_code} {res.text[:80]}"
                if res.status_code in (429, 502):
                    time.sleep(20 * (attempt + 1)); continue
                break
            row = {"assessor": name, "rep": rep, "task": key, "seconds": round(time.time() - t0, 1)}
            if res is not None and res.status_code == 200:
                a = res.json(); p = a["profile"]
                row["profile"] = {d: [p[d]["score"], p[d]["confidence"]] for d in D}
                row["modality"] = [p["modality"]["required"], p["modality"]["confidence"]]
                row["completeness"] = a.get("completeness")
                row["recommendation"] = [a["recommendation"].get("name"), a["recommendation"].get("status"), a["recommendation"].get("illustrative")]
                row["questions"] = len(a.get("clarification_questions") or [])
                row["provider"] = a.get("provider"); row["model"] = a.get("assessment_model")
            else:
                row["error"] = err
            with lock:
                rows.append(row)
                json.dump({"expected": {k: e for k, _, e in TASKS}, "rows": rows}, open(S + r"\accuracy_data.json", "w"), indent=1)
            print(name, rep, key, row.get("error") or "ok", row["seconds"], flush=True)
            time.sleep(2.5 if conf["provider"] == "groq" else 0)


threads = [threading.Thread(target=worker, args=(n,)) for n in only]
[t.start() for t in threads]
[t.join() for t in threads]
print("FINISHED", len(rows), flush=True)
