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

// APIKeyScope is an enumeration of allowed values.
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
	EvalReport   map[string]any  `json:"eval_report"`
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
	ArtifactFormatReference          ArtifactFormat = "reference"
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

// BenchmarkSpec is generated from the OpenAPI schema.
type BenchmarkSpec struct {
	Name  BenchmarkSpecName `json:"name"`
	Limit *int              `json:"limit,omitempty"`
}

// BenchmarkSpecName is an enumeration of allowed values.
type BenchmarkSpecName string

// Values of BenchmarkSpecName.
const (
	BenchmarkSpecNameIfeval        BenchmarkSpecName = "ifeval"
	BenchmarkSpecNameGsm8k         BenchmarkSpecName = "gsm8k"
	BenchmarkSpecNameMmluPro       BenchmarkSpecName = "mmlu-pro"
	BenchmarkSpecNameGpqaDiamond   BenchmarkSpecName = "gpqa-diamond"
	BenchmarkSpecNameHumaneval     BenchmarkSpecName = "humaneval"
	BenchmarkSpecNameLivecodebench BenchmarkSpecName = "livecodebench"
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

// ClaimEnvTaskRequest is generated from the OpenAPI schema.
type ClaimEnvTaskRequest struct {
	WorkerID string `json:"worker_id"`
	WaitMs   *int   `json:"wait_ms,omitempty"`
}

// ClaimEnvTaskResponse is generated from the OpenAPI schema.
type ClaimEnvTaskResponse struct {
	Task map[string]any `json:"task"`
}

// ClaimJobRequest is generated from the OpenAPI schema.
type ClaimJobRequest struct {
	WorkerID     string    `json:"worker_id"`
	LeaseSeconds *int      `json:"lease_seconds,omitempty"`
	Kinds        []JobKind `json:"kinds,omitempty"`
	// Recipes Recipe kinds this worker can run; train jobs for other recipes are left queued.
	Recipes []RecipeKind `json:"recipes,omitempty"`
}

// ClaimJobResponse is generated from the OpenAPI schema.
type ClaimJobResponse struct {
	Protocol ClaimJobResponseProtocol `json:"protocol"`
	Job      *TrainerJob              `json:"job"`
}

// ClaimJobResponseProtocol is an enumeration of allowed values.
type ClaimJobResponseProtocol string

// Values of ClaimJobResponseProtocol.
const (
	ClaimJobResponseProtocolGradTrainerProtocol1 ClaimJobResponseProtocol = "grad.trainer-protocol/1"
)

// CompleteTrainerJobRequest is generated from the OpenAPI schema.
type CompleteTrainerJobRequest struct {
	WorkerID string `json:"worker_id"`
	Attempt  int    `json:"attempt"`
	// Status `abandoned` releases the lease (worker shutdown) and requeues the job without counting a failure.
	Status          CompleteTrainerJobRequestStatus         `json:"status"`
	UploadID        *string                                 `json:"upload_id,omitempty"`
	Format          *ArtifactFormat                         `json:"format,omitempty"`
	Manifest        map[string]any                          `json:"manifest,omitempty"`
	EvalReport      map[string]any                          `json:"eval_report,omitempty"`
	TokensProcessed *int                                    `json:"tokens_processed,omitempty"`
	Error           *string                                 `json:"error,omitempty"`
	ImportSummary   *CompleteTrainerJobRequestImportSummary `json:"import_summary,omitempty"`
}

// CompleteTrainerJobRequestImportSummary is generated from the OpenAPI schema.
type CompleteTrainerJobRequestImportSummary struct {
	DroppedCount   *int     `json:"dropped_count,omitempty"`
	DetectedScores []string `json:"detected_scores,omitempty"`
	DropReasons    []string `json:"drop_reasons,omitempty"`
}

// CompleteTrainerJobRequestStatus `abandoned` releases the lease (worker shutdown) and requeues the job without counting a failure.
type CompleteTrainerJobRequestStatus string

// Values of CompleteTrainerJobRequestStatus.
const (
	CompleteTrainerJobRequestStatusCompleted     CompleteTrainerJobRequestStatus = "completed"
	CompleteTrainerJobRequestStatusStoppedBudget CompleteTrainerJobRequestStatus = "stopped_budget"
	CompleteTrainerJobRequestStatusFailed        CompleteTrainerJobRequestStatus = "failed"
	CompleteTrainerJobRequestStatusCancelled     CompleteTrainerJobRequestStatus = "cancelled"
	CompleteTrainerJobRequestStatusAbandoned     CompleteTrainerJobRequestStatus = "abandoned"
)

// CompleteTrainerJobResponse is generated from the OpenAPI schema.
type CompleteTrainerJobResponse struct {
	JobID    string     `json:"job_id"`
	Kind     JobKind    `json:"kind"`
	Status   string     `json:"status"`
	Run      *Run       `json:"run"`
	Artifact *Artifact  `json:"artifact"`
	Import   *ImportJob `json:"import"`
}

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
	ID          string         `json:"id"`
	WorkspaceID string         `json:"workspace_id"`
	Name        string         `json:"name"`
	Version     int            `json:"version"`
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
	Dataset    string          `json:"dataset"`
	Version    int             `json:"version"`
	Total      int             `json:"total"`
	Data       []DatasetRecord `json:"data"`
	NextCursor *string         `json:"next_cursor"`
}

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

