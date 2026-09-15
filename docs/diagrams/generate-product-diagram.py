#!/usr/bin/env python3
"""Generates docs/diagrams/firsthand-product.excalidraw — the whole FIRSTHAND product as designed
(README ideation), with build status as a badge per component. Deterministic ids and seeds."""
import json
import math
import sys
import zlib

OUT = sys.argv[1] if len(sys.argv) > 1 else "firsthand-product.excalidraw"  # run from docs/diagrams

# ── palette ─────────────────────────────────────────────────────────────────────────────────────
INK = "#1e1e1e"
STATUS = {
    "BUILT": ("#b2f2bb", "#2b8a3e", "solid"),
    "PARTIAL": ("#ffec99", "#e67700", "solid"),
    "PLANNED": ("#a5d8ff", "#1864ab", "solid"),
    "ROADMAP": ("#d0bfff", "#6741d9", "dashed"),
    "STRETCH": ("#ffd8a8", "#d9480f", "dashed"),
    "EXTERNAL GATE": ("#dee2e6", "#495057", "dotted"),
    "NON-GOAL": ("#ffc9c9", "#c92a2a", "dashed"),
}
FLOW = {
    "deposit": "#2f9e44",
    "query": "#1971c2",
    "rescind": "#e03131",
    "liveness": "#e8590c",
    "audit": "#7048e8",
    "gate": "#868e96",
}
LANE_FILL = {
    "people": "#f8f9fa",
    "surfaces": "#fff4e6",
    "libs": "#f3f0ff",
    "gateway": "#e7f5ff",
    "monad": "#ebfbee",
    "evidence": "#fff9db",
    "delivery": "#f1f3f5",
}

elements = []
ids = set()
_seed = [1]


def seed():
    _seed[0] += 1
    return zlib.crc32(str(_seed[0]).encode()) & 0x7FFFFFFF


def base(id_, type_, x, y, w, h, **kw):
    assert id_ not in ids, id_
    ids.add(id_)
    el = {
        "id": id_,
        "type": type_,
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "angle": 0,
        "strokeColor": INK,
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 1,
        "strokeStyle": "solid",
        "roughness": 0,
        "opacity": 100,
        "groupIds": [],
        "frameId": None,
        "roundness": {"type": 3} if type_ == "rectangle" else None,
        "seed": seed(),
        "version": 1,
        "versionNonce": seed(),
        "isDeleted": False,
        "boundElements": [],
        "updated": 1758000000000,
        "link": None,
        "locked": False,
    }
    el.update(kw)
    elements.append(el)
    return el


def text_metrics(text, font_size, max_width=None):
    cw = 0.53 * font_size
    lines = []
    for raw in text.split("\n"):
        if max_width is None:
            lines.append(raw)
            continue
        per = max(8, int((max_width - 12) / cw))
        words = raw.split(" ")
        cur = ""
        for w in words:
            cand = w if not cur else f"{cur} {w}"
            if len(cand) > per and cur:
                lines.append(cur)
                cur = w
            else:
                cur = cand
        lines.append(cur)
    width = max((len(l) for l in lines), default=1) * cw
    height = len(lines) * font_size * 1.25
    return width, height, len(lines)


def text(id_, x, y, content, font_size=16, family=2, align="left", valign="top", container=None,
         color=INK, width=None, group=None):
    w, h, _ = text_metrics(content, font_size, width)
    el = base(
        id_, "text", x, y, width or w, h,
        strokeColor=color,
        text=content,
        fontSize=font_size,
        fontFamily=family,
        textAlign=align,
        verticalAlign=valign,
        containerId=container,
        originalText=content,
        autoResize=container is None,
        lineHeight=1.25,
        roundness=None,
    )
    if group:
        el["groupIds"] = [group]
    return el


def rect(id_, x, y, w, h, fill="transparent", stroke=INK, style="solid", stroke_width=1, group=None):
    el = base(id_, "rectangle", x, y, w, h, backgroundColor=fill, strokeColor=stroke,
              strokeStyle=style, strokeWidth=stroke_width)
    if group:
        el["groupIds"] = [group]
    return el


def bind_text(container, tid, content, font_size=15, align="left", valign="top", color=INK):
    t = text(tid, container["x"] + 6, container["y"] + 6, content, font_size=font_size, align=align,
             valign=valign, container=container["id"], color=color, width=container["width"] - 12)
    t["groupIds"] = list(container["groupIds"])
    container["boundElements"].append({"id": tid, "type": "text"})
    return t


# ── layout engine: column grid + lanes + orthogonal routing ─────────────────────────────────────
COL_W, GUT, X0 = 520, 60, 70
NCOLS = 8
LANE_GAP = 130         # corridor between lanes for horizontal arrow runs
HEADER_H = 96          # lane title + subtitle + same-lane corridor
CANVAS_W = X0 + NCOLS * COL_W + (NCOLS - 1) * GUT + 30


def col_x(i):
    return X0 + i * (COL_W + GUT)


def gutter_x(i):
    """x of the vertical gutter to the LEFT of column i (i in 0..NCOLS)."""
    return col_x(i) - GUT / 2 if i > 0 else X0 - 48


CARD_DEFS = []          # (key, lane, col, span, title, status, lines, min_h)
LANE_DEFS = []          # (key, title, subtitle, [(x, w, title)] sub-bands)


def defcard(key, lane, col, span, title, status, lines, min_h=0, row=0):
    CARD_DEFS.append(dict(key=key, lane=lane, col=col, span=span, title=title, status=status,
                          lines=lines, min_h=min_h, row=row))


