export * as PhaseVerificationStandalone from "./phase-verification-standalone"

import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect"
import { LLMClient, type LLMError, type LLMEvent, type LLMRequest } from "@opencode-ai/llm"
import { Config } from "../../config"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { AbsolutePath } from "../../schema"
import { Project } from "../../project"
import { SessionTodo } from "../todo"
import { SessionSchema } from "../schema"
import { SessionEvent } from "../event"
import { PhaseVerification } from "./phase-verification"

export interface TurnContext {
  sessionID: string
  cwd: string
  lastAssistantText?: string
}

export interface VerificationHarness {
  initialize(cwd: string): Promise<void>
  afterTurn(ctx: TurnContext): Promise<string[]>
  dispose(): Promise<void>
}

export async function createVerificationHarness(options?: {
  typecheckCmd?: string
  lintCmd?: string
  enabled?: boolean
}): Promise<VerificationHarness> {
  const captured: string[] = []
  let currentCwd = ""

  const events = Layer.succeed(
    EventV2.Service,
    EventV2.Service.of({
      publish: (definition: any, data: any) => {
        if (definition === SessionEvent.Synthetic && data?.text) {
          captured.push(data.text)
        }
        return Effect.succeed({
          type: definition.type,
          data,
          aggregateID: data?.sessionID ?? "",
          seq: 0,
          timestamp: new Date(),
        } as any)
      },
      subscribe: () => Stream.empty,
      all: () => Stream.empty,
      aggregateEvents: () => Stream.empty,
      sync: () => Effect.succeed(Effect.void),
      listen: () => Effect.succeed(Effect.void),
      beforeCommit: () => Effect.void,
      project: () => Effect.void,
      replay: () => Effect.void,
      replayAll: () => Effect.succeed(undefined),
      remove: () => Effect.void,
      claim: () => Effect.void,
    }),
  )

  const todos = Layer.succeed(
    SessionTodo.Service,
    SessionTodo.Service.of({
      update: () => Effect.void,
      get: () => Effect.succeed([]),
    }),
  )

  const llmClient = Layer.succeed(
    LLMClient.Service,
    LLMClient.Service.of({
      prepare: () => Effect.die("standalone: no LLM client"),
      stream: (() => Stream.empty) as unknown as (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>,
      generate: () => Effect.die("standalone: no LLM client"),
    }),
  )

  const makeLocationLayer = (cwd: string) =>
    Layer.succeed(
      Location.Service,
      Location.Service.of({
        directory: AbsolutePath.make(cwd),
        workspaceID: undefined as any,
        project: { id: Project.ID.global, directory: AbsolutePath.make(cwd) },
      }),
    )

  const configEntries = options
    ? [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            verification: {
              enabled: options.enabled,
              typecheck: options.typecheckCmd,
              lint: options.lintCmd,
            } as any,
          }),
        }),
      ]
    : []

  const configLayer = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () => Effect.succeed(configEntries),
    }),
  )

  const buildLayer = (cwd: string) => {
    const loc = makeLocationLayer(cwd)
    return PhaseVerification.layer.pipe(
      Layer.provide(events),
      Layer.provide(todos),
      Layer.provide(llmClient),
      Layer.provide(loc),
      Layer.provide(configLayer),
    )
  }

  let runtime: ManagedRuntime.ManagedRuntime<PhaseVerification.Service, unknown> | undefined

  const sessionID = SessionSchema.ID.make("standalone")

  return {
    async initialize(cwd: string) {
      currentCwd = cwd
      runtime?.dispose()
      runtime = ManagedRuntime.make(buildLayer(cwd))
      await runtime.runPromise(
        PhaseVerification.Service.use((pv) => pv.establishBaseline(sessionID, cwd)),
      )
    },

    async afterTurn(ctx: TurnContext) {
      if (!runtime) throw new Error("Harness not initialized. Call initialize() first.")
      captured.length = 0

      const sid = SessionSchema.ID.make(ctx.sessionID || "standalone")
      const dir = ctx.cwd || currentCwd

      await runtime.runPromise(
        PhaseVerification.Service.use((pv) =>
          Effect.gen(function* () {
            const before = yield* pv.snapshot(sid)
            const detection = yield* pv.detectPhaseCompletion(sid, before)

            if (detection.allPhasesComplete || detection.gitSettled) {
              yield* pv.injectGlobalVerification(sid, dir, null as any)
            } else if (detection.singlePhase || detection.hasGitChanges) {
              yield* pv.injectLocalVerification(sid, detection.completedPhaseName)
            }
          }),
        ),
      )

      return [...captured]
    },

    async dispose() {
      if (runtime) {
        await runtime.runPromise(
          PhaseVerification.Service.use((pv) => pv.dispose(sessionID)),
        )
        runtime.dispose()
        runtime = undefined
      }
    },
  }
}
