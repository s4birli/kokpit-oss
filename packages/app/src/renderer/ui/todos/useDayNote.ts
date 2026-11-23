import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineClient } from "../../engine/types.ts";
import { errorMessage, isDisconnected } from "../errors.ts";
import { whenConnected } from "../hooks/when-connected.ts";

export type NoteStatus = "idle" | "saving" | "saved" | "error";

export interface DayNote {
  text: string;
  status: NoteStatus;
  error: string | null;
  /** Local edit; saved after `debounceMs` of quiet, or at once when the day changes or the panel closes. */
  change(text: string): void;
}

/**
 * The note of `date` (undefined = not known yet: nothing loads). Remote changes (`notes.changed`)
 * replace the text only while the user has no unsaved edits.
 */
export function useDayNote(client: EngineClient, date: string | undefined, debounceMs: number): DayNote {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<NoteStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef("");
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const loadSeq = useRef(0);

  const save = useCallback(
    async (day: string): Promise<void> => {
      clearTimeout(timer.current);
      timer.current = undefined;
      if (!dirty.current) return;
      const sent = textRef.current;
      if (alive.current) setStatus("saving");
      try {
        await client.request("notes.set", { date: day, text: sent });
        if (textRef.current === sent) dirty.current = false;
        if (alive.current) {
          setStatus("saved");
          setError(null);
        }
      } catch (err) {
        if (!alive.current) return;
        setStatus("error");
        setError(errorMessage(err));
      }
    },
    [client],
  );

  const load = useCallback(async (): Promise<void> => {
    if (date === undefined) return;
    const my = ++loadSeq.current;
    try {
      const res = await client.request("notes.get", { date });
      if (!alive.current || my !== loadSeq.current || dirty.current) return;
      textRef.current = res.text;
      setText(res.text);
    } catch (err) {
      if (!alive.current || my !== loadSeq.current || isDisconnected(err)) return;
      setError(errorMessage(err));
    }
  }, [client, date]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (date === undefined) return;
    const offConnected = whenConnected(client, load);
    const offEvent = client.onEvent((event) => {
      if (event.name === "notes.changed" && event.date === date) void load();
    });
    return () => {
      offConnected();
      offEvent();
      // Leaving this day (or closing): write what is pending for it now.
      void save(date);
      dirty.current = false;
      textRef.current = "";
      setText("");
      setStatus("idle");
    };
  }, [client, date, load, save]);

  const change = useCallback(
    (next: string) => {
      if (date === undefined) return;
      textRef.current = next;
      dirty.current = true;
      setText(next);
      setStatus("idle");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(date), debounceMs);
    },
    [date, debounceMs, save],
  );

  return { text, status, error, change };
}
