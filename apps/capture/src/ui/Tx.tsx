import { short, txUrl } from "../lib/explorer.js";
import { CopyButton } from "./CopyButton.js";

export type TxStatus = "pending" | "mined" | "failed";

/**
 * A transaction hash that opens the explorer where one exists; plain text on a local chain. The
 * label comes first inside the link so `getByText(/^enrolled/)` finds it; the copy button sits
 * beside the link, never inside it.
 */
export function Tx({
  hash,
  chainId,
  label,
  status,
  copy = true,
}: {
  hash: string;
  chainId: bigint;
  label?: string | undefined;
  status?: TxStatus | undefined;
  copy?: boolean | undefined;
}) {
  const url = txUrl(chainId, hash);
  const text = `${label ? `${label} ` : ""}${short(hash)}`;
  return (
    <span className="tx" data-status={status}>
      {url ? (
        <a className="tx-link" href={url} target="_blank" rel="noreferrer">
          {text} ↗
        </a>
      ) : (
        <code className="tx-code" title={hash}>
          {text}
        </code>
      )}
      {copy && <CopyButton text={hash} label="Copy transaction hash" />}
    </span>
  );
}
