import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { checkServerIdentity, type ConnectionOptions } from "node:tls";

interface PostgresConnection {
  connectionString: string;
  ssl?: ConnectionOptions;
}

/**
 * The pg settings every grad connection uses. With PGSSLROOTCERT set (the
 * libpq variable; the Helm chart's database.caBundle sets it) a connection
 * verifies the server's certificate chain against that CA bundle and the
 * hostname against the certificate (sslmode=verify-full), whatever ssl
 * settings the URL carries: node-postgres ignores PGSSLROOTCERT, and a stale
 * `sslmode=no-verify` must not turn verification off. A client certificate
 * (sslcert, sslkey) is kept.
 */
export const postgresConnection = (
  connectionString: string,
  caFile = process.env.PGSSLROOTCERT,
): PostgresConnection => {
  if (!caFile?.trim()) return { connectionString };

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      "PGSSLROOTCERT is set, so the Postgres connection string must be a postgres:// URL (not key=value pairs).",
    );
  }
  const read = (file: string | null) =>
    file ? readFileSync(file, "utf8") : undefined;
  const cert = read(url.searchParams.get("sslcert"));
  const key = read(url.searchParams.get("sslkey"));
  const ssl: ConnectionOptions = {
    ca: readFileSync(caFile.trim(), "utf8"),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
  };
  // Any ssl* parameter would make node-postgres replace these settings.
  for (const name of [...url.searchParams.keys()]) {
    if (name.startsWith("ssl")) url.searchParams.delete(name);
  }
  // node-postgres sends no server name for an IP address, so Node would check
  // the certificate against "localhost": check it against the address.
  const host = (url.searchParams.get("host") ?? url.hostname).replace(
    /^\[(.+)\]$/,
    "$1",
  );
  if (isIP(host)) {
    ssl.checkServerIdentity = (_name, peer) => checkServerIdentity(host, peer);
  }

  return { connectionString: url.toString(), ssl };
};
