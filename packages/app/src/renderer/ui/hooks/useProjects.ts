import type { Card, Project } from "@kokpit/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineClient } from "../../engine/types.ts";
import { errorMessage, isDisconnected } from "../errors.ts";
import { sortProjects, supportsCards } from "../projects.ts";
import { whenConnected } from "./when-connected.ts";
import { t } from "../../../i18n/index.ts";

export interface ProjectsState {
  projects: Project[];
  cardsByProject: Readonly<Record<string, Card[]>>;
  /** Error loading the project list. */
  error: string | null;
  /** Errors loading a project's cards, by project id. */
  cardErrors: Readonly<Record<string, string>>;
  reloadCards(projectId: string): Promise<void>;
  /** Inserts a card the engine just created, before the list reload arrives. */
  addCard(card: Card): void;
}

/**
 * Projects (built-in first) and the cards of card-capable projects; reloads on
 * (re)connect, on `projects.changed` and (per project) on `cards.changed`.
 */
export function useProjects(client: EngineClient): ProjectsState {
  const [projects, setProjects] = useState<Project[]>([]);
  const [cardsByProject, setCards] = useState<Record<string, Card[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const alive = useRef(true);
  /** Latest request number per project, so stale responses are dropped. */
  const seq = useRef(new Map<string, number>());

  const setCardError = useCallback((projectId: string, message: string | null) => {
    setCardErrors((prev) => {
      if (message === null) {
        if (!(projectId in prev)) return prev;
        const { [projectId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [projectId]: message };
    });
  }, []);

  const reloadCards = useCallback(
    async (projectId: string): Promise<void> => {
      const my = (seq.current.get(projectId) ?? 0) + 1;
      seq.current.set(projectId, my);
      try {
        const { cards } = await client.request("cards.list", { projectId });
        if (!alive.current || seq.current.get(projectId) !== my) return;
        setCards((prev) => ({ ...prev, [projectId]: cards }));
        setCardError(projectId, null);
      } catch (err) {
        if (!alive.current || seq.current.get(projectId) !== my || isDisconnected(err)) return;
        setCardError(projectId, t("workbench.load.cards", { error: errorMessage(err) }));
      }
    },
    [client, setCardError],
  );

  const addCard = useCallback((card: Card) => {
    setCards((prev) => {
      const list = prev[card.projectId] ?? [];
      if (list.some((c) => c.id === card.id)) return prev;
      return { ...prev, [card.projectId]: [...list, card] };
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    let projectsSeq = 0;
    const load = async (): Promise<void> => {
      const my = ++projectsSeq;
      try {
        const { projects: list } = await client.request("projects.list", {});
        if (!alive.current || my !== projectsSeq) return;
        setProjects(sortProjects(list));
        setError(null);
        await Promise.all(list.filter(supportsCards).map((p) => reloadCards(p.id)));
      } catch (err) {
        if (!alive.current || my !== projectsSeq || isDisconnected(err)) return;
        setError(t("workbench.load.projects", { error: errorMessage(err) }));
      }
    };
    const offConnected = whenConnected(client, load);
    const offEvent = client.onEvent((event) => {
      if (event.name === "cards.changed") void reloadCards(event.projectId);
      else if (event.name === "projects.changed") void load();
    });
    return () => {
      alive.current = false;
      offConnected();
      offEvent();
    };
  }, [client, reloadCards]);

  return { projects, cardsByProject, error, cardErrors, reloadCards, addCard };
}
