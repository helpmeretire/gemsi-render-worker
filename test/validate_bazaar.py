import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
assert b["info"]["input"]["queryParams"]["url"].startswith("https://")
assert b["info"]["output"]["example"]["text"] and b["info"]["output"]["example"]["markdown"]
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
