// Code generated from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.

package generated

import "encoding/json"

// APIKey is generated from the OpenAPI schema.
type APIKey struct {
	ID          string        `json:"id"`
	WorkspaceID string        `json:"workspace_id"`
	Name        string        `json:"name"`
	Prefix      string        `json:"prefix"`
	Scopes      []APIKeyScope `json:"scopes"`
	CreatedAt   string        `json:"created_at"`
	RevokedAt   *string       `json:"revoked_at"`
}

// APIKeyScope `x:write` implies `x:read`; `admin` implies every workspace scope. `deployments:write`, `feedback:write` and `env:serve` are Gradiated Cloud scopes: grad-server accepts them on a key but none of its endpoints checks them.
type APIKeyScope string

// Values of APIKeyScope.
const (
	APIKeyScopeAdmin            APIKeyScope = "admin"
	APIKeyScopeDatasetsRead     APIKeyScope = "datasets:read"
	APIKeyScopeDatasetsWrite    APIKeyScope = "datasets:write"
	APIKeyScopeRunsRead         APIKeyScope = "runs:read"
	APIKeyScopeRunsWrite        APIKeyScope = "runs:write"
	APIKeyScopeArtifactsRead    APIKeyScope = "artifacts:read"
	APIKeyScopeArtifactsWrite   APIKeyScope = "artifacts:write"
	APIKeyScopeSecretsRead      APIKeyScope = "secrets:read"
	APIKeyScopeSecretsWrite     APIKeyScope = "secrets:write"
	APIKeyScopeSourcesRead      APIKeyScope = "sources:read"
	APIKeyScopeSourcesWrite     APIKeyScope = "sources:write"
	APIKeyScopeDeploymentsWrite APIKeyScope = "deployments:write"
	APIKeyScopeFeedbackWrite    APIKeyScope = "feedback:write"
	APIKeyScopeEnvServe         APIKeyScope = "env:serve"
)

// AdapterSpec is a union of object shapes; set the fields of exactly one variant.
type AdapterSpec struct {
	Kind          AdapterSpecKind `json:"kind"`
	Rank          *int            `json:"rank,omitempty"`
	Alpha         *int            `json:"alpha,omitempty"`
	MergeOnExport *bool           `json:"merge_on_export,omitempty"`
	NumTokens     *int            `json:"num_tokens,omitempty"`
}

// AdapterSpecKind is an enumeration of allowed values.
type AdapterSpecKind string

// Values of AdapterSpecKind.
const (
	AdapterSpecKindLora       AdapterSpecKind = "lora"
	AdapterSpecKindPrefixKv   AdapterSpecKind = "prefix_kv"
	AdapterSpecKindFrozenHead AdapterSpecKind = "frozen_head"
)

// Artifact is generated from the OpenAPI schema.
type Artifact struct {
	ID           string          `json:"id"`
	WorkspaceID  string          `json:"workspace_id"`
	Name         string          `json:"name"`
	Version      string          `json:"version"`
	RunID        *string         `json:"run_id"`
	CheckpointID *string         `json:"checkpoint_id"`
	BaseModel    string          `json:"base_model"`
	RecipeKind   RecipeKind      `json:"recipe_kind"`
	Format       *ArtifactFormat `json:"format"`
	SHA256       string          `json:"sha256"`
	SizeBytes    int             `json:"size_bytes"`
	Manifest     map[string]any  `json:"manifest"`
	EvalReport   *EvalReport     `json:"eval_report"`
	CreatedAt    string          `json:"created_at"`
}

// ArtifactFormat Artifact format when this checkpoint is exportable (promotable); null for training state only.
type ArtifactFormat string

// Values of ArtifactFormat.
const (
	ArtifactFormatPeftLora           ArtifactFormat = "peft_lora"
	ArtifactFormatMergedSafetensors  ArtifactFormat = "merged_safetensors"
	ArtifactFormatPrefixKv           ArtifactFormat = "prefix_kv"
	ArtifactFormatCartridge          ArtifactFormat = "cartridge"
	ArtifactFormatEncoderSafetensors ArtifactFormat = "encoder_safetensors"
	ArtifactFormatRouterBundle       ArtifactFormat = "router_bundle"
	ArtifactFormatDecisionBundle     ArtifactFormat = "decision_bundle"
	ArtifactFormatRewardBundle       ArtifactFormat = "reward_bundle"
	ArtifactFormatReference          ArtifactFormat = "reference"
)

// AttemptEvent is generated from the OpenAPI schema.
type AttemptEvent struct {
	Type  AttemptEventType `json:"type"`
	RunID string           `json:"run_id"`
	// Seq Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq.
	Seq       int    `json:"seq"`
	Attempt   int    `json:"attempt"`
	Timestamp string `json:"timestamp"`
	// Event started: a worker claimed attempt N (resume_step: the checkpoint it resumes from). interrupted: attempt N ended without a result at `step` (resume_step: where the next attempt resumes). gave_up: no attempts left; the run failed.
	Event  AttemptEventEvent   `json:"event"`
	Reason *InterruptionReason `json:"reason"`
	Step   *int                `json:"step"`
	// ResumeStep Checkpoint step to resume from; null starts from scratch.
	ResumeStep  *int   `json:"resume_step"`
	MaxAttempts int    `json:"max_attempts"`
	Message     string `json:"message"`
}

// AttemptEventEvent started: a worker claimed attempt N (resume_step: the checkpoint it resumes from). interrupted: attempt N ended without a result at `step` (resume_step: where the next attempt resumes). gave_up: no attempts left; the run failed.
type AttemptEventEvent string

// Values of AttemptEventEvent.
const (
	AttemptEventEventStarted     AttemptEventEvent = "started"
	AttemptEventEventInterrupted AttemptEventEvent = "interrupted"
	AttemptEventEventGaveUp      AttemptEventEvent = "gave_up"
)

// AttemptEventType is an enumeration of allowed values.
type AttemptEventType string

// Values of AttemptEventType.
const (
	AttemptEventTypeAttempt AttemptEventType = "attempt"
)

// BaseArtifact Continued training: the artifact whose adapter the run starts from (recipe.model was an artifact reference).
type BaseArtifact struct {
	ID         string             `json:"id"`
	RecipeKind RecipeKind         `json:"recipe_kind"`
	Format     BaseArtifactFormat `json:"format"`
	SHA256     string             `json:"sha256"`
}

// BaseArtifactFormat is an enumeration of allowed values.
type BaseArtifactFormat string

// Values of BaseArtifactFormat.
const (
	BaseArtifactFormatPeftLora BaseArtifactFormat = "peft_lora"
)

// ChatMessage is generated from the OpenAPI schema.
type ChatMessage struct {
	Role       ChatMessageRole  `json:"role"`
	Content    any              `json:"content,omitempty"`
	ToolCalls  []map[string]any `json:"tool_calls,omitempty"`
	ToolCallID *string          `json:"tool_call_id,omitempty"`
	Name       *string          `json:"name,omitempty"`
	Train      *bool            `json:"train,omitempty"`
	// AdditionalProperties holds members not declared in the schema (round-tripped verbatim).
	AdditionalProperties map[string]any `json:"-"`
}

var knownChatMessageFields = map[string]bool{
	"role":         true,
	"content":      true,
	"tool_calls":   true,
	"tool_call_id": true,
	"name":         true,
	"train":        true,
}

// MarshalJSON encodes declared fields plus AdditionalProperties.
func (m ChatMessage) MarshalJSON() ([]byte, error) {
	type plain ChatMessage
	return MarshalWithAdditional(plain(m), m.AdditionalProperties)
}

// UnmarshalJSON decodes declared fields and keeps the rest in AdditionalProperties.
func (m *ChatMessage) UnmarshalJSON(data []byte) error {
	type plain ChatMessage
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	extra, err := AdditionalFields(data, knownChatMessageFields)
	if err != nil {
		return err
	}
	*m = ChatMessage(p)
	m.AdditionalProperties = extra
	return nil
}

// ChatMessageRole is an enumeration of allowed values.
type ChatMessageRole string

// Values of ChatMessageRole.
const (
	ChatMessageRoleSystem    ChatMessageRole = "system"
	ChatMessageRoleUser      ChatMessageRole = "user"
	ChatMessageRoleAssistant ChatMessageRole = "assistant"
	ChatMessageRoleTool      ChatMessageRole = "tool"
)

// Checkpoint is generated from the OpenAPI schema.
type Checkpoint struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspace_id"`
	RunID       string          `json:"run_id"`
	Attempt     int             `json:"attempt"`
	Step        int             `json:"step"`
	EvalScore   *float64        `json:"eval_score"`
	Format      *ArtifactFormat `json:"format"`
	SHA256      string          `json:"sha256"`
	SizeBytes   int             `json:"size_bytes"`
	Metadata    map[string]any  `json:"metadata"`
	Best        bool            `json:"best"`
	Final       bool            `json:"final"`
	ExpiresAt   *string         `json:"expires_at"`
	CreatedAt   string          `json:"created_at"`
}

// CheckpointEvalResult is generated from the OpenAPI schema.
type CheckpointEvalResult struct {
	Name           string                     `json:"name"`
	Step           int                        `json:"step"`
	CheckpointID   string                     `json:"checkpoint_id"`
	EvalID         *string                    `json:"eval_id"`
	Dataset        string                     `json:"dataset"`
	DatasetVersion int                        `json:"dataset_version"`
	Status         CheckpointEvalResultStatus `json:"status"`
	// Score The checkpoint's overall rubric score (null unless completed).
	Score   *float64 `json:"score"`
	CostUSD float64  `json:"cost_usd"`
	Error   *string  `json:"error"`
}

// CheckpointEvalResultStatus is an enumeration of allowed values.
type CheckpointEvalResultStatus string

// Values of CheckpointEvalResultStatus.
const (
	CheckpointEvalResultStatusCompleted CheckpointEvalResultStatus = "completed"
	CheckpointEvalResultStatusFailed    CheckpointEvalResultStatus = "failed"
	CheckpointEvalResultStatusCancelled CheckpointEvalResultStatus = "cancelled"
)

// CheckpointEvent is generated from the OpenAPI schema.
type CheckpointEvent struct {
	Type  CheckpointEventType `json:"type"`
	RunID string              `json:"run_id"`
	// Seq Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq.
	Seq          int             `json:"seq"`
	Attempt      int             `json:"attempt"`
	Timestamp    string          `json:"timestamp"`
	Step         int             `json:"step"`
	CheckpointID string          `json:"checkpoint_id"`
	EvalScore    *float64        `json:"eval_score"`
	Format       *ArtifactFormat `json:"format"`
}

// CheckpointEventType is an enumeration of allowed values.
type CheckpointEventType string

// Values of CheckpointEventType.
const (
	CheckpointEventTypeCheckpoint CheckpointEventType = "checkpoint"
)

// CompletedEvent is generated from the OpenAPI schema.
type CompletedEvent struct {
	Type  CompletedEventType `json:"type"`
	RunID string             `json:"run_id"`
	// Seq Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq.
	Seq       int       `json:"seq"`
	Attempt   int       `json:"attempt"`
	Timestamp string    `json:"timestamp"`
	Status    RunStatus `json:"status"`
	Run       Run       `json:"run"`
}

// CompletedEventType is an enumeration of allowed values.
type CompletedEventType string

// Values of CompletedEventType.
const (
	CompletedEventTypeCompleted CompletedEventType = "completed"
)

// CreateAPIKeyRequest is generated from the OpenAPI schema.
type CreateAPIKeyRequest struct {
	Name   string        `json:"name"`
	Scopes []APIKeyScope `json:"scopes"`
}

