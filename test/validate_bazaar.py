import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
assert b["info"]["input"]["method"] == "POST" and b["info"]["input"]["bodyType"] == "json"
body = b["info"]["input"]["body"]
assert body["text"] and len(body["target_lang"]) == 2 and body["source_lang"] != body["target_lang"]
ex = b["info"]["output"]["example"]
assert ex["translated_text"] and ex["source_lang"] == body["source_lang"] and ex["target_lang"] == body["target_lang"] and ex["input_chars"] == len(body["text"])
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