def deflane(key, title, subtitle, bands=None):
    LANE_DEFS.append(dict(key=key, title=title, subtitle=subtitle, bands=bands or []))


cards = {}
lanes_geo = {}


def card_height(d):
    w = d["span"] * COL_W + (d["span"] - 1) * GUT
    body = "\n".join(f"• {l}" for l in d["lines"])
    _, th, _ = text_metrics(body, 14, w - 12)
    return max(d["min_h"], 40 + th * 1.12 + 24)


def draw_card(d, x, y):
    key, status, w = d["key"], d["status"], d["span"] * COL_W + (d["span"] - 1) * GUT
    fill, stroke, style = STATUS[status]
    g = f"g-{key}"
    height = card_height(d)
    header = rect(f"hdr-{key}", x, y, w, 40, fill="#ffffff", stroke=stroke, style=style, stroke_width=2, group=g)
    bind_text(header, f"hdr-txt-{key}", d["title"], font_size=17, align="left", valign="middle")
    body = rect(f"box-{key}", x, y + 40, w, height - 40, fill="#ffffff", stroke=stroke, style=style,
                stroke_width=2, group=g)
    bind_text(body, f"txt-{key}", "\n".join(f"• {l}" for l in d["lines"]), font_size=14)
    bw = 9 * len(status) + 18
    badge = rect(f"badge-{key}", x + w - bw - 8, y + 8, bw, 24, fill=fill, stroke=stroke, style="solid",
                 stroke_width=1, group=g)
    bind_text(badge, f"badge-txt-{key}", status, font_size=12, align="center", valign="middle", color=stroke)
    cards[key] = dict(body=body, hdr=header, x=x, y=y, w=w, h=height, lane=d["lane"], col=d["col"],
                      span=d["span"])
    return body


def layout(y_start):
    y = y_start
    for L in LANE_DEFS:
        mine = [c for c in CARD_DEFS if c["lane"] == L["key"]]
        rows = sorted({c["row"] for c in mine})
        row_h = {r: max(card_height(c) for c in mine if c["row"] == r) for r in rows}
        inner = sum(row_h.values()) + 30 * (len(rows) - 1)
        h = HEADER_H + inner + 30
        r = rect(f"lane-{L['key']}", 40, y, CANVAS_W - 80, h, fill=LANE_FILL[L["key"]], stroke="#adb5bd",
                 group=f"g-lane-{L['key']}")
        text(f"lane-title-{L['key']}", 56, y + 10, L["title"], font_size=24, group=f"g-lane-{L['key']}", color="#343a40")
        text(f"lane-sub-{L['key']}", 56, y + 42, L["subtitle"], font_size=14, group=f"g-lane-{L['key']}", color="#495057")
        for bx, bw, bt in L["bands"]:
            text(f"lane-band-{L['key']}-{int(bx)}", bx, y + 42, bt, font_size=14, group=f"g-lane-{L['key']}", color="#495057")
        lanes_geo[L["key"]] = dict(y=y, h=h, top=y, bottom=y + h)
        ry = y + HEADER_H
        for rr in rows:
            for c in mine:
                if c["row"] == rr:
                    draw_card(c, col_x(c["col"]), ry)
            ry += row_h[rr] + 30
        y += h + LANE_GAP


LANE_ORDER = []
corridor_use = {}   # corridor key -> count (for staggering)
gutter_use = {}


def corridor_y(lane_key, side):
    """y of the horizontal corridor just below ('below') or above ('above') a lane, staggered."""
    g = lanes_geo[lane_key]
    k = (lane_key, side)
    n = corridor_use.get(k, 0)
    corridor_use[k] = n + 1
    off = (n % 7) * 15 - 45
    return (g["bottom"] + LANE_GAP / 2 + off) if side == "below" else (g["top"] - LANE_GAP / 2 + off)


def blocked(x, y0, y1):
    """True if a vertical run at x between y0..y1 would cross any card."""
    lo, hi = min(y0, y1), max(y0, y1)
    for c in cards.values():
        if c["x"] - 6 <= x <= c["x"] + c["w"] + 6 and c["y"] < hi and c["y"] + c["h"] > lo:
            return True
    return False


def gutter(i, y0, y1):
    """Nearest free vertical gutter to column i's left edge for a run y0..y1 (skips gutters inside wide cards)."""
    order = sorted(range(NCOLS + 1), key=lambda k: abs(k - i))
    for k in order:
        gx = gutter_x(k) if k < NCOLS else col_x(NCOLS - 1) + COL_W + 30
        if not blocked(gx, y0, y1):
            n = gutter_use.get(k, 0)
            gutter_use[k] = n + 1
            return gx + (n % 5) * 8 - 16
    return gutter_x(i)