// CreateDatasetRequest is generated from the OpenAPI schema.
type CreateDatasetRequest struct {
	Name     string         `json:"name"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// CreateImportRequest is generated from the OpenAPI schema.
type CreateImportRequest struct {
	Source    ImportSource                  `json:"source"`
	Connector *CreateImportRequestConnector `json:"connector,omitempty"`
}

// CreateImportRequestConnector is an enumeration of allowed values.
type CreateImportRequestConnector string

// Values of CreateImportRequestConnector.
const (
	CreateImportRequestConnectorAuto             CreateImportRequestConnector = "auto"
	CreateImportRequestConnectorGradTrajectories CreateImportRequestConnector = "grad_trajectories"
	CreateImportRequestConnectorOpenaiChat       CreateImportRequestConnector = "openai_chat"
	CreateImportRequestConnectorGradiated        CreateImportRequestConnector = "gradiated"
	CreateImportRequestConnectorOTEL             CreateImportRequestConnector = "otel"
	CreateImportRequestConnectorLangfuse         CreateImportRequestConnector = "langfuse"
	CreateImportRequestConnectorPosthog          CreateImportRequestConnector = "posthog"
	CreateImportRequestConnectorBraintrust       CreateImportRequestConnector = "braintrust"
	CreateImportRequestConnectorLangsmith        CreateImportRequestConnector = "langsmith"
)

// CreateSourceRequest is generated from the OpenAPI schema.
type CreateSourceRequest struct {
	Provider SourceProvider `json:"provider"`
	// Schedule Five-field cron in UTC (`*/15 * * * *`); minute resolution, so it fires at most once a minute (a seconds field is rejected). Leave it out to sync only on request.
	Schedule *string `json:"schedule,omitempty"`
	// SampleRate The share of traces to sync, chosen by a hash of the trace id: re-syncs keep the same sample, and a trace's feedback follows it. Default 1.
	SampleRate *float64 `json:"sample_rate,omitempty"`
	// MaxRecordsPerSync At most this many new traces per sync; the rest are not synced (the sync's drop reasons count them). Feedback on traces already synced always lands. Null: no cap.
	MaxRecordsPerSync *int `json:"max_records_per_sync,omitempty"`
	// MaxRecordsPerDay At most this many new traces per UTC day; the rest are not synced (the sync's drop reasons count them). Feedback on traces already synced always lands. Null: no cap.
	MaxRecordsPerDay *int `json:"max_records_per_day,omitempty"`
	// VersionInterval Seconds between the dataset versions scheduled syncs commit (default 900). A scheduled sync may fetch every minute; its parts wait, staged, until the interval has passed or enough records are waiting, so a busy source doesn't add a version a minute. 0: every sync commits. Manual and full syncs always commit.
	VersionInterval *int `json:"version_interval,omitempty"`
}

// CreateUploadRequest is generated from the OpenAPI schema.
type CreateUploadRequest struct {
	Purpose   CreateUploadRequestPurpose `json:"purpose"`
	Filename  string                     `json:"filename"`
	SizeBytes int                        `json:"size_bytes"`
	SHA256    string                     `json:"sha256"`
}

// CreateUploadRequestPurpose is an enumeration of allowed values.
type CreateUploadRequestPurpose string

// Values of CreateUploadRequestPurpose.
const (
	CreateUploadRequestPurposeDatasetImport CreateUploadRequestPurpose = "dataset_import"
)

// CreatedAPIKey is generated from the OpenAPI schema.
type CreatedAPIKey struct {
	Key    APIKey `json:"key"`
	Secret string `json:"secret"`
}

// Dataset is generated from the OpenAPI schema.
type Dataset struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Name        string `json:"name"`
	Version     int    `json:"version"`
	// RecordCount Records in the current version after merging: score updates fold into their records, and a full source sync restarts the count. A record pushed again with an id it already has counts again.
	RecordCount int            `json:"record_count"`
	Metadata    map[string]any `json:"metadata"`
	CreatedAt   string         `json:"created_at"`
	UpdatedAt   string         `json:"updated_at"`
}

// DatasetRecord is generated from the OpenAPI schema.
type DatasetRecord struct {
	Schema         *DatasetRecordSchema `json:"schema,omitempty"`
	ID             *string              `json:"id,omitempty"`
	SessionID      *string              `json:"session_id,omitempty"`
	GroupID        *string              `json:"group_id,omitempty"`
	Role           *DatasetRecordRole   `json:"role,omitempty"`
	Source         *string              `json:"source,omitempty"`
	Timestamp      *string              `json:"timestamp,omitempty"`
	Messages       []ChatMessage        `json:"messages,omitempty"`
	Tools          []map[string]any     `json:"tools,omitempty"`
	Input          *TrajectoryInput     `json:"input,omitempty"`
	Output         *TrajectoryOutput    `json:"output,omitempty"`
	Prompt         any                  `json:"prompt,omitempty"`
	Completion     any                  `json:"completion,omitempty"`
	Chosen         any                  `json:"chosen,omitempty"`
	Rejected       any                  `json:"rejected,omitempty"`
	Query          *string              `json:"query,omitempty"`
	Positive       *string              `json:"positive,omitempty"`
	Negatives      []string             `json:"negatives,omitempty"`
	State          any                  `json:"state,omitempty"`
	Questions      map[string]any       `json:"questions,omitempty"`
	ExpectedOutput any                  `json:"expected_output,omitempty"`
	Scores         map[string]float64   `json:"scores,omitempty"`
	Metrics        map[string]float64   `json:"metrics,omitempty"`
	Metadata       map[string]any       `json:"metadata,omitempty"`
}

// DatasetRecordRole is an enumeration of allowed values.
type DatasetRecordRole string

// Values of DatasetRecordRole.
const (
	DatasetRecordRoleChosen      DatasetRecordRole = "chosen"
	DatasetRecordRoleRejected    DatasetRecordRole = "rejected"
	DatasetRecordRoleAnchor      DatasetRecordRole = "anchor"
	DatasetRecordRolePositive    DatasetRecordRole = "positive"
	DatasetRecordRoleNegative    DatasetRecordRole = "negative"
	DatasetRecordRoleDesirable   DatasetRecordRole = "desirable"
	DatasetRecordRoleUndesirable DatasetRecordRole = "undesirable"
	DatasetRecordRoleRollout     DatasetRecordRole = "rollout"
)

// DatasetRecordSchema is an enumeration of allowed values.
type DatasetRecordSchema string

// Values of DatasetRecordSchema.
const (
	DatasetRecordSchemaGradTrajectory1 DatasetRecordSchema = "grad.trajectory/1"
)

// DatasetRecordsPage is generated from the OpenAPI schema.
type DatasetRecordsPage struct {
	Dataset string          `json:"dataset"`
	Version int             `json:"version"`
	Total   int             `json:"total"`
	Data    []DatasetRecord `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// DecisionHeadReport is generated from the OpenAPI schema.
type DecisionHeadReport struct {
	Type        DecisionHeadReportType `json:"type"`
	Examples    int                    `json:"examples"`
	Accuracy    *float64               `json:"accuracy"`
	Ece         *float64               `json:"ece"`
	Temperature float64                `json:"temperature"`
	// Brier Written by: noul heads.
	Brier *float64 `json:"brier,omitempty"`
	// Mae Written by: score heads.
	Mae             *float64                                    `json:"mae,omitempty"`
	MacroF1         *float64                                    `json:"macro_f1,omitempty"`
	PerOption       map[string]DecisionHeadReportPerOptionValue `json:"per_option,omitempty"`
	ConfusionMatrix *DecisionHeadReportConfusionMatrix          `json:"confusion_matrix,omitempty"`
	// AdditionalProperties holds members not declared in the schema (round-tripped verbatim).
	AdditionalProperties map[string]any `json:"-"`
}

var knownDecisionHeadReportFields = map[string]bool{
	"type":             true,
	"examples":         true,
	"accuracy":         true,
	"ece":              true,
	"temperature":      true,
	"brier":            true,
	"mae":              true,
	"macro_f1":         true,
	"per_option":       true,
	"confusion_matrix": true,
}

// MarshalJSON encodes declared fields plus AdditionalProperties.
func (m DecisionHeadReport) MarshalJSON() ([]byte, error) {
	type plain DecisionHeadReport
	return MarshalWithAdditional(plain(m), m.AdditionalProperties)
}

// UnmarshalJSON decodes declared fields and keeps the rest in AdditionalProperties.
func (m *DecisionHeadReport) UnmarshalJSON(data []byte) error {
	type plain DecisionHeadReport
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	extra, err := AdditionalFields(data, knownDecisionHeadReportFields)
	if err != nil {
		return err
	}
	*m = DecisionHeadReport(p)
	m.AdditionalProperties = extra
	return nil
}

// DecisionHeadReportConfusionMatrix is generated from the OpenAPI schema.
type DecisionHeadReportConfusionMatrix struct {
	Labels []string `json:"labels"`
	Matrix [][]int  `json:"matrix"`
}

// DecisionHeadReportPerOptionValue is generated from the OpenAPI schema.
type DecisionHeadReportPerOptionValue struct {
	Precision *float64 `json:"precision"`
	Recall    *float64 `json:"recall"`
	F1        *float64 `json:"f1"`
	Support   int      `json:"support"`
}

// DecisionHeadReportType is an enumeration of allowed values.
type DecisionHeadReportType string

// Values of DecisionHeadReportType.
const (
	DecisionHeadReportTypeChoice DecisionHeadReportType = "choice"
	DecisionHeadReportTypeNoul   DecisionHeadReportType = "noul"
	DecisionHeadReportTypeScore  DecisionHeadReportType = "score"
)

// DeployArtifactRequest is generated from the OpenAPI schema.
type DeployArtifactRequest struct {
	Artifact    string   `json:"artifact"`
	Name        *string  `json:"name,omitempty"`
	Fallback    *string  `json:"fallback,omitempty"`
	ExploreRate *float64 `json:"explore_rate,omitempty"`
}

// Deployment is generated from the OpenAPI schema.
type Deployment struct {
	ID                 string               `json:"id"`
	WorkspaceID        string               `json:"workspace_id"`
	Name               string               `json:"name"`
	ModelID            string               `json:"model_id"`
	ActiveArtifactID   string               `json:"active_artifact_id"`
	PreviousArtifactID *string              `json:"previous_artifact_id"`
	FallbackModel      *string              `json:"fallback_model"`
	ExploreRate        float64              `json:"explore_rate"`
	Status             DeploymentStatusType `json:"status"`
	CreatedAt          string               `json:"created_at"`
	UpdatedAt          string               `json:"updated_at"`
}

// DeploymentStatus is generated from the OpenAPI schema.
type DeploymentStatus struct {
	Deployment    Deployment `json:"deployment"`
	FeedbackCount int        `json:"feedback_count"`
	AverageScore  *float64   `json:"average_score"`
}

// DeploymentStatusType is an enumeration of allowed values.
type DeploymentStatusType string

// Values of DeploymentStatusType.
const (
	DeploymentStatusTypeActive   DeploymentStatusType = "active"
	DeploymentStatusTypeDisabled DeploymentStatusType = "disabled"
)

// EmbedRequest is generated from the OpenAPI schema.
type EmbedRequest struct {
	// Model Name of a deployed embedding artifact.
	Model string `json:"model"`
	Input any    `json:"input"`
}

// EmbedResponse is generated from the OpenAPI schema.
type EmbedResponse struct {
	Model string                  `json:"model"`
	Data  []EmbedResponseDataItem `json:"data"`
	Usage EmbedResponseUsage      `json:"usage"`
}

// EmbedResponseDataItem is generated from the OpenAPI schema.
type EmbedResponseDataItem struct {
	Index     int       `json:"index"`
	Embedding []float64 `json:"embedding"`
}

// EmbedResponseUsage is generated from the OpenAPI schema.
type EmbedResponseUsage struct {
	PromptTokens int `json:"prompt_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

// EvalMode `eval` generates outputs from `models`; `score` (`dataset.score()`) grades each record's own output (model `record`) and writes the scores to the dataset's next version.
type EvalMode string

// Values of EvalMode.
const (
	EvalModeEval  EvalMode = "eval"
	EvalModeScore EvalMode = "score"
)

// EvalModelSummary is generated from the OpenAPI schema.
type EvalModelSummary struct {
	Model             string                      `json:"model"`
	Overall           float64                     `json:"overall"`
	CILow             float64                     `json:"ci_low"`
	CIHigh            float64                     `json:"ci_high"`
	PassAtK           map[string]float64          `json:"pass_at_k"`
	VsBaseline        *EvalModelSummaryVsBaseline `json:"vs_baseline"`
	Tasks             int                         `json:"tasks"`
	Errors            int                         `json:"errors"`
	TokensPerTask     float64                     `json:"tokens_per_task"`
	CostPer1kTasksUSD *float64                    `json:"cost_per_1k_tasks_usd"`
}

// EvalModelSummaryVsBaseline is generated from the OpenAPI schema.
type EvalModelSummaryVsBaseline struct {
	Delta  float64 `json:"delta"`
	CILow  float64 `json:"ci_low"`
	CIHigh float64 `json:"ci_high"`
}

// EvalOutput is generated from the OpenAPI schema.
type EvalOutput struct {
	ID             string             `json:"id"`
	EvalID         string             `json:"eval_id"`
	TaskID         string             `json:"task_id"`
	Model          string             `json:"model"`
	SampleIndex    int                `json:"sample_index"`
	Input          []ChatMessage      `json:"input"`
	Output         *string            `json:"output"`
	ExpectedOutput any                `json:"expected_output,omitempty"`
	Record         DatasetRecord      `json:"record"`
	Scores         map[string]float64 `json:"scores"`
	Error          *string            `json:"error"`
	Usage          EvalOutputUsage    `json:"usage"`
}

// EvalOutputUsage is generated from the OpenAPI schema.
type EvalOutputUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

// EvalReport is generated from the OpenAPI schema.
type EvalReport struct {
	// MetricName Selection metric: eval_loss (sft, router, decision, off-policy distill, pointwise-only reward), preference_accuracy (dpo, reward), eval_kl (cartridge, on-policy distill), recall_at_10 (embedding).
	MetricName string `json:"metric_name"`
	// MetricMode Direction of metric_name: min (lower is better: eval_loss, eval_kl) or max (higher is better: preference_accuracy, recall_at_10). best_step and the pinned best checkpoint follow it.
	MetricMode   *EvalReportMetricMode `json:"metric_mode,omitempty"`
	SelectedStep int                   `json:"selected_step"`
	BestStep     *int                  `json:"best_step"`
	FinalStep    int                   `json:"final_step"`
	TrainRecords int                   `json:"train_records"`
	EvalRecords  int                   `json:"eval_records"`
	Warnings     []string              `json:"warnings"`
	// EvalLoss Written by: sft, dpo, router, decision, distill, reward.
	EvalLoss *float64 `json:"eval_loss,omitempty"`
	// EvalTokenAccuracy Written by: sft, distill.
	EvalTokenAccuracy *float64 `json:"eval_token_accuracy,omitempty"`
	// TrainedTokenFraction Written by: sft.
	TrainedTokenFraction *float64 `json:"trained_token_fraction,omitempty"`
	// TrainExamples Written by: sft, distill.
	TrainExamples *int `json:"train_examples,omitempty"`
	// EvalExamples Written by: sft, router, decision, distill.
	EvalExamples *int `json:"eval_examples,omitempty"`
	// SelectionExamples Written by: router, decision.
	SelectionExamples *int `json:"selection_examples,omitempty"`
	// Truncated Written by: sft, dpo.
	Truncated *int `json:"truncated,omitempty"`
	// PreferenceAccuracy Share of held-out pairs whose chosen answer outscores the rejected one. Written by: dpo, reward.
	PreferenceAccuracy *float64 `json:"preference_accuracy,omitempty"`
	// RewardMargin Written by: dpo, reward.
	RewardMargin *float64 `json:"reward_margin,omitempty"`
	// Beta Written by: dpo.
	Beta *float64 `json:"beta,omitempty"`
	// TrainPairs Written by: dpo, embedding, reward.
	TrainPairs *int `json:"train_pairs,omitempty"`
	// EvalPairs Written by: dpo, embedding, reward.
	EvalPairs *int `json:"eval_pairs,omitempty"`
	// DroppedRecords Written by: dpo, embedding, reward.
	DroppedRecords *int `json:"dropped_records,omitempty"`
	// TrainPoints Written by: reward (pointwise).
	TrainPoints *int `json:"train_points,omitempty"`
	// EvalPoints Written by: reward (pointwise).
	EvalPoints *int `json:"eval_points,omitempty"`
	// PointwiseBrier Mean squared error of sigmoid(reward) against the held-out scores. Written by: reward (pointwise).
	PointwiseBrier *float64 `json:"pointwise_brier,omitempty"`
	// EvalKL Written by: cartridge, distill.
	EvalKL *float64 `json:"eval_kl,omitempty"`
	// BaseKL Held-out KL of the untrained student to the teacher. Written by: distill (on-policy).
	BaseKL *float64 `json:"base_kl,omitempty"`
	// NoContextKL Written by: cartridge.
	NoContextKL *float64 `json:"no_context_kl,omitempty"`
	// KLReduction Written by: cartridge, distill.
	KLReduction *float64 `json:"kl_reduction,omitempty"`
	// NumTokens Written by: cartridge.
	NumTokens *int `json:"num_tokens,omitempty"`
	// Teacher Written by: cartridge, distill.
	Teacher *string `json:"teacher,omitempty"`
	// Rollout Written by: distill.
	Rollout *EvalReportRollout `json:"rollout,omitempty"`
	// Candidates Written by: router.
	Candidates []string `json:"candidates,omitempty"`
	// FallbackModel Written by: router.
	FallbackModel *string `json:"fallback_model,omitempty"`
	// FallbackQuality Written by: router.
	FallbackQuality *float64 `json:"fallback_quality,omitempty"`
	// RoutesAnyTraffic Written by: router.
	RoutesAnyTraffic *bool                `json:"routes_any_traffic,omitempty"`
	ParetoSummary    *RouterParetoSummary `json:"pareto_summary,omitempty"`
	// Ece Written by: decision.
	Ece *float64 `json:"ece,omitempty"`
	// Heads Written by: decision (one entry per question).
	Heads map[string]DecisionHeadReport `json:"heads,omitempty"`
	// RecallAt1 Written by: embedding.
	RecallAt1 *float64 `json:"recall_at_1,omitempty"`
	// RecallAt5 Written by: embedding.
	RecallAt5 *float64 `json:"recall_at_5,omitempty"`
	// RecallAt10 Written by: embedding.
	RecallAt10 *float64 `json:"recall_at_10,omitempty"`
	// Mrr Written by: embedding.
	Mrr *float64 `json:"mrr,omitempty"`
	// CorpusSize Written by: embedding.
	CorpusSize *int `json:"corpus_size,omitempty"`
	// Baseline Retrieval metrics of the untrained base encoder. Written by: embedding.
	Baseline *EvalReportBaseline `json:"baseline,omitempty"`
	// AdditionalProperties holds members not declared in the schema (round-tripped verbatim).
	AdditionalProperties map[string]any `json:"-"`
}

var knownEvalReportFields = map[string]bool{
	"metric_name":            true,
	"metric_mode":            true,
	"selected_step":          true,
	"best_step":              true,
	"final_step":             true,
	"train_records":          true,
	"eval_records":           true,
	"warnings":               true,
	"eval_loss":              true,
	"eval_token_accuracy":    true,
	"trained_token_fraction": true,
	"train_examples":         true,
	"eval_examples":          true,
	"selection_examples":     true,
	"truncated":              true,
	"preference_accuracy":    true,
	"reward_margin":          true,
	"beta":                   true,
	"train_pairs":            true,
	"eval_pairs":             true,
	"dropped_records":        true,
	"train_points":           true,
	"eval_points":            true,
	"pointwise_brier":        true,
	"eval_kl":                true,
	"base_kl":                true,
	"no_context_kl":          true,
	"kl_reduction":           true,
	"num_tokens":             true,
	"teacher":                true,
	"rollout":                true,
	"candidates":             true,
	"fallback_model":         true,
	"fallback_quality":       true,
	"routes_any_traffic":     true,
	"pareto_summary":         true,
	"ece":                    true,
	"heads":                  true,
	"recall_at_1":            true,
	"recall_at_5":            true,
	"recall_at_10":           true,
	"mrr":                    true,
	"corpus_size":            true,
	"baseline":               true,
}

// MarshalJSON encodes declared fields plus AdditionalProperties.
func (m EvalReport) MarshalJSON() ([]byte, error) {
	type plain EvalReport
	return MarshalWithAdditional(plain(m), m.AdditionalProperties)
}

// UnmarshalJSON decodes declared fields and keeps the rest in AdditionalProperties.
func (m *EvalReport) UnmarshalJSON(data []byte) error {
	type plain EvalReport
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	extra, err := AdditionalFields(data, knownEvalReportFields)
	if err != nil {
		return err
	}
	*m = EvalReport(p)
	m.AdditionalProperties = extra
	return nil
}

// EvalReportBaseline Retrieval metrics of the untrained base encoder. Written by: embedding.
type EvalReportBaseline struct {
	RecallAt1  *float64 `json:"recall_at_1"`
	RecallAt5  *float64 `json:"recall_at_5"`
	RecallAt10 *float64 `json:"recall_at_10"`
	Mrr        *float64 `json:"mrr"`
	// AdditionalProperties holds members not declared in the schema (round-tripped verbatim).
	AdditionalProperties map[string]any `json:"-"`
}

var knownEvalReportBaselineFields = map[string]bool{
	"recall_at_1":  true,
	"recall_at_5":  true,
	"recall_at_10": true,
	"mrr":          true,
}

// MarshalJSON encodes declared fields plus AdditionalProperties.
func (m EvalReportBaseline) MarshalJSON() ([]byte, error) {
	type plain EvalReportBaseline
	return MarshalWithAdditional(plain(m), m.AdditionalProperties)
}

// UnmarshalJSON decodes declared fields and keeps the rest in AdditionalProperties.
func (m *EvalReportBaseline) UnmarshalJSON(data []byte) error {
	type plain EvalReportBaseline
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	extra, err := AdditionalFields(data, knownEvalReportBaselineFields)
	if err != nil {
		return err
	}
	*m = EvalReportBaseline(p)
	m.AdditionalProperties = extra
	return nil
}

// EvalReportMetricMode Direction of metric_name: min (lower is better: eval_loss, eval_kl) or max (higher is better: preference_accuracy, recall_at_10). best_step and the pinned best checkpoint follow it.
type EvalReportMetricMode string

// Values of EvalReportMetricMode.
const (
	EvalReportMetricModeMin EvalReportMetricMode = "min"
	EvalReportMetricModeMax EvalReportMetricMode = "max"
)

// EvalReportRollout Written by: distill.
type EvalReportRollout string

// Values of EvalReportRollout.
const (
	EvalReportRolloutOnPolicy  EvalReportRollout = "on_policy"
	EvalReportRolloutOffPolicy EvalReportRollout = "off_policy"
)

// EvalRubricItem is generated from the OpenAPI schema.
type EvalRubricItem struct {
	Name      string                   `json:"name"`
	Kind      EvalRubricItemKind       `json:"kind"`
	Weight    *float64                 `json:"weight,omitempty"`
	Pattern   *string                  `json:"pattern,omitempty"`
	Flags     *string                  `json:"flags,omitempty"`
	Validator *EvalRubricItemValidator `json:"validator,omitempty"`
	Model     *string                  `json:"model,omitempty"`
	Prompt    *string                  `json:"prompt,omitempty"`
	// Runtime Code scorers always run in the SDK process (`local`); the eval waits in `awaiting_scores` until the SDK posts their scores.
	Runtime *EvalRubricItemRuntime `json:"runtime,omitempty"`
}

// EvalRubricItemKind is an enumeration of allowed values.
type EvalRubricItemKind string

// Values of EvalRubricItemKind.
const (
	EvalRubricItemKindRegex     EvalRubricItemKind = "regex"
	EvalRubricItemKindValidator EvalRubricItemKind = "validator"
	EvalRubricItemKindCode      EvalRubricItemKind = "code"
	EvalRubricItemKindJudge     EvalRubricItemKind = "judge"
)

// EvalRubricItemRuntime Code scorers always run in the SDK process (`local`); the eval waits in `awaiting_scores` until the SDK posts their scores.
type EvalRubricItemRuntime string

// Values of EvalRubricItemRuntime.
const (
	EvalRubricItemRuntimeLocal EvalRubricItemRuntime = "local"
)

// EvalRubricItemValidator is an enumeration of allowed values.
type EvalRubricItemValidator string

// Values of EvalRubricItemValidator.
const (
	EvalRubricItemValidatorJSON        EvalRubricItemValidator = "json"
	EvalRubricItemValidatorNonEmpty    EvalRubricItemValidator = "non_empty"
	EvalRubricItemValidatorExactMatch  EvalRubricItemValidator = "exact_match"
	EvalRubricItemValidatorFinalNumber EvalRubricItemValidator = "final_number"
	EvalRubricItemValidatorChoice      EvalRubricItemValidator = "choice"
)

// EvalRun is generated from the OpenAPI schema.
type EvalRun struct {
	ID            string             `json:"id"`
	WorkspaceID   string             `json:"workspace_id"`
	Name          string             `json:"name"`
	Status        EvalStatus         `json:"status"`
	Mode          EvalMode           `json:"mode"`
	Models        []string           `json:"models"`
	Baseline      *string            `json:"baseline"`
	TaskSource    EvalRunTaskSource  `json:"task_source"`
	Rubric        []EvalRubricItem   `json:"rubric"`
	Samples       int                `json:"samples"`
	Temperature   float64            `json:"temperature"`
	MaxTokens     int                `json:"max_tokens"`
	PassThreshold float64            `json:"pass_threshold"`
	JudgeModels   []string           `json:"judge_models"`
	LocalScorers  []string           `json:"local_scorers"`
	Progress      EvalRunProgress    `json:"progress"`
	Summary       []EvalModelSummary `json:"summary"`
	TotalCostUSD  float64            `json:"total_cost_usd"`
	// ScoredDatasetVersion Scoring jobs: the dataset version holding the new scores (the source version when every record was already scored); null until completed.
	ScoredDatasetVersion *int    `json:"scored_dataset_version"`
	Error                *string `json:"error"`
	CreatedAt            string  `json:"created_at"`
	UpdatedAt            string  `json:"updated_at"`
	CompletedAt          *string `json:"completed_at"`
}

// EvalRunProgress is generated from the OpenAPI schema.
type EvalRunProgress struct {
	TotalOutputs       int `json:"total_outputs"`
	Generated          int `json:"generated"`
	PendingLocalScores int `json:"pending_local_scores"`
}

// EvalRunTaskSource is generated from the OpenAPI schema.
type EvalRunTaskSource struct {
	Kind    EvalRunTaskSourceKind `json:"kind"`
	Dataset string                `json:"dataset"`
	Version int                   `json:"version"`
}

// EvalRunTaskSourceKind is an enumeration of allowed values.
type EvalRunTaskSourceKind string

// Values of EvalRunTaskSourceKind.
const (
	EvalRunTaskSourceKindDataset EvalRunTaskSourceKind = "dataset"
)

// EvalStatus is an enumeration of allowed values.
type EvalStatus string

// Values of EvalStatus.
const (
	EvalStatusQueued         EvalStatus = "queued"
	EvalStatusRunning        EvalStatus = "running"
	EvalStatusAwaitingScores EvalStatus = "awaiting_scores"
	EvalStatusCompleted      EvalStatus = "completed"
	EvalStatusFailed         EvalStatus = "failed"
	EvalStatusCancelled      EvalStatus = "cancelled"
)

// EvalTaskOutcome is generated from the OpenAPI schema.
type EvalTaskOutcome struct {
	TaskID       string        `json:"task_id"`
	Model        string        `json:"model"`
	Score        float64       `json:"score"`
	Passed       bool          `json:"passed"`
	SampleScores []float64     `json:"sample_scores"`
	JudgeModel   *string       `json:"judge_model"`
	Record       DatasetRecord `json:"record"`
}

// FeedbackEventInput is generated from the OpenAPI schema.
type FeedbackEventInput struct {
	InferenceID    *string            `json:"inference_id,omitempty"`
	SessionID      *string            `json:"session_id,omitempty"`
	DeploymentName *string            `json:"deployment_name,omitempty"`
	IdempotencyKey string             `json:"idempotency_key"`
	Score          *float64           `json:"score,omitempty"`
	ExpectedOutput any                `json:"expected_output,omitempty"`
	Metrics        map[string]float64 `json:"metrics,omitempty"`
}

// FeedbackRecord is generated from the OpenAPI schema.
type FeedbackRecord struct {
	ID             string             `json:"id"`
	WorkspaceID    string             `json:"workspace_id"`
	InferenceID    *string            `json:"inference_id"`
	SessionID      *string            `json:"session_id"`
	DeploymentName *string            `json:"deployment_name"`
	IdempotencyKey string             `json:"idempotency_key"`
	Score          *float64           `json:"score"`
	ExpectedOutput any                `json:"expected_output,omitempty"`
	Metrics        map[string]float64 `json:"metrics"`
	CreatedAt      string             `json:"created_at"`
}

// FilterDatasetRequest is generated from the OpenAPI schema.
type FilterDatasetRequest struct {
	// Scores Conditions on stored scores, `{name: "<op><number>"}` with op one of >=, <=, >, <, ==, != (a bare number means ==). A record without the score does not match.
	Scores map[string]any `json:"scores,omitempty"`
	// Metadata Exact matches on `metadata` fields.
	Metadata map[string]any `json:"metadata,omitempty"`
	// CreatedAfter Records whose `timestamp` is at or after this time (a timestamp with offset, or a UTC date `YYYY-MM-DD`).
	CreatedAfter any `json:"created_after,omitempty"`
	// CreatedBefore Records whose `timestamp` is before this time.
	CreatedBefore any `json:"created_before,omitempty"`
	// IDs Keep only these record ids (what the SDKs send for a filter function they ran locally).
	IDs []string `json:"ids,omitempty"`
	// Version Source version to filter (default: the current version).
	Version *int `json:"version,omitempty"`
	// Name Name of the view. Default: `<dataset>-f-<hash of source, version and filter>`, so the same filter returns the same view.
	Name *string `json:"name,omitempty"`
}

// GPUInfo starting: the claiming worker's GPU (null without one, e.g. the reference backend). Never the worker id or host.
type GPUInfo struct {
	Name     string  `json:"name"`
	MemoryGb float64 `json:"memory_gb"`
}

// GetUsageSummaryParams holds the query and header parameters of GetUsageSummary.
type GetUsageSummaryParams struct {
	// From Start of the period (inclusive): YYYY-MM-DD (UTC) or an ISO 8601 timestamp.
	From *string
	// To End of the period: a date YYYY-MM-DD covers that whole UTC day; a timestamp is exclusive.
	To      *string
	GroupBy *GetUsageSummaryParamsGroupBy
}

// GetUsageSummaryParamsGroupBy is an enumeration of allowed values.
type GetUsageSummaryParamsGroupBy string

// Values of GetUsageSummaryParamsGroupBy.
const (
	GetUsageSummaryParamsGroupByDay    GetUsageSummaryParamsGroupBy = "day"
	GetUsageSummaryParamsGroupByWeek   GetUsageSummaryParamsGroupBy = "week"
	GetUsageSummaryParamsGroupByMonth  GetUsageSummaryParamsGroupBy = "month"
	GetUsageSummaryParamsGroupByModel  GetUsageSummaryParamsGroupBy = "model"
	GetUsageSummaryParamsGroupByRecipe GetUsageSummaryParamsGroupBy = "recipe"
	GetUsageSummaryParamsGroupByKind   GetUsageSummaryParamsGroupBy = "kind"
)

// HFColumnMapping is generated from the OpenAPI schema.
type HFColumnMapping struct {
	Messages   *string `json:"messages,omitempty"`
	Prompt     *string `json:"prompt,omitempty"`
	Completion *string `json:"completion,omitempty"`
	Chosen     *string `json:"chosen,omitempty"`
	Rejected   *string `json:"rejected,omitempty"`
	Answer     *string `json:"answer,omitempty"`
	Query      *string `json:"query,omitempty"`
	Positive   *string `json:"positive,omitempty"`
}

// ImportJob is generated from the OpenAPI schema.
type ImportJob struct {
	ID          string             `json:"id"`
	WorkspaceID string             `json:"workspace_id"`
	Dataset     string             `json:"dataset"`
	Status      ImportStatus       `json:"status"`
	Source      map[string]any     `json:"source"`
	Connector   ImportJobConnector `json:"connector"`
	Attempt     int                `json:"attempt"`
	// ImportedCount Records this import added to the dataset (score updates for existing records add none).
	ImportedCount  int      `json:"imported_count"`
	DroppedCount   int      `json:"dropped_count"`
	DetectedScores []string `json:"detected_scores"`
	// DropReasons Why rows were dropped, one line per row (`line 12: invalid JSON`), capped at 100 entries.
	DropReasons    []string `json:"drop_reasons"`
	DatasetVersion *int     `json:"dataset_version"`
	Error          *string  `json:"error"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
}

// ImportJobConnector is an enumeration of allowed values.
type ImportJobConnector string

// Values of ImportJobConnector.
const (
	ImportJobConnectorAuto             ImportJobConnector = "auto"
	ImportJobConnectorGradTrajectories ImportJobConnector = "grad_trajectories"
	ImportJobConnectorOpenaiChat       ImportJobConnector = "openai_chat"
	ImportJobConnectorGradiated        ImportJobConnector = "gradiated"
	ImportJobConnectorOTEL             ImportJobConnector = "otel"
	ImportJobConnectorLangfuse         ImportJobConnector = "langfuse"
	ImportJobConnectorPosthog          ImportJobConnector = "posthog"
	ImportJobConnectorBraintrust       ImportJobConnector = "braintrust"
	ImportJobConnectorLangsmith        ImportJobConnector = "langsmith"
)

// ImportSource is a union of object shapes; set the fields of exactly one variant.
type ImportSource struct {
	Kind     ImportSourceKind    `json:"kind"`
	UploadID *string             `json:"upload_id,omitempty"`
	Format   *ImportSourceFormat `json:"format,omitempty"`
	Repo     *string             `json:"repo,omitempty"`
	Split    *string             `json:"split,omitempty"`
	Config   *string             `json:"config,omitempty"`
	Revision *string             `json:"revision,omitempty"`
	Columns  *HFColumnMapping    `json:"columns,omitempty"`
	Limit    *int                `json:"limit,omitempty"`
	// Secret Name of a workspace secret holding a Hugging Face token, for gated or private datasets. The worker receives the token at claim time.
	Secret    *string                `json:"secret,omitempty"`
	Benchmark *ImportSourceBenchmark `json:"benchmark,omitempty"`
}

// ImportSourceBenchmark is an enumeration of allowed values.
type ImportSourceBenchmark string

// Values of ImportSourceBenchmark.
const (
	ImportSourceBenchmarkGsm8k        ImportSourceBenchmark = "gsm8k"
	ImportSourceBenchmarkMmlu         ImportSourceBenchmark = "mmlu"
	ImportSourceBenchmarkMmluPro      ImportSourceBenchmark = "mmlu_pro"
	ImportSourceBenchmarkArcChallenge ImportSourceBenchmark = "arc_challenge"
)

// ImportSourceFormat is an enumeration of allowed values.
type ImportSourceFormat string

// Values of ImportSourceFormat.
const (
	ImportSourceFormatAuto    ImportSourceFormat = "auto"
	ImportSourceFormatJsonl   ImportSourceFormat = "jsonl"
	ImportSourceFormatJSON    ImportSourceFormat = "json"
	ImportSourceFormatParquet ImportSourceFormat = "parquet"
)

// ImportSourceKind is an enumeration of allowed values.
type ImportSourceKind string

// Values of ImportSourceKind.
const (
	ImportSourceKindUpload    ImportSourceKind = "upload"
	ImportSourceKindHF        ImportSourceKind = "hf"
	ImportSourceKindBenchmark ImportSourceKind = "benchmark"
)

// ImportStatus is an enumeration of allowed values.
type ImportStatus string

// Values of ImportStatus.
const (
	ImportStatusQueued    ImportStatus = "queued"
	ImportStatusRunning   ImportStatus = "running"
	ImportStatusCompleted ImportStatus = "completed"
	ImportStatusFailed    ImportStatus = "failed"
)

// InterruptionReason Why an attempt ended without a result: lease_lost (the worker was lost: it stopped heartbeating after a crash, kill or network failure), compute_reclaimed (the GPU was reclaimed; the worker saved a checkpoint when it had time and handed the run back), worker_error (the worker hit an unexpected error and handed the run back), oom (CUDA out of memory).
type InterruptionReason string

// Values of InterruptionReason.
const (
	InterruptionReasonLeaseLost        InterruptionReason = "lease_lost"
	InterruptionReasonComputeReclaimed InterruptionReason = "compute_reclaimed"
	InterruptionReasonWorkerError      InterruptionReason = "worker_error"
	InterruptionReasonOom              InterruptionReason = "oom"
)

// ListAPIKeysParams holds the query and header parameters of ListAPIKeys.
type ListAPIKeysParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit  *int
	Cursor *string
}

