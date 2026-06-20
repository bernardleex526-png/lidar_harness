// Multi-tier verification for opencode harness
//
// Tiers:
//   0. Complexity Gate      — lightweight classify: simple tasks skip heavy verification
//   1. Local Loop Closure   — per-phase, TodoWrite or git-fallback
//   2. Global Pose Graph    — harness runs typecheck/lint directly (baseline-diffed)
//   3. Multi-Perspective    — independent sub-agent LLM calls (security/correctness/style)
//
// Security: commands are locked at baseline time, validated against a safe-prefix allowlist.
// Context:  delta-only injection — only unseen error signatures are shown to the model.
// Phase:    parallel multi-signal detection (TodoWrite + git commit + git change).
// Convergence: monotonic shownErrors set guarantees termination.

export * as PhaseVerification from "./phase-verification"

import { LLMClient, LLMError, LLMEvent, LLM, Message, SystemPart, type LLMRequest, type Model } from "@opencode-ai/llm"
import { Context, DateTime, Effect, Layer, Stream } from "effect"
import { exec } from "child_process"
import { join } from "path"
import { Config } from "../../config"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { SessionTodo } from "../todo"
import { SessionSchema } from "../schema"
import { SessionEvent } from "../event"
import { SessionMessageID } from "../message-id"

// ─── Constants ───

const DEFAULT_TIMEOUT = 120_000
const MAX_PGO_ROUNDS = 5
const GIT_SETTLE_TURNS = 2
const MAX_NEW_ERRORS_PER_ROUND = 20
const NOISE_FLOOR = 3
const N_TURNS_WITHOUT_TODOS = 3

// ─── Error types ───

class CommandNotFoundError extends Error {
  constructor(cmd: string) {
    super(`command not found: ${cmd.split(" ")[0]}`)
    this.name = "CommandNotFoundError"
  }
}

class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`command failed (exit ${exitCode}): ${command}`)
    this.name = "CommandFailedError"
  }
}

// ─── Security: command allowlist ───

const SAFE_PREFIXES = [
  "tsc",
  "bun tsc",
  "npx tsc",
  "bunx tsc",
  "pnpm exec tsc",
  "bun run",
  "npm run",
  "pnpm run",
  "yarn run",
  "eslint",
  "bunx eslint",
  "npx eslint",
  "pnpm dlx eslint",
  "biome check",
  "biome lint",
  "oxlint",
  "deno check",
  "deno lint",
]

const isSafeCommand = (cmd: string) =>
  !cmd || SAFE_PREFIXES.some((p) => cmd === p || cmd.startsWith(p + " "))

// ─── Shell helpers ───

const runCommand = (cmd: string, cwd: string, timeout: number = DEFAULT_TIMEOUT) =>
  Effect.callback<{ stdout: string; stderr: string }, CommandNotFoundError | CommandFailedError>((resume) => {
    const child = exec(cmd, { cwd, timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resume(Effect.succeed({ stdout: stdout.trim(), stderr: stderr.trim() }))
        return
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        resume(Effect.fail(new CommandNotFoundError(cmd)))
        return
      }
      resume(Effect.fail(new CommandFailedError(cmd, error.code ?? 1, stderr.trim())))
    })
    return Effect.sync(() => {
      child.kill()
    })
  })

const runCommandOrEmpty = (cmd: string, cwd: string, timeout?: number) =>
  Effect.gen(function* () {
    if (!cmd) return { stdout: "", stderr: "" }
    return yield* runCommand(cmd, cwd, timeout).pipe(
      Effect.catchCause(() => Effect.succeed({ stdout: "", stderr: "" })),
    )
  })

const readFileOrNull = (filePath: string) =>
  Effect.gen(function* () {
    const { readFile } = yield* Effect.promise(() => import("fs/promises"))
    return yield* Effect.promise(() => readFile(filePath, "utf-8"))
  }).pipe(Effect.catchCause(() => Effect.succeed(null as string | null)))

const loadPackageJson = (cwd: string) =>
  Effect.gen(function* () {
    const content = yield* readFileOrNull(join(cwd, "package.json"))
    if (!content) return null
    try {
      return JSON.parse(content) as Record<string, unknown>
    } catch {
      return null
    }
  })

const fileExists = (filePath: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => import("fs/promises").then(({ stat }) => stat(filePath)))
    return true
  }).pipe(Effect.catchCause(() => Effect.succeed(false)))

