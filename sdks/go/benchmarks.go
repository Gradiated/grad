package grad

import (
	"context"
	"strconv"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// Built-in benchmarks for Datasets.FromBenchmark.
const (
	BenchmarkGSM8K        = generated.ImportSourceBenchmarkGsm8k
	BenchmarkMMLU         = generated.ImportSourceBenchmarkMmlu
	BenchmarkMMLUPro      = generated.ImportSourceBenchmarkMmluPro
	BenchmarkARCChallenge = generated.ImportSourceBenchmarkArcChallenge
)

// BenchmarkOptions configures a benchmark import.
type BenchmarkOptions struct {
	// Limit imports the first N problems (the same ones every time).
	Limit int
	// Name of the dataset (default "<benchmark>-<limit>", or "<benchmark>").
	Name string
}

func (o BenchmarkOptions) dataset(b generated.ImportSourceBenchmark) string {
	switch {
	case o.Name != "":
		return o.Name
	case o.Limit > 0:
		return string(b) + "-" + strconv.Itoa(o.Limit)
	default:
		return string(b)
	}
}

// ImportBenchmark starts importing a built-in benchmark from Hugging Face at a
// pinned revision, with fixed prompts. An eval on the dataset without a rubric
// uses the benchmark's answer check.
func (s *DatasetsService) ImportBenchmark(ctx context.Context, benchmark generated.ImportSourceBenchmark, o BenchmarkOptions) *ImportHandle {
	api, err := s.c.api()
	if err != nil {
		return &ImportHandle{c: s.c, err: err}
	}
	req := &generated.CreateImportRequest{
		Source:    generated.ImportSource{Kind: generated.ImportSourceKindBenchmark, Benchmark: &benchmark, Limit: optInt(o.Limit)},
		Connector: ptr(generated.CreateImportRequestConnector("auto")),
	}
	job, err := api.CreateDatasetImport(ctx, o.dataset(benchmark), req)
	return &ImportHandle{c: s.c, job: job, err: err}
}

// FromBenchmark imports a built-in benchmark, waits for it and returns the dataset.
func (s *DatasetsService) FromBenchmark(ctx context.Context, benchmark generated.ImportSourceBenchmark, o BenchmarkOptions, opts ...WaitOption) (*Dataset, error) {
	if _, err := s.ImportBenchmark(ctx, benchmark, o).Wait(ctx, opts...); err != nil {
		return nil, err
	}
	return s.Get(ctx, o.dataset(benchmark))
}