// ListAPIKeysResponse is generated from the OpenAPI schema.
type ListAPIKeysResponse struct {
	Data []APIKey `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListArtifactsParams holds the query and header parameters of ListArtifacts.
type ListArtifactsParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit  *int
	Cursor *string
	Name   *string
}

// ListArtifactsResponse is generated from the OpenAPI schema.
type ListArtifactsResponse struct {
	Data []Artifact `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListBaseModelsResponse is generated from the OpenAPI schema.
type ListBaseModelsResponse struct {
	Data []TrainableModel `json:"data"`
}

// ListDatasetRecordsParams holds the query and header parameters of ListDatasetRecords.
type ListDatasetRecordsParams struct {
	Version *int
	// Limit Page size (default 100). Values above 1000 are clamped to 1000.
	Limit  *int
	Cursor *string
}

// ListDatasetsParams holds the query and header parameters of ListDatasets.
type ListDatasetsParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit  *int
	Cursor *string
}

// ListDatasetsResponse is generated from the OpenAPI schema.
type ListDatasetsResponse struct {
	Data []Dataset `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListDeploymentsParams holds the query and header parameters of ListDeployments.
type ListDeploymentsParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit  *int
	Cursor *string
}

// ListDeploymentsResponse is generated from the OpenAPI schema.
type ListDeploymentsResponse struct {
	Data []Deployment `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListEvalFailuresParams holds the query and header parameters of ListEvalFailures.
type ListEvalFailuresParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit     *int
	Cursor    *string
	Model     *string
	Threshold *float64
}

