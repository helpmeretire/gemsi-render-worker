import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
assert b["info"]["input"]["method"] == "GET" and b["info"]["input"]["queryParams"]["symbol"] == "AAPL"
ex = b["info"]["output"]["example"]
assert isinstance(ex["price"], float) and isinstance(ex["changePercent"], float) and ex["symbol"] == "AAPL" and ex["currency"] == "USD"
assert ex["asOf"].endswith("Z") and ex["source"] == "Yahoo Finance" and "not investment advice" in ex["notice"]
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
