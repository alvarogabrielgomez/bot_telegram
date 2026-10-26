// Argument checks the harness runs in code before a tool does anything. The
// model's arguments are untrusted: a prompt injection can make it ask for any
// URL. These rules hold whatever the model was told.
//
// Known limit: this looks at the host as written. A public name whose DNS
// resolves to a private address passes. Closing that is the job of the yt-dlp
// backend, which does the actual fetch.

import { isIP } from "node:net";

const REFUSED = "Error: only public http(s) links can be downloaded.";
const refuse = () => ({ ok: false, error: REFUSED });

// 0/8, 10/8, 100.64/10 (carrier NAT), 127/8, 169.254/16 (link-local, cloud
// metadata), 172.16/12, 192.168/16.
function isPrivateV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

// `ip` is the compressed lowercase form the URL parser produces, without brackets.
function isPrivateV6(ip) {
  if (ip === "::" || ip === "::1") return true;
  // ::ffff:a.b.c.d reaches the IPv4 address a.b.c.d. The parser writes it as two hex groups.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(ip.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
}

function isInternalName(host) {
  return (
    // A name with no dot is not a public one; in a compose network it is a service.
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

// The URL returned is the parsed, normalized form (`0x7f.1` is already
// `127.0.0.1`, `http://a.com\@127.0.0.1/` is already host 127.0.0.1). Hand that
// one to the tool, so the backend cannot read the string differently than this check did.
export function checkMediaUrl(raw) {
  if (typeof raw !== "string" || !URL.canParse(raw)) return refuse();
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") return refuse();

  // IPv6 hosts come back in brackets; a trailing dot makes "localhost." a different string.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const family = isIP(host);
  if (family === 4 && isPrivateV4(host)) return refuse();
  if (family === 6 && isPrivateV6(host)) return refuse();
  if (family === 0 && isInternalName(host)) return refuse();

  return { ok: true, url: url.href };
}
