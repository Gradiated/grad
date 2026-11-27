import { useEffect, useState } from "react";

import { App } from "../src/app.js";
import type { KeyStore } from "../src/lib/auth.js";
import { fakeFetch, type Routes } from "./fake.js";

const memoryStore = (key: string | undefined): KeyStore => {
  let value = key;
  return { get: () => value, set: (k) => (value = k), clear: () => (value = undefined) };
};

/**
 * The whole console at `path` against a fake grad-server. The story iframe's
 * URL and `fetch` are swapped while it is mounted (the router reads
 * `location`, the health page probes `/health/ready` directly) and restored after.
 */
export const Console = ({ path, routes, signedIn = true }: { path: string; routes: Routes; signedIn?: boolean }) => {
  const [setup] = useState(() => {
    const original = { url: location.href, fetch: globalThis.fetch };
    const fake = fakeFetch(routes);
    history.replaceState(null, "", path);
    globalThis.fetch = fake;
    return { original, fake, store: memoryStore(signedIn ? "grad_demo_9f2c41d7e8a3b6" : undefined) };
  });
  useEffect(
    () => () => {
      globalThis.fetch = setup.original.fetch;
      history.replaceState(null, "", setup.original.url);
    },
    [setup],
  );
  return <App baseURL={location.origin} fetch={setup.fake} store={setup.store} />;
};
