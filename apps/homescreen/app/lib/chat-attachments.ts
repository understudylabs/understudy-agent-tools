export type ChatAttachment = {
  id: string;
  filename: string;
  mediaType: string;
  previewUrl?: string;
};

export type ChatAttachmentUpload = {
  filename: string;
  mediaType: string;
  dataUrl: string;
};

type MessageWithAttachments = {
  attachments?: ChatAttachment[];
};

export function persistableChatMessages<T extends MessageWithAttachments>(messages: T[]) {
  return messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map(({ previewUrl: _previewUrl, ...attachment }) => attachment),
  }));
}

export function recentUniqueAttachmentRefs<T extends MessageWithAttachments>(
  messages: T[],
  limit = 40,
) {
  const byId = new Map<string, ChatAttachment>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (!byId.has(attachment.id)) byId.set(attachment.id, attachment);
    }
  }
  return [...byId.values()]
    .slice(-limit)
    .map(({ previewUrl: _previewUrl, ...attachment }) => attachment);
}

export function withHydratedAttachments<T extends MessageWithAttachments>(
  messages: T[],
  hydrated: Array<ChatAttachment & { dataUrl: string }>,
) {
  const previews = new Map(hydrated.map((attachment) => [attachment.id, attachment.dataUrl]));
  return messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map((attachment) => {
      const previewUrl = previews.get(attachment.id);
      return previewUrl ? { ...attachment, previewUrl } : attachment;
    }),
  }));
}
