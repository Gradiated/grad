import type { ChatMessage, DatasetRecord } from "./generated/models.js";

/** A `grad.trajectory/1` record; `scores` and `metrics` start empty so you can fill them in. */
export type Trajectory = DatasetRecord & {
  scores: Record<string, number>;
  metrics: Record<string, number>;
  metadata: Record<string, unknown>;
};

export const Trajectory = {
  fromMessages: (
    messages: ChatMessage[],
    options: { sessionId?: string; groupId?: string; id?: string; source?: string; metadata?: Record<string, unknown> } = {},
  ): Trajectory => ({
    schema: "grad.trajectory/1",
    messages,
    scores: {},
    metrics: {},
    metadata: options.metadata ?? {},
    ...(options.id !== undefined ? { id: options.id } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.groupId !== undefined ? { groupId: options.groupId } : {}),
    ...(options.source !== undefined ? { source: options.source } : {}),
  }),
};
