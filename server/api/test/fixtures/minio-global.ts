import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { TestProject } from "vitest/node";

import type { S3TestTarget } from "./minio.js";

const run = promisify(execFile);

/** pgsty/minio is the maintained MinIO community fork; pinned by digest. */
const MINIO_IMAGE =
  "pgsty/minio@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372";

const waitReady = async (
  endpoint: string,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint}/minio/health/ready`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`MinIO at ${endpoint} did not become ready`);
};

const createBucket = async (target: S3TestTarget): Promise<void> => {
  const client = new S3Client({
    endpoint: target.endpoint,
    region: target.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
    },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: target.bucket }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
      throw error;
    }
  } finally {
    client.destroy();
  }
};

/**
 * Provides an S3 target for the storage contract suite: the endpoint in
 * S3_TEST_ENDPOINT (CI service container) or a throwaway `gradr3-minio-*`
 * container on a loopback port, removed on teardown.
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const region = process.env.S3_TEST_REGION ?? "us-east-1";

  if (process.env.S3_TEST_ENDPOINT) {
    const target: S3TestTarget = {
      endpoint: process.env.S3_TEST_ENDPOINT,
      bucket: process.env.S3_TEST_BUCKET ?? "grad-test",
      region,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "minioadmin",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin",
    };
    await waitReady(target.endpoint, 60_000);
    await createBucket(target);
    project.provide("s3Target", target);
    project.provide("s3Unavailable", null);

    return async () => undefined;
  }

  const name = `gradr3-minio-${randomBytes(4).toString("hex")}`;
  const accessKeyId = "gradr3test";
  const secretAccessKey = randomBytes(16).toString("hex");
  try {
    await run(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-p",
        "127.0.0.1::9000",
        "-e",
        `MINIO_ROOT_USER=${accessKeyId}`,
        "-e",
        `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
        MINIO_IMAGE,
        "server",
        "/data",
      ],
      { timeout: 120_000 },
    );
    const { stdout } = await run("docker", ["port", name, "9000/tcp"]);
    const port = stdout.trim().split("\n")[0]?.split(":").pop();
    if (!port) throw new Error(`could not read the port of ${name}`);

    const target: S3TestTarget = {
      endpoint: `http://127.0.0.1:${port}`,
      bucket: "grad-test",
      region,
      accessKeyId,
      secretAccessKey,
    };
    await waitReady(target.endpoint, 60_000);
    await createBucket(target);
    project.provide("s3Target", target);
    project.provide("s3Unavailable", null);
  } catch (error) {
    await run("docker", ["rm", "-f", name]).catch(() => undefined);
    project.provide("s3Target", null);
    project.provide(
      "s3Unavailable",
      error instanceof Error ? error.message : String(error),
    );

    return async () => undefined;
  }

  return async () => {
    await run("docker", ["rm", "-f", name]).catch(() => undefined);
  };
}