// ListEvalFailuresResponse is generated from the OpenAPI schema.
type ListEvalFailuresResponse struct {
	EvalID string            `json:"eval_id"`
	Data   []EvalTaskOutcome `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListEvalOutputsParams holds the query and header parameters of ListEvalOutputs.
type ListEvalOutputsParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit         *int
	Cursor        *string
	Model         *string
	MissingScorer *string
}

// ListEvalOutputsResponse is generated from the OpenAPI schema.
type ListEvalOutputsResponse struct {
	Data []EvalOutput `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListEvalResultsParams holds the query and header parameters of ListEvalResults.
type ListEvalResultsParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit  *int
	Cursor *string
	Model  *string
}

// ListEvalResultsResponse is generated from the OpenAPI schema.
type ListEvalResultsResponse struct {
	Data []EvalTaskOutcome `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListEvalsParams holds the query and header parameters of ListEvals.
type ListEvalsParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit  *int
	Cursor *string
}

// ListEvalsResponse is generated from the OpenAPI schema.
type ListEvalsResponse struct {
	Data []EvalRun `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListImportsParams holds the query and header parameters of ListImports.
type ListImportsParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit  *int
	Cursor *string
}

// ListImportsResponse is generated from the OpenAPI schema.
type ListImportsResponse struct {
	Data []ImportJob `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListRunCheckpointsParams holds the query and header parameters of ListRunCheckpoints.
type ListRunCheckpointsParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit  *int
	Cursor *string
}

// ListRunCheckpointsResponse is generated from the OpenAPI schema.
type ListRunCheckpointsResponse struct {
	Data []Checkpoint `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListRunEventsParams holds the query and header parameters of ListRunEvents.
type ListRunEventsParams struct {
	Cursor *string
	// Limit Page size (default 1000). Values above 5000 are clamped to 5000.
	Limit *int
}

// ListRunMetricsParams holds the query and header parameters of ListRunMetrics.
type ListRunMetricsParams struct {
	Cursor    *string
	AfterStep *int
	// Limit Page size (default 1000). Values above 5000 are clamped to 5000.
	Limit *int
}

// ListRunsParams holds the query and header parameters of ListRuns.
type ListRunsParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit  *int
	Cursor *string
}

// ListRunsResponse is generated from the OpenAPI schema.
type ListRunsResponse struct {
	Data []Run `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListSecretsParams holds the query and header parameters of ListSecrets.
type ListSecretsParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit  *int
	Cursor *string
}

// ListSecretsResponse is generated from the OpenAPI schema.
type ListSecretsResponse struct {
	Data []Secret `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListSourcesParams holds the query and header parameters of ListSources.
type ListSourcesParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit   *int
	Cursor  *string
	Dataset *string
}

// ListSourcesResponse is generated from the OpenAPI schema.
type ListSourcesResponse struct {
	Data []Source `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// ListUsageParams holds the query and header parameters of ListUsage.
type ListUsageParams struct {
	// Limit Page size (default 50). Values above 200 are clamped to 200.
	Limit  *int
	Cursor *string
	// From Start of the period (inclusive): YYYY-MM-DD (UTC) or an ISO 8601 timestamp.
	From *string
	// To End of the period: a date YYYY-MM-DD covers that whole UTC day; a timestamp is exclusive.
	To *string
	// RunID Only usage billed for this run: its training and the evals it started (labeling, teacher answers, checkpoint evals).
	RunID  *string
	EvalID *string
	Kind   *ListUsageParamsKind
}

// ListUsageParamsKind is an enumeration of allowed values.
type ListUsageParamsKind string

// Values of ListUsageParamsKind.
const (
	ListUsageParamsKindTraining ListUsageParamsKind = "training"
	ListUsageParamsKindEval     ListUsageParamsKind = "eval"
	ListUsageParamsKindScoring  ListUsageParamsKind = "scoring"
	ListUsageParamsKindLabeling ListUsageParamsKind = "labeling"
	ListUsageParamsKindTeacher  ListUsageParamsKind = "teacher"
)

// ListUsageResponse is generated from the OpenAPI schema.
type ListUsageResponse struct {
	Data []UsageRecord `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
}

// LogEvent is generated from the OpenAPI schema.
type LogEvent struct {
	Type  LogEventType `json:"type"`
	RunID string       `json:"run_id"`
	// Seq Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq.
	Seq       int    `json:"seq"`
	Attempt   int    `json:"attempt"`
	Timestamp string `json:"timestamp"`
	Step      *int   `json:"step"`
	Message   string `json:"message"`
}

// LogEventType is an enumeration of allowed values.
type LogEventType string

// Values of LogEventType.
const (
	LogEventTypeLog LogEventType = "log"
)

// LoggerSpec is a union of object shapes; set the fields of exactly one variant.
type LoggerSpec struct {
	Kind    LoggerSpecKind `json:"kind"`
	Project *string        `json:"project,omitempty"`
	Entity  *string        `json:"entity,omitempty"`
	// Host W&B server (default https://api.wandb.ai).
	Host *string `json:"host,omitempty"`
	// Secret Workspace secret holding the W&B API key.
	Secret *string `json:"secret,omitempty"`
	// RunName Tracker run name (default: the grad run name).
	RunName     *string `json:"run_name,omitempty"`
	TrackingURI *string `json:"tracking_uri,omitempty"`
	Experiment  *string `json:"experiment,omitempty"`
}

// LoggerSpecKind is an enumeration of allowed values.
type LoggerSpecKind string

// Values of LoggerSpecKind.
const (
	LoggerSpecKindWandb  LoggerSpecKind = "wandb"
	LoggerSpecKindMlflow LoggerSpecKind = "mlflow"
)

// LossSpec is a union of object shapes; set the fields of exactly one variant.
type LossSpec struct {
	Kind      LossSpecKind       `json:"kind"`
	Reduction *LossSpecReduction `json:"reduction,omitempty"`
	Beta      *float64           `json:"beta,omitempty"`
	Temp      *float64           `json:"temp,omitempty"`
	TopK      *int               `json:"top_k,omitempty"`
}

// LossSpecKind is an enumeration of allowed values.
type LossSpecKind string

// Values of LossSpecKind.
const (
	LossSpecKindCrossEntropy  LossSpecKind = "cross_entropy"
	LossSpecKindDpo           LossSpecKind = "dpo"
	LossSpecKindInfonce       LossSpecKind = "infonce"
	LossSpecKindTopKKLDistill LossSpecKind = "top_k_kl_distill"
)

// LossSpecReduction is an enumeration of allowed values.
type LossSpecReduction string

// Values of LossSpecReduction.
const (
	LossSpecReductionPerExample LossSpecReduction = "per_example"
	LossSpecReductionPerToken   LossSpecReduction = "per_token"
)

// MetricEvent is generated from the OpenAPI schema.
type MetricEvent struct {
	Type  MetricEventType `json:"type"`
	RunID string          `json:"run_id"`
	// Seq Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq.
	Seq       int          `json:"seq"`
	Attempt   int          `json:"attempt"`
	Timestamp string       `json:"timestamp"`
	Step      int          `json:"step"`
	Metric    *MetricPoint `json:"metric"`
}

// MetricEventType is an enumeration of allowed values.
type MetricEventType string

// Values of MetricEventType.
const (
	MetricEventTypeMetric MetricEventType = "metric"
)

// MetricPoint is generated from the OpenAPI schema.
type MetricPoint struct {
	Seq      int      `json:"seq"`
	Attempt  int      `json:"attempt"`
	Step     int      `json:"step"`
	Loss     float64  `json:"loss"`
	EvalLoss *float64 `json:"eval_loss,omitempty"`
	// EvalMetrics Held-out metrics of an eval step by name (including the recipe's selection metric, eval_report.metric_name); absent on steps without an eval.
	EvalMetrics  map[string]*float64 `json:"eval_metrics,omitempty"`
	GradNorm     *float64            `json:"grad_norm,omitempty"`
	LR           *float64            `json:"lr,omitempty"`
	TokensPerSec *float64            `json:"tokens_per_sec,omitempty"`
	Tokens       int                 `json:"tokens"`
	CostUSD      float64             `json:"cost_usd"`
	Timestamp    string              `json:"timestamp"`
	// AdditionalProperties holds members not declared in the schema (round-tripped verbatim).
	AdditionalProperties map[string]any `json:"-"`
}

var knownMetricPointFields = map[string]bool{
	"seq":            true,
	"attempt":        true,
	"step":           true,
	"loss":           true,
	"eval_loss":      true,
	"eval_metrics":   true,
	"grad_norm":      true,
	"lr":             true,
	"tokens_per_sec": true,
	"tokens":         true,
	"cost_usd":       true,
	"timestamp":      true,
}

// MarshalJSON encodes declared fields plus AdditionalProperties.
func (m MetricPoint) MarshalJSON() ([]byte, error) {
	type plain MetricPoint
	return MarshalWithAdditional(plain(m), m.AdditionalProperties)
}

// UnmarshalJSON decodes declared fields and keeps the rest in AdditionalProperties.
func (m *MetricPoint) UnmarshalJSON(data []byte) error {
	type plain MetricPoint
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	extra, err := AdditionalFields(data, knownMetricPointFields)
	if err != nil {
		return err
	}
	*m = MetricPoint(p)
	m.AdditionalProperties = extra
	return nil
}

