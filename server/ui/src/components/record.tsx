import { useState } from "react";

import type { ChatMessage, DatasetRecord } from "@sdk/generated/models.js";

import { compact, int } from "../lib/format.js";

const text = (c: unknown): string => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : typeof p === "string" ? p : JSON.stringify(p))).join("");
  if (c === null || c === undefined) return "";
  return JSON.stringify(c);
};

/** The conversation-ish parts of any record shape, as (role, text) pairs. */
export const recordTurns = (r: DatasetRecord): { role: string; text: string }[] => {
  const msgs = (m: ChatMessage[] | undefined) => (m ?? []).map((x) => ({ role: x.role, text: text(x.content) || (x.toolCalls ? JSON.stringify(x.toolCalls) : "") }));
  const asTurns = (role: string, v: string | ChatMessage[] | undefined) => (v === undefined ? [] : typeof v === "string" ? [{ role, text: v }] : msgs(v));
  if (r.messages?.length) return msgs(r.messages);
  if (r.input?.messages) return [...msgs(r.input.messages), ...msgs(r.output?.turns)];
  if (r.prompt !== undefined) return [...asTurns("prompt", r.prompt), ...asTurns("completion", r.completion), ...asTurns("chosen", r.chosen), ...asTurns("rejected", r.rejected)];
  if (r.query !== undefined) return [{ role: "query", text: r.query }, ...(r.positive ? [{ role: "positive", text: r.positive }] : []), ...(r.negatives ?? []).slice(0, 2).map((n) => ({ role: "negative", text: n }))];
  return [{ role: "record", text: JSON.stringify(r) }];
};

/** Characters a collapsed message renders, and the most an expanded one shows (a record can hold megabytes). */
const PREVIEW_CHARS = 1_000;
const MAX_CHARS = 100_000;

/** One turn of a record: clamped to a few lines, expandable in place. */
export const Message = ({ role, text }: { role: string; text: string }) => {
  const [open, setOpen] = useState(false);
  const long = text.length > 240 || text.split("\n", 6).length > 5;
  const shown = text.slice(0, open ? MAX_CHARS : PREVIEW_CHARS);
  return (
    <div className="msg">
      <span className="role">{role}</span>
      <div>
        <span className={`content${long ? "" : " short"}${open ? " open" : ""}`}>
          {shown}
          {text.length > shown.length && "…"}
        </span>
        {long && (
          <button type="button" className="btn ghost sm more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Show less" : `Show all ${text.length > 9_999 ? compact(text.length) : int(text.length)} characters`}
          </button>
        )}
      </div>
    </div>
  );
};
