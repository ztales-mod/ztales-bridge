/**
 * The bridge between the pure protocols (ftp-core.js, ssh-core.js via link.js) and Cloudflare's
 * TCP. This is the only file that imports `cloudflare:sockets`.
 */

import { connect } from "cloudflare:sockets";
import { withServer } from "./link.js";

export { FtpError } from "./ftp-core.js";

/** { secure }: TLS from the start; { raw }: plain TCP (SSH); neither: plain, upgradable (FTP STARTTLS). */
export function cloudflareOpen(host, port, { secure, raw } = {}) {
  return connect({ hostname: host, port: Number(port) },
    { secureTransport: secure ? "on" : raw ? "off" : "starttls", allowHalfOpen: false });
}

/** cfg from linkCfg(env); store keeps the guessed protocol and the SFTP host key. */
export function withServerLink(cfg, store, fn, state) {
  return withServer(cloudflareOpen, cfg, store, fn, state);
}