// MetricsPage is generated from the OpenAPI schema.
type MetricsPage struct {
	RunID  string        `json:"run_id"`
	Status RunStatus     `json:"status"`
	Data   []MetricPoint `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
	// TailCursor Cursor after the newest point returned so far; pass it back as `cursor` to poll for points written later (tailing a running run).
	TailCursor string `json:"tail_cursor"`
}

// OptimizerSpec is generated from the OpenAPI schema.
type OptimizerSpec struct {
	Kind        *OptimizerSpecKind `json:"kind,omitempty"`
	Betas       []any              `json:"betas,omitempty"`
	WeightDecay *float64           `json:"weight_decay,omitempty"`
	// GradClip Max global gradient norm; 0 disables clipping.
	GradClip *float64 `json:"grad_clip,omitempty"`
}

// OptimizerSpecKind is an enumeration of allowed values.
type OptimizerSpecKind string

// Values of OptimizerSpecKind.
const (
	OptimizerSpecKindAdamw OptimizerSpecKind = "adamw"
)

// PhaseEvent is generated from the OpenAPI schema.
type PhaseEvent struct {
	Type  PhaseEventType `json:"type"`
	RunID string         `json:"run_id"`
	// Seq Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq.
	Seq       int      `json:"seq"`
	Attempt   int      `json:"attempt"`
	Timestamp string   `json:"timestamp"`
	Phase     RunPhase `json:"phase"`
	// Step Training step when the phase began (0 before training; the resume step on a resumed attempt).
	Step int `json:"step"`
	// WorkersOnline queued and waiting_for_compute: workers of this job kind holding a lease (all busy; an idle worker would have claimed the run).
	WorkersOnline *int `json:"workers_online"`
	// Autoscaling queued and waiting_for_compute: true when workers scale from zero (KEDA), so one is starting rather than missing.
	Autoscaling *bool `json:"autoscaling"`
	// QueuePosition queued and waiting_for_compute: about how many runs start before this one when the phase began (fair share across workspaces). Run.queue_position is the live value.
	QueuePosition *int `json:"queue_position"`
	// Message queued and waiting_for_compute: why the run waits, ready to show ("Queued behind 3 runs", "Queued: workspace concurrency limit (8 running)", "Waiting for a GPU with ≥46 GB; online workers have 24 GB"). Null when it is next in line.
	Message *string  `json:"message"`
	GPU     *GPUInfo `json:"gpu"`
}

// PhaseEventType is an enumeration of allowed values.
type PhaseEventType string

// Values of PhaseEventType.
const (
	PhaseEventTypePhase PhaseEventType = "phase"
)

// PlanCostBreakdown estimated_cost_usd split by what bills it; the parts sum to it (to rounding).
type PlanCostBreakdown struct {
	// TrainUSD The base model's tokens on every training step: each record (or both sides of a preference pair) once per epoch, at price_per_million_tokens. Held-out evaluation during training is not billed.
	TrainUSD float64 `json:"train_usd"`
	// TeacherUSD The teacher's tokens (on-policy distill), at its price.
	TeacherUSD float64 `json:"teacher_usd"`
	// EvalUSD Evals the run starts, billed as evals: the labeling eval before training and recipe.evals on every checkpoint.
	EvalUSD float64 `json:"eval_usd"`
}

// PlanEvalRequest is generated from the OpenAPI schema.
type PlanEvalRequest struct {
	Name           *string  `json:"name,omitempty"`
	Models         []string `json:"models"`
	Baseline       *string  `json:"baseline,omitempty"`
	Dataset        string   `json:"dataset"`
	DatasetVersion *int     `json:"dataset_version,omitempty"`
	// Rubric Default: the dataset's own rubric (a benchmark's answer check), else a non_empty validator.
	Rubric      []EvalRubricItem `json:"rubric,omitempty"`
	Samples     *int             `json:"samples,omitempty"`
	Temperature *float64         `json:"temperature,omitempty"`
	MaxTokens   *int             `json:"max_tokens,omitempty"`
	Limit       *int             `json:"limit,omitempty"`
	// PassThreshold Defaults to 1.0 when every rubric item is binary (regex/validator) and 0.5 otherwise.
	PassThreshold *float64 `json:"pass_threshold,omitempty"`
}

// PlanEvalResponse is generated from the OpenAPI schema.
type PlanEvalResponse struct {
	TaskSourceKind      PlanEvalResponseTaskSourceKind `json:"task_source_kind"`
	DatasetVersion      int                            `json:"dataset_version"`
	EstimatedTasks      int                            `json:"estimated_tasks"`
	EstimatedModelCalls int                            `json:"estimated_model_calls"`
	EstimatedJudgeCalls int                            `json:"estimated_judge_calls"`
	EstimatedCostUSD    float64                        `json:"estimated_cost_usd"`
	JudgeModels         []string                       `json:"judge_models"`
	LocalScorers        []string                       `json:"local_scorers"`
	PassThreshold       float64                        `json:"pass_threshold"`
	Warnings            []string                       `json:"warnings"`
}

// PlanEvalResponseTaskSourceKind is an enumeration of allowed values.
type PlanEvalResponseTaskSourceKind string

// Values of PlanEvalResponseTaskSourceKind.
const (
	PlanEvalResponseTaskSourceKindDataset PlanEvalResponseTaskSourceKind = "dataset"
)

// PlanRunRequest is generated from the OpenAPI schema.
type PlanRunRequest struct {
	Dataset    string     `json:"dataset"`
	Name       string     `json:"name"`
	Recipe     RecipeSpec `json:"recipe"`
	Split      *SplitSpec `json:"split,omitempty"`
	MaxCostUSD *float64   `json:"max_cost_usd,omitempty"`
}

// PlanRunResponse is generated from the OpenAPI schema.
type PlanRunResponse struct {
	ResolvedConfig  ResolvedRunConfig `json:"resolved_config"`
	DatasetVersion  int               `json:"dataset_version"`
	UsableRecords   int               `json:"usable_records"`
	TotalRecords    int               `json:"total_records"`
	EstimatedSteps  int               `json:"estimated_steps"`
	EstimatedTokens int               `json:"estimated_tokens"`
	// EstimatedCostUSD Everything the run is expected to bill: training (and teacher) tokens, plus the evals it starts (labeling, recipe.evals). See cost_breakdown.
	EstimatedCostUSD float64 `json:"estimated_cost_usd"`
	// EstimatedDurationS Wall-clock estimate in seconds on one H100 80 GB: model load and export, training at the measured tokens/s for this base and recipe, evaluations and checkpoints. Excludes queueing and any labeling eval.
	EstimatedDurationS int `json:"estimated_duration_s"`
	// MinGPUMemoryGb GPU memory (GB) this run needs: the base's min_gpu_memory_gb plus a teacher loaded beside it. Null when the base's requirement is unknown.
	MinGPUMemoryGb        *float64 `json:"min_gpu_memory_gb"`
	PricePerMillionTokens float64  `json:"price_per_million_tokens"`
	TrainedTokenFraction  float64  `json:"trained_token_fraction"`
	// Labeling The labeling eval that runs before training (billed as an eval, included in estimated_cost_usd): router runs with a Judge/validator rubric replay prompts against the candidates; off-policy distill runs have the teacher answer each prompt.
	Labeling *PlanRunResponseLabeling `json:"labeling"`
	// Teacher On-policy distill runs: the teacher's scoring tokens at the teacher's price (included in estimated_tokens as student-price tokens, and in estimated_cost_usd).
	Teacher       *PlanRunResponseTeacher `json:"teacher"`
	CostBreakdown PlanCostBreakdown       `json:"cost_breakdown"`
	Warnings      []string                `json:"warnings"`
}

// PlanRunResponseLabeling The labeling eval that runs before training (billed as an eval, included in estimated_cost_usd): router runs with a Judge/validator rubric replay prompts against the candidates; off-policy distill runs have the teacher answer each prompt.
type PlanRunResponseLabeling struct {
	EstimatedModelCalls int     `json:"estimated_model_calls"`
	EstimatedJudgeCalls int     `json:"estimated_judge_calls"`
	EstimatedCostUSD    float64 `json:"estimated_cost_usd"`
}

// PlanRunResponseTeacher On-policy distill runs: the teacher's scoring tokens at the teacher's price (included in estimated_tokens as student-price tokens, and in estimated_cost_usd).
type PlanRunResponseTeacher struct {
	Model                 string  `json:"model"`
	PricePerMillionTokens float64 `json:"price_per_million_tokens"`
	EstimatedTokens       int     `json:"estimated_tokens"`
	EstimatedCostUSD      float64 `json:"estimated_cost_usd"`
}

// PoolingSpec is generated from the OpenAPI schema.
type PoolingSpec struct {
	Kind PoolingSpecKind `json:"kind"`
}

// PoolingSpecKind is an enumeration of allowed values.
type PoolingSpecKind string

// Values of PoolingSpecKind.
const (
	PoolingSpecKindMean PoolingSpecKind = "mean"
	PoolingSpecKindCls  PoolingSpecKind = "cls"
)

// PostEvalScoresRequest is generated from the OpenAPI schema.
type PostEvalScoresRequest struct {
	Scores []PostEvalScoresRequestScoresItem `json:"scores"`
}

// PostEvalScoresRequestScoresItem is generated from the OpenAPI schema.
type PostEvalScoresRequestScoresItem struct {
	OutputID string  `json:"output_id"`
	Scorer   string  `json:"scorer"`
	Score    float64 `json:"score"`
}

// PostEvalScoresResponse is generated from the OpenAPI schema.
type PostEvalScoresResponse struct {
	Accepted           int        `json:"accepted"`
	Status             EvalStatus `json:"status"`
	PendingLocalScores int        `json:"pending_local_scores"`
}

// PromoteCheckpointRequest is generated from the OpenAPI schema.
type PromoteCheckpointRequest struct {
	Name *string `json:"name,omitempty"`
}

// PushDatasetRequest is generated from the OpenAPI schema.
type PushDatasetRequest struct {
	Records  []DatasetRecord `json:"records"`
	Metadata map[string]any  `json:"metadata,omitempty"`
}

// RecipeEval is generated from the OpenAPI schema.
type RecipeEval struct {
	Dataset string `json:"dataset"`
	// Version Dataset version (default: the current one, pinned at plan time).
	Version *int `json:"version,omitempty"`
	// Rubric Judges, regexes and validators (default: the dataset's own rubric, such as a benchmark's answer check). Code scorers can't run during training.
	Rubric []EvalRubricItem `json:"rubric,omitempty"`
	// Limit Evaluate the first N tasks at each checkpoint.
	Limit *int `json:"limit,omitempty"`
	// Name Name of this eval in the report (default: the dataset name).
	Name *string `json:"name,omitempty"`
}

// RecipeKind is an enumeration of allowed values.
type RecipeKind string

// Values of RecipeKind.
const (
	RecipeKindSft       RecipeKind = "sft"
	RecipeKindDpo       RecipeKind = "dpo"
	RecipeKindRouter    RecipeKind = "router"
	RecipeKindDecision  RecipeKind = "decision"
	RecipeKindCartridge RecipeKind = "cartridge"
	RecipeKindEmbedding RecipeKind = "embedding"
	RecipeKindDistill   RecipeKind = "distill"
	RecipeKindReward    RecipeKind = "reward"
	RecipeKindGrpo      RecipeKind = "grpo"
)

// RecipeSpec is generated from the OpenAPI schema.
type RecipeSpec struct {
	Kind             RecipeKind          `json:"kind"`
	Model            *string             `json:"model,omitempty"`
	Adapter          *AdapterSpec        `json:"adapter,omitempty"`
	LR               any                 `json:"lr,omitempty"`
	LRScale          *float64            `json:"lr_scale,omitempty"`
	BatchSize        *int                `json:"batch_size,omitempty"`
	Epochs           *int                `json:"epochs,omitempty"`
	Schedule         *RecipeSpecSchedule `json:"schedule,omitempty"`
	Warmup           *float64            `json:"warmup,omitempty"`
	TrainOn          *RecipeSpecTrainOn  `json:"train_on,omitempty"`
	Thinking         *RecipeSpecThinking `json:"thinking,omitempty"`
	PreserveThinking *bool               `json:"preserve_thinking,omitempty"`
	// Reduction Default per_example.
	Reduction         *RecipeSpecReduction `json:"reduction,omitempty"`
	Select            *RecipeSpecSelect    `json:"select,omitempty"`
	CheckpointTTLDays *int                 `json:"checkpoint_ttl_days,omitempty"`
	Beta              *float64             `json:"beta,omitempty"`
	Models            []string             `json:"models,omitempty"`
	MaxQualityDrop    *float64             `json:"max_quality_drop,omitempty"`
	ContextText       *string              `json:"context_text,omitempty"`
	NumTokens         *int                 `json:"num_tokens,omitempty"`
	Temp              *float64             `json:"temp,omitempty"`
	// Teacher CartridgeRecipe and DistillRecipe: the model to learn from. DistillRecipe also takes an artifact (name@version) with rollout off_policy.
	Teacher   *string        `json:"teacher,omitempty"`
	Rollout   *RolloutSpec   `json:"rollout,omitempty"`
	Optimizer *OptimizerSpec `json:"optimizer,omitempty"`
	// EvalEvery Optimizer steps between held-out evaluations; auto = every 25% of the run, at most every 20 steps; each eval step is also a checkpoint.
	EvalEvery any          `json:"eval_every,omitempty"`
	Loss      *LossSpec    `json:"loss,omitempty"`
	Pool      *PoolingSpec `json:"pool,omitempty"`
	// Rubric RouterRecipe: a score name on your records (scores[rubric]), or Judge/validator items: the server then replays each prompt against recipe.models and scores the answers in a labeling eval before training. RewardModelRecipe: a score name in [0, 1] on records ending in an assistant turn, trained pointwise next to the chosen/rejected pairs.
	Rubric any `json:"rubric,omitempty"`
	// Pricing RouterRecipe: USD per request for each candidate; overrides metrics.cost_usd on your records.
	Pricing map[string]float64 `json:"pricing,omitempty"`
	// Fallback RouterRecipe: the candidate that gets every request the router does not offload (default: the best-scoring candidate).
	Fallback *string `json:"fallback,omitempty"`
	// MaxNewTokens CartridgeRecipe: teacher answer length per prompt during distillation (default 256).
	MaxNewTokens *int `json:"max_new_tokens,omitempty"`
	// SlotToken CartridgeRecipe: a reserved token that marks where the cartridge goes (default: the first reserved token that tokenizes atomically).
	SlotToken *string `json:"slot_token,omitempty"`
	// Evals Extra evals on each checkpoint during training (the eval executor, billed like any eval). Results are in run.checkpoint_evals, the run's checkpoint_eval events and eval_report.checkpoint_evals.
	Evals []RecipeEval `json:"evals,omitempty"`
	// Loggers Experiment trackers that receive the run's metrics. A tracker that fails is reported and dropped; it never fails the run.
	Loggers []LoggerSpec `json:"loggers,omitempty"`
}

// RecipeSpecReduction Default per_example.
type RecipeSpecReduction string

// Values of RecipeSpecReduction.
const (
	RecipeSpecReductionPerExample RecipeSpecReduction = "per_example"
	RecipeSpecReductionPerToken   RecipeSpecReduction = "per_token"
)

// RecipeSpecSchedule is an enumeration of allowed values.
type RecipeSpecSchedule string

// Values of RecipeSpecSchedule.
const (
	RecipeSpecScheduleLinear   RecipeSpecSchedule = "linear"
	RecipeSpecScheduleCosine   RecipeSpecSchedule = "cosine"
	RecipeSpecScheduleConstant RecipeSpecSchedule = "constant"
)

// RecipeSpecSelect is an enumeration of allowed values.
type RecipeSpecSelect string

// Values of RecipeSpecSelect.
const (
	RecipeSpecSelectBest RecipeSpecSelect = "best"
	RecipeSpecSelectLast RecipeSpecSelect = "last"
)

// RecipeSpecThinking is an enumeration of allowed values.
type RecipeSpecThinking string

// Values of RecipeSpecThinking.
const (
	RecipeSpecThinkingAuto RecipeSpecThinking = "auto"
	RecipeSpecThinkingOn   RecipeSpecThinking = "on"
	RecipeSpecThinkingOff  RecipeSpecThinking = "off"
)

// RecipeSpecTrainOn is an enumeration of allowed values.
type RecipeSpecTrainOn string

// Values of RecipeSpecTrainOn.
const (
	RecipeSpecTrainOnLast         RecipeSpecTrainOn = "last"
	RecipeSpecTrainOnAllAssistant RecipeSpecTrainOn = "all_assistant"
)

// RecordFeedbackRequest is generated from the OpenAPI schema.
type RecordFeedbackRequest struct {
	Events []FeedbackEventInput `json:"events"`
}

// RecordFeedbackResponse is generated from the OpenAPI schema.
type RecordFeedbackResponse struct {
	Accepted     int              `json:"accepted"`
	Deduplicated int              `json:"deduplicated"`
	Records      []FeedbackRecord `json:"records"`
}

// RenderDatasetRequest is generated from the OpenAPI schema.
type RenderDatasetRequest struct {
	Model            *string                       `json:"model,omitempty"`
	TrainOn          *RenderDatasetRequestTrainOn  `json:"train_on,omitempty"`
	Thinking         *RenderDatasetRequestThinking `json:"thinking,omitempty"`
	PreserveThinking *bool                         `json:"preserve_thinking,omitempty"`
	Limit            *int                          `json:"limit,omitempty"`
}

// RenderDatasetRequestThinking is an enumeration of allowed values.
type RenderDatasetRequestThinking string

// Values of RenderDatasetRequestThinking.
const (
	RenderDatasetRequestThinkingAuto RenderDatasetRequestThinking = "auto"
	RenderDatasetRequestThinkingOn   RenderDatasetRequestThinking = "on"
	RenderDatasetRequestThinkingOff  RenderDatasetRequestThinking = "off"
)

// RenderDatasetRequestTrainOn is an enumeration of allowed values.
type RenderDatasetRequestTrainOn string

// Values of RenderDatasetRequestTrainOn.
const (
	RenderDatasetRequestTrainOnLast         RenderDatasetRequestTrainOn = "last"
	RenderDatasetRequestTrainOnAllAssistant RenderDatasetRequestTrainOn = "all_assistant"
)

// RenderDatasetResponse is generated from the OpenAPI schema.
type RenderDatasetResponse struct {
	Dataset          string `json:"dataset"`
	Model            string `json:"model"`
	TemplateRevision string `json:"template_revision"`
	// TokenCounts Token counts (total, trained and per span) are estimates (about 4 characters per token); the trainer tokenizes with the model's pinned tokenizer, and the run's metrics report the exact tokens.
	TokenCounts RenderDatasetResponseTokenCounts    `json:"token_counts"`
	Examples    []RenderDatasetResponseExamplesItem `json:"examples"`
}

// RenderDatasetResponseExamplesItem is generated from the OpenAPI schema.
type RenderDatasetResponseExamplesItem struct {
	RecordID         string                                       `json:"record_id"`
	TemplateRevision string                                       `json:"template_revision"`
	TotalTokens      int                                          `json:"total_tokens"`
	TrainedTokens    int                                          `json:"trained_tokens"`
	TrainedFraction  float64                                      `json:"trained_fraction"`
	Spans            []RenderDatasetResponseExamplesItemSpansItem `json:"spans"`
}

// RenderDatasetResponseExamplesItemSpansItem is generated from the OpenAPI schema.
type RenderDatasetResponseExamplesItemSpansItem struct {
	Text    string `json:"text"`
	Trained bool   `json:"trained"`
	Tokens  int    `json:"tokens"`
}

// RenderDatasetResponseTokenCounts Token counts (total, trained and per span) are estimates (about 4 characters per token); the trainer tokenizes with the model's pinned tokenizer, and the run's metrics report the exact tokens.
type RenderDatasetResponseTokenCounts string

// Values of RenderDatasetResponseTokenCounts.
const (
	RenderDatasetResponseTokenCountsEstimated RenderDatasetResponseTokenCounts = "estimated"
)

// ResolvedRunConfig is generated from the OpenAPI schema.
type ResolvedRunConfig struct {
	RuleVersion          string                     `json:"rule_version"`
	Dataset              string                     `json:"dataset"`
	DatasetVersion       int                        `json:"dataset_version"`
	Name                 string                     `json:"name"`
	RecipeKind           RecipeKind                 `json:"recipe_kind"`
	Model                string                     `json:"model"`
	TemplateRevision     string                     `json:"template_revision"`
	Adapter              ResolvedRunConfigAdapter   `json:"adapter"`
	LR                   float64                    `json:"lr"`
	LRSource             string                     `json:"lr_source"`
	BatchSize            int                        `json:"batch_size"`
	Epochs               int                        `json:"epochs"`
	Schedule             ResolvedRunConfigSchedule  `json:"schedule"`
	Warmup               float64                    `json:"warmup"`
	TrainOn              ResolvedRunConfigTrainOn   `json:"train_on"`
	Thinking             ResolvedRunConfigThinking  `json:"thinking"`
	PreserveThinking     bool                       `json:"preserve_thinking"`
	Reduction            ResolvedRunConfigReduction `json:"reduction"`
	Select               ResolvedRunConfigSelect    `json:"select"`
	CheckpointEverySteps int                        `json:"checkpoint_every_steps"`
	EvalEverySteps       int                        `json:"eval_every_steps"`
	Optimizer            OptimizerSpec              `json:"optimizer"`
	CheckpointTTLDays    int                        `json:"checkpoint_ttl_days"`
	Split                ResolvedRunConfigSplit     `json:"split"`
	// LabelEvalID The labeling eval whose answers the run trains on: router runs with a Judge/validator rubric, and off-policy distill runs (the teacher's answers).
	LabelEvalID  *string        `json:"label_eval_id"`
	BaseArtifact *BaseArtifact  `json:"base_artifact"`
	RecipeParams map[string]any `json:"recipe_params"`
	// CheckpointEvals recipe.evals, with the dataset version and rubric pinned.
	CheckpointEvals []ResolvedRunConfigCheckpointEvalsItem `json:"checkpoint_evals,omitempty"`
	Loggers         []LoggerSpec                           `json:"loggers,omitempty"`
}

// ResolvedRunConfigAdapter is a union of object shapes; set the fields of exactly one variant.
type ResolvedRunConfigAdapter struct {
	Kind          ResolvedRunConfigAdapterKind `json:"kind"`
	Rank          *int                         `json:"rank,omitempty"`
	Alpha         *int                         `json:"alpha,omitempty"`
	MergeOnExport *bool                        `json:"merge_on_export,omitempty"`
	NumTokens     *int                         `json:"num_tokens,omitempty"`
}

// ResolvedRunConfigAdapterKind is an enumeration of allowed values.
type ResolvedRunConfigAdapterKind string

// Values of ResolvedRunConfigAdapterKind.
const (
	ResolvedRunConfigAdapterKindLora        ResolvedRunConfigAdapterKind = "lora"
	ResolvedRunConfigAdapterKindPrefixKv    ResolvedRunConfigAdapterKind = "prefix_kv"
	ResolvedRunConfigAdapterKindFrozenHead  ResolvedRunConfigAdapterKind = "frozen_head"
	ResolvedRunConfigAdapterKindEncoderFull ResolvedRunConfigAdapterKind = "encoder_full"
)

// ResolvedRunConfigCheckpointEvalsItem is generated from the OpenAPI schema.
type ResolvedRunConfigCheckpointEvalsItem struct {
	Name           string           `json:"name"`
	Dataset        string           `json:"dataset"`
	DatasetVersion int              `json:"dataset_version"`
	Rubric         []EvalRubricItem `json:"rubric"`
	Limit          *int             `json:"limit"`
}

// ResolvedRunConfigReduction is an enumeration of allowed values.
type ResolvedRunConfigReduction string

// Values of ResolvedRunConfigReduction.
const (
	ResolvedRunConfigReductionPerExample ResolvedRunConfigReduction = "per_example"
	ResolvedRunConfigReductionPerToken   ResolvedRunConfigReduction = "per_token"
)

// ResolvedRunConfigSchedule is an enumeration of allowed values.
type ResolvedRunConfigSchedule string

// Values of ResolvedRunConfigSchedule.
const (
	ResolvedRunConfigScheduleLinear   ResolvedRunConfigSchedule = "linear"
	ResolvedRunConfigScheduleCosine   ResolvedRunConfigSchedule = "cosine"
	ResolvedRunConfigScheduleConstant ResolvedRunConfigSchedule = "constant"
)

// ResolvedRunConfigSelect is an enumeration of allowed values.
type ResolvedRunConfigSelect string

// Values of ResolvedRunConfigSelect.
const (
	ResolvedRunConfigSelectBest ResolvedRunConfigSelect = "best"
	ResolvedRunConfigSelectLast ResolvedRunConfigSelect = "last"
)

// ResolvedRunConfigSplit is generated from the OpenAPI schema.
type ResolvedRunConfigSplit struct {
	Strategy     ResolvedRunConfigSplitStrategy `json:"strategy"`
	EvalFraction float64                        `json:"eval_fraction"`
	Seed         int                            `json:"seed"`
	TrainRecords int                            `json:"train_records"`
	EvalRecords  int                            `json:"eval_records"`
}

// ResolvedRunConfigSplitStrategy is an enumeration of allowed values.
type ResolvedRunConfigSplitStrategy string

// Values of ResolvedRunConfigSplitStrategy.
const (
	ResolvedRunConfigSplitStrategyBySession ResolvedRunConfigSplitStrategy = "by_session"
	ResolvedRunConfigSplitStrategyByGroup   ResolvedRunConfigSplitStrategy = "by_group"
	ResolvedRunConfigSplitStrategyRandom    ResolvedRunConfigSplitStrategy = "random"
)

// ResolvedRunConfigThinking is an enumeration of allowed values.
type ResolvedRunConfigThinking string

// Values of ResolvedRunConfigThinking.
const (
	ResolvedRunConfigThinkingAuto ResolvedRunConfigThinking = "auto"
	ResolvedRunConfigThinkingOn   ResolvedRunConfigThinking = "on"
	ResolvedRunConfigThinkingOff  ResolvedRunConfigThinking = "off"
)

// ResolvedRunConfigTrainOn is an enumeration of allowed values.
type ResolvedRunConfigTrainOn string

// Values of ResolvedRunConfigTrainOn.
const (
	ResolvedRunConfigTrainOnLast         ResolvedRunConfigTrainOn = "last"
	ResolvedRunConfigTrainOnAllAssistant ResolvedRunConfigTrainOn = "all_assistant"
)

// ResumeRunRequest is generated from the OpenAPI schema.
type ResumeRunRequest struct {
	MaxCostUSD *float64 `json:"max_cost_usd,omitempty"`
}

// RolloutSpec is a union of object shapes; set the fields of exactly one variant.
type RolloutSpec struct {
	Kind RolloutSpecKind `json:"kind"`
	// MaxNewTokens Length of each student answer; auto (default) sizes it from the assistant turns in your records (256 without any).
	MaxNewTokens any `json:"max_new_tokens,omitempty"`
}

// RolloutSpecKind is an enumeration of allowed values.
type RolloutSpecKind string

// Values of RolloutSpecKind.
const (
	RolloutSpecKindOnPolicy  RolloutSpecKind = "on_policy"
	RolloutSpecKindOffPolicy RolloutSpecKind = "off_policy"
)

// RouteRequest is generated from the OpenAPI schema.
type RouteRequest struct {
	Deployment string           `json:"deployment"`
	Messages   []ChatMessage    `json:"messages"`
	Tools      []map[string]any `json:"tools,omitempty"`
	SessionID  *string          `json:"session_id,omitempty"`
}

// RouteResponse is generated from the OpenAPI schema.
type RouteResponse struct {
	InferenceID   string             `json:"inference_id"`
	Deployment    string             `json:"deployment"`
	ArtifactID    string             `json:"artifact_id"`
	Model         string             `json:"model"`
	IsExploration bool               `json:"is_exploration"`
	Confidence    float64            `json:"confidence"`
	Scores        map[string]float64 `json:"scores"`
}

// RouterParetoSummary Router quality vs. cost on the held-out report fold, against the fallback model. Values are null when no report prompt was scored for every candidate.
type RouterParetoSummary struct {
	TargetMaxDrop float64  `json:"target_max_drop"`
	RoutedQuality *float64 `json:"routed_quality"`
	QualityDrop   *float64 `json:"quality_drop"`
	// QualityDropCi95 95% bootstrap interval [low, high].
	QualityDropCi95 []float64 `json:"quality_drop_ci95"`
	OffloadRate     *float64  `json:"offload_rate"`
	CostSavingsPct  *float64  `json:"cost_savings_pct"`
	Ece             *float64  `json:"ece"`
	Threshold       *float64  `json:"threshold"`
	Temperature     float64   `json:"temperature"`
	// AdditionalProperties holds members not declared in the schema (round-tripped verbatim).
	AdditionalProperties map[string]any `json:"-"`
}

var knownRouterParetoSummaryFields = map[string]bool{
	"target_max_drop":   true,
	"routed_quality":    true,
	"quality_drop":      true,
	"quality_drop_ci95": true,
	"offload_rate":      true,
	"cost_savings_pct":  true,
	"ece":               true,
	"threshold":         true,
	"temperature":       true,
}

// MarshalJSON encodes declared fields plus AdditionalProperties.
func (m RouterParetoSummary) MarshalJSON() ([]byte, error) {
	type plain RouterParetoSummary
	return MarshalWithAdditional(plain(m), m.AdditionalProperties)
}

// UnmarshalJSON decodes declared fields and keeps the rest in AdditionalProperties.
func (m *RouterParetoSummary) UnmarshalJSON(data []byte) error {
	type plain RouterParetoSummary
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	extra, err := AdditionalFields(data, knownRouterParetoSummaryFields)
	if err != nil {
		return err
	}
	*m = RouterParetoSummary(p)
	m.AdditionalProperties = extra
	return nil
}

// Run is generated from the OpenAPI schema.
type Run struct {
	ID                    string            `json:"id"`
	WorkspaceID           string            `json:"workspace_id"`
	Name                  string            `json:"name"`
	DatasetID             string            `json:"dataset_id"`
	DatasetName           string            `json:"dataset_name"`
	DatasetVersion        int               `json:"dataset_version"`
	RecipeKind            RecipeKind        `json:"recipe_kind"`
	Status                RunStatus         `json:"status"`
	ResolvedConfig        ResolvedRunConfig `json:"resolved_config"`
	MaxCostUSD            *float64          `json:"max_cost_usd"`
	PricePerMillionTokens float64           `json:"price_per_million_tokens"`
	TokensProcessed       int               `json:"tokens_processed"`
	CostUSD               float64           `json:"cost_usd"`
	CurrentStep           int               `json:"current_step"`
	TotalSteps            int               `json:"total_steps"`
	// Attempt Attempts started so far (every start on a worker counts, including ones whose GPU was reclaimed).
	Attempt int `json:"attempt"`
	// MaxAttempts The run fails once this many attempts end without a result (lost worker, worker error, OOM). Attempts whose GPU was reclaimed don't count toward it.
	MaxAttempts      int              `json:"max_attempts"`
	Phase            *RunPhaseType    `json:"phase"`
	PhaseSince       *string          `json:"phase_since"`
	LastInterruption *RunInterruption `json:"last_interruption"`
	// WorkersOnline While queued: workers of this kind holding a lease (all busy). Null otherwise.
	WorkersOnline *int `json:"workers_online"`
	// Autoscaling While queued: true when workers scale from zero (KEDA), so a worker is starting. Null otherwise.
	Autoscaling *bool `json:"autoscaling"`
	// QueuePosition While queued for a worker: about how many runs start before this one. Claims are fair across workspaces (the workspace with the fewest running runs goes next), so this counts other workspaces' runs too. Approximate; null otherwise.
	QueuePosition *int `json:"queue_position"`
	// QueueMessage While queued for a worker: why it waits, ready to show: "Queued behind 3 runs", "Queued: workspace concurrency limit (8 running)" (the workspace runs as many as it may at once), or "Waiting for a GPU with ≥46 GB; online workers have 24 GB". Null when it is next in line, and once it is claimed.
	QueueMessage *string `json:"queue_message"`
	// MinGPUMemoryGb GPU memory (GB) the run needs (its plan's min_gpu_memory_gb): only workers with at least this much claim it. Null when unknown.
	MinGPUMemoryGb *float64     `json:"min_gpu_memory_gb"`
	LatestMetric   *MetricPoint `json:"latest_metric"`
	EvalReport     *EvalReport  `json:"eval_report"`
	// CheckpointEvals recipe.evals results, one per finished eval: a checkpoint (step) on a dataset.
	CheckpointEvals []CheckpointEvalResult `json:"checkpoint_evals"`
	ArtifactID      *string                `json:"artifact_id"`
	Error           *string                `json:"error"`
	CreatedAt       string                 `json:"created_at"`
	UpdatedAt       string                 `json:"updated_at"`
	FinishedAt      *string                `json:"finished_at"`
	// Warnings Only on the response that created the run (POST /v1/runs): the plan's warnings, such as another queued or running run with the same name. They're also the run's first warning events.
	Warnings []string `json:"warnings,omitempty"`
}

// RunEvent is a union of object shapes; set the fields of exactly one variant.
type RunEvent struct {
	Type  RunEventType `json:"type"`
	RunID string       `json:"run_id"`
	// Seq Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq.
	Seq       int       `json:"seq"`
	Attempt   int       `json:"attempt"`
	Timestamp string    `json:"timestamp"`
	Phase     *RunPhase `json:"phase,omitempty"`
	// Step Training step when the phase began (0 before training; the resume step on a resumed attempt).
	Step *int `json:"step,omitempty"`
	// WorkersOnline queued and waiting_for_compute: workers of this job kind holding a lease (all busy; an idle worker would have claimed the run).
	WorkersOnline *int `json:"workers_online,omitempty"`
	// Autoscaling queued and waiting_for_compute: true when workers scale from zero (KEDA), so one is starting rather than missing.
	Autoscaling *bool `json:"autoscaling,omitempty"`
	// QueuePosition queued and waiting_for_compute: about how many runs start before this one when the phase began (fair share across workspaces). Run.queue_position is the live value.
	QueuePosition *int `json:"queue_position,omitempty"`
	// Message queued and waiting_for_compute: why the run waits, ready to show ("Queued behind 3 runs", "Queued: workspace concurrency limit (8 running)", "Waiting for a GPU with ≥46 GB; online workers have 24 GB"). Null when it is next in line.
	Message      *string             `json:"message,omitempty"`
	GPU          *GPUInfo            `json:"gpu,omitempty"`
	Metric       *MetricPoint        `json:"metric,omitempty"`
	CheckpointID *string             `json:"checkpoint_id,omitempty"`
	EvalScore    *float64            `json:"eval_score,omitempty"`
	Format       *ArtifactFormat     `json:"format,omitempty"`
	Event        *RunEventEvent      `json:"event,omitempty"`
	Reason       *InterruptionReason `json:"reason,omitempty"`
	// ResumeStep Checkpoint step to resume from; null starts from scratch.
	ResumeStep  *int       `json:"resume_step,omitempty"`
	MaxAttempts *int       `json:"max_attempts,omitempty"`
	Status      *RunStatus `json:"status,omitempty"`
	Run         *Run       `json:"run,omitempty"`
}

// RunEventEvent is an enumeration of allowed values.
type RunEventEvent string

// Values of RunEventEvent.
const (
	RunEventEventStarted     RunEventEvent = "started"
	RunEventEventInterrupted RunEventEvent = "interrupted"
	RunEventEventGaveUp      RunEventEvent = "gave_up"
)

// RunEventType is an enumeration of allowed values.
type RunEventType string

// Values of RunEventType.
const (
	RunEventTypePhase      RunEventType = "phase"
	RunEventTypeMetric     RunEventType = "metric"
	RunEventTypeCheckpoint RunEventType = "checkpoint"
	RunEventTypeAttempt    RunEventType = "attempt"
	RunEventTypeWarning    RunEventType = "warning"
	RunEventTypeLog        RunEventType = "log"
	RunEventTypeCompleted  RunEventType = "completed"
)

// RunEventsPage is generated from the OpenAPI schema.
type RunEventsPage struct {
	RunID  string     `json:"run_id"`
	Status RunStatus  `json:"status"`
	Data   []RunEvent `json:"data"`
	// NextCursor Pass back as `cursor` for the next page; null on the last page (every list endpoint).
	NextCursor *string `json:"next_cursor"`
	// TailCursor Cursor after the newest event returned so far; pass it back as `cursor` to poll for later events.
	TailCursor string `json:"tail_cursor"`
}

// RunInterruption is generated from the OpenAPI schema.
type RunInterruption struct {
	Attempt    int                `json:"attempt"`
	Reason     InterruptionReason `json:"reason"`
	Step       int                `json:"step"`
	ResumeStep *int               `json:"resume_step"`
	At         string             `json:"at"`
	Message    string             `json:"message"`
}

// RunPhase Where a run is in its lifecycle (on a Run: the latest phase; once the run is terminal, status is authoritative and phase is the last one reached). queued, waiting_for_compute (queued for longer than the server's threshold with no worker claiming it) and starting (a worker claimed it) come from the server; the worker reports the rest. training, evaluating and checkpointing repeat.
type RunPhase string

// Values of RunPhase.
const (
	RunPhaseQueued            RunPhase = "queued"
	RunPhaseWaitingForCompute RunPhase = "waiting_for_compute"
	RunPhaseStarting          RunPhase = "starting"
	RunPhaseLoadingModel      RunPhase = "loading_model"
	RunPhaseTraining          RunPhase = "training"
	RunPhaseEvaluating        RunPhase = "evaluating"
	RunPhaseCheckpointing     RunPhase = "checkpointing"
	RunPhaseUploading         RunPhase = "uploading"
	RunPhaseCompleting        RunPhase = "completing"
)

// RunPhaseType is an enumeration of allowed values.
type RunPhaseType string

// Values of RunPhaseType.
const (
	RunPhaseTypeQueued            RunPhaseType = "queued"
	RunPhaseTypeWaitingForCompute RunPhaseType = "waiting_for_compute"
	RunPhaseTypeStarting          RunPhaseType = "starting"
	RunPhaseTypeLoadingModel      RunPhaseType = "loading_model"
	RunPhaseTypeTraining          RunPhaseType = "training"
	RunPhaseTypeEvaluating        RunPhaseType = "evaluating"
	RunPhaseTypeCheckpointing     RunPhaseType = "checkpointing"
	RunPhaseTypeUploading         RunPhaseType = "uploading"
	RunPhaseTypeCompleting        RunPhaseType = "completing"
)

// RunStatus stopped_budget: the run reached its max_cost_usd (resume with a higher cap). stopped_balance: the workspace ran out of balance on Cloud (top up, then resume; the cap is unchanged). Both keep their checkpoints.
type RunStatus string

// Values of RunStatus.
const (
	RunStatusQueued         RunStatus = "queued"
	RunStatusRunning        RunStatus = "running"
	RunStatusCompleted      RunStatus = "completed"
	RunStatusFailed         RunStatus = "failed"
	RunStatusCancelled      RunStatus = "cancelled"
	RunStatusStoppedBudget  RunStatus = "stopped_budget"
	RunStatusStoppedBalance RunStatus = "stopped_balance"
)

// ScoreDatasetRequest is generated from the OpenAPI schema.
type ScoreDatasetRequest struct {
	Rubric []EvalRubricItem `json:"rubric"`
	// Version Dataset version to score (default: the current version).
	Version *int `json:"version,omitempty"`
	// Name Name of the scoring job (default `<dataset>-score`).
	Name  *string `json:"name,omitempty"`
	Limit *int    `json:"limit,omitempty"`
}

// Secret A workspace secret's metadata. The value is never returned.
type Secret struct {
	// Name Lowercase letters, digits, '.', '_' and '-'; unique per workspace.
	Name        string `json:"name"`
	WorkspaceID string `json:"workspace_id"`
	// AllowedHosts The hosts this secret may be sent to.
	AllowedHosts []string `json:"allowed_hosts"`
	CreatedAt    string   `json:"created_at"`
	UpdatedAt    string   `json:"updated_at"`
}

// SetSecretRequest is generated from the OpenAPI schema.
type SetSecretRequest struct {
	// Name Lowercase letters, digits, '.', '_' and '-'; unique per workspace.
	Name string `json:"name"`
	// Value Write-only: stored encrypted and never returned by any endpoint.
	Value string `json:"value"`
	// AllowedHosts Hosts (`host[:port]`, or URLs) this secret may be sent to: a source's host, huggingface.co for HF imports, a logger's host. Default: the public hosts of the supported providers (cloud.langfuse.com, us.cloud.langfuse.com, api.smith.langchain.com, eu.api.smith.langchain.com, api.braintrust.dev, us.posthog.com, eu.posthog.com, app.phoenix.arize.com, huggingface.co, api.wandb.ai). A secret for a self-hosted tool must name its host. Replacing a secret replaces its hosts.
	AllowedHosts []string `json:"allowed_hosts,omitempty"`
}

// Source An observability provider synced into one dataset. A source feeds exactly one dataset; a dataset can have several sources. Deleting the dataset deletes its sources; removing a source keeps the dataset.
type Source struct {
	ID          string             `json:"id"`
	WorkspaceID string             `json:"workspace_id"`
	Dataset     string             `json:"dataset"`
	Provider    SourceProviderType `json:"provider"`
	Schedule    *string            `json:"schedule"`
	// SampleRate The share of traces synced (1: all).
	SampleRate        float64 `json:"sample_rate"`
	MaxRecordsPerSync *int    `json:"max_records_per_sync"`
	MaxRecordsPerDay  *int    `json:"max_records_per_day"`
	// RecordsToday New traces synced so far this UTC day (what max_records_per_day counts).
	RecordsToday int `json:"records_today"`
	// VersionInterval Seconds between the dataset versions scheduled syncs commit (0: every sync).
	VersionInterval int `json:"version_interval"`
	// PendingRecords Records scheduled syncs fetched that wait for the next dataset version.
	PendingRecords int `json:"pending_records"`
	// NextSyncAt When the schedule fires next (null without a schedule or while paused). After a failed sync the schedule backs off: twice its interval per consecutive failure, at most an hour.
	NextSyncAt *string `json:"next_sync_at"`
	// Status `paused` after 10 consecutive failed syncs: the schedule stops firing. A manual sync, or setting a new value for the source's secret, resumes it.
	Status SourceStatus `json:"status"`
	// PausedReason Why the source is paused (null while active).
	PausedReason *string `json:"paused_reason"`
	// LastError The error of the last failed sync (provider keys redacted); cleared by a successful sync.
	LastError   *string `json:"last_error"`
	LastErrorAt *string `json:"last_error_at"`
	// ConsecutiveFailures Failed syncs since the last successful one.
	ConsecutiveFailures int `json:"consecutive_failures"`
	// PendingFull A full sync was requested while another sync ran; it is queued as soon as that one ends.
	PendingFull bool `json:"pending_full"`
	// LastSyncedAt When the last successful sync finished.
	LastSyncedAt *string     `json:"last_synced_at"`
	LastSync     *SourceSync `json:"last_sync"`
	CreatedAt    string      `json:"created_at"`
	UpdatedAt    string      `json:"updated_at"`
}

// SourceProvider is generated from the OpenAPI schema.
type SourceProvider struct {
	// Kind One of langfuse, langsmith, braintrust, posthog, phoenix, gradiated; anything else is 422 source_provider_unsupported.
	Kind string `json:"kind"`
	// Host The provider's API host (https). Optional for providers with one public host; not used by 'gradiated'.
	Host *string `json:"host,omitempty"`
	// Secret Name of the workspace secret holding the provider key. Not used by 'gradiated'.
	Secret *string `json:"secret,omitempty"`
	// Project The provider project to read. Required for braintrust (project id or name) and posthog (numeric project id); optional elsewhere (LangSmith project, Phoenix project).
	Project *string `json:"project,omitempty"`
	// Filters Which traces to sync; a trace must match every key. Values are a string or a list (any of which matches) unless noted: `tags` (list: every tag), `environment`, `model`, `version`, `release`, `name` (trace name or route), `user_id`, `session_id`, `metadata` (`{key: value}`, each equal), `from`/`to` (ISO 8601: the trace started in [from, to)), `has_feedback` (true: a score or a correction) and `min_score` (a number every score must reach, or `{name: number}`). Score filters are judged on the merged dataset, so feedback that arrives later still counts. LangSmith also takes `filter` (a LangSmith filter expression, AND-ed); gradiated takes `models`, `tasks` and `versions`. Any other key is 422 source_filter_unsupported. The response holds the effective filters (single values as lists).
	Filters map[string]any `json:"filters,omitempty"`
}

// SourceProviderType is generated from the OpenAPI schema.
type SourceProviderType struct {
	Kind    SourceProviderTypeKind `json:"kind"`
	Host    *string                `json:"host"`
	Secret  *string                `json:"secret"`
	Project *string                `json:"project"`
	// Filters The effective filters: validated, with single values as lists.
	Filters map[string]any `json:"filters"`
}

// SourceProviderTypeKind is an enumeration of allowed values.
type SourceProviderTypeKind string

// Values of SourceProviderTypeKind.
const (
	SourceProviderTypeKindLangfuse   SourceProviderTypeKind = "langfuse"
	SourceProviderTypeKindLangsmith  SourceProviderTypeKind = "langsmith"
	SourceProviderTypeKindBraintrust SourceProviderTypeKind = "braintrust"
	SourceProviderTypeKindPosthog    SourceProviderTypeKind = "posthog"
	SourceProviderTypeKindPhoenix    SourceProviderTypeKind = "phoenix"
	SourceProviderTypeKindGradiated  SourceProviderTypeKind = "gradiated"
)

// SourceStatus `paused` after 10 consecutive failed syncs: the schedule stops firing. A manual sync, or setting a new value for the source's secret, resumes it.
type SourceStatus string

// Values of SourceStatus.
const (
	SourceStatusActive SourceStatus = "active"
	SourceStatusPaused SourceStatus = "paused"
)

// SourceSync The most recent sync, running or finished.
type SourceSync struct {
	ImportID       string           `json:"import_id"`
	Status         SourceSyncStatus `json:"status"`
	Full           bool             `json:"full"`
	DatasetVersion *int             `json:"dataset_version"`
	Error          *string          `json:"error"`
	CreatedAt      string           `json:"created_at"`
	FinishedAt     *string          `json:"finished_at"`
}

// SourceSyncStatus is an enumeration of allowed values.
type SourceSyncStatus string

// Values of SourceSyncStatus.
const (
	SourceSyncStatusQueued    SourceSyncStatus = "queued"
	SourceSyncStatusRunning   SourceSyncStatus = "running"
	SourceSyncStatusCompleted SourceSyncStatus = "completed"
	SourceSyncStatusFailed    SourceSyncStatus = "failed"
)

// SplitSpec is generated from the OpenAPI schema.
type SplitSpec struct {
	Strategy     *SplitSpecStrategy `json:"strategy,omitempty"`
	EvalFraction *float64           `json:"eval_fraction,omitempty"`
	Seed         *int               `json:"seed,omitempty"`
}

// SplitSpecStrategy is an enumeration of allowed values.
type SplitSpecStrategy string

// Values of SplitSpecStrategy.
const (
	SplitSpecStrategyBySession SplitSpecStrategy = "by_session"
	SplitSpecStrategyByGroup   SplitSpecStrategy = "by_group"
	SplitSpecStrategyRandom    SplitSpecStrategy = "random"
)

// SyncSourceRequest is generated from the OpenAPI schema.
type SyncSourceRequest struct {
	// Full Rebuild the dataset from the provider as a new version (ignores the stored watermark).
	Full *bool `json:"full,omitempty"`
}

// TrainableModel is generated from the OpenAPI schema.
type TrainableModel struct {
	ID                       string                       `json:"id"`
	HFRepo                   *string                      `json:"hf_repo"`
	Family                   TrainableModelFamily         `json:"family"`
	Adapters                 []TrainableModelAdaptersItem `json:"adapters"`
	Recipes                  []RecipeKind                 `json:"recipes"`
	DefaultFor               []RecipeKind                 `json:"default_for"`
	PricePerMillionTokensUSD float64                      `json:"price_per_million_tokens_usd"`
	MaxContextTokens         int                          `json:"max_context_tokens"`
	TemplateRevision         string                       `json:"template_revision"`
	CalibratedLrs            map[string]float64           `json:"calibrated_lrs"`
	// MinGPUMemoryGb GPU memory (GB) training this base needs at the recipe defaults, measured on an H100 80 GB. v0 trains on one GPU, and runs.plan refuses (422 model_exceeds_gpu_memory) a run that needs more than 80 GB. Null when unknown.
	MinGPUMemoryGb *float64 `json:"min_gpu_memory_gb"`
}

// TrainableModelAdaptersItem is an enumeration of allowed values.
type TrainableModelAdaptersItem string

// Values of TrainableModelAdaptersItem.
const (
	TrainableModelAdaptersItemLora        TrainableModelAdaptersItem = "lora"
	TrainableModelAdaptersItemPrefixKv    TrainableModelAdaptersItem = "prefix_kv"
	TrainableModelAdaptersItemFrozenHead  TrainableModelAdaptersItem = "frozen_head"
	TrainableModelAdaptersItemEncoderFull TrainableModelAdaptersItem = "encoder_full"
)

// TrainableModelFamily is an enumeration of allowed values.
type TrainableModelFamily string

// Values of TrainableModelFamily.
const (
	TrainableModelFamilyLlm     TrainableModelFamily = "llm"
	TrainableModelFamilyEncoder TrainableModelFamily = "encoder"
)

// TrajectoryInput is generated from the OpenAPI schema.
type TrajectoryInput struct {
	Messages []ChatMessage    `json:"messages,omitempty"`
	Tools    []map[string]any `json:"tools,omitempty"`
	Media    []map[string]any `json:"media,omitempty"`
	Features map[string]any   `json:"features,omitempty"`
	Payload  any              `json:"payload,omitempty"`
	// AdditionalProperties holds members not declared in the schema (round-tripped verbatim).
	AdditionalProperties map[string]any `json:"-"`
}

var knownTrajectoryInputFields = map[string]bool{
	"messages": true,
	"tools":    true,
	"media":    true,
	"features": true,
	"payload":  true,
}

// MarshalJSON encodes declared fields plus AdditionalProperties.
func (m TrajectoryInput) MarshalJSON() ([]byte, error) {
	type plain TrajectoryInput
	return MarshalWithAdditional(plain(m), m.AdditionalProperties)
}

// UnmarshalJSON decodes declared fields and keeps the rest in AdditionalProperties.
func (m *TrajectoryInput) UnmarshalJSON(data []byte) error {
	type plain TrajectoryInput
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	extra, err := AdditionalFields(data, knownTrajectoryInputFields)
	if err != nil {
		return err
	}
	*m = TrajectoryInput(p)
	m.AdditionalProperties = extra
	return nil
}

// TrajectoryOutput is generated from the OpenAPI schema.
type TrajectoryOutput struct {
	Turns   []ChatMessage `json:"turns,omitempty"`
	Payload any           `json:"payload,omitempty"`
	// AdditionalProperties holds members not declared in the schema (round-tripped verbatim).
	AdditionalProperties map[string]any `json:"-"`
}

var knownTrajectoryOutputFields = map[string]bool{
	"turns":   true,
	"payload": true,
}

// MarshalJSON encodes declared fields plus AdditionalProperties.
func (m TrajectoryOutput) MarshalJSON() ([]byte, error) {
	type plain TrajectoryOutput
	return MarshalWithAdditional(plain(m), m.AdditionalProperties)
}

// UnmarshalJSON decodes declared fields and keeps the rest in AdditionalProperties.
func (m *TrajectoryOutput) UnmarshalJSON(data []byte) error {
	type plain TrajectoryOutput
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	extra, err := AdditionalFields(data, knownTrajectoryOutputFields)
	if err != nil {
		return err
	}
	*m = TrajectoryOutput(p)
	m.AdditionalProperties = extra
	return nil
}

// UpdateSourceRequest Fields left out keep their value. Changes apply from the next sync; traces already synced stay (a full sync rebuilds the dataset with the new settings).
type UpdateSourceRequest struct {
	// Filters Replaces the source's filters ({} clears them). Which traces to sync; a trace must match every key. Values are a string or a list (any of which matches) unless noted: `tags` (list: every tag), `environment`, `model`, `version`, `release`, `name` (trace name or route), `user_id`, `session_id`, `metadata` (`{key: value}`, each equal), `from`/`to` (ISO 8601: the trace started in [from, to)), `has_feedback` (true: a score or a correction) and `min_score` (a number every score must reach, or `{name: number}`). Score filters are judged on the merged dataset, so feedback that arrives later still counts. LangSmith also takes `filter` (a LangSmith filter expression, AND-ed); gradiated takes `models`, `tasks` and `versions`. Any other key is 422 source_filter_unsupported. The response holds the effective filters (single values as lists).
	Filters map[string]any `json:"filters,omitempty"`
	// Schedule Five-field cron in UTC (`*/15 * * * *`); minute resolution, so it fires at most once a minute (a seconds field is rejected). Leave it out to sync only on request.
	Schedule *string `json:"schedule,omitempty"`
	// SampleRate The share of traces to sync, chosen by a hash of the trace id: re-syncs keep the same sample, and a trace's feedback follows it. Default 1.
	SampleRate *float64 `json:"sample_rate,omitempty"`
	// MaxRecordsPerSync At most this many new traces per sync; the rest are not synced (the sync's drop reasons count them). Feedback on traces already synced always lands. Null: no cap.
	MaxRecordsPerSync *int `json:"max_records_per_sync,omitempty"`
	// MaxRecordsPerDay At most this many new traces per UTC day; the rest are not synced (the sync's drop reasons count them). Feedback on traces already synced always lands. Null: no cap.
	MaxRecordsPerDay *int `json:"max_records_per_day,omitempty"`
	// VersionInterval Seconds between the dataset versions scheduled syncs commit (default 900). A scheduled sync may fetch every minute; its parts wait, staged, until the interval has passed or enough records are waiting, so a busy source doesn't add a version a minute. 0: every sync commits. Manual and full syncs always commit.
	VersionInterval *int `json:"version_interval,omitempty"`
}

// UploadTicket is generated from the OpenAPI schema.
type UploadTicket struct {
	// UploadID The file's sha256: uploads are content-addressed, so re-uploading the same bytes is harmless.
	UploadID string             `json:"upload_id"`
	Method   UploadTicketMethod `json:"method"`
	// URL Presigned S3 PUT URL; send exactly `headers` (they bind the length and sha256).
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt string            `json:"expires_at"`
}

// UploadTicketMethod is an enumeration of allowed values.
type UploadTicketMethod string

// Values of UploadTicketMethod.
const (
	UploadTicketMethodPut UploadTicketMethod = "PUT"
)

// UsageGroup is generated from the OpenAPI schema.
type UsageGroup struct {
	// Key The group: a UTC day or week start (YYYY-MM-DD), a month (YYYY-MM), a model, a recipe or a kind. Null for usage with no recipe (plain evals, scoring).
	Key     *string `json:"key"`
	CostUSD float64 `json:"cost_usd"`
	Tokens  int     `json:"tokens"`
	Records int     `json:"records"`
}

// UsageGroupBy is an enumeration of allowed values.
type UsageGroupBy string

// Values of UsageGroupBy.
const (
	UsageGroupByDay    UsageGroupBy = "day"
	UsageGroupByWeek   UsageGroupBy = "week"
	UsageGroupByMonth  UsageGroupBy = "month"
	UsageGroupByModel  UsageGroupBy = "model"
	UsageGroupByRecipe UsageGroupBy = "recipe"
	UsageGroupByKind   UsageGroupBy = "kind"
)

// UsageKind What the tokens paid for: `training` (a run's attempts), `eval` (evals, including a run's checkpoint evals), `scoring` (dataset.score), `labeling` (a router run's labeling eval) or `teacher` (an off-policy distill run's teacher answers).
type UsageKind string

// Values of UsageKind.
const (
	UsageKindTraining UsageKind = "training"
	UsageKindEval     UsageKind = "eval"
	UsageKindScoring  UsageKind = "scoring"
	UsageKindLabeling UsageKind = "labeling"
	UsageKindTeacher  UsageKind = "teacher"
)

// UsageKindTotal is generated from the OpenAPI schema.
type UsageKindTotal struct {
	Kind    UsageKind `json:"kind"`
	CostUSD float64   `json:"cost_usd"`
	Tokens  int       `json:"tokens"`
	Records int       `json:"records"`
}

// UsageRecord is generated from the OpenAPI schema.
type UsageRecord struct {
	ID   string    `json:"id"`
	Kind UsageKind `json:"kind"`
	// RefID The run (kind `training`) or eval this usage belongs to.
	RefID   string  `json:"ref_id"`
	RefName *string `json:"ref_name"`
	// RunID The run the usage was billed for: the run itself, or the run whose labeling, teacher or checkpoint eval it is.
	RunID   *string `json:"run_id"`
	Attempt int     `json:"attempt"`
	// TokensFrom The attempt's tokens this row starts after (usage is billed in increments while an attempt runs).
	TokensFrom     int     `json:"tokens_from"`
	TokensThrough  int     `json:"tokens_through"`
	Tokens         int     `json:"tokens"`
	CostUSD        float64 `json:"cost_usd"`
	PriceVersion   string  `json:"price_version"`
	IdempotencyKey string  `json:"idempotency_key"`
	CreatedAt      string  `json:"created_at"`
}

// UsageRefTotal is generated from the OpenAPI schema.
type UsageRefTotal struct {
	ID      string    `json:"id"`
	Name    *string   `json:"name"`
	Kind    UsageKind `json:"kind"`
	CostUSD float64   `json:"cost_usd"`
	Tokens  int       `json:"tokens"`
}

// UsageSummary is generated from the OpenAPI schema.
type UsageSummary struct {
	// From Start of the period (inclusive).
	From string `json:"from"`
	// To End of the period (exclusive).
	To      string  `json:"to"`
	CostUSD float64 `json:"cost_usd"`
	Tokens  int     `json:"tokens"`
	Records int     `json:"records"`
	// ByKind One entry per kind with usage, costliest first.
	ByKind []UsageKindTotal `json:"by_kind"`
	// TopRuns The costliest runs' training in the period (up to 5).
	TopRuns []UsageRefTotal `json:"top_runs"`
	// TopEvals The costliest evals, scoring, labeling and teacher jobs in the period (up to 5).
	TopEvals []UsageRefTotal `json:"top_evals"`
	GroupBy  *UsageGroupBy   `json:"group_by"`
	// Groups With group_by: one entry per group with usage, oldest first for time groups and costliest first otherwise.
	Groups []UsageGroup `json:"groups"`
}

// WarningEvent is generated from the OpenAPI schema.
type WarningEvent struct {
	Type  WarningEventType `json:"type"`
	RunID string           `json:"run_id"`
	// Seq Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq.
	Seq       int    `json:"seq"`
	Attempt   int    `json:"attempt"`
	Timestamp string `json:"timestamp"`
	Step      *int   `json:"step"`
	Message   string `json:"message"`
}

// WarningEventType is an enumeration of allowed values.
type WarningEventType string

// Values of WarningEventType.
const (
	WarningEventTypeWarning WarningEventType = "warning"
)
