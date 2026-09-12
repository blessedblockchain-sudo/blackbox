"use client";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { PublicKey } from "@solana/web3.js";
import type { PublicRoundInfo } from "../../lib/api-types";
import { CHAT_SLOTS, CHAT_TEXT_MAX, chatPda, chatTextError, type RoundView } from "../../lib/chain";
import { erAddressExplorer } from "../../lib/explorer";
import { useChat } from "../../lib/hooks";
import { formatInt, shortAddr } from "../../lib/format";
import { Button, ExtLink, Panel, PanelHeader } from "../ui";

/**
 * The public round chat: a ring buffer of the last 32 messages in an ephemeral
 * account that exists only on the rollup (created by the first post, closed
 * before the round is committed to Solana). Anyone can read it; on a local
 * round this page can post as the server-held web backer.
 */
export function RoundChat({ info, round }: { info: PublicRoundInfo; round: RoundView }) {
  const chat = useChat(info);
  const [me, setMe] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const canPost = info.localRoutes && (round.status === "open" || round.status === "live");

  useEffect(() => {
    if (!canPost) return;
    let stop = false;
    fetch("/api/local/chat", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { author?: string } | null) => !stop && b?.author && setMe(b.author))
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [canPost]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    info.entrants.forEach((e) => e.name && m.set(e.owner, e.name));
    info.backers.forEach((b) => b.name && m.set(b.owner, b.name));
    info.licenses.forEach((l) => l.name && !m.has(l.buyer) && m.set(l.buyer, l.name));
    if (me) m.set(me, "Web backer (you)");
    return m;
  }, [info, me]);

  // Follow new messages unless the reader has scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const invalid = chatTextError(text);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/local/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const body = (await res.json()) as { author?: string; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.author) setMe(body.author);
      setText("");
      stick.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const bytes = new TextEncoder().encode(text).length;
  const chatKey = info.round ? chatPda(new PublicKey(info.round)).toBase58() : null;
  return (
    <Panel aria-label="Round chat">
      <PanelHeader title="Round chat · public" meta={chat.exists ? `last ${formatInt(Math.min(chat.messages.length, CHAT_SLOTS))} of ${CHAT_SLOTS} slots` : undefined}>
        {chatKey ? (
          <ExtLink href={erAddressExplorer(chatKey, info.cluster, info.endpoints.tee)} className="num text-[11px] text-fg-dim">
            ephemeral account {shortAddr(chatKey)}
          </ExtLink>
        ) : null}
      </PanelHeader>
      {chat.messages.length ? (
        <ol
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          aria-live="polite"
          className="max-h-52 overflow-y-auto py-1"
        >
          {chat.messages.map((m, i) => (
            <li key={`${m.author}-${m.tick}-${m.ts}-${i}`} className="grid grid-cols-[5.5rem_minmax(0,8.5rem)_minmax(0,1fr)] gap-3 px-3 py-1 text-xs">
              <span className="num whitespace-nowrap text-fg-faint" title={new Date(m.ts * 1000).toLocaleString("en-US", { hour12: false })}>
                tick {formatInt(m.tick)}
              </span>
              <span className="truncate font-mono text-fg-muted" title={m.author}>
                {names.get(m.author) ?? shortAddr(m.author)}
              </span>
              <span className="break-words text-fg">{m.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-3 py-4 text-xs text-fg-dim">
          {chat.error
            ? `Cannot read the chat: ${chat.error}`
            : round.status === "settled" || round.status === "settling"
              ? "This round's chat is gone. It lived in an ephemeral account on the rollup, and close_chat refunded its rent to the round before the round committed to Solana — it never existed on L1."
              : "No messages yet. The chat lives in an ephemeral account on the rollup: the first post creates it, and the round closes it before it commits to Solana."}
        </p>
      )}
      {canPost ? (
        <form onSubmit={send} className="flex flex-wrap items-center gap-2 border-t border-edge px-3 py-2">
          <label htmlFor="chat-text" className="sr-only">
            Message to the round chat
          </label>
          <input
            id="chat-text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            placeholder="Say something to the arena"
            aria-invalid={!!error}
            aria-describedby="chat-hint"
            className="min-h-9 min-w-0 flex-1 border border-edge-strong bg-void px-2 text-xs text-fg outline-none placeholder:text-fg-faint focus-visible:border-gain/60"
          />
          <span className={bytes > CHAT_TEXT_MAX ? "num text-[11px] text-loss" : "num text-[11px] text-fg-faint"}>
            {bytes}/{CHAT_TEXT_MAX}
          </span>
          <Button type="submit" disabled={sending || !text.trim() || bytes > CHAT_TEXT_MAX} aria-busy={sending}>
            {sending ? "Posting…" : "Post"}
          </Button>
          <p id="chat-hint" className="w-full text-[11px] text-fg-dim">
            Posts post_chat on the rollup as the local web backer (its key stays on the server).
          </p>
          {error ? (
            <p role="alert" className="w-full text-[11px] break-words text-loss">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="border-t border-edge px-3 py-2 text-[11px] text-fg-dim">Read-only here. Entrants and agents post with post_chat on the rollup while the round is open or live.</p>
      )}
    </Panel>
  );
}