def route(src, dst):
    """Orthogonal polyline from src card to dst card that only travels in lane corridors and column gutters."""
    a, b = cards[src], cards[dst]
    la, lb = LANE_ORDER.index(a["lane"]), LANE_ORDER.index(b["lane"])
    acx = a["x"] + a["w"] / 2
    bcx = b["x"] + b["w"] / 2
    pts = []
    if la == lb:
        # same lane: neighbours connect side to side, otherwise dip below the row through the lane's bottom margin
        if abs(a["col"] + a["span"] - b["col"]) == 0 or abs(b["col"] + b["span"] - a["col"]) == 0:
            if a["x"] < b["x"]:
                y = min(a["y"] + a["h"], b["y"] + b["h"]) - 30
                return [(a["x"] + a["w"], y), (b["x"], y)]
            y = min(a["y"] + a["h"], b["y"] + b["h"]) - 30
            return [(a["x"], y), (b["x"] + b["w"], y)]
        # non-adjacent, same lane: run along the corridor between the lane header and the first row
        n = corridor_use.get((a["lane"], "inner"), 0)
        corridor_use[(a["lane"], "inner")] = n + 1
        yt = lanes_geo[a["lane"]]["top"] + 66 + (n % 3) * 9
        return [(acx, a["y"]), (acx, yt), (bcx, yt), (bcx, b["y"])]
    down = lb > la
    start = (acx, a["y"] + a["h"]) if down else (acx, a["y"])
    end = (bcx, b["y"]) if down else (bcx, b["y"] + b["h"])
    pts.append(start)
    first = corridor_y(a["lane"], "below" if down else "above")
    pts.append((acx, first))
    if abs(la - lb) == 1:
        pts.append((bcx, first))
    else:
        # travel the gutter left of the destination column (or right edge gutter when heading far right)
        last = corridor_y(b["lane"], "above" if down else "below")
        gx = gutter(b["col"], first, last)
        pts.append((gx, first))
        pts.append((gx, last))
        pts.append((bcx, last))
    pts.append(end)
    return pts


def arrow(key, src, dst, label, flow, dashed=False):
    a, b = cards[src]["body"], cards[dst]["body"]
    pts = route(src, dst)
    x0, y0 = pts[0]
    rel = [[p[0] - x0, p[1] - y0] for p in pts]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    aid = f"arrow-{key}"
    el = base(
        aid, "arrow", x0, y0, max(xs) - min(xs), max(ys) - min(ys),
        strokeColor=FLOW[flow], strokeWidth=2, strokeStyle="dashed" if dashed else "solid",
        points=rel,
        startBinding={"elementId": a["id"], "focus": 0, "gap": 2},
        endBinding={"elementId": b["id"], "focus": 0, "gap": 2},
        startArrowhead=None, endArrowhead="arrow", elbowed=False, roundness=None,
    )
    a["boundElements"].append({"id": aid, "type": "arrow"})
    b["boundElements"].append({"id": aid, "type": "arrow"})
    # label on the longest horizontal segment
    best, mid = 0, pts[0]
    for p, q in zip(pts, pts[1:]):
        if abs(q[0] - p[0]) >= best and p[1] == q[1]:
            best, mid = abs(q[0] - p[0]), ((p[0] + q[0]) / 2, p[1])
    lw, lh, _ = text_metrics(label, 13)
    t = text(f"arrow-txt-{key}", mid[0] - lw / 2, mid[1] - lh / 2, label, font_size=13, align="center",
             valign="middle", container=aid, color=FLOW[flow])
    el["boundElements"].append({"id": t["id"], "type": "text"})
    return el


# ═══════════════════════════════════════════════════════════════════════════════════════════════
# 0. Title strip, causal chain, legend
# ═══════════════════════════════════════════════════════════════════════════════════════════════
text("title", 40, 20, "FIRSTHAND — the product, end to end", font_size=40)
text(
    "thesis", 40, 74,
    "Every piece of human-created data gets a passkey-signed passport of origin, price and consent; AI buyers pay per "
    "query over x402; humans withdraw consent faster than anyone can front-run it. Three verbs — deposit / query / "
    "rescind — one verification call (README §1, §4). Read the causal chain left→right, then the lanes top→bottom: "
    "supply side on the left, demand side on the right, Monad in the middle, evidence and delivery at the bottom.",
    font_size=16, width=3400, color="#343a40",
)
text("chain-title", 40, 140, "Causal chain (README §8)", font_size=18, color="#343a40")
chain = [
    "passkey tap", "PRF output", "derived keys", "deposit signs passport", "batch root anchors (MIP-8)",
    "buyer accepts terms", "grant wraps vault key", "query pays (x402)", "verify() gates",
    "data + passport served", "receipt anchors", "rescind (BTX | commit-reveal)",
    "next verify() fails → ledger dates the end of consent",
]
cx = 40
for i, step in enumerate(chain):
    w = 300 if i < 12 else 420
    r = rect(f"chain-{i}", cx, 172, w, 64, fill="#ffffff", stroke="#495057", stroke_width=2, group="g-chain")
    bind_text(r, f"chain-txt-{i}", f"{i + 1}. {step}", font_size=15, align="center", valign="middle")
    if i > 0:
        prev = elements[[e["id"] for e in elements].index(f"chain-{i - 1}")]
        aid = f"chain-arrow-{i}"
        gap = cx - (prev["x"] + prev["width"])
        el = base(aid, "arrow", prev["x"] + prev["width"], 204, gap, 0, strokeColor="#495057", strokeWidth=2,
                  points=[[0, 0], [gap, 0]],
                  startBinding={"elementId": prev["id"], "focus": 0, "gap": 2},
                  endBinding={"elementId": r["id"], "focus": 0, "gap": 2},
                  startArrowhead=None, endArrowhead="arrow", elbowed=False, roundness=None)
        el["groupIds"] = ["g-chain"]
        prev["boundElements"].append({"id": aid, "type": "arrow"})
        r["boundElements"].append({"id": aid, "type": "arrow"})
    cx += w + 40

