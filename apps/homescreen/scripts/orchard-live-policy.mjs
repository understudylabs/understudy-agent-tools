import { timingSafeEqual } from "node:crypto";

export const viewerAuthorized = (authorization, expectedToken) => {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};

export const validateEventPage = (body, { experimentId, requestedAfter, isCanonicalEvent }) => {
  if (
    body?.experiment_id !== experimentId
    || !Array.isArray(body.events)
    || body.events.some((event) => !isCanonicalEvent(event))
    || !Number.isInteger(body.next_after)
    || typeof body.has_more !== "boolean"
  ) return false;

  const sequences = body.events.map((event) => event.sequence);
  if (new Set(sequences).size !== sequences.length) return false;
  if (sequences.some((sequence) => !Number.isInteger(sequence) || sequence <= requestedAfter)) return false;
  if (sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1])) return false;
  if (body.next_after < requestedAfter) return false;
  if (sequences.length === 0) return body.next_after === requestedAfter && body.has_more === false;
  return body.next_after === sequences.at(-1);
};
