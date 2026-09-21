import { Skeleton } from "../ui/index.js";

/** Before discovery answers. There is an <h1> from the first paint — the browser tier waits for one. */
export function LoadingFrame() {
  return (
    <main>
      <section className="loading-frame">
        <h1>Connecting to the gateway</h1>
        <p className="lede">
          Reading the venue's discovery document: chain, contracts, epoch clock, relay.
        </p>
        <Skeleton lines={3} />
      </section>
    </main>
  );
}
