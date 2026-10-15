import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
inp = b["info"]["input"]
assert inp["method"] == "POST" and inp["bodyType"] == "json"
msgs = inp["body"]["messages"]
assert isinstance(msgs, list) and len(msgs) >= 1 and all(m["role"] in ("system", "user", "assistant") and isinstance(m["content"], str) and m["content"] for m in msgs)
assert inp["body"]["model"] == "llama-3.3-70b"
out = b["info"]["output"]["example"]
assert out["object"] == "chat.completion" and out["id"].startswith("chatcmpl-")
assert out["choices"][0]["message"]["role"] == "assistant" and out["choices"][0]["message"]["content"] and out["choices"][0]["finish_reason"] == "stop"
assert out["usage"]["total_tokens"] == out["usage"]["prompt_tokens"] + out["usage"]["completion_tokens"] > 0
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
