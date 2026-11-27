{{- define "grad.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "grad.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "grad.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "grad.labels" -}}
app.kubernetes.io/name: {{ include "grad.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "grad.apiServiceAccount" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (printf "%s-api" (include "grad.fullname" .)) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "grad.workerServiceAccount" -}}
{{- if .Values.workerServiceAccount.create -}}
{{- default (printf "%s-worker" (include "grad.fullname" .)) .Values.workerServiceAccount.name -}}
{{- else -}}
{{- default "default" .Values.workerServiceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* How workers authenticate: kubernetes (service-account tokens) or static (per-pool keys). */}}
{{- define "grad.workerAuth" -}}
{{- .Values.workers.auth | default "kubernetes" -}}
{{- end -}}

{{/* A pool's ServiceAccount in workers.auth=kubernetes: (list ctx poolName) */}}
{{- define "grad.poolServiceAccount" -}}
{{- $ctx := index . 0 -}}
{{- printf "%s-%s-worker" $ctx.Release.Name (index . 1) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* GRAD_WORKER_K8S_SERVICE_ACCOUNTS: each enabled pool's ServiceAccount -> its kinds. */}}
{{- define "grad.workerServiceAccountsJson" -}}
{{- $map := dict -}}
{{- range $name, $w := omit .Values.workers "auth" -}}
{{- if $w.enabled -}}
{{- $_ := set $map (printf "%s/%s" $.Release.Namespace (include "grad.poolServiceAccount" (list $ $name))) $w.kinds -}}
{{- end -}}
{{- end -}}
{{- toJson $map -}}
{{- end -}}

{{/* The PriorityClass of low-priority (training) pools. */}}
{{- define "grad.trainingPriorityClass" -}}
{{- .Values.trainingPriorityClass.name | default (printf "%s-training-low" .Release.Name) -}}
{{- end -}}

{{/* The Secret every pod reads: the chart's own (secrets.create) or secrets.existingSecret. */}}
{{- define "grad.secretName" -}}
{{- if .Values.secrets.create -}}
{{- include "grad.fullname" . -}}
{{- else -}}
{{- .Values.secrets.existingSecret -}}
{{- end -}}
{{- end -}}

{{/* The Secret key holding a worker pool's API key: (list ctx poolName pool) */}}
{{- define "grad.workerKeyName" -}}
{{- $ctx := index . 0 -}}
{{- $w := index . 2 -}}
{{- if $w.apiKeySecretKey -}}
{{- $w.apiKeySecretKey -}}
{{- else if $ctx.Values.secrets.create -}}
{{- printf "worker-%s-api-key" (index . 1) -}}
{{- else -}}
{{- $ctx.Values.workerDefaults.apiKeySecretKey -}}
{{- end -}}
{{- end -}}

{{/* An env var from the chart Secret: (list ctx NAME key optional) */}}
{{- define "grad.secretEnv" -}}
{{- $ctx := index . 0 -}}
- name: {{ index . 1 }}
  valueFrom:
    secretKeyRef:
      name: {{ include "grad.secretName" $ctx }}
      key: {{ index . 2 }}
      {{- if index . 3 }}
      optional: true
      {{- end }}
{{- end -}}

{{/* Pod security shared by every grad pod: (list uid) */}}
{{- define "grad.podSecurity" -}}
runAsNonRoot: true
runAsUser: {{ index . 0 }}
runAsGroup: {{ index . 0 }}
fsGroup: {{ index . 0 }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "grad.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* Fails the render on values that cannot work. */}}
{{- define "grad.validate" -}}
{{- if not .Values.storage.s3Bucket -}}
{{- fail "storage.s3Bucket is required: grad-server replicas and workers share artifacts through S3-compatible storage (set storage.s3Endpoint for SeaweedFS, MinIO or R2)." -}}
{{- end -}}
{{- if and (not .Values.secrets.create) (not .Values.secrets.existingSecret) -}}
{{- fail "secrets.existingSecret is required with secrets.create=false: a Secret with at least a database-url key." -}}
{{- end -}}
{{- /* Keys from older docs and chart versions: refuse them instead of ignoring them. */ -}}
{{- $moved := dict "secret" "secrets.existingSecret (with secrets.create=false)" "database" "secrets.databaseUrl, or secrets.existingSecret" "auth" "secrets.adminApiKeyHash, or secrets.existingSecret" "trainer" "workers.train (gpuCount, nodeSelector, tolerations) and workerDefaults.image" "judge" "evals.judgeBaseUrl" -}}
{{- range $key, $instead := $moved -}}
{{- if hasKey $.Values $key -}}
{{- fail (printf "values key '%s' is not part of this chart; use %s." $key $instead) -}}
{{- end -}}
{{- end -}}
{{- if not (has (include "grad.workerAuth" .) (list "kubernetes" "static")) -}}
{{- fail (printf "workers.auth: %q is not kubernetes or static" .Values.workers.auth) -}}
{{- end -}}
{{- if hasKey .Values.api "deployMode" -}}
{{- fail "values key 'api.deployMode' is not part of this chart: self-hosted servers never deploy (deployments are served by Gradiated Cloud)." -}}
{{- end -}}
{{- if hasKey .Values.models "mirrorUri" -}}
{{- fail "values key 'models.mirrorUri' is not part of this chart; use models.mirror." -}}
{{- end -}}
{{- if or (hasKey .Values.keda "minReplicaCount") (hasKey .Values.keda "maxReplicaCount") -}}
{{- fail "values keys 'keda.minReplicaCount'/'keda.maxReplicaCount' are not part of this chart; use keda.workers.<pool>.minReplicaCount/maxReplicaCount (pools: train, import)." -}}
{{- end -}}
{{- if .Values.keda.enabled -}}
{{- if not (has .Values.keda.trigger (list "prometheus" "metrics-api")) -}}
{{- fail (printf "keda.trigger: %q is not prometheus or metrics-api" .Values.keda.trigger) -}}
{{- end -}}
{{- if not .Values.metrics.enabled -}}
{{- fail "keda.enabled needs metrics.enabled: KEDA reads the queue depth grad-server exports." -}}
{{- end -}}
{{- if and (eq .Values.keda.trigger "prometheus") (not .Values.keda.prometheus.serverAddress) -}}
{{- fail "keda.trigger=prometheus needs keda.prometheus.serverAddress (or set keda.trigger=metrics-api to poll grad-server directly)." -}}
{{- end -}}
{{- end -}}
{{- if and (or .Values.metrics.serviceMonitor.enabled .Values.metrics.prometheusRule.enabled) (not .Values.metrics.enabled) -}}
{{- fail "metrics.serviceMonitor and metrics.prometheusRule need metrics.enabled." -}}
{{- end -}}
{{- range $name, $w := omit .Values.workers "auth" -}}
{{- if $w.enabled -}}
{{- range $w.kinds -}}
{{- if not (has . (list "train" "import" "eval")) -}}
{{- fail (printf "workers.%s.kinds: %q is not a job kind (train, import, eval)" $name .) -}}
{{- end -}}
{{- end -}}
{{- if and (has "eval" $w.kinds) (gt (int $w.gpuCount) 0) -}}
{{- fail (printf "workers.%s: eval jobs run on CPU workers (they only call the inference endpoint); move kind eval to a pool with gpuCount 0, such as import." $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* KEDA prometheus trigger: open (claimable or leased) jobs of a pool's kinds,
     (list ctx kinds). Imports include source syncs (metric kind `sync`). Every
     API replica reports the same numbers, hence max over pods. */}}
{{- define "grad.openJobsPromQL" -}}
{{- $ctx := index . 0 -}}
{{- $kinds := list -}}
{{- range (index . 1) }}{{ $kinds = append $kinds . }}{{ if eq . "import" }}{{ $kinds = append $kinds "sync" }}{{ end }}{{ end -}}
max(sum by (pod) (grad_jobs_open{ {{- include "grad.metricsSelector" $ctx }}, kind=~"{{ join "|" $kinds }}"})) or vector(0)
{{- end -}}

{{/* PromQL label matchers for this release's grad-server series (as a ServiceMonitor scrapes them). */}}
{{- define "grad.metricsSelector" -}}
{{- .Values.keda.prometheus.selector | default (printf "namespace=%q, service=%q" .Release.Namespace (printf "%s-api" (include "grad.fullname" .))) -}}
{{- end -}}

{{/* KEDA metrics-api trigger: grad-server's queue depth for a pool's kinds, (list ctx kinds). */}}
{{- define "grad.queueDepthUrl" -}}
{{- $ctx := index . 0 -}}
http://{{ include "grad.fullname" $ctx }}-api.{{ $ctx.Release.Namespace }}.svc:{{ $ctx.Values.metrics.port }}/metrics/queue?kinds={{ join "," (index . 1) }}
{{- end -}}
