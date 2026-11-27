import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

import { reapStaleContainers } from "./docker-postgres.js";

const exec = promisify(execFile);

/** The image and flags of the compose stack's `seaweedfs` service. */
export const SEAWEEDFS_IMAGE =
  "chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882";

/** `weed mini` (single-node S3) without the WebDAV, admin, Iceberg and Lance extras. */
export const seaweedfsArgs = (config: string, bucket: string): string[] => [
  "mini",
  "-dir=/data",
  `-s3.config=${config}`,
  `-bucket=${bucket}`,
  "-webdav=false",
  "-admin.ui=false",
  "-s3.port.iceberg=0",
  "-s3.port.lance=0",
  "-master.telemetry=false",
];

/** An S3 identity config (`-s3.config`): one key with full access. */
export const seaweedfsConfig = (
  accessKeyId: string,
  secretAccessKey: string,
): string =>
  JSON.stringify({
    identities: [
      {
        name: "grad",
        credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }],
        actions: ["Admin", "Read", "Write", "List", "Tagging"],
      },
    ],
  });

/** Every throwaway test store is named `gradr8-s3-<pid>`. */
export const S3_CONTAINER_PREFIX = "gradr8-s3-";

export interface S3TestTarget {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface DockerSeaweedfs {
  target: S3TestTarget;
  stop: () => Promise<void>;
}

const waitReady = async (
  target: S3TestTarget,
  timeoutMs: number,
): Promise<void> => {
  const client = new S3Client({
    endpoint: target.endpoint,
    region: target.region,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
    },
  });
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  try {
    while (Date.now() < deadline) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: target.bucket }));
        return;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  } finally {
    client.destroy();
  }
  throw new Error(
    `SeaweedFS at ${target.endpoint} not ready: ${String(lastError)}`,
  );
};

/**
 * Starts `gradr8-s3-<pid>` (SeaweedFS, S3 API on a random loopback port, a
 * random key, bucket `grad-test`) and waits until the bucket answers. Stale
 * ones older than 2 h are reaped first, like the Postgres containers.
 */
export const startDockerSeaweedfs = async (): Promise<DockerSeaweedfs> => {
  await reapStaleContainers(S3_CONTAINER_PREFIX).catch(() => undefined);
  const name = `${S3_CONTAINER_PREFIX}${process.pid}`;
  const accessKeyId = `gradtest${randomBytes(4).toString("hex")}`;
  const secretAccessKey = randomBytes(20).toString("hex");
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "s3-"));
  const config = path.join(dir, "s3.json");
  await writeFile(config, seaweedfsConfig(accessKeyId, secretAccessKey));
  // The container runs as the `seaweed` user.
  await chmod(dir, 0o755);
  await chmod(config, 0o644);
  const stop = async () => {
    await exec("docker", ["rm", "-f", name]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  };
  await exec("docker", ["rm", "-f", name]).catch(() => undefined);
  try {
    await exec(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "--memory",
        "512m",
        "-p",
        "127.0.0.1::8333",
        "-v",
        `${config}:/etc/seaweedfs/s3.json:ro`,
        SEAWEEDFS_IMAGE,
        ...seaweedfsArgs("/etc/seaweedfs/s3.json", "grad-test"),
      ],
      { timeout: 120_000 },
    );
    const { stdout } = await exec("docker", ["port", name, "8333/tcp"]);
    const port = stdout.trim().split("\n")[0]?.split(":").pop();
    if (!port) throw new Error(`could not read the port of ${name}`);
    const target: S3TestTarget = {
      endpoint: `http://127.0.0.1:${port}`,
      bucket: "grad-test",
      region: "us-east-1",
      accessKeyId,
      secretAccessKey,
    };
    await waitReady(target, 60_000);

    return { target, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};
