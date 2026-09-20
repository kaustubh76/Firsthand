import type { Bytes32 } from "@firsthand/core";

/**
 * An external buyer asks for access by handing the human a link. Nothing secret travels in it: a
 * card id (public on chain), the card's X25519 public key (the vault key is wrapped to it), the
 * namespace, and a label. The human approves with a passkey in the Locker; the requester learns
 * the outcome from the chain — the grant id is deterministic (README §7.2, ADR-0011).
 */
export interface GrantRequest {
  readonly card: Bytes32;
  readonly pub: Bytes32;
  readonly ns: number;
  readonly label: string;
  readonly at: number;
  /** The requester's ERC-8004 agent id, when it has one — verified against the chain before display. */
  readonly agentId?: string;
}

const KEY = "firsthand.requests";
const HEX32 = /^0x[0-9a-f]{64}$/;

export function parseGrantRequest(search: string): GrantRequest | null {
  const q = new URLSearchParams(search);
  const card = q.get("grant")?.toLowerCase() ?? "";
  const pub = q.get("pub")?.toLowerCase() ?? "";
  const ns = Number(q.get("ns") ?? "0");
  if (!HEX32.test(card) || !HEX32.test(pub)) return null;
  if (!Number.isInteger(ns) || ns < 0 || ns > 15) return null;
  const label = (q.get("from") ?? "an agent").slice(0, 64);
  const agent = q.get("agent");
  return {
    card: card as Bytes32,
    pub: pub as Bytes32,
    ns,
    label,
    at: Date.now(),
    ...(agent && /^\d{1,20}$/.test(agent) ? { agentId: agent } : {}),
  };
}

export function requestLink(appUrl: string, r: Omit<GrantRequest, "at">): string {
  const q = new URLSearchParams({ grant: r.card, pub: r.pub, ns: String(r.ns), from: r.label });
  if (r.agentId) q.set("agent", r.agentId);
  return `${appUrl.replace(/\/+$/, "")}/?${q.toString()}`;
}

export function loadRequests(): GrantRequest[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as GrantRequest[]) : [];
  } catch {
    return [];
  }
}

function save(list: GrantRequest[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: the request lives for this page only
  }
}

/** Remembers a request from the URL (deduplicated by card + ns) and strips it from the address bar. */
export function absorbRequestFromUrl(): GrantRequest[] {
  const list = loadRequests();
  const incoming = typeof location === "undefined" ? null : parseGrantRequest(location.search);
  if (incoming) {
    const exists = list.some((r) => r.card === incoming.card && r.ns === incoming.ns);
    if (!exists) list.unshift(incoming);
    save(list);
    try {
      const url = new URL(location.href);
      for (const k of ["grant", "pub", "ns", "from", "agent"]) url.searchParams.delete(k);
      history.replaceState(null, "", url.toString());
    } catch {
      // not fatal
    }
  }
  return list;
}

export function dismissRequest(card: Bytes32, ns: number): GrantRequest[] {
  const list = loadRequests().filter((r) => !(r.card === card && r.ns === ns));
  save(list);
  return list;
}

/** A shared locker: `?principal=<id>` opens the Verify tab listing what that principal published. */
export function parsePrincipalLink(search: string): Bytes32 | null {
  const id = new URLSearchParams(search).get("principal")?.toLowerCase() ?? "";
  return HEX32.test(id) ? (id as Bytes32) : null;
}

export function lockerLink(appUrl: string, principalId: Bytes32): string {
  return `${appUrl.replace(/\/+$/, "")}/?principal=${principalId}`;
}
