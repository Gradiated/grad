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

{{/* An env var from the chart Secret: (list ctx NAME key optional) */}}
{{- define "grad.secretEnv" -}}
{{- $ctx := index . 0 -}}
- name: {{ index . 1 }}
  valueFrom:
    secretKeyRef:
      name: {{ $ctx.Values.secret.name }}
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
{{- fail "storage.s3Bucket is required: grad-server replicas and workers share artifacts through S3-compatible storage (set storage.s3Endpoint for MinIO or R2)." -}}
{{- end -}}
{{- if not .Values.secret.name -}}
{{- fail "secret.name is required: a Secret with at least a database-url key." -}}
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
{{- range $name, $w := .Values.workers -}}
{{- if $w.enabled -}}
{{- range $w.kinds -}}
{{- if not (has . (list "train" "import")) -}}
{{- fail (printf "workers.%s.kinds: %q is not a job kind (train, import)" $name .) -}}
{{- end -}}
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
