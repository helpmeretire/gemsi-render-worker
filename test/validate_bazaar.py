import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
assert b["info"]["input"]["method"] == "POST" and b["info"]["input"]["bodyType"] == "json"
assert b["info"]["input"]["body"]["text"] and b["info"]["input"]["body"]["style"] in ("paragraph", "bullets", "tldr")
assert b["info"]["output"]["example"]["summary"].startswith("- ") and b["info"]["output"]["example"]["usage"]["prompt_tokens"] > 0
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
