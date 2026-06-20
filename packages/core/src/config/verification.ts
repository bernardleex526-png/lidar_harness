export * as ConfigVerification from "./verification"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.Verification")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  typecheck: Schema.String.pipe(Schema.optional),
  lint: Schema.String.pipe(Schema.optional),
}) {}
