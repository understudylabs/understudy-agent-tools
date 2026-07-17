"use client";

import { memo, useMemo } from "react";
import { ArrowDownIcon } from "lucide-react";

import {
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerVisibility,
} from "@/app/components/base-ui/message-scroller";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/app/components/base-ui/hover-card";

export type ChatTurnAnchor = {
  id: string;
  label: string;
};

function sameTurnAnchors(previous: ChatTurnAnchor[], next: ChatTurnAnchor[]) {
  return previous.length === next.length && previous.every((anchor, index) => (
    anchor.id === next[index]?.id && anchor.label === next[index]?.label
  ));
}

export const ChatScrollControls = memo(function ChatScrollControls({
  anchors,
  streaming,
}: {
  anchors: ChatTurnAnchor[];
  streaming: boolean;
}) {
  const { scrollToMessage } = useMessageScroller();
  const { currentAnchorId, visibleMessageIds } = useMessageScrollerVisibility();
  const visibleIds = useMemo(() => new Set(visibleMessageIds), [visibleMessageIds]);
  const positionTicks = useMemo(() => {
    const maximumTicks = 12;
    if (anchors.length <= maximumTicks) return anchors;

    const sampledIndexes = new Set<number>([0, anchors.length - 1]);
    for (let index = 1; index < maximumTicks - 1; index += 1) {
      sampledIndexes.add(Math.round(index * (anchors.length - 1) / (maximumTicks - 1)));
    }
    if (currentAnchorId) {
      const currentIndex = anchors.findIndex((anchor) => anchor.id === currentAnchorId);
      if (currentIndex >= 0 && !sampledIndexes.has(currentIndex)) {
        const replaceableIndex = [...sampledIndexes]
          .filter((index) => index !== 0 && index !== anchors.length - 1)
          .sort((left, right) => (
            Math.abs(left - currentIndex) - Math.abs(right - currentIndex)
          ))[0];
        if (replaceableIndex !== undefined) sampledIndexes.delete(replaceableIndex);
        sampledIndexes.add(currentIndex);
      }
    }

    return [...sampledIndexes]
      .sort((left, right) => left - right)
      .map((index) => anchors[index])
      .filter((anchor): anchor is ChatTurnAnchor => Boolean(anchor));
  }, [anchors, currentAnchorId]);

  if (anchors.length === 0) return null;

  const anchorIndex = currentAnchorId
    ? anchors.findIndex((anchor) => anchor.id === currentAnchorId)
    : -1;
  const currentTurn = Math.max(0, anchorIndex) + 1;
  const visibleLabel = `${visibleMessageIds.length} message${visibleMessageIds.length === 1 ? "" : "s"} visible`;

  return (
    <>
      {anchors.length > 1 && (
        <HoverCard openDelay={160} closeDelay={120}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              className="chat-scroll-outline-trigger"
              aria-label={`Open conversation outline. Turn ${currentTurn} of ${anchors.length}.`}
            >
              {positionTicks.map((anchor) => (
                <span
                  key={anchor.id}
                  className="chat-scroll-outline-tick"
                  data-current={anchor.id === currentAnchorId}
                  data-visible={visibleIds.has(anchor.id)}
                  aria-hidden="true"
                />
              ))}
            </button>
          </HoverCardTrigger>
          <HoverCardContent
            side="left"
            align="center"
            sideOffset={10}
            className="chat-scroll-outline-card"
          >
            <div className="chat-scroll-outline-heading">
              <span>Conversation</span>
              <span>{currentTurn} / {anchors.length}</span>
            </div>
            <div className="chat-scroll-outline-list">
              {anchors.map((anchor, index) => (
                <button
                  key={anchor.id}
                  type="button"
                  className="chat-scroll-outline-item"
                  aria-current={anchor.id === currentAnchorId ? "location" : undefined}
                  onClick={() => {
                    scrollToMessage(anchor.id, {
                      align: "start",
                      behavior: "smooth",
                    });
                  }}
                >
                  <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <span>{anchor.label}</span>
                </button>
              ))}
            </div>
          </HoverCardContent>
        </HoverCard>
      )}
      <MessageScrollerButton
        className="chat-scroll-tracker"
        aria-label={`Turn ${currentTurn} of ${anchors.length}. ${visibleLabel}. Jump to latest.`}
        title="Jump to latest"
      >
        {streaming && <span className="chat-scroll-live-dot" aria-hidden="true" />}
        <span className="chat-scroll-turn">Turn {currentTurn} of {anchors.length}</span>
        <span className="chat-scroll-latest">
          Latest
          <ArrowDownIcon aria-hidden="true" size={13} strokeWidth={2} />
        </span>
      </MessageScrollerButton>
    </>
  );
}, (previous, next) => (
  previous.streaming === next.streaming && sameTurnAnchors(previous.anchors, next.anchors)
));
