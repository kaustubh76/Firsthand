import { short, txUrl } from "../lib/explorer.js";

/** A transaction hash that opens the explorer where one exists; plain text on a local chain. */
export function Tx({ hash, chainId, label }: { hash: string; chainId: bigint; label?: string }) {
  const url = txUrl(chainId, hash);
  const text = `${label ? `${label} ` : ""}${short(hash)}`;
  return url ? (
    <a className="tx" href={url} target="_blank" rel="noreferrer">
      {text} ↗
    </a>
  ) : (
    <code className="tx">{text}</code>
  );
}

export function Hex({ value, n = 10 }: { value: string; n?: number }) {
  return (
    <code title={value} className="hex">
      {short(value, n)}
    </code>
  );
}
