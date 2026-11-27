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

// AdamW sets the optimizer. Zero fields take the defaults (betas 0.9/0.95,
// weight decay 0, grad clip 1); LR, when set, is the recipe's learning rate.
type AdamW struct {
	LR          float64
	Betas       [2]float64
	WeightDecay float64
	GradClip    float64
}

// Common holds the settings every recipe accepts. Zero values are left unset,
// so the server applies the documented defaults (shown by Runs.Plan).
type Common struct {
	// Model is a catalog model id, or an artifact reference ("name@version")
	// to keep training its LoRA adapter (SFT and DPO); empty means the recipe default.
	Model string
	// Adapter defaults to LoRA{Rank: 32}.
	Adapter Adapter
	// LR is "auto" (default) or a float64 learning rate.
	LR any
	// LRScale multiplies the resolved learning rate (default 1).
	LRScale   float64
	Optimizer *AdamW
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
	// EvalEvery is optimizer steps between held-out evals (0: every 10% of steps).
	EvalEvery int
}

func (c Common) spec(kind generated.RecipeKind) (RecipeSpec, error) {
	s := RecipeSpec{Kind: kind, Model: optString(c.Model), LR: c.LR, LRScale: optFloat(c.LRScale), BatchSize: optInt(c.BatchSize),
		Epochs: optInt(c.Epochs), Warmup: optFloat(c.Warmup), CheckpointTTLDays: optInt(c.CheckpointTTLDays)}
	if c.EvalEvery > 0 {
		s.EvalEvery = c.EvalEvery
	}
	if c.Adapter != nil {
		a := c.Adapter.adapterSpec()
		s.Adapter = &a
	}
	if o := c.Optimizer; o != nil {
		if o.LR != 0 {
			if c.LR != nil && c.LR != o.LR {
				return s, fmt.Errorf("grad: LR %v conflicts with AdamW.LR %v", c.LR, o.LR)
			}
			s.LR = o.LR
		}
		betas := o.Betas
		if betas == [2]float64{} {
			betas = [2]float64{0.9, 0.95}
		}
		clip := o.GradClip
		if clip == 0 {
			clip = 1
		}
		s.Optimizer = &generated.OptimizerSpec{Kind: ptr(generated.OptimizerSpecKindAdamw), Betas: []any{betas[0], betas[1]},
			WeightDecay: ptr(o.WeightDecay), GradClip: ptr(clip)}
	}
	if c.Schedule != "" {
		s.Schedule = ptr(generated.RecipeSpecSchedule(c.Schedule))
	}
	if c.TrainOn != "" {
		s.TrainOn = ptr(generated.RecipeSpecTrainOn(c.TrainOn))
	}
	if c.Thinking != "" {
		s.Thinking = ptr(generated.RecipeSpecThinking(c.Thinking))
	}
	if c.PreserveThinking {
		s.PreserveThinking = ptr(true)
	}
	if c.Reduction != "" {
		s.Reduction = ptr(generated.RecipeSpecReduction(c.Reduction))
	}
	if c.Select != "" {
		s.Select = ptr(generated.RecipeSpecSelect(c.Select))
	}
	return s, nil
}

// SFTRecipe is supervised fine-tuning on chat records.
type SFTRecipe struct {
	Common
	// MergeOnExport exports a merged checkpoint instead of a LoRA adapter.
	MergeOnExport bool
}

// RecipeSpec implements Recipe.
func (r SFTRecipe) RecipeSpec() (RecipeSpec, error) {
	s, err := r.spec(generated.RecipeKindSft)
	if err != nil || !r.MergeOnExport {
		return s, err
	}
	lora, ok := r.Adapter.(LoRA)
	if !ok && r.Adapter != nil {
		return s, fmt.Errorf("grad: MergeOnExport needs a LoRA adapter, got %T", r.Adapter)
	}
	lora.MergeOnExport = true
	a := lora.adapterSpec()
	s.Adapter = &a
	return s, nil
}

