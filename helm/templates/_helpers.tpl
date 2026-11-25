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

{{/*
Image reference for every container, built only from values.yaml as <registry>/<repository>:<tag>, so
AWS Marketplace can regionalize it by rewriting registry. An empty tag falls back to the chart's
appVersion; a digest, when set, takes precedence over the tag.

  {{ include "enterprise-stack.image" (dict "image" .Values.api.image "path" "api.image" "root" .) }}
*/}}
{{- define "enterprise-stack.image" -}}
{{- $image := .image -}}
{{- if $image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $image.digest) -}}
{{- fail (printf "%s.digest must be a sha256 digest" .path) -}}
{{- end -}}
{{- printf "%s/%s@%s" $image.registry $image.repository $image.digest -}}
{{- else -}}
{{- printf "%s/%s:%s" $image.registry $image.repository ($image.tag | default .root.Chart.AppVersion) -}}
{{- end -}}
{{- end -}}

{{/*
/config for the API and the license-request Job: either one operator-provided Secret holding every
file, or the rendered ConfigMap plus the sensitive files from sensitiveConfig.secretName.
*/}}
{{- define "enterprise-stack.configVolume" -}}
{{- if .Values.api.existingConfigSecret }}
secret:
  secretName: {{ .Values.api.existingConfigSecret | quote }}
{{- else }}
projected:
  sources:
    - configMap:
        name: {{ include "enterprise-stack.fullname" . }}-api-config
    {{- with .Values.sensitiveConfig.files }}
    - secret:
        name: {{ required "sensitiveConfig.secretName is required" $.Values.sensitiveConfig.secretName | quote }}
        items:
          {{- range . }}
          - key: {{ . | quote }}
            path: {{ . | quote }}
          {{- end }}
    {{- end }}
{{- end }}
{{- end -}}
