import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
assert b["info"]["input"]["queryParams"]["q"]
ex = b["info"]["output"]["example"]
assert ex["results"] and ex["results"][0]["url"].startswith("https://") and ex["source"] == "DuckDuckGo"
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