// DispatchEnvTaskResponse is generated from the OpenAPI schema.
type DispatchEnvTaskResponse struct {
	ID            string `json:"id"`
	EnvName       string `json:"env_name"`
	Status        string `json:"status"`
	ActiveWorkers int    `json:"active_workers"`
}

// DownloadTrainerDatasetParams holds the query and header parameters of DownloadTrainerDataset.
type DownloadTrainerDatasetParams struct {
	Attempt int
}

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

// EnvTaskDispatch is generated from the OpenAPI schema.
type EnvTaskDispatch struct {
	EnvName      string         `json:"env_name"`
	Task         map[string]any `json:"task"`
	ModelID      string         `json:"model_id"`
	SystemPrompt *string        `json:"system_prompt,omitempty"`
	TimeoutS     *int           `json:"timeout_s,omitempty"`
}

// EnvTaskResult is generated from the OpenAPI schema.
type EnvTaskResult struct {
	WorkerID   string             `json:"worker_id"`
	Score      *float64           `json:"score,omitempty"`
	Scores     map[string]float64 `json:"scores,omitempty"`
	Trajectory map[string]any     `json:"trajectory,omitempty"`
	Error      *string            `json:"error,omitempty"`
}

// EnvWorkerRegister is generated from the OpenAPI schema.
type EnvWorkerRegister struct {
	Name        string `json:"name"`
	WorkerID    string `json:"worker_id"`
	Concurrency *int   `json:"concurrency,omitempty"`
}

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
	EvalRubricItemValidatorJSON       EvalRubricItemValidator = "json"
	EvalRubricItemValidatorNonEmpty   EvalRubricItemValidator = "non_empty"
	EvalRubricItemValidatorExactMatch EvalRubricItemValidator = "exact_match"
)

// EvalRun is generated from the OpenAPI schema.
type EvalRun struct {
	ID            string             `json:"id"`
	WorkspaceID   string             `json:"workspace_id"`
	Name          string             `json:"name"`
	Status        EvalStatus         `json:"status"`
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
	Error         *string            `json:"error"`
	CreatedAt     string             `json:"created_at"`
	UpdatedAt     string             `json:"updated_at"`
	CompletedAt   *string            `json:"completed_at"`
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
	ID             string             `json:"id"`
	WorkspaceID    string             `json:"workspace_id"`
	Dataset        string             `json:"dataset"`
	Status         ImportStatus       `json:"status"`
	Source         map[string]any     `json:"source"`
	Connector      ImportJobConnector `json:"connector"`
	Attempt        int                `json:"attempt"`
	ImportedCount  int                `json:"imported_count"`
	DroppedCount   int                `json:"dropped_count"`
	DetectedScores []string           `json:"detected_scores"`
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
}

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
	ImportSourceKindUpload ImportSourceKind = "upload"
	ImportSourceKindHF     ImportSourceKind = "hf"
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