// DPORecipe is direct preference optimization on chosen/rejected pairs
// (set Model to an SFT run's artifact to continue it).
type DPORecipe struct {
	Common
	// Beta is the DPO loss beta (default 0.1).
	Beta float64
}

// RecipeSpec implements Recipe.
func (r DPORecipe) RecipeSpec() (RecipeSpec, error) {
	s, err := r.spec(generated.RecipeKindDpo)
	s.Beta = optFloat(r.Beta)
	return s, err
}

// RouterRecipe trains a router that picks the cheapest model meeting the quality bar.
type RouterRecipe struct {
	Common
	// Models are the candidate models (default: those found in the records).
	Models []string
	// MaxQualityDrop is how much quality the router may trade for cost (default 0.02).
	MaxQualityDrop float64
	// Rubric is a score name on the records (string), or a Judge, validator or
	// Rubric of them: the server then labels the prompts with an eval first.
	Rubric any
	// Pricing is USD per request for each candidate.
	Pricing map[string]float64
	// Fallback gets every request the router does not offload (default: the best candidate).
	Fallback string
}

// RecipeSpec implements Recipe.
func (r RouterRecipe) RecipeSpec() (RecipeSpec, error) {
	s, err := r.spec(generated.RecipeKindRouter)
	if err != nil {
		return s, err
	}
	s.Models = r.Models
	s.MaxQualityDrop = optFloat(r.MaxQualityDrop)
	s.Pricing = r.Pricing
	s.Fallback = optString(r.Fallback)
	switch rubric := r.Rubric.(type) {
	case nil:
	case string:
		s.Rubric = rubric
	default:
		items, ok := rubric.(Rubric)
		if !ok {
			item, isItem := rubric.(RubricItem)
			if !isItem {
				return s, fmt.Errorf("grad: RouterRecipe.Rubric must be a score name, a RubricItem or a Rubric, got %T", r.Rubric)
			}
			items = Rubric{item}
		}
		wire, local, err := items.wire()
		if err != nil {
			return s, err
		}
		if len(local) > 0 {
			return s, fmt.Errorf("grad: RouterRecipe.Rubric cannot run local scorer functions (that needs a sandbox, post-v0); use a Judge or validators")
		}
		if len(r.Models) == 0 {
			return s, fmt.Errorf("grad: RouterRecipe.Rubric replays your prompts against the candidates: set Models")
		}
		s.Rubric = wire
	}
	return s, nil
}

// DecisionModelRecipe trains a decision model for choice, yes/no and score questions.
type DecisionModelRecipe struct {
	Common
}

// RecipeSpec implements Recipe.
func (r DecisionModelRecipe) RecipeSpec() (RecipeSpec, error) {
	return r.spec(generated.RecipeKindDecision)
}

// CartridgeRecipe compresses a long context into a trained KV prefix.
type CartridgeRecipe struct {
	Common
	// Context is required: ContextFromText, ContextFromFile or ContextFromURI.
	Context Context
	// NumTokens is the prefix size (default 256).
	NumTokens int
	// Teacher reads the full context (default: the base model).
	Teacher string
	// TopK is the top-k KL distillation loss's k (default 20).
	TopK int
	// MaxNewTokens is the teacher's answer length per prompt (default 256).
	MaxNewTokens int
}

// RecipeSpec implements Recipe.
func (r CartridgeRecipe) RecipeSpec() (RecipeSpec, error) {
	s, err := r.spec(generated.RecipeKindCartridge)
	if err != nil {
		return s, err
	}
	s.NumTokens = optInt(r.NumTokens)
	s.Teacher = optString(r.Teacher)
	s.MaxNewTokens = optInt(r.MaxNewTokens)
	if r.TopK > 0 {
		s.Loss = &generated.LossSpec{Kind: generated.LossSpecKindTopKKLDistill, TopK: ptr(r.TopK)}
	}
	return s, r.Context.apply(&s)
}

