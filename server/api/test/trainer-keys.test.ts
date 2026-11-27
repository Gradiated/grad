import { describe, expect, it } from "vitest";

import {
  claimableKinds,
  createLocalApiKeyAuth,
  hashApiKey,
  matchTrainerKey,
  trainerKeysOf,
} from "../src/adapters.js";
import { parseServerEnvironment } from "../src/environment.js";

const GPU = "grad_trainer_gpu_host_key";
const CPU = "grad_trainer_connector_key";
const keys = [
  { label: "h100-01", sha256: hashApiKey(GPU), kinds: ["train"] as const },
  { label: "connector", sha256: hashApiKey(CPU), kinds: ["import"] as const },
];

describe("kind-scoped trainer keys (TRAINER_KEYS_JSON)", () => {
  it("parses labelled keys and rejects malformed ones", () => {
    const base = {
      DATABASE_URL: "postgres://x",
      S3_BUCKET: "grad",
      AUTH_MODE: "none",
    };
    expect(parseServerEnvironment(base).trainerKeys).toEqual([]);
    expect(
      parseServerEnvironment({
        ...base,
        TRAINER_KEYS_JSON: JSON.stringify(keys),
      }).trainerKeys,
    ).toEqual(keys);

    for (const [raw, message] of [
      ["not json", /must be JSON/],
      [
        JSON.stringify([{ label: "a", sha256: "short", kinds: ["train"] }]),
        /sha256/,
      ],
      [
        JSON.stringify([{ label: "a", sha256: hashApiKey("x"), kinds: [] }]),
        /kinds/,
      ],
      [
        JSON.stringify([
          { label: "a", sha256: hashApiKey("x"), kinds: ["eval"] },
        ]),
        /kinds/,
      ],
      [
        JSON.stringify([...keys, { ...keys[0], sha256: hashApiKey("y") }]),
        /two keys labelled 'h100-01'/,
      ],
    ] as const) {
      expect(() =>
        parseServerEnvironment({ ...base, TRAINER_KEYS_JSON: raw }),
      ).toThrow(message);
    }
  });

  it("scopes each worker principal to its key's kinds", async () => {
    const all = trainerKeysOf(hashApiKey("grad_platform"), keys);
    expect(matchTrainerKey("grad_platform", all)?.workerKinds).toEqual([
      "train",
      "import",
    ]);
    const gpu = matchTrainerKey(GPU, all);
    expect(gpu).toMatchObject({
      actor: "trainer-worker:h100-01",
      scopes: ["trainer:worker"],
      workerKinds: ["train"],
    });
    expect(matchTrainerKey("nope", all)).toBeNull();
    expect(trainerKeysOf(undefined)).toEqual([]);

    if (!gpu) throw new Error("expected a principal");
    expect(claimableKinds(gpu, ["train", "import"])).toEqual(["train"]);
    expect(claimableKinds(gpu, ["import"])).toEqual([]);

    const auth = createLocalApiKeyAuth({
      trainerKeys: keys,
      lookup: { findActiveByHash: async () => null },
    });
    expect((await auth.authenticate(CPU))?.workerKinds).toEqual(["import"]);
    expect(await auth.authenticate("grad_platform")).toBeNull();
  });
});
