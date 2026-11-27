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
{{- end -}}
