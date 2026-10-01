import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSessionDir } from "../scripts/bench-common";

const HOME = "/home/tester";

describe("projectSessionDir", () => {
  it("matches pi's session-dir slug for a deep project path", () => {
    // Verified against real dirs under ~/.pi/agent/sessions: two dashes on
    // each side, non-alphanumeric runs collapsed to one dash.
    expect(projectSessionDir("/Users/x/Code/proj", HOME, join)).toBe(
      join(HOME, ".pi/agent/sessions", "--Users-x-Code-proj--"),
    );
  });

  it("collapses dotted and multi-dash runs in the cwd", () => {
    expect(projectSessionDir("/Users/x/Code/betterbase.dev/sub", HOME, join)).toBe(
      join(HOME, ".pi/agent/sessions", "--Users-x-Code-betterbase-dev-sub--"),
    );
  });

  it("never pads a slug that is already fully stripped", () => {
    expect(projectSessionDir("/tmp/pi-clean", HOME, join)).toBe(join(HOME, ".pi/agent/sessions", "--tmp-pi-clean--"));
  });
});