// JobKind is an enumeration of allowed values.
type JobKind string

// Values of JobKind.
const (
	JobKindTrain  JobKind = "train"
	JobKindImport JobKind = "import"
)

// ListAPIKeysParams holds the query and header parameters of ListAPIKeys.
type ListAPIKeysParams struct {
	Limit  *int
	Cursor *string
}

// ListAPIKeysResponse is generated from the OpenAPI schema.
type ListAPIKeysResponse struct {
	Data       []APIKey `json:"data"`
	NextCursor *string  `json:"next_cursor"`
}

// ListArtifactsParams holds the query and header parameters of ListArtifacts.
type ListArtifactsParams struct {
	Limit  *int
	Cursor *string
	Name   *string
}

// ListArtifactsResponse is generated from the OpenAPI schema.
type ListArtifactsResponse struct {
	Data       []Artifact `json:"data"`
	NextCursor *string    `json:"next_cursor"`
}

// ListDatasetRecordsParams holds the query and header parameters of ListDatasetRecords.
type ListDatasetRecordsParams struct {
	Version *int
	Limit   *int
	Cursor  *string
}

// ListDatasetsParams holds the query and header parameters of ListDatasets.
type ListDatasetsParams struct {
	Limit  *int
	Cursor *string
}

// ListDatasetsResponse is generated from the OpenAPI schema.
type ListDatasetsResponse struct {
	Data       []Dataset `json:"data"`
	NextCursor *string   `json:"next_cursor"`
}

// ListDeploymentsParams holds the query and header parameters of ListDeployments.
type ListDeploymentsParams struct {
	Limit  *int
	Cursor *string
}

// ListDeploymentsResponse is generated from the OpenAPI schema.
type ListDeploymentsResponse struct {
	Data       []Deployment `json:"data"`
	NextCursor *string      `json:"next_cursor"`
}

// ListEvalFailuresParams holds the query and header parameters of ListEvalFailures.
type ListEvalFailuresParams struct {
	Limit     *int
	Cursor    *string
	Model     *string
	Threshold *float64
}

// ListEvalFailuresResponse is generated from the OpenAPI schema.
type ListEvalFailuresResponse struct {
	EvalID     string            `json:"eval_id"`
	Data       []EvalTaskOutcome `json:"data"`
	NextCursor *string           `json:"next_cursor"`
}

// ListEvalOutputsParams holds the query and header parameters of ListEvalOutputs.
type ListEvalOutputsParams struct {
	Limit         *int
	Cursor        *string
	Model         *string
	MissingScorer *string
}

// ListEvalOutputsResponse is generated from the OpenAPI schema.
type ListEvalOutputsResponse struct {
	Data       []EvalOutput `json:"data"`
	NextCursor *string      `json:"next_cursor"`
}

// ListEvalResultsParams holds the query and header parameters of ListEvalResults.
type ListEvalResultsParams struct {
	Limit  *int
	Cursor *string
	Model  *string
}

// ListEvalResultsResponse is generated from the OpenAPI schema.
type ListEvalResultsResponse struct {
	Data       []EvalTaskOutcome `json:"data"`
	NextCursor *string           `json:"next_cursor"`
}

// ListEvalsParams holds the query and header parameters of ListEvals.
type ListEvalsParams struct {
	Limit  *int
	Cursor *string
}

// ListEvalsResponse is generated from the OpenAPI schema.
type ListEvalsResponse struct {
	Data       []EvalRun `json:"data"`
	NextCursor *string   `json:"next_cursor"`
}

