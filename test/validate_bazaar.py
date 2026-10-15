import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
body = b["info"]["input"]["body"]
assert b["info"]["input"]["method"] == "POST" and b["info"]["input"]["bodyType"] == "json"
assert isinstance(body["text"], str) and 1 <= len(body["text"]) <= 1500
assert body["format"] in ("svg", "png", "json") and isinstance(body["size"], int) and 128 <= body["size"] <= 2048
assert isinstance(body["margin"], int) and 0 <= body["margin"] <= 8 and body["ecc"] in ("L", "M", "Q", "H")
ex = b["info"]["output"]["example"]
assert b["info"]["output"]["type"] == "json" and 1 <= ex["version"] <= 40 and ex["modules"] == 17 + 4 * ex["version"]
assert isinstance(ex["matrix"], list) and len(ex["matrix"]) == ex["modules"] and all(len(r) == ex["modules"] and set(r) <= {"0", "1"} for r in ex["matrix"])
assert ex["svg"].startswith("<svg") and ex["svg"].endswith("</svg>") and ex["ecc"] == body["ecc"]
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
