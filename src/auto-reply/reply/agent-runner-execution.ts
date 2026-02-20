import crypto from "node:crypto";
import fs from "node:fs";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionId } from "../../agents/cli-session.js";
import { isTimeoutError } from "../../agents/failover-error.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import {
  isCompactionFailureError,
  isContextOverflowError,
  isLikelyContextOverflowError,
  isTransientHttpError,
  sanitizeUserFacingText,
} from "../../agents/pi-embedded-helpers.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import {
  resolveGroupSessionKey,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import {
  isMarkdownCapableMessageChannel,
  resolveMessageChannel,
} from "../../utils/message-channel.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  buildEmbeddedRunBaseParams,
  buildEmbeddedRunContexts,
  resolveModelFallbackOptions,
} from "./agent-runner-utils.js";
import { type BlockReplyPipeline } from "./block-reply-pipeline.js";
import type { FollowupRun } from "./queue.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import type { TypingSignaler } from "./typing-mode.js";

export type RuntimeFallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: string;
  status?: number;
  code?: string;
};

export type AgentRunLoopResult =
  | {
      kind: "success";
      runId: string;
      runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      fallbackProvider?: string;
      fallbackModel?: string;
      fallbackAttempts: RuntimeFallbackAttempt[];
      didLogHeartbeatStrip: boolean;
      autoCompactionCompleted: boolean;
      /** Payload keys sent directly (not via pipeline) during tool flush. */
      directlySentBlockKeys?: Set<string>;
    }
  | { kind: "final"; payload: ReplyPayload };

export function resolveMaxTotalWaitMs(runTimeoutMs: number | undefined): number {
  const timeoutMs =
    typeof runTimeoutMs === "number" && Number.isFinite(runTimeoutMs) ? runTimeoutMs : 0;
  return Math.max(150_000, timeoutMs > 0 ? timeoutMs + 60_000 : 150_000);
}

export function resolveMaxWaitRetryDelayMs(maxTotalWaitMs: number): number {
  return Math.max(30_000, Math.round(maxTotalWaitMs / 6));
}

