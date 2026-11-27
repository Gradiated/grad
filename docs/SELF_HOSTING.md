# Self-Hosting Guide

## Local Development (`grad local up`)

Start PostgreSQL, `grad-server`, and a CPU `grad-trainer` worker locally:

```bash
grad local up
# Or with NVIDIA GPU acceleration:
grad local up --gpu
```

Point any SDK or CLI at `http://127.0.0.1:8080`:

```bash
export GRAD_BASE_URL=http://127.0.0.1:8080
grad models list
```

## Production Kubernetes (Helm)

Self-hosted deployments require only **PostgreSQL** and **S3-compatible object storage**.

1. Create the required secrets (`grad-postgres` with `database-url`, `grad-auth` with `admin-api-key-hash` and `trainer-api-key`):
   ```bash
   ADMIN_HASH=$(printf '%s' "$MY_ADMIN_KEY" | sha256sum | awk '{print $1}')
   kubectl create secret generic grad-postgres --from-literal=database-url="postgres://..."
   kubectl create secret generic grad-auth --from-literal=admin-api-key-hash="$ADMIN_HASH"
   ```
2. Install the chart:
   ```bash
   helm upgrade --install grad server/helm/grad \
     --namespace grad --create-namespace \
     --set storage.s3Bucket=my-grad-artifacts \
     --set api.authMode=api_key \
     --set api.deployMode=disabled
   ```
3. Optional air-gapped VPC & KEDA GPU scale-to-zero:
   ```bash
   helm upgrade --install grad server/helm/grad \
     --set keda.enabled=true \
     --set models.mirrorUri=s3://internal-mirror/models \
     --set judge.baseUrl=https://vllm.internal.example.com/v1
   ```
4. Serve trained artifacts on vLLM or SGLang by downloading the verified `.grad.tar.gz` archive:
   ```bash
   grad artifacts download support-sft@latest --out ./support-sft.grad.tar.gz
   ```
