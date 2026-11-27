import type { TestProject } from "vitest/node";

import { startDockerSeaweedfs, type S3TestTarget } from "./docker-seaweedfs.js";

declare module "vitest" {
  export interface ProvidedContext {
    s3Target: S3TestTarget;
  }
}

/**
 * vitest globalSetup: one throwaway `gradr8-s3-<pid>` SeaweedFS for the run,
 * removed on teardown. Every test app gets its own key prefix in its bucket
 * (fixtures/s3.ts).
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const s3 = await startDockerSeaweedfs().catch((error: unknown) => {
    throw new Error(
      `The server tests need S3: make docker available to start SeaweedFS (${String(error).split("\n")[0]}).`,
    );
  });
  project.provide("s3Target", s3.target);

  return s3.stop;
}
