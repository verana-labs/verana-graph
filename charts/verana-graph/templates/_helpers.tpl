{{/*
Expand the name of the chart.
*/}}
{{- define "verana-graph.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "verana-graph.fullname" -}}
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
Common labels
*/}}
{{- define "verana-graph.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "verana-graph.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "verana-graph.selectorLabels" -}}
app.kubernetes.io/name: {{ include "verana-graph.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Database host: the embedded Postgres is a sidecar in the same pod, so the app reaches it on
localhost; otherwise the external host the operator points us at.
*/}}
{{- define "verana-graph.databaseHost" -}}
{{- if .Values.database.enabled -}}
localhost
{{- else -}}
{{- required "database.host is required when database.enabled is false" .Values.database.host -}}
{{- end -}}
{{- end }}

{{/*
POSTGRES_PASSWORD env entry, shared by the app and the embedded Postgres. The password always
comes from an existing Kubernetes Secret referenced by database.pwdSecret — never a plain-text
value in the manifest.
*/}}
{{- define "verana-graph.postgresPasswordEnv" -}}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ required "database.pwdSecret.name is required: the DB password must come from a Secret" .Values.database.pwdSecret.name }}
      key: {{ required "database.pwdSecret.key is required: the DB password must come from a Secret" .Values.database.pwdSecret.key }}
{{- end }}