const anyFileExists = (cwd: string, names: string[]) =>
  Effect.gen(function* () {
    for (const name of names) {
      if (yield* fileExists(join(cwd, name))) return true
    }
    return false
  })

// ─── Sub-agent LLM call ───

const runSubAgent = (
  stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>,
  model: Model,
  system: string,
  prompt: string,
  maxTokens = 1024,
) =>
  Effect.gen(function* () {
    const request = LLM.request({
      model,
      system: [SystemPart.make(system)],
      messages: [Message.user(prompt)],
      tools: [],
      generation: { maxTokens },
    })
    const chunks: string[] = []
    let failed = false
    yield* stream(request).pipe(
      Stream.runForEach((event: LLMEvent) => {
        if (LLMEvent.is.providerError(event)) failed = true
        if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
        return Effect.void
      }),
      Effect.catchTag("LLM.Error", () => Effect.sync(() => (failed = true))),
    )
    const text = chunks.join("").trim()
    return failed || !text ? null : text
  })

// ─── Project command detection ───

type ProjectCommands = {
  typecheck: string
  lint: string
  timeout: { typecheck: number; lint: number }
}

const detectPackageManager = (cwd: string) =>
  Effect.gen(function* () {
    if (yield* fileExists(join(cwd, "bun.lock"))) return "bun"
    if (yield* fileExists(join(cwd, "yarn.lock"))) return "yarn"
    if (yield* fileExists(join(cwd, "pnpm-lock.yaml"))) return "pnpm"
    return "npm"
  })

const detectCommands = (cwd: string): Effect.Effect<ProjectCommands> =>
  Effect.gen(function* () {
    const pkg = yield* loadPackageJson(cwd)
    const scripts: Record<string, string> = (pkg?.scripts as Record<string, string>) ?? {}
    const hasTSConfig = yield* fileExists(join(cwd, "tsconfig.json"))
    const hasLintRc = yield* anyFileExists(cwd, [
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
      ".eslintrc.yaml",
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.ts",
    ])

    const tcTimeout = hasTSConfig ? 300_000 : 120_000
    const pm = yield* detectPackageManager(cwd)
    const run = `${pm} run`
    const execCmd = pm === "bun" ? "bunx" : pm === "pnpm" ? "pnpm dlx" : "npx"

    return {
      typecheck:
        scripts["typecheck"] ? `${run} typecheck`
        : scripts["check"] ? `${run} check`
        : scripts["ts:check"] ? `${run} ts:check`
        : hasTSConfig ? `${execCmd} tsc --noEmit`
        : "",
      lint:
        scripts["lint"] ? `${run} lint`
        : scripts["eslint"] ? `${run} eslint`
        : hasLintRc ? `${execCmd} eslint .`
        : "",
      timeout: {
        typecheck: tcTimeout,
        lint: 120_000,
      },
    }
  })

// ─── Context compression: error signature helpers ───

type ErrorSignature = string
type ReviewFinding = string

const normalizeError = (line: string): ErrorSignature =>
  line
    .replace(/:\d+:\d+/g, ":N:N")
    .replace(/\(\d+,\d+\)/g, "(N,N)")
    .replace(/\s+\d+ms\b/g, " Nms")
    .trim()

const splitLines = (s: string) => s.split("\n").filter((l) => l.trim())

type CheckResult = { stdout: string; stderr: string }
type BaselineResult = { typecheck: CheckResult; lint: CheckResult }

const computeErrorSigs = (results: BaselineResult, baseline: BaselineResult | null): ErrorSignature[] => {
  const allLines = splitLines(
    [results.typecheck.stdout, results.typecheck.stderr, results.lint.stdout, results.lint.stderr]
      .filter(Boolean)
      .join("\n"),
  )
  const baselineSigs = baseline
    ? new Set(
        splitLines(
          [baseline.typecheck.stdout, baseline.typecheck.stderr, baseline.lint.stdout, baseline.lint.stderr]
            .filter(Boolean)
            .join("\n"),
        ).map(normalizeError),
      )
    : new Set<string>()
  return [...new Set(allLines.map(normalizeError).filter((s) => s && !baselineSigs.has(s)))]
}

