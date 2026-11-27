import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import type { Sampler, SpanExporter } from "@opentelemetry/sdk-trace";

/**
 * Optional OpenTelemetry tracing: off unless OTEL_EXPORTER_OTLP_ENDPOINT (or
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) is set, configured by the standard OTEL
 * variables (service name, resource attributes, sampler, headers). When off,
 * every helper here is a no-op and the SDK is never loaded.
 */

const TRACER = "grad-server";
let enabled = false;
let shutdownProvider: (() => Promise<void>) | null = null;

export const tracingEnabled = (): boolean => enabled;

type Samplers = typeof import("@opentelemetry/sdk-trace");

/** OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG (default parentbased_always_on). */
export const samplerFromEnv = (
  env: Record<string, string | undefined>,
  sdk: Pick<
    Samplers,
    | "AlwaysOnSampler"
    | "AlwaysOffSampler"
    | "ParentBasedSampler"
    | "TraceIdRatioBasedSampler"
  >,
): Sampler => {
  const arg = Number(env.OTEL_TRACES_SAMPLER_ARG ?? "1");
  const ratio = Number.isFinite(arg) && arg >= 0 && arg <= 1 ? arg : 1;
  const name = (env.OTEL_TRACES_SAMPLER ?? "parentbased_always_on").trim();
  const root: Record<string, () => Sampler> = {
    always_on: () => new sdk.AlwaysOnSampler(),
    always_off: () => new sdk.AlwaysOffSampler(),
    traceidratio: () => new sdk.TraceIdRatioBasedSampler(ratio),
  };
  const base = name.replace(/^parentbased_/, "");
  const make = root[base] ?? root.always_on;
  const sampler = (make as () => Sampler)();

  return name.startsWith("parentbased_") || !root[base]
    ? new sdk.ParentBasedSampler({ root: sampler })
    : sampler;
};

/**
 * Starts tracing when an OTLP endpoint is configured. `exporter` replaces
 * the OTLP exporter (tests) and exports each span as it ends.
 */
export const startTracing = async (
  env: Record<string, string | undefined> = process.env,
  options: { exporter?: SpanExporter; version?: string } = {},
): Promise<boolean> => {
  const endpoint =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const disabled =
    env.OTEL_SDK_DISABLED === "true" || env.OTEL_TRACES_EXPORTER === "none";
  if (enabled || disabled || (!endpoint && !options.exporter)) return enabled;

  const [sdk, hooks, core, res] = await Promise.all([
    import("@opentelemetry/sdk-trace"),
    import("@opentelemetry/context-async-hooks"),
    import("@opentelemetry/core"),
    import("@opentelemetry/resources"),
  ]);
  const exporter =
    options.exporter ??
    new (
      await import("@opentelemetry/exporter-trace-otlp-proto")
    ).OTLPTraceExporter();
  const resource = res
    .defaultResource()
    .merge(
      res.resourceFromAttributes({
        "service.name": "grad-server",
        ...(options.version ? { "service.version": options.version } : {}),
      }),
    )
    .merge(
      res.detectResources({
        detectors: [
          res.resourceAttributesEnvDetector,
          res.serviceNameEnvDetector,
        ],
      }),
    );
  const provider = new sdk.TracerProvider({
    resource,
    sampler: samplerFromEnv(env, sdk),
    spanProcessors: [
      options.exporter
        ? new sdk.SimpleSpanProcessor({ exporter })
        : new sdk.BatchSpanProcessor({ exporter }),
    ],
  });

  context.setGlobalContextManager(
    new hooks.AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new core.W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  shutdownProvider = () => provider.shutdown();
  enabled = true;

  return true;
};

/** Flushes and stops the exporter (graceful shutdown). */
export const stopTracing = async (): Promise<void> => {
  const stop = shutdownProvider;
  shutdownProvider = null;
  enabled = false;
  await stop?.();
  trace.disable();
  context.disable();
  propagation.disable();
};

/**
 * Runs `fn` in a span (a child of `parent`, else of the active span). The
 * span records a thrown error and ends when `fn` settles.
 */
export const withSpan = async <T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span | null) => Promise<T>,
  options: { kind?: SpanKind; parent?: Context } = {},
): Promise<T> => {
  if (!enabled) return fn(null);

  return trace
    .getTracer(TRACER)
    .startActiveSpan(
      name,
      { kind: options.kind ?? SpanKind.INTERNAL, attributes },
      options.parent ?? context.active(),
      async (span) => {
        try {
          return await fn(span);
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
};

/** The W3C context of incoming headers (ROOT when tracing is off). */
export const contextFromHeaders = (headers: Headers): Context =>
  enabled
    ? propagation.extract(ROOT_CONTEXT, {
        traceparent: headers.get("traceparent") ?? undefined,
        tracestate: headers.get("tracestate") ?? undefined,
      })
    : ROOT_CONTEXT;

/** The context a stored `traceparent` names (ROOT when absent or off). */
export const contextFromTraceparent = (traceparent: string | null): Context =>
  enabled && traceparent
    ? propagation.extract(ROOT_CONTEXT, { traceparent })
    : ROOT_CONTEXT;

/** The active span's W3C `traceparent`, or null (no span, or tracing off). */
export const currentTraceparent = (): string | null => {
  if (!enabled) return null;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  return carrier.traceparent ?? null;
};

/** The active span's trace id, for log lines. */
export const currentTraceId = (): string | undefined => {
  if (!enabled) return undefined;
  const span = trace.getActiveSpan()?.spanContext();

  return span && trace.isSpanContextValid(span) ? span.traceId : undefined;
};

export { SpanKind };
