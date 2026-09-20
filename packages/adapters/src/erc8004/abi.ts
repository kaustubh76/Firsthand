import { parseAbi } from "viem";

/**
 * The slice of ERC-8004 v1 (Trustless Agents) FIRSTHAND uses, from the reference deployment's ABIs
 * (erc-8004/erc-8004-contracts, CC0). Identity = an ERC-721 whose token is the agent; Reputation =
 * feedback signals keyed by (agentId, client). Both are `msg.sender`-authorised, so neither rides a
 * relay: an agent registers with its own gas, and the venue that served it gives feedback as itself.
 */
export const IdentityRegistryAbi = parseAbi([
  "struct MetadataEntry { string metadataKey; bytes metadataValue; }",
  "function register(string agentURI, MetadataEntry[] metadata) returns (uint256 agentId)",
  "function register(string agentURI) returns (uint256 agentId)",
  "function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)",
  "function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function getVersion() pure returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export const ReputationRegistryAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function getClients(uint256 agentId) view returns (address[])",
  "function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] indexes, int128[] values, uint8[] decimals, string[] tag1s, string[] tag2s, bool[] revoked)",
  "function getIdentityRegistry() view returns (address)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

/** Metadata key on the agent that names the FIRSTHAND card it buys with. */
export const CARD_METADATA_KEY = "firsthand.card";
/** Feedback tags the gateway uses: every paid, honoured query is one unit of `paid-query`. */
export const FEEDBACK_TAG1 = "firsthand";
export const FEEDBACK_TAG2_PAID = "paid-query";