rect("legend", 40, 262, CANVAS_W - 80, 100, fill="#ffffff", stroke="#adb5bd", group="g-legend")
text("legend-title", 56, 270, "Legend", font_size=16, group="g-legend", color="#343a40")
lx = 56
for status, (fill, stroke, style) in STATUS.items():
    bw = 9 * len(status) + 18
    b = rect(f"legend-{status}", lx, 298, bw, 24, fill=fill, stroke=stroke, group="g-legend")
    bind_text(b, f"legend-txt-{status}", status, font_size=12, align="center", valign="middle", color=stroke)
    lx += bw + 14
text(
    "legend-status-note", lx + 10, 300,
    "badges = build status on 2026-09-15 — an annotation; every box is part of the design. "
    "Dashed stroke = roadmap / non-goal, dotted = external gate.",
    font_size=13, group="g-legend", color="#495057",
)
lx = 56
names = {"deposit": "① deposit", "query": "② query", "rescind": "③ rescind", "liveness": "④ liveness / attest",
         "audit": "⑤ audit / evidence", "gate": "⑥ external gate (dashed)"}
for flow, color in FLOW.items():
    t = text(f"legend-flow-{flow}", lx, 334, f"━━ {names[flow]}", font_size=14, group="g-legend", color=color)
    lx += t["width"] + 30
text(
    "legend-lanes", lx + 10, 334,
    "Arrows only travel in the gaps between lanes and columns — follow one colour at a time.",
    font_size=13, group="g-legend", color="#495057",
)

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# Lanes and cards (col 0..3 = supply side, col 4..7 = demand side)
# ═══════════════════════════════════════════════════════════════════════════════════════════════
deflane("people", "A · People & agents", "Who touches the system and what each of them holds.",
        bands=[(col_x(4), 0, "→ demand side")])
defcard("principal", "people", 0, 1, "Principal (the human)", "BUILT", [
    "One passkey, no seed phrase; every key derives from its PRF output (§7.3)",
    "Enrolls once, re-attests weekly (liveness), deposits, grants, rescinds",
    "All secrets stay on the principal's device — never on a gateway",
    "Recovery: single passkey in the demo; guardian threshold is roadmap (§13)",
])
defcard("auditor", "people", 1, 1, "Auditor / regulator / compliance", "BUILT", [
    "Receives a Lineage Manifest: one file per corpus (§1, §24)",
    "Verifies offline: Merkle inclusion + anchors + receipts + finality depth",
    "Per-asset diligence and EU-AI-Act lineage without trusting the gateway",
])
defcard("externals", "people", 2, 2, "External gates (§16 Phase 0)", "EXTERNAL GATE", [
    "Mera passkey provider: PRF exposure for HKDF derivation → unblocks the key tree",
    "Monad BTX testnet availability — NOT deployed as of 2026-09 (Category Labs' batched threshold encryption) → unblocks the btx path",
    "Monad MIP-8 storage-page spec — pricing unconfirmed on a vanilla EVM → decides the anchors layout (H1)",
    "Cleanverse CVI sandbox — verified-human namespaces for the Silver tier",
])
defcard("buyer", "people", 4, 1, "Buyer / AI agent", "BUILT", [
    "Holds a grantee card: cardId = keccak(owner, X25519 pubkey) (ERC-8004 lineage, §7.2)",
    "Accepts terms by signature, pays per query over x402 (EIP-3009 USDC)",
    "Opens plaintext locally: unwrap vault key → DEK → blob",
    "Demo buyer: a Qwen agent accepting terms and paying (§19)",
])
defcard("observer", "people", 5, 1, "Observer bot (adversary, §13)", "BUILT", [
    "Watches the mempool; on a pending rescind fires a bulk extraction",
    "Bids priority fee to be ordered before the rescission in the block",
    "Its win rate is the S3 / H2 measurement, per arm",
])
defcard("team", "people", 6, 2, "Team, mentors, judges (§17, §18)", "PLANNED", [
    "Solo dev (Kaushtubh / Cipher); gate discipline: CI green, ≥ 95 % coverage on math libs, self-review checklist",
    "Written mentor answers or fallbacks locked per external gate; Cipher affiliation declared",
    "Judges: public repo + testnet credentials (deployments/NOTES.md) + both videos",
])

deflane("surfaces", "B · Surfaces — user side (secrets live here)      ·      Gateway — serving path (holds NO key material)",
        "Left: three verbs, one verification call, an SDK and an MCP tool (§4); only these may import @firsthand/crypto. "
        "Right: open-spec, self-hostable; serves ciphertext + public proofs and re-runs verify() on every serve.")