// ListImportsParams holds the query and header parameters of ListImports.
type ListImportsParams struct {
	Limit  *int
	Cursor *string
}

// ListImportsResponse is generated from the OpenAPI schema.
type ListImportsResponse struct {
	Data       []ImportJob `json:"data"`
	NextCursor *string     `json:"next_cursor"`
}

// ListModelsResponse is generated from the OpenAPI schema.
type ListModelsResponse struct {
	Data []TrainableModel `json:"data"`
}

// ListRunCheckpointsParams holds the query and header parameters of ListRunCheckpoints.
type ListRunCheckpointsParams struct {
	Limit  *int
	Cursor *string
}

// ListRunCheckpointsResponse is generated from the OpenAPI schema.
type ListRunCheckpointsResponse struct {
	Data       []Checkpoint `json:"data"`
	NextCursor *string      `json:"next_cursor"`
}

// ListRunMetricsParams holds the query and header parameters of ListRunMetrics.
type ListRunMetricsParams struct {
	Cursor    *string
	AfterStep *int
	Limit     *int
}

// ListRunsParams holds the query and header parameters of ListRuns.
type ListRunsParams struct {
	Limit  *int
	Cursor *string
}

// ListRunsResponse is generated from the OpenAPI schema.
type ListRunsResponse struct {
	Data       []Run   `json:"data"`
	NextCursor *string `json:"next_cursor"`
}

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

// MetricPoint is generated from the OpenAPI schema.
type MetricPoint struct {
	Seq          int      `json:"seq"`
	Attempt      int      `json:"attempt"`
	Step         int      `json:"step"`
	Loss         float64  `json:"loss"`
	EvalLoss     *float64 `json:"eval_loss,omitempty"`
	EvalMetric   *float64 `json:"eval_metric,omitempty"`
	GradNorm     *float64 `json:"grad_norm,omitempty"`
	LR           *float64 `json:"lr,omitempty"`
	TokensPerSec *float64 `json:"tokens_per_sec,omitempty"`
	Tokens       int      `json:"tokens"`
	CostUSD      float64  `json:"cost_usd"`
	Timestamp    string   `json:"timestamp"`
	// AdditionalProperties holds members not declared in the schema (round-tripped verbatim).
	AdditionalProperties map[string]any `json:"-"`
}

