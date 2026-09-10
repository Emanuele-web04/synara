// FILE: ComputerSetupRequiredCard.test.tsx
// Purpose: Keeps the setup card aligned with live permission state and explicit setup.
// Layer: Chat transcript UI regression test

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ComputerStatusResult } from "@synara/contracts";

import { ComputerSetupRequiredCard } from "./ComputerSetupRequiredCard";

function status(availability: ComputerStatusResult["availability"]): ComputerStatusResult {
  return {
    computerId: "desktop",
    availability,
    health: { status: "connected", captureAvailable: true, consecutiveFailures: 0, reconnects: 0 },
    capabilities: {
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      focus: true,
      raise: true,
      ghostCursor: true,
      visibleDesktop: true,
    },
    provisionable: true,
  };
}

describe("ComputerSetupRequiredCard", () => {
  it("explains the explicit setup action without claiming a prompt already appeared", () => {
    const markup = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility", "screenRecording"]}
        onSetUp={() => undefined}
      />,
    );

    expect(markup).toContain("Computer control needs Accessibility and Screen Recording");
    expect(markup).toContain(
      "Choose Set up to request missing permissions or open System Settings.",
    );
    expect(markup).not.toContain("macOS is asking");
    expect(markup).toContain("Set up");
  });

  it("falls back to the unnamed grant when the backend refused without naming one", () => {
    const markup = renderToStaticMarkup(<ComputerSetupRequiredCard onSetUp={() => undefined} />);

    expect(markup).toContain("Computer control needs setup");
    expect(markup).toContain("Choose Set up to check permissions and prepare computer control.");
  });

  it("explains a locally built copy's stale grant, and says nothing of it on a signed build", () => {
    // The case that looks like a Synara bug: System Settings shows Synara
    // switched on, because the grant it lists belongs to a binary a rebuild
    // replaced. Without this the card tells the user to flip a switch that is
    // already flipped.
    const adhoc = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility"]}
        buildSignature="adhoc"
        onSetUp={() => undefined}
      />,
    );
    expect(adhoc).toContain("locally built copy");
    expect(adhoc).toContain("add the current build again");

    const signed = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility"]}
        buildSignature="signed"
        onSetUp={() => undefined}
      />,
    );
    // On a Developer ID build the switch means what it says, so this advice
    // would send the user off resetting a database for nothing.
    expect(signed).not.toContain("locally built copy");
    expect(signed).not.toContain("tccutil");
  });

  it("names the responsible app in the tccutil fallback, and withholds it when unknown", () => {
    // The command has to repair *this* Synara's TCC row. `.dev` and `.canary`
    // are separate bundle identifiers, so a guessed production id would revoke a
    // separately installed release build's working grants and fix nothing here.
    const known = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility"]}
        buildSignature="adhoc"
        bundleId="com.emanueledipietro.synara.dev"
        onSetUp={() => undefined}
      />,
    );
    expect(known).toContain("tccutil reset Accessibility com.emanueledipietro.synara.dev");

    // A server with no desktop shell behind it has no responsible app, and the
    // card must say nothing rather than guess.
    const unknown = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility"]}
        buildSignature="adhoc"
        onSetUp={() => undefined}
      />,
    );
    expect(unknown).toContain("add the current build again");
    expect(unknown).not.toContain("tccutil");
  });

  it("drops the button once the grants have landed", () => {
    const markup = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility"]}
        computerControlReady
        onSetUp={() => undefined}
      />,
    );

    expect(markup).toContain("Computer control is ready");
    expect(markup).not.toContain("macOS is asking");
    expect(markup).not.toContain(">Set up<");
  });

  it("replaces historical missing grants and build identity with the live status", () => {
    const markup = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility", "screenRecording"]}
        buildSignature="adhoc"
        bundleId="old.bundle"
        status={status({
          kind: "permission-required",
          missing: ["screenRecording"],
          buildSignature: "signed",
          message: "Screen Recording is missing.",
        })}
        onSetUp={() => undefined}
      />,
    );
    expect(markup).toContain("Computer control needs Screen Recording");
    expect(markup).not.toContain("Accessibility");
    expect(markup).not.toContain("old.bundle");
    expect(markup).not.toContain("locally built copy");
  });

  it("reports unsupported platforms and status failures without old grant claims", () => {
    const unsupported = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility", "screenRecording"]}
        status={status({ kind: "unsupported-platform", platform: "win32" })}
        onSetUp={() => undefined}
      />,
    );
    expect(unsupported).toContain("Computer control is unavailable");
    expect(unsupported).not.toContain("needs Accessibility");
    expect(unsupported).not.toContain(">Set up<");
    const failed = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility"]}
        computerControlReady
        status={status({ kind: "available" })}
        statusError="The server disconnected."
        onSetUp={() => undefined}
        onRecheck={() => undefined}
      />,
    );
    expect(failed).toContain("The server disconnected.");
    expect(failed).toContain(">Recheck<");
    expect(failed).not.toContain("Computer control is ready");
    expect(failed).not.toContain("Accessibility");
  });

  it("requires connected health and capture access before reporting readiness", () => {
    const current = status({ kind: "available" });
    const markup = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        status={{
          ...current,
          health: { ...current.health, status: "unavailable" },
          provisionable: false,
        }}
        computerControlReady
      />,
    );
    expect(markup).not.toContain("Computer control is ready");
    expect(markup).toContain("Computer access has not been checked");
  });

  it("disables setup while the shared request is pending", () => {
    const markup = renderToStaticMarkup(
      <ComputerSetupRequiredCard isPending onSetUp={() => undefined} />,
    );
    expect(markup).toContain("Setting up…");
    expect(markup).toContain('disabled=""');
  });
});