defcard("pwa", "surfaces", 0, 1, "Capture PWA (apps/capture)", "PARTIAL", [
    "Vite + React PWA; WebAuthn PRF ceremony on the device",
    "Screens today: Enroll · Unlock · Capture (text) · Locker · Rescind (commit-reveal); memory adapters",
    "Pending (Phase 5): live-chain wiring, gateway blob endpoint, media/clip capture, buyer screen, Consent Ledger view",
    "Vision (§19): phone captures a live clip → one tap → passport stamped",
])
defcard("mcp", "surfaces", 1, 1, "MCP server (apps/mcp)", "BUILT", [
    "Tools: firsthand_enroll · attest · deposit · grant · query · rescind · status (stdio)",
    "Runs on the user's machine and may derive keys; a hostile client can only pollute its own locker (§13)",
    "Transport: BtxTransport (BTX_RPC_URL) | PublicMempoolTransport | memory (calldata only)",
    "Buyer side via BUYER_PRIVATE_KEY + GRANTEE_SEED_HEX; PRF handoff from the PWA pending",
])
defcard("importers", "surfaces", 2, 1, "Importers (packages/importers)", "BUILT", [
    "ChatGPT and Claude memory exports → namespaces (§10, §22)",
    "Deposits carry AttestationClass.IMPORT + sourceTag so buyers can filter (§13)",
    "CLI: parse → normalise (JCS) → deposit through the SDK",
])
defcard("sdk", "surfaces", 3, 1, "SDK (@firsthand/sdk)", "BUILT", [
    "Locker: PRF → key tree, namespaces (ns 0..15), P-256 authority key, deposit keys per (ns, epoch)",
    "Verbs: enroll · attest · deposit (mint → seal → refusal gate) · publish · acceptTerms · grant · query · rescind",
    "Batcher (≤ 256 passports per anchor); BuyerSession (registerCard, acceptTerms, query, queryAndOpen)",
    "Lineage Manifest export + offline verifyManifest (signatures all | none | sample)",
])
defcard("routes", "surfaces", 4, 1, "Gateway routes (apps/gateway, Hono)", "BUILT", [
    "GET /v1/query/:grantId/:passportId — 402 priced from the sidecar → X-PAYMENT → verify → settle → serve",
    "GET /v1/passports/:id · /v1/blobs/:id · /v1/grants/:id/wrap · /v1/anchors/:root",
    "POST /v1/passports · /v1/blobs · /v1/grants/:id/wrap — verified ingest",
    "/.well-known/firsthand.json · /healthz; RFC 9457 problem+json with FH_* codes",
])
defcard("serving", "surfaces", 5, 1, "Serving — verified ingest, verified serve", "BUILT", [
    "Ingest a sidecar only if: signature ✓ · root anchored ✓ · anchor owner ✓ · Merkle index ✓ · terms preimage ✓",
    "Accept a grant wrap only if keccak256(bytes) == GrantManager.wrapRef; blobs content-addressed",
    "Serve: verifyPredicate (GrantReader + anchorOf) → Settlement → {sidecar, blob, wrappedDek, receipt}",
    "A poisoned catalog can at most refuse — never mis-serve (ADR-0011)",
])
defcard("x402", "surfaces", 6, 1, "x402 middleware + facilitator", "PARTIAL", [
    "402 carries accepts[]: maxAmountRequired = price, payTo = RoyaltyRouter, extra.{chainId, name, version, chainTime}",
    "Buyer signs EIP-3009 TransferWithAuthorization under the USDC domain; header X-PAYMENT",
    "Facilitator: MemoryFacilitator (built) | MonadFacilitatorClient (built; live interop Phase 5)",
])
defcard("storage", "surfaces", 7, 1, "Catalog · blobs · rate limit · relayer", "BUILT", [
    "PassportCatalog (memory | fs): public sidecars; BlobStore (memory | fs; IPFS shell): ciphertext only",
    "Token-bucket pre-filter; the on-chain ReceiptLedger counter is the truth",
    "RELAYER_PRIVATE_KEY pays gas for RoyaltyRouter.settle and nothing else — never a user key",
])

deflane("libs", "C · Libraries — pure logic, ports, and the Monad-specific adapters behind them",
        "ADR-0001: only @firsthand/crypto touches secrets. ADR-0006: every Monad feature sits behind a port with a memory double.")
defcard("crypto", "libs", 0, 1, "@firsthand/crypto", "BUILT", [
    "HKDF-SHA256 key tree (salt FIRSTHAND/kdf/v1): k_id · k_ns,e · k_dep(ns,e) · k_nonce(ns,e) (ADR-0005)",
    "P-256 authority key — verified on chain by the RIP-7212 precompile, low-s enforced",
    "secp256k1 deposit keys per (ns, epoch) — sign passports and anchors, never hold funds",
    "XChaCha20-Poly1305 envelope 'FH1E'; X25519 sealed-box grant wrap (ADR-0007); SecretBytes handles",
    "Roadmap: guardian-threshold recovery; WebAuthn assertion parsing on chain",
])
defcard("core", "libs", 1, 1, "@firsthand/core", "BUILT", [
    "EIP-712 typed encodings: Passport, Terms, Attestation, Enroll / Attest / Anchor / Grant / AcceptTerms / Rescind",
    "Merkle depth 8, batch 256 (ADR-0004); SplitMath floor + dust (ADR-0003); epochs, grace 2, thaw (ADR-0008/0012)",
    "verifyPredicate — the one call — and the grant state machine (RESCINDED > EXPIRED > FROZEN > ACTIVE)",
    "FH_* error codes → RFC 9457; zod schemas; golden vectors shared with forge",
])
defcard("ports", "libs", 2, 1, "@firsthand/adapters — ports (ADR-0006)", "BUILT", [
    "Supply: AnchorWriter · TxTransport (btx | public | memory) · BlobStore",
    "Gateway: PassportCatalog · GrantReader (principalLiveness, chainTime) · Settlement",
    "Demand / audit: X402Facilitator · ConsentLedger · Erc8004Registry",
    "Every port has a memory double with call recording + failNext(); browser subpaths /memory and /x402",
])
defcard("impls", "libs", 3, 2, "@firsthand/adapters — live implementations", "PARTIAL", [
    "BUILT: OnchainAnchorWriter (simulate first, decoded reverts) · OnchainGrantReader · OnchainSettlement · PublicMempoolTransport · FsBlobStore · FsPassportCatalog · MonadFacilitatorClient",
    "PARTIAL: BtxTransport — sign → seal (hook) → post via configurable method; refuses FH_BTX_UNAVAILABLE while the node lacks it (never a silent downgrade)",
    "PARTIAL (typed shells): EnvioConsentLedger (GraphQL client ready) · IpfsBlobStore · OnchainErc8004Registry",
    "Pending live runs: Monad native x402 facilitator (Phase 5); BTX when Monad ships it",
])
defcard("runtime", "libs", 5, 1, "@firsthand/runtime · contracts ABI · test-vectors", "BUILT", [
    "Logger with non-removable redaction (prf / prk / secret / privateKey / dek / seed …); env loading",
    "Generated ABIs for 14 contracts; golden vectors hand-derived via cast + OpenSSL, run by vitest AND forge",
])
defcard("rules", "libs", 6, 2, "Architecture rules (enforced in CI)", "BUILT", [
    "check-deps allow-list + Biome noRestrictedImports: apps/gateway can never depend on @firsthand/crypto",
    "Monad specifics (BTX, MIP-8, P-256 precompile, x402, ERC-8004, Envio) only behind ports",
    "Each contract verifies authority signatures under its OWN EIP-712 domain (ADR-0009)",
    "Encodings change only with regenerated vectors + independently re-derived hand cases",
])

