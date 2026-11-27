# grad-sdk (Python)

Thin, zero-dependency Python SDK wrapping the OpenAPI-generated wire client for `grad-server`.

```python
from grad import Grad, SFTRecipe

client = Grad(base_url="http://127.0.0.1:8080")
client.datasets.push("support", [
    {"messages": [{"role": "user", "content": "Reset password?"}, {"role": "assistant", "content": "Settings -> Reset."}]}
])
plan = client.runs.plan("support", name="support-sft", recipe=SFTRecipe(model="qwen/qwen3-8b"))
run = client.runs.create("support", name="support-sft", recipe=SFTRecipe(model="qwen/qwen3-8b"), max_cost_usd=5.0)
```
