import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";

// CLI builtin:codemode exposes paid models.* without an off switch. Reuse the
// public factory instead; this file is explicitly loaded only by the child.
export default createCodemodeExtension({ models: false, mode: "only" });
