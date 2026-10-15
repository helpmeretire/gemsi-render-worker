import base64, json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
body = b["info"]["input"]["body"]
assert b["info"]["input"]["method"] == "POST" and b["info"]["input"]["bodyType"] == "json"
assert isinstance(body["prompt"], str) and 3 <= len(body["prompt"]) <= 1500
assert isinstance(body["steps"], int) and 1 <= body["steps"] <= 8 and body["format"] in ("png", "json")
ex = b["info"]["output"]["example"]
assert b["info"]["output"]["type"] == "json" and ex["content_type"] == "image/png" and ex["bytes"] > 0 and ex["steps"] == body["steps"]
assert base64.b64decode(ex["image_base64"], validate=True)[:8] == b"\x89PNG\r\n\x1a\n"
assert ex["model"].startswith("@cf/black-forest-labs/flux-1-schnell")
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