deflane("monad", "D · Monad — immutable contracts (no proxies, no admin keys) and the chain features they lean on",
        "Every authority-signed entry point is relayable: authorisation is the P-256 signature, never msg.sender.")
defcard("registry", "monad", 0, 1, "PrincipalRegistry (§9)", "BUILT", [
    "enroll(x, y, epoch, nonce, sig) — principalId = keccak(x, y); P-256 verified by the precompile",
    "attest(principalId, epoch, depositKeysRoot, nonce, sig) — weekly liveness; one root per epoch, monotone",
    "isLive = within grace 2 ∧ now ≥ thawEpoch; a re-attest after a gap thaws one boundary later (§7.6)",
    "FROZEN is derived, never stored; nonces scoped per principal",
])
defcard("anchors", "monad", 1, 1, "PassportAnchors — Baseline · Paged (§9)", "BUILT", [
    "anchor(principalId, ns, epoch, batchRoot, termsHash, nonce, depositKeys[16], depositSig)",
    "Deposit-key signature must recover to depositKeys[ns]; keccak(depositKeys) == attested root",
    "isAnchored · isIncluded(root, passportId, proof) · anchorOf(root) → (principal, ns, epoch)",
    "Paged = contiguous slot run per (principal, ns, epoch): the MIP-8 arm for H1 (ADR-0010)",
])
defcard("grants", "monad", 2, 1, "GrantManager (§7.2, §7.5)", "BUILT", [
    "registerCard(owner, x25519Pub) · acceptTerms(card, principal, TermsInput, nonce, cardSig) — terms by preimage",
    "grant(…, term ≤ 8, termsHash, wrapRef, authoritySig) — P-256; price ≥ floor; wrapRef never re-released",
    "rescind(grantId, epoch, nonce, sig) — effective at inclusion · revealRescind(grantId, salt, …) within revealWindowBlocks",
    "effectiveStatus (lazy): RESCINDED > EXPIRED > FROZEN (registry.isLive) > ACTIVE",
])
defcard("rescissions", "monad", 3, 1, "Rescissions (§9)", "BUILT", [
    "commit(keccak(grantId ‖ salt)) — anyone may post (relayable, sender unlinkable)",
    "commitBlock(commitment) — the effective end of consent on the fallback path",
    "BTX is a transport property, not a contract API: rescind is the same call on both arms",
])
defcard("ledger", "monad", 4, 1, "ReceiptLedger (§9)", "BUILT", [
    "record(grantId, queryNonce, payer, ns, termsHash, rateLimit, epoch) — router-only",
    "receiptId = keccak(grantId, authNonce): payment and receipt dedup coincide",
    "queriesThisEpoch < rateLimit (0 = unlimited); every read is an on-chain receipt (§1)",
])
defcard("router", "monad", 5, 1, "RoyaltyRouter (§7.3, §9)", "BUILT", [
    "settle(grantId, TermsInput, TransferAuthorization): status ACTIVE ∧ hashTerms ∧ value == price",
    "EIP-3009 transferWithAuthorization pull → SplitMath (floor) → payees → residual to dust",
    "Invariant (fuzz + invariant suites): router USDC balance == dustBalance; measured 241,741 gas/settle",
])
defcard("lens", "monad", 6, 1, "FirsthandLens (§7.3, §9)", "BUILT", [
    "verify(passport, sig, batchRoot, proof, grantId) → (ok, reason)",
    "Order: SIG → ROOT_UNKNOWN → MERKLE → SCOPE_MISMATCH → TERMS → status → EPOCH_OUT_OF_GRANT",
    "Twin of core verifyPredicate — identical reasons on and off chain; read-only views for dashboards / Envio",
])
defcard("libs", "monad", 7, 1, "Libraries · MockUSDC · Deploy", "BUILT", [
    "PassportLib · MerkleLib · SplitMath · AuthorityDigests · EpochLib · P256 — pure, fuzz-tested",
    "MockUSDC: ERC-20 + EIP-3009 test double under USDC's domain (anvil only)",
    "Deploy.s.sol → deployments/<chainId>.json; immutable, no admin keys",
])
defcard("monadfeatures", "monad", 0, 3, "Monad features leaned on (§8) — status of each", "EXTERNAL GATE", [
    "P-256 precompile 0x100 (RIP-7212): LIVE — anvil --odyssey today, native on testnet",
    "MIP-8 storage pages: pricing unconfirmed — baseline 168,109 vs paged 171,358 gas/batch on a vanilla EVM; H1 re-measured on testnet",
    "BTX encrypted mempool: NOT deployed (2026-09) — transport ships probe-gated; commit-reveal is the fallback that works everywhere",
    "Native x402 facilitator: client built, live interop Phase 5 · ERC-8004 registry: cards are on-chain commitments, adapter shell · Envio HyperIndex: config + schema, handlers Phase 5",
], row=1)

