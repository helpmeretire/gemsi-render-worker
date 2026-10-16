import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
assert b["info"]["input"]["method"] == "POST" and b["info"]["input"]["bodyType"] == "json"
assert isinstance(b["info"]["input"]["body"]["texts"], list) and len(b["info"]["input"]["body"]["texts"]) >= 1
ex = b["info"]["output"]["example"]
assert ex["results"][0]["label"] in ("positive", "negative") and -1 <= ex["results"][0]["polarity"] <= 1
assert ex["summary"]["count"] == len(ex["results"])
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
