export type ChatStreamPatch = {
  replaceContent: string | null;
  appendContent: string;
  appendReasoning: string;
};

export type ChatStreamBatcherOptions = {
  schedule?: (callback: FrameRequestCallback) => number;
  cancel?: (handle: number) => void;
};

export class ChatStreamBatcher {
  constructor(
    apply: (patch: ChatStreamPatch) => void,
    options?: ChatStreamBatcherOptions,
  );
  appendContent(text: string): void;
  replaceContent(text: string): void;
  appendReasoning(text: string): void;
  flush(): void;
  reset(): void;
  dispose(): void;
}