var knownMetricPointFields = map[string]bool{
	"seq":            true,
	"attempt":        true,
	"step":           true,
	"loss":           true,
	"eval_loss":      true,
	"eval_metric":    true,
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

// MetricPointInput is generated from the OpenAPI schema.
type MetricPointInput struct {
	Step         int      `json:"step"`
	Loss         float64  `json:"loss"`
	EvalLoss     *float64 `json:"eval_loss,omitempty"`
	EvalMetric   *float64 `json:"eval_metric,omitempty"`
	GradNorm     *float64 `json:"grad_norm,omitempty"`
	LR           *float64 `json:"lr,omitempty"`
	TokensPerSec *float64 `json:"tokens_per_sec,omitempty"`
	Tokens       int      `json:"tokens"`
	CostUSD      *float64 `json:"cost_usd,omitempty"`
	Timestamp    string   `json:"timestamp"`
	// AdditionalProperties holds members not declared in the schema (round-tripped verbatim).
	AdditionalProperties map[string]any `json:"-"`
}

var knownMetricPointInputFields = map[string]bool{
	"step":           true,
	"loss":           true,
	"eval_loss":      true,
	"eval_metric":    true,
	"grad_norm":      true,
	"lr":             true,
	"tokens_per_sec": true,
	"tokens":         true,
	"cost_usd":       true,
	"timestamp":      true,
}

// MarshalJSON encodes declared fields plus AdditionalProperties.
func (m MetricPointInput) MarshalJSON() ([]byte, error) {
	type plain MetricPointInput
	return MarshalWithAdditional(plain(m), m.AdditionalProperties)
}

// UnmarshalJSON decodes declared fields and keeps the rest in AdditionalProperties.
func (m *MetricPointInput) UnmarshalJSON(data []byte) error {
	type plain MetricPointInput
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	extra, err := AdditionalFields(data, knownMetricPointInputFields)
	if err != nil {
		return err
	}
	*m = MetricPointInput(p)
	m.AdditionalProperties = extra
	return nil
}

// MetricsPage is generated from the OpenAPI schema.
type MetricsPage struct {
	RunID      string        `json:"run_id"`
	Status     RunStatus     `json:"status"`
	Data       []MetricPoint `json:"data"`
	NextCursor *string       `json:"next_cursor"`
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

// PlanEvalRequest is generated from the OpenAPI schema.
type PlanEvalRequest struct {
	Name           *string          `json:"name,omitempty"`
	Models         []string         `json:"models"`
	Baseline       *string          `json:"baseline,omitempty"`
	Dataset        *string          `json:"dataset,omitempty"`
	DatasetVersion *int             `json:"dataset_version,omitempty"`
	EnvName        *string          `json:"env_name,omitempty"`
	Tasks          []map[string]any `json:"tasks,omitempty"`
	Benchmarks     []BenchmarkSpec  `json:"benchmarks,omitempty"`
	Rubric         []EvalRubricItem `json:"rubric,omitempty"`
	Samples        *int             `json:"samples,omitempty"`
	Temperature    *float64         `json:"temperature,omitempty"`
	MaxTokens      *int             `json:"max_tokens,omitempty"`
	Limit          *int             `json:"limit,omitempty"`
	// PassThreshold Defaults to 1.0 when every rubric item is binary (regex/validator) and 0.5 otherwise.
	PassThreshold *float64 `json:"pass_threshold,omitempty"`
	MaxCostUSD    *float64 `json:"max_cost_usd,omitempty"`
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
	// DependsOn Chained run (run.then(...)): starts from this run's artifact once it completes and is cancelled if it fails. Omit recipe.model.
	DependsOn *string `json:"depends_on,omitempty"`
}

// PlanRunResponse is generated from the OpenAPI schema.
type PlanRunResponse struct {
	ResolvedConfig        ResolvedRunConfig `json:"resolved_config"`
	DatasetVersion        int               `json:"dataset_version"`
	UsableRecords         int               `json:"usable_records"`
	TotalRecords          int               `json:"total_records"`
	EstimatedSteps        int               `json:"estimated_steps"`
	EstimatedTokens       int               `json:"estimated_tokens"`
	EstimatedCostUSD      float64           `json:"estimated_cost_usd"`
	PricePerMillionTokens float64           `json:"price_per_million_tokens"`
	TrainedTokenFraction  float64           `json:"trained_token_fraction"`
	Warnings              []string          `json:"warnings"`
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

// PostImportRecordsRequest is generated from the OpenAPI schema.
type PostImportRecordsRequest struct {
	WorkerID string `json:"worker_id"`
	Attempt  int    `json:"attempt"`
	Records  []any  `json:"records"`
}

// PostImportRecordsResponse is generated from the OpenAPI schema.
type PostImportRecordsResponse struct {
	Accepted int                                   `json:"accepted"`
	Rejected int                                   `json:"rejected"`
	Errors   []PostImportRecordsResponseErrorsItem `json:"errors"`
}

// PostImportRecordsResponseErrorsItem is generated from the OpenAPI schema.
type PostImportRecordsResponseErrorsItem struct {
	Index int    `json:"index"`
	Error string `json:"error"`
}

// Problem is generated from the OpenAPI schema.
type Problem struct {
	Type      string `json:"type"`
	Title     string `json:"title"`
	Status    int    `json:"status"`
	Detail    string `json:"detail"`
	Code      string `json:"code"`
	RequestID string `json:"request_id"`
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
	ContextURI        *string              `json:"context_uri,omitempty"`
	NumTokens         *int                 `json:"num_tokens,omitempty"`
	Temp              *float64             `json:"temp,omitempty"`
	Teacher           *string              `json:"teacher,omitempty"`
	EnvName           *string              `json:"env_name,omitempty"`
	GroupSize         *int                 `json:"group_size,omitempty"`
	Optimizer         *OptimizerSpec       `json:"optimizer,omitempty"`
	// EvalEvery Optimizer steps between held-out evaluations; auto = every 10% of steps (the checkpoint interval).
	EvalEvery any          `json:"eval_every,omitempty"`
	Loss      *LossSpec    `json:"loss,omitempty"`
	Pool      *PoolingSpec `json:"pool,omitempty"`
	// Rubric RouterRecipe: the score name on your records that measures quality (scores[rubric]).
	Rubric *string `json:"rubric,omitempty"`
	// Pricing RouterRecipe: USD per request for each candidate; overrides metrics.cost_usd on your records.
	Pricing map[string]float64 `json:"pricing,omitempty"`
	// Fallback RouterRecipe: the candidate that gets every request the router does not offload (default: the best-scoring candidate).
	Fallback *string `json:"fallback,omitempty"`
	// MaxNewTokens CartridgeRecipe: teacher answer length per prompt during distillation (default 256).
	MaxNewTokens *int `json:"max_new_tokens,omitempty"`
	// SlotToken CartridgeRecipe: a reserved token that marks where the cartridge goes (default: the first reserved token that tokenizes atomically).
	SlotToken *string `json:"slot_token,omitempty"`
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

// RegisterEnvWorkerResponse is generated from the OpenAPI schema.
type RegisterEnvWorkerResponse struct {
	Name            string `json:"name"`
	WorkerID        string `json:"worker_id"`
	Concurrency     int    `json:"concurrency"`
	LastHeartbeatAt string `json:"last_heartbeat_at"`
}

// RegisterTrainerCheckpointRequest is generated from the OpenAPI schema.
type RegisterTrainerCheckpointRequest struct {
	WorkerID  string          `json:"worker_id"`
	Attempt   int             `json:"attempt"`
	Step      int             `json:"step"`
	EvalScore *float64        `json:"eval_score,omitempty"`
	UploadID  string          `json:"upload_id"`
	Format    *ArtifactFormat `json:"format,omitempty"`
	Metadata  map[string]any  `json:"metadata,omitempty"`
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
	Dataset          string                              `json:"dataset"`
	Model            string                              `json:"model"`
	TemplateRevision string                              `json:"template_revision"`
	TokenCounts      RenderDatasetResponseTokenCounts    `json:"token_counts"`
	Examples         []RenderDatasetResponseExamplesItem `json:"examples"`
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

// RenderDatasetResponseTokenCounts is an enumeration of allowed values.
type RenderDatasetResponseTokenCounts string

// Values of RenderDatasetResponseTokenCounts.
const (
	RenderDatasetResponseTokenCountsEstimated RenderDatasetResponseTokenCounts = "estimated"
)

// ReportTrainerProgressRequest is generated from the OpenAPI schema.
type ReportTrainerProgressRequest struct {
	WorkerID string           `json:"worker_id"`
	Attempt  int              `json:"attempt"`
	Metric   MetricPointInput `json:"metric"`
}

// ReportTrainerProgressResponse is generated from the OpenAPI schema.
type ReportTrainerProgressResponse struct {
	Status     RunStatus                                `json:"status"`
	ShouldStop bool                                     `json:"should_stop"`
	StopReason *ReportTrainerProgressResponseStopReason `json:"stop_reason"`
	CostUSD    float64                                  `json:"cost_usd"`
}

// ReportTrainerProgressResponseStopReason is an enumeration of allowed values.
type ReportTrainerProgressResponseStopReason string

// Values of ReportTrainerProgressResponseStopReason.
const (
	ReportTrainerProgressResponseStopReasonCancelled ReportTrainerProgressResponseStopReason = "cancelled"
	ReportTrainerProgressResponseStopReasonBudget    ReportTrainerProgressResponseStopReason = "budget"
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
	BaseArtifact         *BaseArtifact              `json:"base_artifact"`
	RecipeParams         map[string]any             `json:"recipe_params"`
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
	Attempt               int               `json:"attempt"`
	MaxAttempts           int               `json:"max_attempts"`
	LatestMetric          *MetricPoint      `json:"latest_metric"`
	EvalReport            map[string]any    `json:"eval_report"`
	ArtifactID            *string           `json:"artifact_id"`
	// DependsOn The run this chained run starts from; it stays queued until that run completes.
	DependsOn  *string `json:"depends_on"`
	Error      *string `json:"error"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
	FinishedAt *string `json:"finished_at"`
}

// RunStatus is an enumeration of allowed values.
type RunStatus string

// Values of RunStatus.
const (
	RunStatusQueued        RunStatus = "queued"
	RunStatusRunning       RunStatus = "running"
	RunStatusCompleted     RunStatus = "completed"
	RunStatusFailed        RunStatus = "failed"
	RunStatusCancelled     RunStatus = "cancelled"
	RunStatusStoppedBudget RunStatus = "stopped_budget"
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

// TrainerHeartbeatRequest is generated from the OpenAPI schema.
type TrainerHeartbeatRequest struct {
	WorkerID     string `json:"worker_id"`
	Attempt      int    `json:"attempt"`
	LeaseSeconds *int   `json:"lease_seconds,omitempty"`
}

// TrainerHeartbeatResponse is generated from the OpenAPI schema.
type TrainerHeartbeatResponse struct {
	Status         string                              `json:"status"`
	ShouldStop     bool                                `json:"should_stop"`
	StopReason     *TrainerHeartbeatResponseStopReason `json:"stop_reason"`
	LeaseExpiresAt string                              `json:"lease_expires_at"`
}

// TrainerHeartbeatResponseStopReason is an enumeration of allowed values.
type TrainerHeartbeatResponseStopReason string

// Values of TrainerHeartbeatResponseStopReason.
const (
	TrainerHeartbeatResponseStopReasonCancelled TrainerHeartbeatResponseStopReason = "cancelled"
	TrainerHeartbeatResponseStopReasonBudget    TrainerHeartbeatResponseStopReason = "budget"
)

// TrainerJob is generated from the OpenAPI schema.
type TrainerJob struct {
	ID                    string            `json:"id"`
	Kind                  JobKind           `json:"kind"`
	Attempt               int               `json:"attempt"`
	LeaseSeconds          int               `json:"lease_seconds"`
	LeaseExpiresAt        string            `json:"lease_expires_at"`
	Run                   *TrainerJobRun    `json:"run"`
	Import                *TrainerJobImport `json:"import"`
	PricePerMillionTokens *float64          `json:"price_per_million_tokens"`
	// MaxCostUSD Remaining budget for this attempt (the run cap minus cost billed by earlier attempts).
	MaxCostUSD *float64           `json:"max_cost_usd"`
	Dataset    *TrainerJobDataset `json:"dataset"`
	Resume     *TrainerJobResume  `json:"resume"`
	// Base Continued training: the starting artifact's bundle (a PEFT LoRA adapter) to load before training.
	Base *TrainerJobBase `json:"base"`
}

// TrainerJobBase Continued training: the starting artifact's bundle (a PEFT LoRA adapter) to load before training.
type TrainerJobBase struct {
	ArtifactID  string `json:"artifact_id"`
	SHA256      string `json:"sha256"`
	DownloadURL string `json:"download_url"`
}

// TrainerJobDataset is generated from the OpenAPI schema.
type TrainerJobDataset struct {
	Version     int    `json:"version"`
	RecordCount int    `json:"record_count"`
	DownloadURL string `json:"download_url"`
}

// TrainerJobImport is generated from the OpenAPI schema.
type TrainerJobImport struct {
	ID          string                    `json:"id"`
	WorkspaceID string                    `json:"workspace_id"`
	Dataset     string                    `json:"dataset"`
	Source      map[string]any            `json:"source"`
	Connector   TrainerJobImportConnector `json:"connector"`
}

// TrainerJobImportConnector is an enumeration of allowed values.
type TrainerJobImportConnector string

// Values of TrainerJobImportConnector.
const (
	TrainerJobImportConnectorAuto             TrainerJobImportConnector = "auto"
	TrainerJobImportConnectorGradTrajectories TrainerJobImportConnector = "grad_trajectories"
	TrainerJobImportConnectorOpenaiChat       TrainerJobImportConnector = "openai_chat"
	TrainerJobImportConnectorGradiated        TrainerJobImportConnector = "gradiated"
	TrainerJobImportConnectorOTEL             TrainerJobImportConnector = "otel"
	TrainerJobImportConnectorLangfuse         TrainerJobImportConnector = "langfuse"
	TrainerJobImportConnectorPosthog          TrainerJobImportConnector = "posthog"
	TrainerJobImportConnectorBraintrust       TrainerJobImportConnector = "braintrust"
	TrainerJobImportConnectorLangsmith        TrainerJobImportConnector = "langsmith"
)

// TrainerJobResume is generated from the OpenAPI schema.
type TrainerJobResume struct {
	CheckpointID string `json:"checkpoint_id"`
	Step         int    `json:"step"`
	DownloadURL  string `json:"download_url"`
}

// TrainerJobRun is generated from the OpenAPI schema.
type TrainerJobRun struct {
	ID             string            `json:"id"`
	WorkspaceID    string            `json:"workspace_id"`
	Name           string            `json:"name"`
	RecipeKind     RecipeKind        `json:"recipe_kind"`
	ResolvedConfig ResolvedRunConfig `json:"resolved_config"`
	TotalSteps     int               `json:"total_steps"`
}

// TrainerQueueStats is generated from the OpenAPI schema.
type TrainerQueueStats struct {
	Queued  int                     `json:"queued"`
	Running int                     `json:"running"`
	Total   int                     `json:"total"`
	ByKind  TrainerQueueStatsByKind `json:"by_kind"`
}

// TrainerQueueStatsByKind is generated from the OpenAPI schema.
type TrainerQueueStatsByKind struct {
	Train  TrainerQueueStatsByKindTrain  `json:"train"`
	Import TrainerQueueStatsByKindImport `json:"import"`
}

// TrainerQueueStatsByKindImport is generated from the OpenAPI schema.
type TrainerQueueStatsByKindImport struct {
	Queued  int `json:"queued"`
	Running int `json:"running"`
}

// TrainerQueueStatsByKindTrain is generated from the OpenAPI schema.
type TrainerQueueStatsByKindTrain struct {
	Queued  int `json:"queued"`
	Running int `json:"running"`
}

// TrainerUploadRequest is generated from the OpenAPI schema.
type TrainerUploadRequest struct {
	WorkerID  string                   `json:"worker_id"`
	Attempt   int                      `json:"attempt"`
	Kind      TrainerUploadRequestKind `json:"kind"`
	SHA256    string                   `json:"sha256"`
	SizeBytes int                      `json:"size_bytes"`
}

// TrainerUploadRequestKind is an enumeration of allowed values.
type TrainerUploadRequestKind string

// Values of TrainerUploadRequestKind.
const (
	TrainerUploadRequestKindCheckpoint TrainerUploadRequestKind = "checkpoint"
	TrainerUploadRequestKindArtifact   TrainerUploadRequestKind = "artifact"
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

// UploadTicket is generated from the OpenAPI schema.
type UploadTicket struct {
	UploadID string             `json:"upload_id"`
	Method   UploadTicketMethod `json:"method"`
	// URL Absolute presigned URL, or a path relative to the API base URL (local storage).
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