const extractFindings = (reviews: { role: string; text: string | null }[]): ReviewFinding[] =>
  reviews.flatMap((r) =>
    !r.text || r.text.trim() === "No issues found"
      ? []
      : r.text
          .split("\n")
          .map((line) => `${r.role}:${line.trim()}`)
          .filter((f) => f.length > r.role.length + 1),
  )

// ─── PGO result tracking ───

type PGOSnapshot = { results: BaselineResult; round: number }
type PGOState = {
  snapshot: PGOSnapshot
  done: boolean
  completedSet: Set<string>
  baseline: BaselineResult | null
  shownErrors: Set<ErrorSignature>
  shownFindings: Set<ReviewFinding>
}

type BaselineEntry = {
  typecheck: CheckResult
  lint: CheckResult
  commands: ProjectCommands
}

// ─── Git helpers ───

const gitDiff = (cwd: string) => runCommandOrEmpty("git diff --name-only", cwd)
const gitDiffWithStaged = (cwd: string) => runCommandOrEmpty("git diff --name-only HEAD", cwd)
const gitDiffContent = (cwd: string) => runCommandOrEmpty("git diff", cwd)
const gitDiffHead = (cwd: string) => runCommandOrEmpty("git diff --name-only HEAD", cwd)
const gitLogOne = (cwd: string) => runCommandOrEmpty("git log --oneline -1", cwd)

// ─── Phase → file mapping ───

const phaseFilesKey = (phaseContent: string) => phaseContent.slice(0, 80)

// ─── Complexity classification ───

type Complexity = "simple" | "complex"

const CLASSIFY_PROMPT = `Classify the following task as "simple" or "complex".

Rules:
- "simple": single-file edit, typo fix, small function addition, one-line change
- "complex": multi-file refactor, new feature, architectural change, migration, anything touching >1 file

Reply with exactly one word: simple or complex.

Task:`

const classifyComplexity = (
  stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>,
  model: Model,
  prompt: string,
) =>
  Effect.gen(function* () {
    const result = yield* runSubAgent(stream, model, CLASSIFY_PROMPT, prompt, 10)
    if (!result) return "complex" as Complexity
    const lower = result.toLowerCase().trim()
    return lower.startsWith("simple") ? ("simple" as Complexity) : ("complex" as Complexity)
  })

// ─── Compact prompts (delta-only) ───

const buildCompactGlobalPrompt = (
  round: number,
  newErrors: string[],
  resolvedCount: number,
  knownCount: number,
): string => {
  const truncated =
    newErrors.length > MAX_NEW_ERRORS_PER_ROUND
      ? [...newErrors.slice(0, MAX_NEW_ERRORS_PER_ROUND), `... and ${newErrors.length - MAX_NEW_ERRORS_PER_ROUND} more`]
      : newErrors
  return [
    `=== Verification Round ${round} ===`,
    `NEW ISSUES (+${newErrors.length}):`,
    ...truncated.map((e) => `  ${e}`),
    resolvedCount > 0 ? `RESOLVED (-${resolvedCount}): ${resolvedCount} issues no longer appear.` : null,
    knownCount > 0 ? `ALREADY KNOWN: ${knownCount} pre-existing issues (ignored).` : null,
    `Fix the NEW issues only. Reply "Verification: clean" when done.`,
  ]
    .filter(Boolean)
    .join("\n")
}

const buildCompactReviewPrompt = (findings: ReviewFinding[]): string =>
  `=== Review (new findings only) ===\n${findings.map((f) => `[${f}]`).join("\n")}\n\nAddress real issues. Ignore "No issues found".`

const buildLocalVerificationPrompt = (phaseName: string, files: string) =>
  `SLAM Loop Closure (Local Phase Verification):

Phase: ${phaseName}
Files modified in this phase: ${files || "(unknown)"}

1. SCAN: Review the files listed above. Do the changes achieve the phase goal?
2. DRIFT: Check for regression, overreach, typo/logic errors.
3. TIGHTEN: Fix ONLY affected lines. Do NOT restart or redo earlier phases.
4. Reply: "Phase verified: ok" or "Phase verified: N issues fixed".`