function formatRetryDelayMs(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds > 0) {
    return `${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

function parseRetryDelayMsFromMessage(message: string): number | null {
  const patterns: RegExp[] = [
    /retry[-\s]?after[:\s]+(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i,
    /try again in[:\s]+(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i,
  ];
  for (const re of patterns) {
    const match = re.exec(message);
    if (!match) {
      continue;
    }
    const amount = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }
    if (unit === "ms") {
      return amount;
    }
    if (["s", "sec", "secs", "second", "seconds"].includes(unit)) {
      return amount * 1000;
    }
    if (["m", "min", "mins", "minute", "minutes"].includes(unit)) {
      return amount * 60_000;
    }
    if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) {
      return amount * 3_600_000;
    }
  }
  return null;
}

function buildFriendlyFailureText(params: {
  errorCode: string;
  message: string;
  retryDelayMs?: number | null;
}): string {
  const retryDelayMs = params.retryDelayMs ?? parseRetryDelayMsFromMessage(params.message);
  const retryHint =
    typeof retryDelayMs === "number" && Number.isFinite(retryDelayMs) && retryDelayMs > 0
      ? ` Reintenta en ${formatRetryDelayMs(retryDelayMs)}.`
      : " Reintenta en un rato.";
  return `No he podido responder ahora.${retryHint} [${params.errorCode}]`;
}

export async function runAgentTurnWithFallback(params: {
  commandBody: string;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  typingSignals: TypingSignaler;
  blockReplyPipeline: BlockReplyPipeline | null;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  pendingToolTasks: Set<Promise<void>>;
  resetSessionAfterCompactionFailure: (reason: string) => Promise<boolean>;
  resetSessionAfterRoleOrderingConflict: (reason: string) => Promise<boolean>;
  isHeartbeat: boolean;
  sessionKey?: string;
  getActiveSessionEntry: () => SessionEntry | undefined;
  activeSessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
}): Promise<AgentRunLoopResult> {
  const TRANSIENT_HTTP_RETRY_DELAY_MS = 2_500;
  const MAX_TOTAL_WAIT_MS = resolveMaxTotalWaitMs(params.followupRun.run.timeoutMs);
  const maxWaitController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    maxWaitController.abort();
  }, MAX_TOTAL_WAIT_MS);
  if (params.opts?.abortSignal) {
    if (params.opts.abortSignal.aborted) {
      maxWaitController.abort();
    } else {
      params.opts.abortSignal.addEventListener(
        "abort",
        () => {
          maxWaitController.abort();
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
        },
        { once: true },
      );
    }
  }
  const effectiveAbortSignal = maxWaitController.signal;

  let didLogHeartbeatStrip = false;
  let autoCompactionCompleted = false;
  // Track payloads sent directly (not via pipeline) during tool flush to avoid duplicates.
  const directlySentBlockKeys = new Set<string>();

  const runId = params.opts?.runId ?? crypto.randomUUID();
  let didNotifyAgentRunStart = false;
  const notifyAgentRunStart = () => {
    if (didNotifyAgentRunStart) {
      return;
    }
    didNotifyAgentRunStart = true;
    params.opts?.onAgentRunStart?.(runId);
  };
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
      isHeartbeat: params.isHeartbeat,
    });
  }
  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = params.followupRun.run.provider;
  let fallbackModel = params.followupRun.run.model;
  let fallbackAttempts: RuntimeFallbackAttempt[] = [];
  let didResetAfterCompactionFailure = false;
  let didRetryTransientHttpError = false;

  try {
    while (true) {
      try {
        const normalizeStreamingText = (
          payload: ReplyPayload,
        ): { text?: string; skip: boolean } => {
          let text = payload.text;
          if (!params.isHeartbeat && text?.includes("HEARTBEAT_OK")) {
            const stripped = stripHeartbeatToken(text, {
              mode: "message",
            });
            if (stripped.didStrip && !didLogHeartbeatStrip) {
              didLogHeartbeatStrip = true;
              logVerbose("Stripped stray HEARTBEAT_OK token from reply");
            }
            if (stripped.shouldSkip && (payload.mediaUrls?.length ?? 0) === 0) {
              return { skip: true };
            }
            text = stripped.text;
          }
          if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
            return { skip: true };
          }
          if (!text) {
            // Allow media-only payloads (e.g. tool result screenshots) through.
            if ((payload.mediaUrls?.length ?? 0) > 0) {
              return { text: undefined, skip: false };
            }
            return { skip: true };
          }
          const sanitized = sanitizeUserFacingText(text, {
            errorContext: Boolean(payload.isError),
          });
          if (!sanitized.trim()) {
            return { skip: true };
          }
          return { text: sanitized, skip: false };
        };
        const handlePartialForTyping = async (
          payload: ReplyPayload,
        ): Promise<string | undefined> => {
          const { text, skip } = normalizeStreamingText(payload);
          if (skip || !text) {
            return undefined;
          }
          await params.typingSignals.signalTextDelta(text);
          return text;
        };
        const blockReplyPipeline = params.blockReplyPipeline;
        const onToolResult = params.opts?.onToolResult;
        const fallbackResult = await runWithModelFallback({
          ...resolveModelFallbackOptions(params.followupRun.run),
          run: (provider, model) => {
            // Notify that model selection is complete (including after fallback).
            // This allows responsePrefix template interpolation with the actual model.
            params.opts?.onModelSelected?.({
              provider,
              model,
              thinkLevel: params.followupRun.run.thinkLevel,
            });

            if (isCliProvider(provider, params.followupRun.run.config)) {
              const startedAt = Date.now();
              notifyAgentRunStart();
              emitAgentEvent({
                runId,
                stream: "lifecycle",
                data: {
                  phase: "start",
                  startedAt,
                },
              });
              const cliSessionId = getCliSessionId(params.getActiveSessionEntry(), provider);
              return (async () => {
                let lifecycleTerminalEmitted = false;
                try {
                  const result = await runCliAgent({
                    sessionId: params.followupRun.run.sessionId,
                    sessionKey: params.sessionKey,
                    agentId: params.followupRun.run.agentId,
                    sessionFile: params.followupRun.run.sessionFile,
                    workspaceDir: params.followupRun.run.workspaceDir,
                    config: params.followupRun.run.config,
                    prompt: params.commandBody,
                    provider,
                    model,
                    thinkLevel: params.followupRun.run.thinkLevel,
                    timeoutMs: params.followupRun.run.timeoutMs,
                    runId,
                    extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
                    ownerNumbers: params.followupRun.run.ownerNumbers,
                    cliSessionId,
                    images: params.opts?.images,
                  });

                  // CLI backends don't emit streaming assistant events, so we need to
                  // emit one with the final text so server-chat can populate its buffer
                  // and send the response to TUI/WebSocket clients.
                  const cliText = result.payloads?.[0]?.text?.trim();
                  if (cliText) {
                    emitAgentEvent({
                      runId,
                      stream: "assistant",
                      data: { text: cliText },
                    });
                  }

                  emitAgentEvent({
                    runId,
                    stream: "lifecycle",
                    data: {
                      phase: "end",
                      startedAt,
                      endedAt: Date.now(),
                    },
                  });
                  lifecycleTerminalEmitted = true;

                  return result;
                } catch (err) {
                  emitAgentEvent({
                    runId,
                    stream: "lifecycle",
                    data: {
                      phase: "error",
                      startedAt,
                      endedAt: Date.now(),
                      error: String(err),
                    },
                  });
                  lifecycleTerminalEmitted = true;
                  throw err;
                } finally {
                  // Defensive backstop: never let a CLI run complete without a terminal
                  // lifecycle event, otherwise downstream consumers can hang.
                  if (!lifecycleTerminalEmitted) {
                    emitAgentEvent({
                      runId,
                      stream: "lifecycle",
                      data: {
                        phase: "error",
                        startedAt,
                        endedAt: Date.now(),
                        error: "CLI run completed without lifecycle terminal event",
                      },
                    });
                  }
                }
              })();
            }
            const { authProfile, embeddedContext, senderContext } = buildEmbeddedRunContexts({
              run: params.followupRun.run,
              sessionCtx: params.sessionCtx,
              hasRepliedRef: params.opts?.hasRepliedRef,
              provider,
            });
            const runBaseParams = buildEmbeddedRunBaseParams({
              run: params.followupRun.run,
              provider,
              model,
              runId,
              authProfile,
            });
            return runEmbeddedPiAgent({
              ...embeddedContext,
              groupId: resolveGroupSessionKey(params.sessionCtx)?.id,
              groupChannel:
                params.sessionCtx.GroupChannel?.trim() ?? params.sessionCtx.GroupSubject?.trim(),
              groupSpace: params.sessionCtx.GroupSpace?.trim() ?? undefined,
              ...senderContext,
              ...runBaseParams,
              prompt: params.commandBody,
              extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
              toolResultFormat: (() => {
                const channel = resolveMessageChannel(
                  params.sessionCtx.Surface,
                  params.sessionCtx.Provider,
                );
                if (!channel) {
                  return "markdown";
                }
                return isMarkdownCapableMessageChannel(channel) ? "markdown" : "plain";
              })(),
              suppressToolErrorWarnings: params.opts?.suppressToolErrorWarnings,
              images: params.opts?.images,
              abortSignal: effectiveAbortSignal,
              blockReplyBreak: params.resolvedBlockStreamingBreak,
              blockReplyChunking: params.blockReplyChunking,
              onPartialReply: async (payload) => {
                const textForTyping = await handlePartialForTyping(payload);
                if (!params.opts?.onPartialReply || textForTyping === undefined) {
                  return;
                }
                await params.opts.onPartialReply({
                  text: textForTyping,
                  mediaUrls: payload.mediaUrls,
                });
              },
              onAssistantMessageStart: async () => {
                await params.typingSignals.signalMessageStart();
                await params.opts?.onAssistantMessageStart?.();
              },
              onReasoningStream:
                params.typingSignals.shouldStartOnReasoning || params.opts?.onReasoningStream
                  ? async (payload) => {
                      await params.typingSignals.signalReasoningDelta();
                      await params.opts?.onReasoningStream?.({
                        text: payload.text,
                        mediaUrls: payload.mediaUrls,
                      });
                    }
                  : undefined,
              onReasoningEnd: params.opts?.onReasoningEnd,
              onAgentEvent: async (evt) => {
                // Signal run start only after the embedded agent emits real activity.
                const hasLifecyclePhase =
                  evt.stream === "lifecycle" && typeof evt.data.phase === "string";
                if (evt.stream !== "lifecycle" || hasLifecyclePhase) {
                  notifyAgentRunStart();
                }
                // Trigger typing when tools start executing.
                // Must await to ensure typing indicator starts before tool summaries are emitted.
                if (evt.stream === "tool") {
                  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                  const name = typeof evt.data.name === "string" ? evt.data.name : undefined;
                  if (phase === "start" || phase === "update") {
                    await params.typingSignals.signalToolStart();
                    await params.opts?.onToolStart?.({ name, phase });
                  }
                }
                // Track auto-compaction completion
                if (evt.stream === "compaction") {
                  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                  if (phase === "end") {
                    autoCompactionCompleted = true;
                  }
                }
              },
              // Always pass onBlockReply so flushBlockReplyBuffer works before tool execution,
              // even when regular block streaming is disabled. The handler sends directly
              // via opts.onBlockReply when the pipeline isn't available.
              onBlockReply: params.opts?.onBlockReply
                ? createBlockReplyDeliveryHandler({
                    onBlockReply: params.opts.onBlockReply,
                    currentMessageId:
                      params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid,
                    normalizeStreamingText,
                    applyReplyToMode: params.applyReplyToMode,
                    typingSignals: params.typingSignals,
                    blockStreamingEnabled: params.blockStreamingEnabled,
                    blockReplyPipeline,
                    directlySentBlockKeys,
                  })
                : undefined,
              onBlockReplyFlush:
                params.blockStreamingEnabled && blockReplyPipeline
                  ? async () => {
                      await blockReplyPipeline.flush({ force: true });
                    }
                  : undefined,
              shouldEmitToolResult: params.shouldEmitToolResult,
              shouldEmitToolOutput: params.shouldEmitToolOutput,
              onToolResult: onToolResult
                ? (payload) => {
                    // `subscribeEmbeddedPiSession` may invoke tool callbacks without awaiting them.
                    // If a tool callback starts typing after the run finalized, we can end up with
                    // a typing loop that never sees a matching markRunComplete(). Track and drain.
                    const task = (async () => {
                      const { text, skip } = normalizeStreamingText(payload);
                      if (skip) {
                        return;
                      }
                      await params.typingSignals.signalTextDelta(text);
                      await onToolResult({
                        text,
                        mediaUrls: payload.mediaUrls,
                      });
                    })()
                      .catch((err) => {
                        logVerbose(`tool result delivery failed: ${String(err)}`);
                      })
                      .finally(() => {
                        params.pendingToolTasks.delete(task);
                      });
                    params.pendingToolTasks.add(task);
                  }
                : undefined,
            });
          },
        });
        runResult = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;
        fallbackAttempts = Array.isArray(fallbackResult.attempts)
          ? fallbackResult.attempts.map((attempt) => ({
              provider: String(attempt.provider ?? ""),
              model: String(attempt.model ?? ""),
              error: String(attempt.error ?? ""),
              reason: attempt.reason ? String(attempt.reason) : undefined,
              status: typeof attempt.status === "number" ? attempt.status : undefined,
              code: attempt.code ? String(attempt.code) : undefined,
            }))
          : [];

        // Some embedded runs surface context overflow as an error payload instead of throwing.
        // Treat those as a session-level failure and auto-recover by starting a fresh session.
        const embeddedError = runResult.meta?.error;
        if (
          embeddedError &&
          isContextOverflowError(embeddedError.message) &&
          !didResetAfterCompactionFailure &&
          (await params.resetSessionAfterCompactionFailure(embeddedError.message))
        ) {
          didResetAfterCompactionFailure = true;
          return {
            kind: "final",
            payload: {
              text: "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 4000 or higher in your config.",
            },
          };
        }
        if (embeddedError?.kind === "role_ordering") {
          const didReset = await params.resetSessionAfterRoleOrderingConflict(
            embeddedError.message,
          );
          if (didReset) {
            return {
              kind: "final",
              payload: {
                text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
              },
            };
          }
        }

        break;
      } catch (err) {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        const message = err instanceof Error ? err.message : String(err);
        const isMaxWaitAbort = maxWaitController.signal.aborted;
        const isAbortOrTimeout =
          isMaxWaitAbort ||
          isTimeoutError(err) ||
          /request was aborted|request aborted|operation was aborted/i.test(message);
        const isContextOverflow = isLikelyContextOverflowError(message);
        const isCompactionFailure = isCompactionFailureError(message);
        const isSessionCorruption = /function call turn comes immediately after/i.test(message);
        const isRoleOrderingError = /incorrect role information|roles must alternate/i.test(
          message,
        );
        const isTransientHttp = isTransientHttpError(message);
        const isAllModelsFailed = /^All models failed\s*\(/i.test(message);

        if (isAbortOrTimeout) {
          const timeoutErrorCode = isMaxWaitAbort ? "OC-E-MAXWAIT" : "OC-E-TIMEOUT";
          const retryDelayMs = isMaxWaitAbort
            ? resolveMaxWaitRetryDelayMs(MAX_TOTAL_WAIT_MS)
            : null;
          if (isMaxWaitAbort) {
            defaultRuntime.error(
              `Agent run exceeded max total wait (${MAX_TOTAL_WAIT_MS}ms); returning fallback to user.`,
            );
          } else {
            defaultRuntime.error(
              `Agent run aborted or timed out (${message}); returning fallback to user.`,
            );
          }
          return {
            kind: "final",
            payload: {
              text: buildFriendlyFailureText({
                errorCode: timeoutErrorCode,
                message,
                retryDelayMs,
              }),
            },
          };
        }

        if (
          isCompactionFailure &&
          !didResetAfterCompactionFailure &&
          (await params.resetSessionAfterCompactionFailure(message))
        ) {
          didResetAfterCompactionFailure = true;
          return {
            kind: "final",
            payload: {
              text: "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 4000 or higher in your config.",
            },
          };
        }
        if (isRoleOrderingError) {
          const didReset = await params.resetSessionAfterRoleOrderingConflict(message);
          if (didReset) {
            return {
              kind: "final",
              payload: {
                text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
              },
            };
          }
        }

        // Auto-recover from Gemini session corruption by resetting the session
        if (
          isSessionCorruption &&
          params.sessionKey &&
          params.activeSessionStore &&
          params.storePath
        ) {
          const sessionKey = params.sessionKey;
          const corruptedSessionId = params.getActiveSessionEntry()?.sessionId;
          defaultRuntime.error(
            `Session history corrupted (Gemini function call ordering). Resetting session: ${params.sessionKey}`,
          );

          try {
            // Delete transcript file if it exists
            if (corruptedSessionId) {
              const transcriptPath = resolveSessionTranscriptPath(corruptedSessionId);
              try {
                fs.unlinkSync(transcriptPath);
              } catch {
                // Ignore if file doesn't exist
              }
            }

            // Keep the in-memory snapshot consistent with the on-disk store reset.
            delete params.activeSessionStore[sessionKey];

            // Remove session entry from store using a fresh, locked snapshot.
            await updateSessionStore(params.storePath, (store) => {
              delete store[sessionKey];
            });
          } catch (cleanupErr) {
            defaultRuntime.error(
              `Failed to reset corrupted session ${params.sessionKey}: ${String(cleanupErr)}`,
            );
          }

          return {
            kind: "final",
            payload: {
              text: "⚠️ Session history was corrupted. I've reset the conversation - please try again!",
            },
          };
        }

        if (isTransientHttp && !didRetryTransientHttpError) {
          didRetryTransientHttpError = true;
          // Retry the full runWithModelFallback() cycle — transient errors
          // (502/521/etc.) typically affect the whole provider, so falling
          // back to an alternate model first would not help. Instead we wait
          // and retry the complete primary→fallback chain.
          defaultRuntime.error(
            `Transient HTTP provider error before reply (${message}). Retrying once in ${TRANSIENT_HTTP_RETRY_DELAY_MS}ms.`,
          );
          await new Promise<void>((resolve) => {
            setTimeout(resolve, TRANSIENT_HTTP_RETRY_DELAY_MS);
          });
          continue;
        }

        defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
        const safeMessage = isTransientHttp
          ? sanitizeUserFacingText(message, { errorContext: true })
          : message;
        const trimmedMessage = safeMessage.replace(/\.\s*$/, "");
        const allModelsErrorCode = /rate_limit|cooldown|429/i.test(message)
          ? "OC-E-MODELS-RATELIMIT"
          : "OC-E-MODELS-FAILED";
        const fallbackText = isAllModelsFailed
          ? buildFriendlyFailureText({
              errorCode: allModelsErrorCode,
              message,
            })
          : isContextOverflow
            ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model."
            : isRoleOrderingError
              ? "⚠️ Message ordering conflict - please try again. If this persists, use /new to start a fresh session."
              : `⚠️ Agent failed before reply: ${trimmedMessage}.\nLogs: openclaw logs --follow`;

        return {
          kind: "final",
          payload: {
            text: fallbackText,
          },
        };
      }
    }

    return {
      kind: "success",
      runId,
      runResult,
      fallbackProvider,
      fallbackModel,
      fallbackAttempts,
      didLogHeartbeatStrip,
      autoCompactionCompleted,
      directlySentBlockKeys: directlySentBlockKeys.size > 0 ? directlySentBlockKeys : undefined,
    };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  }
}
