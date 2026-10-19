/**
 * superedit — registers the forgiving-matcher `edit` tool from
 * lib/superedit.ts, replacing pi's built-in edit tool by name (the superbash
 * pattern: recall's file tracking, EditToolCallEvent, and the default active
 * set all key off the name and keep working).
 *
 * The kill switch is registration-time: PI_SUPEREDIT=0|false leaves pi's
 * built-in edit tool in place. The occurrence: "all" cap and the post-edit
 * syntax check's enablement are read per call so PI_SUPEREDIT_ALL_CAP and
 * PI_SUPEREDIT_SYNTAX apply without a reload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSuperEditTool, parseAllCap, parseSupereditEnabled } from "../../lib/superedit";
import { parseSyntaxEnabled } from "../../lib/superedit-syntax";

export default function (pi: ExtensionAPI) {
  if (!parseSupereditEnabled(process.env)) return;
  pi.registerTool(
    createSuperEditTool(process.cwd(), {
      allCap: () => parseAllCap(process.env),
      syntax: { enabled: () => parseSyntaxEnabled(process.env) },
    }),
  );
}
