import { PassportCard, sealOf } from "../../components/PassportCard.js";
import { useNavigation } from "../../shell/navigation.js";
import { Button, Card, EmptyState, Pill } from "../../ui/index.js";
import type { LockerCtx } from "./types.js";

/** Every passport this browser minted, newest first, as the object it is. */
export function DepositsCard({ ctx }: { ctx: LockerCtx }) {
  const nav = useNavigation();
  const { journal, config } = ctx;
  const published = journal.deposits.filter((d) => d.published).length;
  return (
    <Card
      id="locker-deposits"
      icon="stamp"
      title="Deposits"
      subtitle="Each one a passkey-signed Data Passport: origin, class, terms, anchored batch."
      actions={
        journal.deposits.length > 0 && (
          <Pill tone={published > 0 ? "ok" : "neutral"}>
            {published} of {journal.deposits.length} published
          </Pill>
        )
      }
    >
      {journal.deposits.length === 0 ? (
        <EmptyState
          icon="stamp"
          title="Nothing stamped yet"
          hint="A note, a photo or a ChatGPT export becomes a passport in one tap."
          action={
            <Button size="sm" icon="camera" onClick={() => nav.go("capture", "capture-note")}>
              Stamp something
            </Button>
          }
        />
      ) : (
        <ul className="cards">
          {journal.deposits.map((d) => (
            <PassportCard
              key={d.passportId}
              entry={d}
              seal={sealOf(d)}
              chainId={config.chainId}
              gatewayUrl={config.gatewayUrl}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
