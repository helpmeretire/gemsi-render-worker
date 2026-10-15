import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
assert b["info"]["input"]["method"] == "GET" and b["info"]["input"]["queryParams"]["q"]
ex = b["info"]["output"]["example"]
r0 = ex["results"][0]
assert isinstance(r0["lat"], float) and isinstance(r0["lon"], float) and r0["display_name"]
assert len(r0["bounding_box"]) == 4 and r0["address"]["country_code"] == "us"
assert ex["source"] == "OpenStreetMap Nominatim" and "OpenStreetMap contributors" in ex["attribution"]
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
