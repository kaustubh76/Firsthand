/**
 * Envio event handlers — Phase 5. Each handler upserts the read model in schema.graphql.
 * The `generated` module appears after `pnpm --filter @firsthand/indexer codegen`.
 *
 * Handler outline (kept as documentation until codegen runs):
 *
 *   PrincipalRegistry.PrincipalEnrolled  → Principal + ConsentEvent(enrolled)
 *   PrincipalRegistry.PrincipalAttested  → Principal.lastAttestedEpoch + ConsentEvent(attested)
 *   PassportAnchors.BatchAnchored        → Anchor
 *   GrantManager.GrantCreated            → Grant(status=ACTIVE) + ConsentEvent(granted)
 *   GrantManager.GrantRescinded          → Grant.status=RESCINDED, effectiveBlock + ConsentEvent(rescinded)
 *   Rescissions.RescissionCommitted      → Rescission
 *   ReceiptLedger.ReceiptRecorded        → Receipt
 */
export {};
