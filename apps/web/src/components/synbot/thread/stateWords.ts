// FILE: stateWords.ts
// Purpose: One state vocabulary for every card in a bot's thread (the task, the hand-off, the
//          report): Working, Waiting for you, Done, Failed, Stopped (plus Queued and Starting
//          for a task, and Waiting for your Start for a hand-off; the words are the synbot
//          catalog's delegation_* and task_* keys), each with its chip tone; and a queued task's
//          reason in the user's words (the server's known reasons, else "Queued").
// Layer: SynBot thread UI (pure)
// Exports: delegationStateKey, delegationTone, taskStateKey, taskTone, queueReasonKey

import type { BotDelegationState, HubWorkState } from "@synara/contracts";

import type { Tone } from "../kit/controls";

const DELEGATION_KEY: Record<BotDelegationState, string> = {
  "awaiting-start": "synbot:delegation_awaiting-start",
  sent: "synbot:delegation_sent",
  working: "synbot:delegation_working",
  waiting: "synbot:delegation_waiting",
  completed: "synbot:delegation_completed",
  failed: "synbot:delegation_failed",
  cancelled: "synbot:delegation_cancelled",
};

/** The i18n key of a hand-off's state. */
export function delegationStateKey(state: BotDelegationState): string {
  return DELEGATION_KEY[state];
}

/** A delegation's tone: amber while it waits for the user, then working, done, failed. */
export function delegationTone(state: BotDelegationState): Tone {
  switch (state) {
    case "awaiting-start":
    case "waiting":
      return "attention";
    case "sent":
    case "working":
      return "active";
    case "completed":
      return "good";
    case "failed":
      return "bad";
    case "cancelled":
      return "muted";
  }
}

const TASK_KEY: Record<HubWorkState, string> = {
  queued: "synbot:task_queued",
  starting: "synbot:task_starting",
  working: "synbot:task_working",
  waiting: "synbot:task_waiting",
  idle: "synbot:task_idle",
  completed: "synbot:task_completed",
  failed: "synbot:task_failed",
  cancelled: "synbot:task_cancelled",
};

/** The i18n key of a task's state. */
export function taskStateKey(state: HubWorkState): string {
  return TASK_KEY[state];
}

export function taskTone(state: HubWorkState): Tone {
  switch (state) {
    case "starting":
    case "working":
      return "active";
    case "waiting":
      return "attention";
    case "completed":
      return "good";
    case "failed":
      return "bad";
    case "queued":
    case "idle":
    case "cancelled":
      return "muted";
  }
}

/** The reasons the server queues a task with (hubWorkService), in the user's words. */
const QUEUE_REASON_KEY: Readonly<Record<string, string>> = {
  "Resume this hub before starting work": "synbot:queue_resumeBot",
  "Link this repository before starting": "synbot:queue_linkProject",
  "Waiting for an available worker slot": "synbot:queue_waitingSlot",
};

/** Why a task waits, as an i18n key: a known server reason, else plain "Queued" (an unknown
 * server string never shows raw). */
export function queueReasonKey(reason: string | null): string {
  return (reason ? QUEUE_REASON_KEY[reason.trim()] : undefined) ?? TASK_KEY.queued;
}
