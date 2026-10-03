import { useEffect, useState } from "react";
import {
  challengeOf,
  describeBoot,
  describeLevel,
  parseChainText,
  trustsGeneratedAnchor,
} from "../../lib/devices.js";
import { updateJournal } from "../../lib/journal.js";
import { Button, Card, EmptyState, Field, Hash, Notice, Pill, Tx } from "../../ui/index.js";
import type { LockerCtx } from "./types.js";

/**
 * Registering a secure element, and taking it back (ADR-0015).
 *
 * This needs no live bridge to the phone: a certificate chain is public data, so the companion
 * app writes it out and it arrives here the same way a delegation code does. Only *signing a
 * capture* needs the device present.
 *
 * The chain is verified locally before anything is sent, against the anchors and the minimum
 * level read from the registry itself — not from config, because verifying against a looser rule
 * than the chain enforces would tell the user a device is registrable when it is not.
 */
export function DevicesCard({ ctx }: { ctx: LockerCtx }) {
  const { session, config, client, journal, actions } = ctx;
  const [text, setText] = useState("");
  const [generatedAnchor, setGeneratedAnchor] = useState(false);
  const devices = journal.devices ?? [];
  const registry = config.hardwareDeviceRegistry !== `0x${"00".repeat(20)}`;

  // Which certificates this registry trusts is read from the registry, never configured — so a
  // deployment pinned to a certificate this repository generated says so on its own, and stops
  // saying so the moment it is redeployed against a real attestation intermediate. Two cached
  // reads: `policy()` memoises, because the anchors are constructor arguments with no setter.
  useEffect(() => {
    const reader = client.devices;
    if (!reader) return;
    let live = true;
    void reader
      .policy()
      .then((policy) => {
        if (live) setGeneratedAnchor(trustsGeneratedAnchor(policy));
      })
      .catch(() => {
        // A registry we cannot read is already reported by the register path; do not double up.
      });
    return () => {
      live = false;
    };
  }, [client.devices]);

  const register = () =>
    actions.run("device:register", async () => {
      const chain = parseChainText(text);
      const { principalId, nonce } = challengeOf(chain[0] as Uint8Array);
      if (principalId !== session.locker.principalId) {
        // The certificate names whoever the key was generated for, and it cannot be re-issued.
        throw new Error(
          "this chain was generated for a different principal — regenerate the key on the phone with this locker's id",
        );
      }
      if (!client.devices) throw new Error("no device registry reachable on this chain");
      const policy = await client.devices.policy();

      const { plan, sent } = await session.registerDevice({
        chain,
        nonce,
        anchors: policy.anchors,
        minimumSecurityLevel: policy.minimumSecurityLevel,
      });
      await client.waitForTx?.(sent.txHash, "Device registered");
      updateJournal(session.locker.principalId, (j) => {
        j.devices = [
          ...(j.devices ?? []),
          {
            keyCommitment: plan.keyCommitment,
            securityLevel: plan.securityLevel,
            verifiedBootState: plan.verifiedBootState,
            registerTx: sent.txHash,
            at: Date.now(),
          },
        ];
      });
      setText("");
    });

  const revoke = (keyCommitment: `0x${string}`) =>
    actions.run(`device:revoke:${keyCommitment}`, async () => {
      const { sent } = await session.revokeDevice(keyCommitment);
      await client.waitForTx?.(sent.txHash, "Device revoked");
      updateJournal(session.locker.principalId, (j) => {
        const entry = (j.devices ?? []).find((d) => d.keyCommitment === keyCommitment);
        if (entry) {
          entry.revokeTx = sent.txHash;
          entry.revokeAt = Date.now();
        }
      });
    });

  const live = devices.filter((d) => d.revokeTx === undefined).length;

  return (
    <Card
      id="locker-devices"
      icon="lock"
      title="Devices"
      subtitle="A class-3 passport is co-signed by a secure element. Registering one proves to the chain that a certified element exists and belongs to this principal — it does not prove what the camera saw, and nothing here claims otherwise."
      actions={
        devices.length > 0 && (
          <Pill tone={live > 0 ? "ok" : "neutral"} dot data-testid="devices-count">
            {live} live
          </Pill>
        )
      }
    >
      {registry && generatedAnchor && (
        <Notice tone="warn">
          This registry is pinned to a certificate <strong>this repository generated</strong>, not
          to a real attestation root. Its private key is published in the test vectors, so on this
          deployment <strong>anyone can forge a class-3 device</strong> — a registration here proves
          the on-chain verifier and the plumbing, and nothing at all about hardware. No real handset
          can register either, because its chain reaches a different anchor. Read from the
          registry&rsquo;s own <code>anchors()</code>, so it disappears by itself once this is
          redeployed against a real attestation intermediate (ADR-0015).
        </Notice>
      )}
      {!registry ? (
        <Notice tone="warn">
          This chain names no <code>HardwareDeviceRegistry</code>, so class 3 is unavailable here.
          Everything else works; a deposit simply cannot claim hardware.
        </Notice>
      ) : (
        <>
          <Field label="Attestation chain from the companion app">
            {(id) => (
              <textarea
                id={id}
                rows={4}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  "-----BEGIN CERTIFICATE-----\n…  (or 0x… hex, one per line, leaf first)"
                }
                data-testid="device-chain-input"
              />
            )}
          </Field>
          <p className="row-meta">
            The nonce is read out of the certificate, not chosen here — the key committed to it at
            generation time and the registry checks it.
          </p>
          <div className="btn-row">
            <Button
              variant="primary"
              icon="lock"
              onClick={register}
              pending={actions.is("device:register")}
              pendingLabel="Verifying and registering…"
              disabled={text.trim() === "" || actions.busy !== null || !config.live}
              data-testid="device-register"
            >
              Verify locally, then register
            </Button>
          </div>
        </>
      )}
      {actions.errorFor((k) => k.startsWith("device:")) && (
        <Notice tone="bad">{actions.errorFor((k) => k.startsWith("device:"))}</Notice>
      )}
      {registry && devices.length === 0 && (
        <EmptyState
          icon="lock"
          title="No device registered"
          hint="Without one, every deposit from this locker is class 2 at best — which is the honest answer, not a failure."
        />
      )}
      {devices.length > 0 && (
        <ul className="plain asset-list" data-testid="device-list">
          {devices.map((d) => (
            <li key={d.keyCommitment}>
              <Pill tone={d.revokeTx ? "neutral" : "ok"}>
                {d.revokeTx ? "revoked" : describeLevel(d.securityLevel)}
              </Pill>
              <span>
                <Hash value={d.keyCommitment} n={6} copy />
              </span>
              <span>
                boot{" "}
                {d.verifiedBootState === null ? "not attested" : describeBoot(d.verifiedBootState)}
              </span>
              <Tx hash={d.registerTx} chainId={config.chainId} label="registered" />
              {d.revokeTx ? (
                <Tx hash={d.revokeTx} chainId={config.chainId} label="revoked" />
              ) : (
                <Button
                  icon="x"
                  onClick={() => revoke(d.keyCommitment)}
                  pending={actions.is(`device:revoke:${d.keyCommitment}`)}
                  pendingLabel="Revoking…"
                  disabled={actions.busy !== null || !config.live}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
