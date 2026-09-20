/**
 * Browser-safe surface: everything a client app needs to talk to a live deployment without holding a
 * key, and nothing that touches node built-ins. `FsBlobStore` and `FsPassportCatalog` are the only
 * modules in this package that import `node:fs`, and they are deliberately absent — importing the
 * root entry from a browser bundle breaks the build, which has already happened twice.
 *
 * The capture PWA reads through `publicClient` (no key) and writes through the gateway's relay.
 */
export type { OnchainAnchorWriterOptions } from "../anchors/OnchainAnchorWriter.js";
export { OnchainAnchorWriter, prepareAnchorTx } from "../anchors/OnchainAnchorWriter.js";
export type { ChainClients, ChainClientsOptions } from "../chain.js";
export { anvil, createChainClients, monadTestnet } from "../chain.js";
export { CARD_METADATA_KEY, FEEDBACK_TAG1, FEEDBACK_TAG2_PAID } from "../erc8004/abi.js";
export type { Erc8004Addresses } from "../erc8004/addresses.js";
export { erc8004Addresses } from "../erc8004/addresses.js";
export { buildAgentURI, buildRegistration, decodeAgentURI } from "../erc8004/agentUri.js";
export type { OnchainErc8004RegistryOptions } from "../erc8004/OnchainErc8004Registry.js";
export { cardMetadata, OnchainErc8004Registry } from "../erc8004/OnchainErc8004Registry.js";
export type { OnchainGrantReaderOptions } from "../grants/OnchainGrantReader.js";
export { OnchainGrantReader } from "../grants/OnchainGrantReader.js";
export * from "../memory/index.js";
export type {
  AnchorLayout,
  AnchorOwnerView,
  AnchorRef,
  AnchorRequest,
  AnchorWriter,
} from "../ports/AnchorWriter.js";
export type { BlobRef, BlobStore } from "../ports/BlobStore.js";
export type {
  AnchorView,
  ConsentEvent,
  ConsentEventKind,
  ReceiptView,
} from "../ports/ConsentLedger.js";
export type {
  AgentView,
  Erc8004Registry,
  Erc8004Writer,
  ReputationSummary,
} from "../ports/Erc8004Registry.js";
export type { GrantView, PrincipalLivenessView } from "../ports/GrantReader.js";
export type {
  PreparedTx,
  TransportCapabilities,
  TransportKind,
  TxRef,
  TxTransport,
} from "../ports/TxTransport.js";
export type { HttpRelayTransportOptions } from "../tx/HttpRelayTransport.js";
export { HttpRelayTransport } from "../tx/HttpRelayTransport.js";
