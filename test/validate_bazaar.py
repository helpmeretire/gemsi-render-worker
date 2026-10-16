import json, sys
from jsonschema import Draft202012Validator
b = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(b["schema"])
Draft202012Validator(b["schema"]).validate(b["info"])
assert b["info"]["input"]["method"] == "GET" and b["info"]["input"]["queryParams"]["address"].startswith("0x")
ex = b["info"]["output"]["example"]
assert ex["address_type"] == "evm" and ex["chains_ok"] == 1
bal = ex["balances"]["base"]
assert bal["ok"] is True and bal["chain_id"] == 8453 and bal["native"]["wei"].isdigit() and bal["usdc"]["raw"].isdigit()
assert isinstance(bal["tx_count"], int) and bal["usdc"]["contract"].lower() == "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
print("PASS bazaar info validates against its JSON schema (draft 2020-12)")
