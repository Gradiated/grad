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

{{/* KEDA: open (queued or leased) jobs of the given quoted, comma-separated kinds. */}}
{{- define "grad.openJobsQuery" -}}
SELECT (SELECT COUNT(*) FROM grad_runs WHERE 'train' IN ({{ . }}) AND ((status = 'queued' AND waiting_on IS NULL) OR worker_id IS NOT NULL)) + (SELECT COUNT(*) FROM grad_import_jobs WHERE 'import' IN ({{ . }}) AND (status = 'queued' OR worker_id IS NOT NULL))
{{- end -}}
