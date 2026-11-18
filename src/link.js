/**
 * One connection to the game server's files, FTP or SFTP, chosen without the owner's help.
 * Pure (no cloudflare:sockets): `open` comes from ftp.js on the Worker and from the tests on Node.
 *
 * Settings (all optional except host, user, password):
 *   FTP_HOST   the address; may carry the port ("host:2022") and the protocol ("sftp://host:2022")
 *   FTP_USER, FTP_PASS
 *   FTP_PORT   used when FTP_HOST has no port (21 by default)
 *   FTP_TLS    "1": explicit TLS on FTP
 *   SERVER_PROTOCOL  "ftp" or "sftp" to skip the guess
 *   SFTP_HOST_KEY    "SHA256:..." to pin the server's key by hand (otherwise pinned on first login)
 *
 * The guess: port 22 is SFTP, 21 is FTP; any other port is asked once (its first line says
 * "SSH-..." or "220 ...") and the answer kept in the state table.
 *
 * SFTP host key: trusted on the first login and kept (as a fingerprint, with a hash of the
 * address, never the address). A later login that shows another key is refused: that is what
 * someone pretending to be the server would look like. A new address starts a new pin.
 */
import { withFtp } from "./ftp-core.js";
import { withSftp, detectProtocol } from "./ssh-core.js";

export function linkCfg(env) {
  let host = String(env.FTP_HOST || "").trim();
  let protocol = String(env.SERVER_PROTOCOL || "").trim().toLowerCase();
  const scheme = host.match(/^(s?ftps?):\/\//i);
  if (scheme) {
    host = host.slice(scheme[0].length);
    if (!protocol) protocol = scheme[1].toLowerCase() === "sftp" ? "sftp" : "ftp";
  }
  // panels often show "sftp://user@host:port/": the user is FTP_USER's, the path ZTALES_ROOT's
  host = host.replace(/\/.*$/, "").replace(/^.*@/, "");
  // the port: the one in the address, else the scheme's own (FTP_PORT belongs to plain FTP setups),
  // else FTP_PORT; nobody serves SFTP on 21
  let port = scheme ? 0 : Number(env.FTP_PORT || 0);
  const hp = host.match(/^(.*):(\d+)$/);
  if (hp && !hp[1].includes(":")) { host = hp[1]; port = Number(hp[2]); }
  if (protocol === "sftp" && port === 21) port = 0;
  if (!port) port = protocol === "sftp" ? 22 : 21;
  if (protocol !== "ftp" && protocol !== "sftp") protocol = "";
  return {
    host, port, user: env.FTP_USER, pass: env.FTP_PASS, tls: env.FTP_TLS === "1",
    protocol, hostKey: String(env.SFTP_HOST_KEY || "").trim(),
  };
}

/** A short hash of host:port: the state remembers which server a pin belongs to, not where it is. */
async function linkId(cfg) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${cfg.host.toLowerCase()}:${cfg.port}`));
  return [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Which protocol, without a probe when the port says it. */
export async function chooseProtocol(open, cfg, state = {}, id = "") {
  if (cfg.protocol) return { protocol: cfg.protocol, learned: false };
  if (cfg.port === 22) return { protocol: "sftp", learned: false };
  if (cfg.port === 21) return { protocol: "ftp", learned: false };
  if (id && state.link_id === id && (state.link_protocol === "ftp" || state.link_protocol === "sftp")) {
    return { protocol: state.link_protocol, learned: false };
  }
  return { protocol: await detectProtocol(open, cfg.host, cfg.port), learned: true };
}

/**
 * Runs fn(session, protocol) over one connection and always closes it. `store` keeps the guessed
 * protocol and the SFTP pin (getState/setState); `state` may be passed when the caller has it.
 */
export async function withServer(open, cfg, store, fn, state = null) {
  const st = state || (await store.getState());
  const id = await linkId(cfg);
  const same = st.link_id === id;
  const { protocol, learned } = await chooseProtocol(open, cfg, st, id);
  const patch = {};
  if (learned || !same || st.link_protocol !== protocol) Object.assign(patch, { link_id: id, link_protocol: protocol });
  if (protocol === "ftp") {
    if (Object.keys(patch).length) await store.setState(patch);
    return withFtp(open, cfg, (s) => fn(s, "ftp"));
  }
  const pin = cfg.hostKey || (same && st.sftp_host_key) || "";
  // SSH is plain TCP: the socket must not be set up for STARTTLS
  const raw = (h, p) => open(h, p, { raw: true });
  return withSftp(raw, { ...cfg, hostKey: pin }, async (s) => {
    if (!pin) Object.assign(patch, { link_id: id, link_protocol: "sftp", sftp_host_key: s.hostKey });
    if (Object.keys(patch).length) await store.setState(patch);
    return fn(s, "sftp");
  });
}
