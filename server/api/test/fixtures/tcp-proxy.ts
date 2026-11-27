import { createServer, Socket, type AddressInfo } from "node:net";

/**
 * A toxiproxy-style TCP proxy for chaos tests: forwards to `target` until
 * told to `blackhole` (connections stay open but nothing gets through, like a
 * failover that leaves a dead peer behind without a RST) or `reset` (every
 * connection is cut, like a restart). `heal` forwards again.
 */
export interface TcpProxy {
  /** host:port to connect to instead of the target. */
  address: string;
  blackhole(): void;
  reset(): void;
  heal(): void;
  close(): Promise<void>;
}

export const startTcpProxy = async (
  targetHost: string,
  targetPort: number,
): Promise<TcpProxy> => {
  let holing = false;
  const pairs = new Set<[Socket, Socket]>();

  const server = createServer((client) => {
    const upstream = new Socket();
    const pair: [Socket, Socket] = [client, upstream];
    pairs.add(pair);
    const end = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
    // Bytes in either direction are dropped while black-holed.
    client.on("data", (chunk) => {
      if (!holing) upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!holing) client.write(chunk);
    });
    upstream.connect(targetPort, targetHost);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  const reset = () => {
    for (const [a, b] of [...pairs]) {
      a.destroy();
      b.destroy();
    }
    pairs.clear();
  };

  return {
    address: `127.0.0.1:${port}`,
    blackhole: () => {
      holing = true;
    },
    reset,
    heal: () => {
      holing = false;
    },
    close: async () => {
      reset();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