const SUB_AGENT_PROMPTS = [
  {
    role: "SECURITY AUDITOR",
    system:
      "You are a security auditor. Review code diff for vulnerabilities. Be concise. Only report real issues with file paths.",
    prompt: (diff: string) => `Examine this code diff for security vulnerabilities:
${diff || "(no changes detected)"}

Check for: unsanitized input, SQL injection, XSS, path traversal, hardcoded secrets, weak crypto, missing authorization, unsafe deserialization.

Reply "No issues found" or list findings as: file path + severity (critical/high/medium/low) + one-line description.`,
  },
  {
    role: "CORRECTNESS VERIFIER",
    system:
      "You are a correctness verifier. Review code diff for logic errors. Be concise. Only report real issues with file paths.",
    prompt: (diff: string) => `Examine this code diff for logic and contract correctness:
${diff || "(no changes detected)"}

Check for: logic mismatch with stated goals, return type inconsistencies, unhandled edge cases, resource leaks in error paths.

Reply "No issues found" or list findings as: file path + issue description.`,
  },
  {
    role: "STYLE CHECKER",
    system:
      "You are a code style reviewer. Review code diff for quality and consistency. Be concise. Only report real issues with file paths.",
    prompt: (diff: string) => `Examine this code diff for quality and consistency:
${diff || "(no changes detected)"}

Check for: dead code, unused imports, naming violations, non-idiomatic error handling, single-responsibility violations.

Reply "No issues found" or list findings as: file path + issue description.`,
  },
]

// ─── Interface ───

export interface Interface {
  readonly snapshot: (sessionID: SessionSchema.ID) => Effect.Effect<readonly SessionTodo.Info[]>
  readonly classify: (sessionID: SessionSchema.ID, prompt: string, model: Model) => Effect.Effect<Complexity>
  readonly isSimple: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly upgradeToComplex: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly establishBaseline: (sessionID: SessionSchema.ID, cwd: string) => Effect.Effect<void>
  readonly detectPhaseCompletion: (
    sessionID: SessionSchema.ID,
    before: readonly SessionTodo.Info[],
  ) => Effect.Effect<{
    singlePhase: boolean
    completedPhaseName: string
    allPhasesComplete: boolean
    hasGitChanges: boolean
    pgoContinueRound: boolean
    gitSettled: boolean
  }>
  readonly injectLocalVerification: (sessionID: SessionSchema.ID, phaseName: string) => Effect.Effect<void>
  readonly injectGlobalVerification: (sessionID: SessionSchema.ID, cwd: string, model: Model) => Effect.Effect<void>
  readonly dispose: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("PhaseVerification") {}

// ─── Layer ───

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const _llm = yield* LLMClient.Service
    const events = yield* EventV2.Service
    const todos = yield* SessionTodo.Service
    const location = yield* Location.Service
    const config = yield* Config.Service

    const lastLocalHash = new Map<string, string>()
    const lastGitHash = new Map<string, string>()
    const gitSettleCount = new Map<string, number>()
    const pgoState = new Map<string, PGOState>()
    const phaseFiles = new Map<string, Map<string, string[]>>()
    const complexityMap = new Map<string, Complexity>()
    const baselineMap = new Map<string, BaselineEntry>()
    const baselineRuns = new Set<string>()
    const gitOnlyMode = new Set<string>()
    const noTodosTurnCount = new Map<string, number>()
    const lastCommitHash = new Map<string, string>()

    const cwd = location.directory

    const getGitFileHash = (dir: string) =>
      Effect.gen(function* () {
        const r = yield* gitDiff(dir)
        return r.stdout || "(clean)"
      })

    const getPreTurnFiles = (dir: string) =>
      Effect.gen(function* () {
        const r = yield* gitDiffWithStaged(dir)
        return r.stdout.trim()
      })

