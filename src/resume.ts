import type { LeafChainState } from "./session-transcript.ts";
import { matchTurnHistory, type TurnBoundary } from "./store.ts";
import { historyAfterUserCount, type HistoryMessage } from "./translate.ts";

export type SessionFileProbe = {
  exists: boolean;
  hasEntry: (uuid: string) => boolean;
  chainAfterLeaf: (uuid: string) => LeafChainState;
  lastEntry: () => string | undefined;
};

export type ResumePlan = {
  resume?: string;
  forkAt?: { sessionId: string; leafUuid: string };
  missedMessages: HistoryMessage[];
  transcript: "none" | "missed" | "history";
  clearBinding: boolean;
  rewindIndex?: number;
  reason: "no-session" | "missing-file" | "latest" | "rewind" | "rewind-no-leaf" | "diverged" | "untracked";
};

function branchFork(
  probe: SessionFileProbe,
  sessionId: string,
  leafUuid: string | undefined,
): { forkAt?: { sessionId: string; leafUuid: string } } {
  if (!leafUuid || probe.chainAfterLeaf(leafUuid) !== "branched") return {};
  return { forkAt: { sessionId, leafUuid } };
}

export function planResume(input: {
  turns: TurnBoundary[];
  prints: string[];
  priorMessages: HistoryMessage[];
  sessionId?: string;
  leafUuid?: string;
  probeFor: (sessionId: string) => SessionFileProbe | null;
}): ResumePlan {
  const { turns, prints, priorMessages, sessionId, leafUuid, probeFor } = input;

  if (!sessionId) {
    return {
      missedMessages: priorMessages,
      transcript: "history",
      clearBinding: false,
      reason: "no-session",
    };
  }

  const current = probeFor(sessionId);
  if (!current || !current.exists) {
    return {
      missedMessages: priorMessages,
      transcript: "history",
      clearBinding: true,
      reason: "missing-file",
    };
  }

  const match = matchTurnHistory(turns, prints);
  if (match.kind === "latest") {
    const missedMessages = historyAfterUserCount(priorMessages, match.count);
    return {
      resume: sessionId,
      ...branchFork(current, sessionId, leafUuid),
      missedMessages,
      transcript: missedMessages.length > 0 ? "missed" : "none",
      clearBinding: false,
      reason: "latest",
    };
  }

  if (match.kind === "untracked") {
    return {
      resume: sessionId,
      ...branchFork(current, sessionId, leafUuid),
      missedMessages: [],
      transcript: "none",
      clearBinding: false,
      reason: "untracked",
    };
  }

  if (match.kind === "diverged") {
    return {
      missedMessages: priorMessages,
      transcript: "history",
      clearBinding: true,
      reason: "diverged",
    };
  }

  if (!match.leafUuid) {
    return {
      resume: sessionId,
      ...branchFork(current, sessionId, leafUuid),
      missedMessages: [],
      transcript: "none",
      clearBinding: false,
      reason: "rewind-no-leaf",
    };
  }

  const source = match.sessionId ?? sessionId;
  const sourceProbe = source === sessionId ? current : probeFor(source);
  if (!sourceProbe || !sourceProbe.exists || !sourceProbe.hasEntry(match.leafUuid)) {
    return {
      missedMessages: priorMessages,
      transcript: "history",
      clearBinding: true,
      reason: "diverged",
    };
  }

  const needsFork =
    source !== sessionId ||
    sourceProbe.lastEntry() !== match.leafUuid ||
    sourceProbe.chainAfterLeaf(match.leafUuid) !== "clean";

  return {
    resume: source,
    ...(needsFork
      ? { forkAt: { sessionId: source, leafUuid: match.leafUuid } }
      : branchFork(sourceProbe, source, leafUuid)),
    missedMessages: [],
    transcript: "none",
    clearBinding: false,
    rewindIndex: match.index,
    reason: "rewind",
  };
}
