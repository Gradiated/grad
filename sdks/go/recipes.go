package grad

import (
	"fmt"
	"os"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// RecipeSpec is the wire form of a recipe.
type RecipeSpec = generated.RecipeSpec

// Recipe is implemented by every recipe struct (SFTRecipe, RouterRecipe, ...).
// Zero-valued fields are left unset so the server applies the documented defaults
// (shown by Runs.Plan).
type Recipe interface {
	RecipeSpec() (RecipeSpec, error)
}

// Adapter is implemented by LoRA, PrefixKV and FrozenHead.
type Adapter interface {
	adapterSpec() generated.AdapterSpec
}

// LoRA trains a low-rank adapter. Rank 0 means the default (32).
type LoRA struct {
	Rank          int
	Alpha         int
	MergeOnExport bool
}

func (a LoRA) adapterSpec() generated.AdapterSpec {
	spec := generated.AdapterSpec{Kind: generated.AdapterSpecKindLora, Rank: optInt(a.Rank), Alpha: optInt(a.Alpha)}
	if a.MergeOnExport {
		spec.MergeOnExport = ptr(true)
	}
	return spec
}

// PrefixKV trains a prefix of key/value tokens (cartridges). NumTokens 0 means the default (256).
type PrefixKV struct{ NumTokens int }

func (a PrefixKV) adapterSpec() generated.AdapterSpec {
	return generated.AdapterSpec{Kind: generated.AdapterSpecKindPrefixKv, NumTokens: optInt(a.NumTokens)}
}

// FrozenHead trains only a head on a frozen backbone.
type FrozenHead struct{}

func (FrozenHead) adapterSpec() generated.AdapterSpec {
	return generated.AdapterSpec{Kind: generated.AdapterSpecKindFrozenHead}
}

// Split decides which records are held out for evaluation.
type Split interface {
	splitSpec() generated.SplitSpec
}

// BySession keeps records with the same session_id on the same side (the default).
type BySession struct {
	EvalFraction float64
	Seed         int
}

// ByGroup keeps records with the same group_id on the same side.
type ByGroup struct {
	EvalFraction float64
	Seed         int
}

// Random splits records uniformly.
type Random struct {
	EvalFraction float64
	Seed         int
}

func split(strategy generated.SplitSpecStrategy, fraction float64, seed int) generated.SplitSpec {
	return generated.SplitSpec{Strategy: &strategy, EvalFraction: optFloat(fraction), Seed: optInt(seed)}
}

func (s BySession) splitSpec() generated.SplitSpec {
	return split(generated.SplitSpecStrategyBySession, s.EvalFraction, s.Seed)
}
func (s ByGroup) splitSpec() generated.SplitSpec {
	return split(generated.SplitSpecStrategyByGroup, s.EvalFraction, s.Seed)
}
func (s Random) splitSpec() generated.SplitSpec {
	return split(generated.SplitSpecStrategyRandom, s.EvalFraction, s.Seed)
}

// Context is the text a cartridge (or distillation) learns to stand in for.
type Context struct {
	text string
	uri  string
	path string
}

// ContextFromText uses the given text.
func ContextFromText(text string) Context { return Context{text: text} }

// ContextFromFile reads the file when the run is planned or created.
func ContextFromFile(path string) Context { return Context{path: path} }

// ContextFromURI points the trainer at a URI such as s3://bucket/key.
func ContextFromURI(uri string) Context { return Context{uri: uri} }

func (c Context) apply(spec *RecipeSpec) error {
	switch {
	case c.path != "":
		raw, err := os.ReadFile(c.path)
		if err != nil {
			return fmt.Errorf("grad: reading cartridge context: %w", err)
		}
		spec.ContextText = ptr(string(raw))
	case c.text != "":
		spec.ContextText = ptr(c.text)
	case c.uri != "":
		spec.ContextURI = ptr(c.uri)
	}
	return nil
}

type common struct {
	model             string
	adapter           Adapter
	lr                any
	lrScale           float64
	batchSize         int
	epochs            int
	schedule          string
	warmup            float64
	trainOn           string
	thinking          string
	preserveThinking  bool
	reduction         string
	selectCheckpoint  string
	checkpointTTLDays int
}

func (c common) spec(kind generated.RecipeKind) RecipeSpec {
	s := RecipeSpec{Kind: kind, Model: optString(c.model), LR: c.lr, LRScale: optFloat(c.lrScale), BatchSize: optInt(c.batchSize),
		Epochs: optInt(c.epochs), Warmup: optFloat(c.warmup), CheckpointTTLDays: optInt(c.checkpointTTLDays)}
	if c.adapter != nil {
		a := c.adapter.adapterSpec()
		s.Adapter = &a
	}
	if c.schedule != "" {
		s.Schedule = ptr(generated.RecipeSpecSchedule(c.schedule))
	}
	if c.trainOn != "" {
		s.TrainOn = ptr(generated.RecipeSpecTrainOn(c.trainOn))
	}
	if c.thinking != "" {
		s.Thinking = ptr(generated.RecipeSpecThinking(c.thinking))
	}
	if c.preserveThinking {
		s.PreserveThinking = ptr(true)
	}
	if c.reduction != "" {
		s.Reduction = ptr(generated.RecipeSpecReduction(c.reduction))
	}
	if c.selectCheckpoint != "" {
		s.Select = ptr(generated.RecipeSpecSelect(c.selectCheckpoint))
	}
	return s
}

// SFTRecipe is supervised fine-tuning on chat records.
// Zero-valued fields are left to the server defaults.
type SFTRecipe struct {
	// Model is a catalog model id or an artifact reference ("name@version"); empty means the recipe default.
	Model string
	// Adapter defaults to LoRA{Rank: 32}.
	Adapter Adapter
	// LR is "auto" (default) or a float64 learning rate.
	LR any
	// LRScale multiplies the resolved learning rate (default 1).
	LRScale   float64
	BatchSize int
	Epochs    int
	// Schedule is linear (default), cosine or constant.
	Schedule string
	Warmup   float64
	// TrainOn is last (default) or all_assistant.
	TrainOn string
	// Thinking is auto (default), on or off.
	Thinking         string
	PreserveThinking bool
	// Reduction is per_example (default) or per_token.
	Reduction string
	// Select is best (default) or last.
	Select string
	// CheckpointTTLDays keeps intermediate checkpoints this long (default 30).
	CheckpointTTLDays int
	// MergeOnExport exports a merged checkpoint instead of a LoRA adapter.
	MergeOnExport bool
}

// RecipeSpec implements Recipe.
func (r SFTRecipe) RecipeSpec() (RecipeSpec, error) {
	s := common{r.Model, r.Adapter, r.LR, r.LRScale, r.BatchSize, r.Epochs, r.Schedule, r.Warmup, r.TrainOn, r.Thinking, r.PreserveThinking, r.Reduction, r.Select, r.CheckpointTTLDays}.spec(generated.RecipeKindSft)
	if r.MergeOnExport {
		lora := LoRA{MergeOnExport: true}
		if l, ok := r.Adapter.(LoRA); ok {
			lora = l
			lora.MergeOnExport = true
		} else if r.Adapter != nil {
			return s, fmt.Errorf("grad: MergeOnExport needs a LoRA adapter, got %T", r.Adapter)
		}
		a := lora.adapterSpec()
		s.Adapter = &a
	}
	return s, nil
}

// DPORecipe is direct preference optimization on chosen/rejected pairs.
// Zero-valued fields are left to the server defaults.
type DPORecipe struct {
	// Model is a catalog model id or an artifact reference ("name@version"); empty means the recipe default.
	Model string
	// Adapter defaults to LoRA{Rank: 32}.
	Adapter Adapter
	// LR is "auto" (default) or a float64 learning rate.
	LR any
	// LRScale multiplies the resolved learning rate (default 1).
	LRScale   float64
	BatchSize int
	Epochs    int
	// Schedule is linear (default), cosine or constant.
	Schedule string
	Warmup   float64
	// TrainOn is last (default) or all_assistant.
	TrainOn string
	// Thinking is auto (default), on or off.
	Thinking         string
	PreserveThinking bool
	// Reduction is per_example (default) or per_token.
	Reduction string
	// Select is best (default) or last.
	Select string
	// CheckpointTTLDays keeps intermediate checkpoints this long (default 30).
	CheckpointTTLDays int
	// Beta is the DPO loss beta (default 0.1).
	Beta float64
}

// RecipeSpec implements Recipe.
func (r DPORecipe) RecipeSpec() (RecipeSpec, error) {
	s := common{r.Model, r.Adapter, r.LR, r.LRScale, r.BatchSize, r.Epochs, r.Schedule, r.Warmup, r.TrainOn, r.Thinking, r.PreserveThinking, r.Reduction, r.Select, r.CheckpointTTLDays}.spec(generated.RecipeKindDpo)
	s.Beta = optFloat(r.Beta)
	return s, nil
}

// RouterRecipe trains a router that picks the cheapest model meeting the quality bar; scores come from the records (scores, metadata.model).
// Zero-valued fields are left to the server defaults.
type RouterRecipe struct {
	// Model is a catalog model id or an artifact reference ("name@version"); empty means the recipe default.
	Model string
	// Adapter defaults to LoRA{Rank: 32}.
	Adapter Adapter
	// LR is "auto" (default) or a float64 learning rate.
	LR any
	// LRScale multiplies the resolved learning rate (default 1).
	LRScale   float64
	BatchSize int
	Epochs    int
	// Schedule is linear (default), cosine or constant.
	Schedule string
	Warmup   float64
	// TrainOn is last (default) or all_assistant.
	TrainOn string
	// Thinking is auto (default), on or off.
	Thinking         string
	PreserveThinking bool
	// Reduction is per_example (default) or per_token.
	Reduction string
	// Select is best (default) or last.
	Select string
	// CheckpointTTLDays keeps intermediate checkpoints this long (default 30).
	CheckpointTTLDays int
	// Models are the candidate models (default: those found in the records).
	Models []string
	// MaxQualityDrop is how much quality the router may trade for cost (default 0.02).
	MaxQualityDrop float64
}

// RecipeSpec implements Recipe.
func (r RouterRecipe) RecipeSpec() (RecipeSpec, error) {
	s := common{r.Model, r.Adapter, r.LR, r.LRScale, r.BatchSize, r.Epochs, r.Schedule, r.Warmup, r.TrainOn, r.Thinking, r.PreserveThinking, r.Reduction, r.Select, r.CheckpointTTLDays}.spec(generated.RecipeKindRouter)
	s.Models = r.Models
	s.MaxQualityDrop = optFloat(r.MaxQualityDrop)
	return s, nil
}

// DecisionModelRecipe trains a decision model for choice, yes/no and score questions.
// Zero-valued fields are left to the server defaults.
type DecisionModelRecipe struct {
	// Model is a catalog model id or an artifact reference ("name@version"); empty means the recipe default.
	Model string
	// Adapter defaults to LoRA{Rank: 32}.
	Adapter Adapter
	// LR is "auto" (default) or a float64 learning rate.
	LR any
	// LRScale multiplies the resolved learning rate (default 1).
	LRScale   float64
	BatchSize int
	Epochs    int
	// Schedule is linear (default), cosine or constant.
	Schedule string
	Warmup   float64
	// TrainOn is last (default) or all_assistant.
	TrainOn string
	// Thinking is auto (default), on or off.
	Thinking         string
	PreserveThinking bool
	// Reduction is per_example (default) or per_token.
	Reduction string
	// Select is best (default) or last.
	Select string
	// CheckpointTTLDays keeps intermediate checkpoints this long (default 30).
	CheckpointTTLDays int
}

// RecipeSpec implements Recipe.
func (r DecisionModelRecipe) RecipeSpec() (RecipeSpec, error) {
	s := common{r.Model, r.Adapter, r.LR, r.LRScale, r.BatchSize, r.Epochs, r.Schedule, r.Warmup, r.TrainOn, r.Thinking, r.PreserveThinking, r.Reduction, r.Select, r.CheckpointTTLDays}.spec(generated.RecipeKindDecision)
	return s, nil
}

// CartridgeRecipe compresses a long context into a trained KV prefix.
// Zero-valued fields are left to the server defaults.
type CartridgeRecipe struct {
	// Model is a catalog model id or an artifact reference ("name@version"); empty means the recipe default.
	Model string
	// Adapter defaults to LoRA{Rank: 32}.
	Adapter Adapter
	// LR is "auto" (default) or a float64 learning rate.
	LR any
	// LRScale multiplies the resolved learning rate (default 1).
	LRScale   float64
	BatchSize int
	Epochs    int
	// Schedule is linear (default), cosine or constant.
	Schedule string
	Warmup   float64
	// TrainOn is last (default) or all_assistant.
	TrainOn string
	// Thinking is auto (default), on or off.
	Thinking         string
	PreserveThinking bool
	// Reduction is per_example (default) or per_token.
	Reduction string
	// Select is best (default) or last.
	Select string
	// CheckpointTTLDays keeps intermediate checkpoints this long (default 30).
	CheckpointTTLDays int
	// Context is required: ContextFromText, ContextFromFile or ContextFromURI.
	Context Context
	// NumTokens is the prefix size (default 256).
	NumTokens int
}

// RecipeSpec implements Recipe.
func (r CartridgeRecipe) RecipeSpec() (RecipeSpec, error) {
	s := common{r.Model, r.Adapter, r.LR, r.LRScale, r.BatchSize, r.Epochs, r.Schedule, r.Warmup, r.TrainOn, r.Thinking, r.PreserveThinking, r.Reduction, r.Select, r.CheckpointTTLDays}.spec(generated.RecipeKindCartridge)
	s.NumTokens = optInt(r.NumTokens)
	if err := r.Context.apply(&s); err != nil {
		return s, err
	}
	return s, nil
}

// EmbeddingRecipe fine-tunes an encoder on query/positive/negatives records.
// Zero-valued fields are left to the server defaults.
type EmbeddingRecipe struct {
	// Model is a catalog model id or an artifact reference ("name@version"); empty means the recipe default.
	Model string
	// Adapter defaults to LoRA{Rank: 32}.
	Adapter Adapter
	// LR is "auto" (default) or a float64 learning rate.
	LR any
	// LRScale multiplies the resolved learning rate (default 1).
	LRScale   float64
	BatchSize int
	Epochs    int
	// Schedule is linear (default), cosine or constant.
	Schedule string
	Warmup   float64
	// TrainOn is last (default) or all_assistant.
	TrainOn string
	// Thinking is auto (default), on or off.
	Thinking         string
	PreserveThinking bool
	// Reduction is per_example (default) or per_token.
	Reduction string
	// Select is best (default) or last.
	Select string
	// CheckpointTTLDays keeps intermediate checkpoints this long (default 30).
	CheckpointTTLDays int
	// Temp is the InfoNCE temperature (default 0.05).
	Temp float64
}

// RecipeSpec implements Recipe.
func (r EmbeddingRecipe) RecipeSpec() (RecipeSpec, error) {
	s := common{r.Model, r.Adapter, r.LR, r.LRScale, r.BatchSize, r.Epochs, r.Schedule, r.Warmup, r.TrainOn, r.Thinking, r.PreserveThinking, r.Reduction, r.Select, r.CheckpointTTLDays}.spec(generated.RecipeKindEmbedding)
	s.Temp = optFloat(r.Temp)
	return s, nil
}

// DistillRecipe distills a teacher model into the student.
// Zero-valued fields are left to the server defaults.
type DistillRecipe struct {
	// Model is a catalog model id or an artifact reference ("name@version"); empty means the recipe default.
	Model string
	// Adapter defaults to LoRA{Rank: 32}.
	Adapter Adapter
	// LR is "auto" (default) or a float64 learning rate.
	LR any
	// LRScale multiplies the resolved learning rate (default 1).
	LRScale   float64
	BatchSize int
	Epochs    int
	// Schedule is linear (default), cosine or constant.
	Schedule string
	Warmup   float64
	// TrainOn is last (default) or all_assistant.
	TrainOn string
	// Thinking is auto (default), on or off.
	Thinking         string
	PreserveThinking bool
	// Reduction is per_example (default) or per_token.
	Reduction string
	// Select is best (default) or last.
	Select string
	// CheckpointTTLDays keeps intermediate checkpoints this long (default 30).
	CheckpointTTLDays int
	// Teacher is required.
	Teacher string
}

// RecipeSpec implements Recipe.
func (r DistillRecipe) RecipeSpec() (RecipeSpec, error) {
	s := common{r.Model, r.Adapter, r.LR, r.LRScale, r.BatchSize, r.Epochs, r.Schedule, r.Warmup, r.TrainOn, r.Thinking, r.PreserveThinking, r.Reduction, r.Select, r.CheckpointTTLDays}.spec(generated.RecipeKindDistill)
	if r.Teacher == "" {
		return s, fmt.Errorf("grad: DistillRecipe needs a Teacher")
	}
	s.Teacher = &r.Teacher
	return s, nil
}

// RewardModelRecipe trains a reward model on preference pairs.
// Zero-valued fields are left to the server defaults.
type RewardModelRecipe struct {
	// Model is a catalog model id or an artifact reference ("name@version"); empty means the recipe default.
	Model string
	// Adapter defaults to LoRA{Rank: 32}.
	Adapter Adapter
	// LR is "auto" (default) or a float64 learning rate.
	LR any
	// LRScale multiplies the resolved learning rate (default 1).
	LRScale   float64
	BatchSize int
	Epochs    int
	// Schedule is linear (default), cosine or constant.
	Schedule string
	Warmup   float64
	// TrainOn is last (default) or all_assistant.
	TrainOn string
	// Thinking is auto (default), on or off.
	Thinking         string
	PreserveThinking bool
	// Reduction is per_example (default) or per_token.
	Reduction string
	// Select is best (default) or last.
	Select string
	// CheckpointTTLDays keeps intermediate checkpoints this long (default 30).
	CheckpointTTLDays int
}

// RecipeSpec implements Recipe.
func (r RewardModelRecipe) RecipeSpec() (RecipeSpec, error) {
	s := common{r.Model, r.Adapter, r.LR, r.LRScale, r.BatchSize, r.Epochs, r.Schedule, r.Warmup, r.TrainOn, r.Thinking, r.PreserveThinking, r.Reduction, r.Select, r.CheckpointTTLDays}.spec(generated.RecipeKindReward)
	return s, nil
}

// GRPORecipe is group-relative policy optimization against a served environment.
// Zero-valued fields are left to the server defaults.
type GRPORecipe struct {
	// Model is a catalog model id or an artifact reference ("name@version"); empty means the recipe default.
	Model string
	// Adapter defaults to LoRA{Rank: 32}.
	Adapter Adapter
	// LR is "auto" (default) or a float64 learning rate.
	LR any
	// LRScale multiplies the resolved learning rate (default 1).
	LRScale   float64
	BatchSize int
	Epochs    int
	// Schedule is linear (default), cosine or constant.
	Schedule string
	Warmup   float64
	// TrainOn is last (default) or all_assistant.
	TrainOn string
	// Thinking is auto (default), on or off.
	Thinking         string
	PreserveThinking bool
	// Reduction is per_example (default) or per_token.
	Reduction string
	// Select is best (default) or last.
	Select string
	// CheckpointTTLDays keeps intermediate checkpoints this long (default 30).
	CheckpointTTLDays int
	EnvName           string
	// GroupSize is attempts per prompt (default 8).
	GroupSize int
}

// RecipeSpec implements Recipe.
func (r GRPORecipe) RecipeSpec() (RecipeSpec, error) {
	s := common{r.Model, r.Adapter, r.LR, r.LRScale, r.BatchSize, r.Epochs, r.Schedule, r.Warmup, r.TrainOn, r.Thinking, r.PreserveThinking, r.Reduction, r.Select, r.CheckpointTTLDays}.spec(generated.RecipeKindGrpo)
	s.EnvName = optString(r.EnvName)
	s.GroupSize = optInt(r.GroupSize)
	return s, nil
}

// RawRecipe sends a wire RecipeSpec unchanged.
type RawRecipe RecipeSpec

// RecipeSpec implements Recipe.
func (r RawRecipe) RecipeSpec() (RecipeSpec, error) { return RecipeSpec(r), nil }
