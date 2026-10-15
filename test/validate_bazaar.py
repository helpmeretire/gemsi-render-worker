import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
assert "@" in b["info"]["input"]["queryParams"]["email"]
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
