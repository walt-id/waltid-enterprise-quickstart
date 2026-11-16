{{/*
Expand the name of the chart.
*/}}
{{- define "enterprise-stack.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "enterprise-stack.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "enterprise-stack.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "enterprise-stack.labels" -}}
helm.sh/chart: {{ include "enterprise-stack.chart" . }}
{{ include "enterprise-stack.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "enterprise-stack.selectorLabels" -}}
app.kubernetes.io/name: {{ include "enterprise-stack.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "enterprise-stack.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "enterprise-stack.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* One image identity and configuration source for the API and license bootstrap. */}}
{{- define "enterprise-stack.apiImage" -}}
{{- if .Values.api.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" .Values.api.image.digest) -}}
{{- fail "api.image.digest must be a sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" .Values.api.image.repository .Values.api.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.api.image.repository (.Values.api.image.tag | default .Chart.AppVersion) -}}
{{- end -}}
{{- end -}}

{{- define "enterprise-stack.configVolume" -}}
{{- if .Values.api.existingConfigSecret }}
secret:
  secretName: {{ .Values.api.existingConfigSecret | quote }}
{{- else }}
configMap:
  name: {{ include "enterprise-stack.fullname" . }}-api-config
{{- end }}
{{- end -}}
