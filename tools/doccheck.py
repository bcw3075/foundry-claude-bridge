"""Doc check: does docs/DEVELOPING.md still match the code?
Usage (from the repo root): python3 doccheck.py [docs/DEVELOPING.md]
Lists every `backticked` name in the doc that no longer appears anywhere in the code or repo files.
Each hit is a lead, not a verdict: read it and fix the doc or the code."""
import os, re, subprocess, sys
doc = sys.argv[1] if len(sys.argv) > 1 else "docs/DEVELOPING.md"
text = open(doc, encoding="utf-8").read()
files = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split()
code = ""
for f in files:
    if f == doc or f.endswith((".zip", ".png", ".webp", ".jpg", ".pyc")): continue
    try: code += open(f, encoding="utf-8", errors="ignore").read() + "\n" + f + "\n"
    except Exception: pass
seen, missing = set(["python3", "node", "npm", "npx", "git"]), []
for raw in re.findall(r"`([^`\n]{2,80})`", text):
    for name in re.split(r"[\s,/()=:;\[\]\"']+|\.\.\.", raw):
        name = name.strip(".'\"{}[]<>*")
        if len(name) < 3 or name in seen or not re.search(r"[A-Za-z]", name): continue
        seen.add(name)
        if name not in code: missing.append(name)
print(f"{len(seen)} names checked in {doc}; {len(missing)} not found in the repo:")
for m in missing: print("  -", m)