deflane("evidence", "E · Evidence & audit — the manifest, the ledger, the experiments, the gates",
        "README §15: results and failed hypotheses are reported as prominently as wins; traces are first-class deliverables.")
defcard("manifest", "evidence", 0, 1, "Lineage Manifest (§1, §10, §24)", "BUILT", [
    "Per passport: 8-hash Merkle proof (257 B) + batch root + anchor block/tx + receipts",
    "verifyManifest offline: Merkle ≈ 193 µs/asset; full signature re-proof ≈ 2.9 ms/asset (pure JS)",
    "Roadmap: streaming manifest format; native signature verifier",
])
defcard("experiments", "evidence", 1, 2, "/experiments — S1–S4, baselines B1/B2, hypotheses H1–H3 (§15)", "BUILT", [
    "S1 deposit-scale (H3/H1): 10 k passports → Merkle-only verify 1.93 s; full ECDSA re-proof 31.4 s; 657 gas/passport baseline",
    "S2 buyer loop (H1): 100 paid queries, 241,741 gas/settle, manifest with receipts verifies, rescinded → GrantNotLive",
    "S3 rescission race (H2, 50 trials/arm, 400 ms fee-ordered blocks): B2 0.98 · commit-reveal 1.00 · btx-blind 0.98 · btx skipped",
    "S4 refusal: precision 1.0 / recall 1.0; 20/20 forged anchors refused on chain",
    "Harness: arms, AnvilMiner, TxpoolPollingFeed, ObserverBot, Extractor; results/*.json + report",
])
defcard("ci", "evidence", 3, 1, "CI gates (docs/CONTRIBUTING.md)", "BUILT", [
    "pnpm check:all: Biome · check-deps · build · typecheck · coverage (core/crypto ≥ 95 %) · vectors",
    "forge: unit (vector-driven) · fuzz (10 k runs) · invariants; 100 % lines on src/",
    "anvil tier: Phase 1–4 round-trips + S1/S2/S3/S4 dry runs, serialised",
])
defcard("envio", "evidence", 4, 1, "Envio Consent Ledger (§16 Phase 5)", "PARTIAL", [
    "packages/indexer: config.yaml (5 contracts, 9 events) + schema.graphql (Principal, Anchor, Grant, Receipt, Rescission, ConsentEvent)",
    "Pending: EventHandlers.ts, envio codegen, addresses from deployments/<chainId>.json",
    "Adapter EnvioConsentLedger: receiptsForGrant · anchorsFor · consentTimeline",
])
defcard("ledgerui", "evidence", 5, 1, "Consent Ledger UI / dashboard (§9, §19)", "PLANNED", [
    "Shows the timestamped end of consent per grant — the demo's fourth scene",
    "Reads FirsthandLens views + Envio; receipts feed the buyer's ERC-8004 reputation surface",
    "Self-hostable next to the gateway",
])
defcard("security", "evidence", 6, 2, "SECURITY.md — threat model (§13) & honest limitations (§14)", "BUILT", [
    "Front-run rescission · synthetic laundering · replay · stolen passkey · bulk scraping · sybil lockers · malicious MCP · reorg",
    "Poisoned gateway catalog · payment-authorization griefing · cross-principal serving (SCOPE_MISMATCH)",
    "Limitations verbatim: rescission governs future access; passports prove origin, not truth; BTX advantage only where BTX is live",
])

deflane("delivery", "F · Delivery, stretch, roadmap — and what is deliberately out",
        "README §16 Phases 5–6, §17 calendar, §22 MVP scope, §23 post-hackathon.")
defcard("phase5", "delivery", 0, 1, "Phase 5 — Surfaces (Oct 6–9)", "PLANNED", [
    "SDK polish · MCP PRF handoff from the PWA · capture PWA on live contracts + media capture",
    "Envio ledger handlers + Consent Ledger UI · Monad facilitator interop · IPFS blob hosting",
    "Docs site, ENGINE-notes, ROADMAP-*.md; gate: quickstart-to-first-recall < 10 min by a non-author",
])
defcard("phase6", "delivery", 1, 1, "Phase 6 — Traction & freeze", "PLANNED", [
    "Two external integration PRs (integrations/ templates) landed on Monad testnet",
    "Testnet deploy → deployments/10143.json, judge credentials in deployments/NOTES.md",
    "Demo (§19): Deposit · Refusal · Query · Rescind split-screen · Evidence; both videos; code freeze Oct 9",
])
defcard("silver", "delivery", 2, 1, "Silver track (stretch; go/no-go Oct 3)", "STRETCH", [
    "Cleanverse CVI attestation required for regulated namespaces (§7.2, §13)",
    "Quality-score v0 as a separate, opt-in layer",
])
defcard("roadmap", "delivery", 3, 2, "Post-hackathon extensions (§23)", "ROADMAP", [
    "Hardware capture attestation (StrongBox / Secure Enclave co-signing) — closes the laundering gap",
    "ZK manifest membership: 'licensed from some verified-human corpus ≥ N'",
    "Quality / consistency scoring (autorater doctrine: calibrated judge, frozen anchors, canaries)",
    "Marketplace partnerships (Troveo-class pilots) + basis-points royalty routing; standards path: passport interchange spec, receipts → ERC-8004 reputation",
])
defcard("nongoals", "delivery", 5, 1, "Must NOT contain (§22)", "NON-GOAL", [
    "Marketplace UI / discovery · quality scoring or autorater · injection screening",
    "ZK selective disclosure · TEE attestation · cross-chain anything",
    "Token · admin keys / upgradability · mainnet",
])

