import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
body = b["info"]["input"]["body"]
assert b["info"]["input"]["method"] == "POST" and b["info"]["input"]["bodyType"] == "json"
assert isinstance(body["url"], str) and body["url"].startswith("https://") and "file_base64" not in body
ex = b["info"]["output"]["example"]
assert b["info"]["output"]["type"] == "json"
assert isinstance(ex["markdown"], str) and ex["markdown"] and ex["truncated"] is False
assert ex["mime_type"] == "application/pdf" and ex["name"].endswith(".pdf") and ex["bytes"] > 0
assert isinstance(ex["word_count"], int) and ex["word_count"] > 0 and ex["source_url"] == body["url"]
assert set(ex) == {"name", "mime_type", "bytes", "markdown", "truncated", "total_chars", "tokens", "word_count", "pages_hint", "source_url", "converted_at"}
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