    const runSubAgents = (model: Model, changedFiles: string) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          SUB_AGENT_PROMPTS.map((p) => runSubAgent(_llm.stream, model, p.system, p.prompt(changedFiles))),
          { concurrency: "unbounded" },
        )
        return SUB_AGENT_PROMPTS.map((p, i) => ({ role: p.role, text: results[i] }))
      })

    const resolveCommands = (
      detected: ProjectCommands,
      verificationCfg: { typecheck?: string; lint?: string } | undefined,
    ): ProjectCommands => {
      const typecheck = verificationCfg?.typecheck ?? detected.typecheck
      const lint = verificationCfg?.lint ?? detected.lint
      return {
        typecheck,
        lint,
        timeout: detected.timeout,
      }
    }

    const runCurrentChecks = (dir: string, cmds: ProjectCommands) =>
      Effect.gen(function* () {
        const [tc, lint] = yield* Effect.all(
          [
            runCommandOrEmpty(cmds.typecheck, dir, cmds.timeout.typecheck),
            runCommandOrEmpty(cmds.lint, dir, cmds.timeout.lint),
          ],
          { concurrency: "unbounded" },
        )
        return { typecheck: tc, lint } satisfies BaselineResult
      })

    // ── Public interface ──

    const snapshot = (sessionID: SessionSchema.ID) => todos.get(sessionID)

    const classify = (sessionID: SessionSchema.ID, prompt: string, model: Model) =>
      Effect.gen(function* () {
        const result = yield* classifyComplexity(_llm.stream, model, prompt)
        complexityMap.set(sessionID, result)
        return result
      }).pipe(Effect.catchCause(() => Effect.succeed("complex" as Complexity)))

    const isSimple = (sessionID: SessionSchema.ID) =>
      Effect.succeed(complexityMap.get(sessionID) === "simple")

    const upgradeToComplex = (sessionID: SessionSchema.ID) =>
      Effect.sync(() => {
        complexityMap.set(sessionID, "complex")
      })

    const establishBaseline = (sessionID: SessionSchema.ID, dir: string) =>
      Effect.gen(function* () {
        if (baselineMap.has(sessionID) || baselineRuns.has(sessionID)) return
        baselineRuns.add(sessionID)

        const entries = yield* config.entries()
        const verificationCfg = Config.latest(entries, "verification")

        if (verificationCfg?.enabled === false) {
          baselineRuns.delete(sessionID)
          return
        }

        const detected = yield* detectCommands(dir)
        const cmds = resolveCommands(detected, verificationCfg)

        // Validate non-explicit commands against allowlist
        if (!verificationCfg?.typecheck && !isSafeCommand(cmds.typecheck)) {
          cmds.typecheck = ""
        }
        if (!verificationCfg?.lint && !isSafeCommand(cmds.lint)) {
          cmds.lint = ""
        }

        if (!cmds.typecheck && !cmds.lint) {
          baselineRuns.delete(sessionID)
          return
        }

        const [tc, lint] = yield* Effect.all(
          [
            runCommandOrEmpty(cmds.typecheck, dir, cmds.timeout.typecheck),
            runCommandOrEmpty(cmds.lint, dir, cmds.timeout.lint),
          ],
          { concurrency: "unbounded" },
        )
        baselineMap.set(sessionID, { typecheck: tc, lint, commands: cmds })
        baselineRuns.delete(sessionID)
      }).pipe(Effect.catchCause(() => Effect.void))

    const detectPhaseCompletion = (sessionID: SessionSchema.ID, before: readonly SessionTodo.Info[]) =>
      Effect.gen(function* () {
        const after = yield* todos.get(sessionID)
        const currentFiles = yield* getPreTurnFiles(cwd)

        // ── Run all git signals in parallel ──
        const [gitUnstagedResult, gitHeadResult, gitLogResult] = yield* Effect.all(
          [getGitFileHash(cwd), gitDiffHead(cwd), gitLogOne(cwd)],
          { concurrency: "unbounded" },
        )

        // ── TodoWrite-based detection ──
        const newlyCompleted = after.filter((task) => {
          const prev = before.find((p) => p.content === task.content)
          return prev && prev.status === "in_progress" && task.status === "completed"
        })
        const allDone = after.length > 0 && after.every((t) => t.status === "completed" || t.status === "cancelled")
        const hasCompleted = after.some((t) => t.status === "completed")

        let completedPhaseName = ""
        let singlePhase = false

        if (newlyCompleted.length > 0) {
          const hash = after
            .filter((t) => t.status === "completed")
            .map((t) => t.content)
            .sort()
            .join("|")
          if (hash !== lastLocalHash.get(sessionID)) {
            lastLocalHash.set(sessionID, hash)
            completedPhaseName = newlyCompleted[0].content
            singlePhase = true
          }
        }

        if (singlePhase && completedPhaseName && currentFiles) {
          const sessionMap = phaseFiles.get(sessionID) ?? new Map()
          const files = currentFiles.split("\n").filter(Boolean)
          sessionMap.set(phaseFilesKey(completedPhaseName), files)
          phaseFiles.set(sessionID, sessionMap)
        }

        // ── No-todos adaptation: switch to git-only mode ──
        if (after.length === 0) {
          const count = (noTodosTurnCount.get(sessionID) ?? 0) + 1
          noTodosTurnCount.set(sessionID, count)
          if (count >= N_TURNS_WITHOUT_TODOS) {
            gitOnlyMode.add(sessionID)
          }
        } else {
          noTodosTurnCount.delete(sessionID)
          gitOnlyMode.delete(sessionID)
        }

        // ── PGO re-trigger on new phases ──
        const ps = pgoState.get(sessionID)
        if (newlyCompleted.length > 0 && ps) {
          const newSet = new Set(after.filter((t) => t.status === "completed").map((t) => t.content))
          const hasNewPhase = [...newSet].some((c) => !ps.completedSet.has(c))
          if (hasNewPhase) {
            pgoState.delete(sessionID)
          } else {
            ps.completedSet = newSet
          }
        }

        const pgoStarted = pgoState.has(sessionID)
        const allPhasesComplete = allDone && hasCompleted && !pgoStarted

        // ── Commit signal: detect new commits ──
        const commitHash = gitLogResult.stdout.trim()
        const prevCommitHash = lastCommitHash.get(sessionID)
        if (commitHash && commitHash !== prevCommitHash) {
          lastCommitHash.set(sessionID, commitHash)
          if (prevCommitHash && !singlePhase) {
            completedPhaseName = commitHash
            singlePhase = true
          }
        }

        // ── Git change signal (elevated to first-class) ──
        let hasGitChanges = false
        let gitSettled = false
        const gitHash = gitUnstagedResult

        if (gitHash === "(clean)") {
          gitSettleCount.delete(sessionID)
        } else if (gitHash === lastGitHash.get(sessionID)) {
          if (!pgoStarted) {
            const count = (gitSettleCount.get(sessionID) ?? 0) + 1
            gitSettleCount.set(sessionID, count)
            if (count >= GIT_SETTLE_TURNS) {
              gitSettled = true
              gitSettleCount.delete(sessionID)
            }
          }
        } else {
          lastGitHash.set(sessionID, gitHash)
          gitSettleCount.set(sessionID, 0)
          if (gitOnlyMode.has(sessionID) || after.length === 0) {
            hasGitChanges = true
          }
        }

        // ── PGO loop (convergence via new-information criterion) ──
        let pgoContinueRound = false
        const current = pgoState.get(sessionID)
        if (current && !current.done && current.snapshot.round < MAX_PGO_ROUNDS) {
          const entry = baselineMap.get(sessionID)
          if (!entry) {
            current.done = true
          } else {
            const cmds = entry.commands
            const prev = current.snapshot.results

            const prevTC = [prev.typecheck.stdout, prev.typecheck.stderr].filter(Boolean).join("\n")
            const prevLint = [prev.lint.stdout, prev.lint.stderr].filter(Boolean).join("\n")

            const [tc, lint] = yield* Effect.all(
              [
                prevTC && cmds.typecheck
                  ? runCommandOrEmpty(cmds.typecheck, cwd, cmds.timeout.typecheck)
                  : Effect.succeed(prev.typecheck),
                prevLint && cmds.lint
                  ? runCommandOrEmpty(cmds.lint, cwd, cmds.timeout.lint)
                  : Effect.succeed(prev.lint),
              ],
              { concurrency: "unbounded" },
            )

            const newResults = { typecheck: tc, lint }
            const currentSigs = computeErrorSigs(newResults, current.baseline)
            const unseenSigs = currentSigs.filter((sig) => !current.shownErrors.has(sig))

            if (unseenSigs.length === 0 || unseenSigs.length < NOISE_FLOOR) {
              current.done = true
            } else {
              const baselineSigCount = current.baseline
                ? computeErrorSigs(current.baseline, null).length
                : 0
              const resolvedCount = [...current.shownErrors].filter(
                (sig) => !currentSigs.includes(sig),
              ).length

              yield* events.publish(SessionEvent.Synthetic, {
                sessionID,
                messageID: SessionMessageID.ID.create(),
                text: buildCompactGlobalPrompt(
                  current.snapshot.round + 1,
                  unseenSigs,
                  resolvedCount,
                  baselineSigCount,
                ),
                timestamp: yield* DateTime.now,
              })
              unseenSigs.forEach((sig) => current.shownErrors.add(sig))
              current.snapshot = { results: newResults, round: current.snapshot.round + 1 }
              pgoContinueRound = true
            }
          }
        }

        return {
          singlePhase,
          completedPhaseName,
          allPhasesComplete,
          hasGitChanges,
          pgoContinueRound,
          gitSettled,
        }
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed({
            singlePhase: false,
            completedPhaseName: "",
            allPhasesComplete: false,
            hasGitChanges: false,
            pgoContinueRound: false,
            gitSettled: false,
          }),
        ),
      )

    // ── Injections ──

    const injectLocalVerification = (sessionID: SessionSchema.ID, phaseName: string) =>
      Effect.gen(function* () {
        const pm = phaseFiles.get(sessionID)
        const files = pm?.get(phaseFilesKey(phaseName))?.join(", ") ?? "(unknown)"

        yield* events.publish(SessionEvent.Synthetic, {
          sessionID,
          messageID: SessionMessageID.ID.create(),
          text: buildLocalVerificationPrompt(phaseName, files),
          timestamp: yield* DateTime.now,
        })
      }).pipe(Effect.catchCause(() => Effect.void))

    const injectGlobalVerification = (sessionID: SessionSchema.ID, dir: string, model: Model) =>
      Effect.gen(function* () {
        const entry = baselineMap.get(sessionID)
        if (!entry) return

        const cmds = entry.commands
        const results = yield* runCurrentChecks(dir, cmds)
        const baseline: BaselineResult = { typecheck: entry.typecheck, lint: entry.lint }

        // Compute error signatures
        const allSigs = computeErrorSigs(results, baseline)

        // Get or initialize PGO state
        const existing = pgoState.get(sessionID)
        const shownErrors = existing?.shownErrors ?? new Set<ErrorSignature>()
        const shownFindings = existing?.shownFindings ?? new Set<ReviewFinding>()

        const unseenSigs = allSigs.filter((sig) => !shownErrors.has(sig))
        const resolvedCount = [...shownErrors].filter((sig) => !allSigs.includes(sig)).length
        const baselineSigCount = computeErrorSigs(baseline, null).length

        pgoState.set(sessionID, {
          snapshot: { results, round: 0 },
          done: false,
          completedSet: new Set(),
          baseline,
          shownErrors,
          shownFindings,
        })

        // Only inject if there are unseen errors
        if (unseenSigs.length > 0) {
          yield* events.publish(SessionEvent.Synthetic, {
            sessionID,
            messageID: SessionMessageID.ID.create(),
            text: buildCompactGlobalPrompt(0, unseenSigs, resolvedCount, baselineSigCount),
            timestamp: yield* DateTime.now,
          })
          unseenSigs.forEach((sig) => shownErrors.add(sig))
        }

        // Sub-agent review with delta findings
        const diffContent = yield* gitDiffContent(dir)
        const reviews = yield* runSubAgents(model, diffContent.stdout)

        const allFindings = extractFindings(reviews)
        const unseenFindings = allFindings.filter((f) => !shownFindings.has(f))

        if (unseenFindings.length > 0) {
          yield* events.publish(SessionEvent.Synthetic, {
            sessionID,
            messageID: SessionMessageID.ID.create(),
            text: buildCompactReviewPrompt(unseenFindings),
            timestamp: yield* DateTime.now,
          })
          unseenFindings.forEach((f) => shownFindings.add(f))
        }
      }).pipe(Effect.catchCause(() => Effect.void))

    const dispose = (sessionID: SessionSchema.ID) =>
      Effect.sync(() => {
        lastLocalHash.delete(sessionID)
        lastGitHash.delete(sessionID)
        gitSettleCount.delete(sessionID)
        pgoState.delete(sessionID)
        phaseFiles.delete(sessionID)
        complexityMap.delete(sessionID)
        baselineMap.delete(sessionID)
        baselineRuns.delete(sessionID)
        gitOnlyMode.delete(sessionID)
        noTodosTurnCount.delete(sessionID)
        lastCommitHash.delete(sessionID)
      })

    return Service.of({
      snapshot,
      classify,
      isSimple,
      upgradeToComplex,
      establishBaseline,
      detectPhaseCompletion,
      injectLocalVerification,
      injectGlobalVerification,
      dispose,
    })
  }),
)