// DistillRecipe trains a LoRA student on a smaller base to copy a teacher on your prompts.
type DistillRecipe struct {
	Common
	// Teacher is required: a catalog model sharing the student's tokenizer, or, with
	// OffPolicy, also an artifact ("name@version") or any model the inference endpoint serves.
	Teacher string
	// OffPolicy has the teacher answer each prompt once through the inference endpoint (a
	// labeling eval, billed as an eval) and trains the student on those answers with
	// cross-entropy. The default, on-policy, has the student write answers that the teacher scores.
	OffPolicy bool
	// MaxNewTokens is the answer length (0: auto on-policy, 1024 off-policy).
	MaxNewTokens int
	// TopK is the on-policy top-k KL loss's k (default 32).
	TopK int
	// Context is read by the teacher only (on-policy).
	Context Context
}

// RecipeSpec implements Recipe.
func (r DistillRecipe) RecipeSpec() (RecipeSpec, error) {
	s, err := r.spec(generated.RecipeKindDistill)
	if err != nil {
		return s, err
	}
	if r.Teacher == "" {
		return s, fmt.Errorf("grad: DistillRecipe needs a Teacher")
	}
	s.Teacher = ptr(r.Teacher)
	kind := generated.RolloutSpecKindOnPolicy
	if r.OffPolicy {
		if r.TopK > 0 {
			return s, fmt.Errorf("grad: DistillRecipe.TopK is the on-policy KL loss; off-policy trains with cross-entropy")
		}
		if r.Context != (Context{}) {
			return s, fmt.Errorf("grad: DistillRecipe.Context is read by the teacher on-policy; drop OffPolicy")
		}
		kind = generated.RolloutSpecKindOffPolicy
		s.Loss = &generated.LossSpec{Kind: generated.LossSpecKindCrossEntropy}
	} else if r.TopK > 0 {
		s.Loss = &generated.LossSpec{Kind: generated.LossSpecKindTopKKLDistill, TopK: ptr(r.TopK)}
	}
	if r.OffPolicy || r.MaxNewTokens > 0 {
		s.Rollout = &generated.RolloutSpec{Kind: kind}
		if r.MaxNewTokens > 0 {
			s.Rollout.MaxNewTokens = r.MaxNewTokens
		}
	}
	return s, r.Context.apply(&s)
}

// RewardModelRecipe trains a scalar reward head on chosen/rejected pairs (scores are sigmoid(reward) in [0, 1]).
type RewardModelRecipe struct {
	Common
	// Rubric optionally names a score in [0, 1] on records ending in an assistant turn,
	// trained pointwise next to the pairs.
	Rubric string
}

// RecipeSpec implements Recipe.
func (r RewardModelRecipe) RecipeSpec() (RecipeSpec, error) {
	s, err := r.spec(generated.RecipeKindReward)
	if r.Rubric != "" {
		s.Rubric = r.Rubric
	}
	return s, err
}

// EmbeddingRecipe fine-tunes an encoder on query/positive/negatives records.
type EmbeddingRecipe struct {
	Common
	// Temp is the InfoNCE temperature (default 0.05).
	Temp float64
	// Pool is mean (default) or cls.
	Pool string
}

// RecipeSpec implements Recipe.
func (r EmbeddingRecipe) RecipeSpec() (RecipeSpec, error) {
	s, err := r.spec(generated.RecipeKindEmbedding)
	s.Temp = optFloat(r.Temp)
	if r.Pool != "" {
		s.Pool = &generated.PoolingSpec{Kind: generated.PoolingSpecKind(r.Pool)}
	}
	return s, err
}

// RawRecipe sends a wire RecipeSpec unchanged.
type RawRecipe RecipeSpec

// RecipeSpec implements Recipe.
func (r RawRecipe) RecipeSpec() (RecipeSpec, error) { return RecipeSpec(r), nil }