LANE_ORDER = [L["key"] for L in LANE_DEFS]
layout(400)

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# Flows — every arrow runs in corridors/gutters; follow one colour at a time
# ═══════════════════════════════════════════════════════════════════════════════════════════════
# ① deposit
arrow("d1", "principal", "pwa", "① passkey tap → PRF", "deposit")
arrow("d2", "pwa", "sdk", "① deposit(datum, terms, attestation)", "deposit")
arrow("d3", "importers", "sdk", "① imports → namespaces", "deposit")
arrow("d4", "mcp", "sdk", "① firsthand_deposit", "deposit")
arrow("d5", "sdk", "impls", "① Batcher → OnchainAnchorWriter", "deposit")
arrow("d6", "impls", "anchors", "① anchor(batchRoot, depositSig)", "deposit")
arrow("d7", "sdk", "routes", "① publishDeposit: sidecar + blob + wrap", "deposit")
arrow("d8", "routes", "serving", "① verified ingest", "deposit")
arrow("d9", "serving", "storage", "① catalog + blobs", "deposit")
arrow("d10", "sdk", "crypto", "① derive keys · seal · sign", "deposit")

# ④ liveness
arrow("l1", "impls", "registry", "④ enroll / attest (P-256, relayable)", "liveness")
arrow("l2", "registry", "grants", "④ isLive → FROZEN / thaw", "liveness")

# ② query
arrow("q1", "buyer", "routes", "② GET /v1/query → 402 → X-PAYMENT", "query")
arrow("q2", "routes", "x402", "② facilitator.verify", "query")
arrow("q3", "serving", "impls", "② GrantReader · OnchainSettlement", "query")
arrow("q4", "impls", "router", "② settle(grantId, terms, auth)", "query")
arrow("q5", "router", "ledger", "② record receipt", "query")
arrow("q6", "grants", "router", "② effectiveStatus == ACTIVE", "query")
arrow("q7", "serving", "buyer", "② {sidecar, blob, wrappedDek, receipt} → open locally", "query")

# ③ rescind
arrow("r1", "principal", "mcp", "③ rescind (passkey-signed)", "rescind")
arrow("r2", "sdk", "impls", "③ planRescind → BtxTransport | PublicMempoolTransport", "rescind")
arrow("r3", "impls", "grants", "③ rescind(grantId) — effective at inclusion", "rescind")
arrow("r4", "impls", "rescissions", "③ commit(hash) → revealRescind", "rescind")
arrow("r5", "rescissions", "grants", "③ commit block = end of consent", "rescind")
arrow("r6", "observer", "router", "③ race: settle burst before inclusion (S3)", "rescind")

# ⑤ audit
arrow("a1", "sdk", "manifest", "⑤ exportManifest (proofs + receipts)", "audit")
arrow("a2", "manifest", "auditor", "⑤ verify offline", "audit")
arrow("a3", "ledger", "envio", "⑤ events → index", "audit")
arrow("a4", "envio", "ledgerui", "⑤ GraphQL", "audit")
arrow("a5", "experiments", "ci", "⑤ dry runs in CI", "audit")

# ⑥ gates
arrow("g1", "externals", "crypto", "⑥ Mera PRF", "gate", dashed=True)
arrow("g2", "externals", "impls", "⑥ BTX RPC surface", "gate", dashed=True)
arrow("g3", "externals", "silver", "⑥ CVI sandbox", "gate", dashed=True)

# ── validation ──────────────────────────────────────────────────────────────────────────────────
by_id = {e["id"]: e for e in elements}
for e in elements:
    for b in e.get("boundElements") or []:
        assert b["id"] in by_id, (e["id"], b)
    if e["type"] == "text" and e.get("containerId"):
        assert e["containerId"] in by_id, e["id"]
        assert any(b["id"] == e["id"] for b in by_id[e["containerId"]]["boundElements"]), e["id"]
    if e["type"] == "arrow":
        for k in ("startBinding", "endBinding"):
            assert e[k]["elementId"] in by_id, (e["id"], k)

doc = {
    "type": "excalidraw",
    "version": 2,
    "source": "https://github.com/kaustubh76/Firsthand (docs/diagrams generator)",
    "elements": elements,
    "appState": {"gridSize": 20, "viewBackgroundColor": "#ffffff"},
    "files": {},
}
with open(OUT, "w") as f:
    json.dump(doc, f, indent=1)
print(f"wrote {OUT}: {len(elements)} elements, {len(cards)} cards, canvas {CANVAS_W}")
