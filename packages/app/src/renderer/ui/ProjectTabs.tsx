// İş P — proje sekmeleri: the strip of open projects above the work area (like browser tabs). Click activates,
// × or middle-click closes (nothing is deleted), drag or the move shortcut reorders.
import { useRef, type KeyboardEvent } from "react";
import type { AgentCount } from "./agents.ts";
import { AgentCounter } from "./RailAgents.tsx";
import "./project-tabs.css";
import { t, useT } from "../../i18n/index.ts";

export interface ProjectTabItem {
  projectId: string;
  title: string;
  /** Running/waiting agents of the project (same counter as the rail). */
  count?: AgentCount | undefined;
  /** Where the project's terminals open, e.g. "Mac mini: /path"; the tab's tooltip. */
  location?: string | undefined;
  /** İş H: name of the project's Claude account when it is not the default one; a small badge on the tab. */
  accountName?: string | undefined;
  /** Claude kullanımı: the account's usage (several lines), added to the badge's tooltip. */
  accountUsage?: string | undefined;
}

export interface ProjectTabsText {
  label: string;
  close(title: string): string;
  /** Shortcuts (aria-keyshortcuts syntax) that move the focused tab left / right. */
  moveKeys: readonly [string, string];
  moveHint: string;
  /** Tooltip of the account badge. */
  account: string;
}

/** i18n: getters, read at render in the current language. */
export const defaultProjectTabsText: ProjectTabsText = {
  get label() {
    return t("workbench.projectTabs.label");
  },
  close: (title) => t("workbench.projectTabs.close", { title }),
  moveKeys: ["Alt+Shift+ArrowLeft", "Alt+Shift+ArrowRight"],
  get moveHint() {
    return t("workbench.projectTabs.moveHint");
  },
  get account() {
    return t("workbench.projectTabs.account");
  },
};

const MIDDLE_BUTTON = 1;
type KeyLike = Pick<KeyboardEvent, "key" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">;

/** Whether a key event is exactly `combo` ("Alt+Shift+ArrowLeft": these modifiers and no others). */
export function matchesKeys(e: KeyLike, combo: string): boolean {
  const parts = combo.split("+");
  const key = parts.at(-1);
  const mods = new Set(parts.slice(0, -1));
  return (
    e.key === key &&
    e.altKey === mods.has("Alt") &&
    e.shiftKey === mods.has("Shift") &&
    e.ctrlKey === mods.has("Control") &&
    e.metaKey === mods.has("Meta")
  );
}

export interface ProjectTabsProps {
  items: readonly ProjectTabItem[];
  active: string | null;
  onActivate(projectId: string): void;
  onClose(projectId: string): void;
  /** Move a tab to `index` of the strip. */
  onMove(projectId: string, index: number): void;
  /** The pointer entered a tab's account badge (time to fetch fresh usage numbers for its tooltip). */
  onAccountHover?(projectId: string): void;
  text?: ProjectTabsText;
}

export function ProjectTabs({ items, active, onActivate, onClose, onMove, onAccountHover, text = defaultProjectTabsText }: ProjectTabsProps) {
  useT(); // re-render on a language switch (the default texts are read at render)
  const dragged = useRef<string | null>(null);
  if (items.length === 0) return null;
  const [leftKeys, rightKeys] = text.moveKeys;

  const onKeyDown = (e: KeyboardEvent, index: number, projectId: string): void => {
    const delta = matchesKeys(e, leftKeys) ? -1 : matchesKeys(e, rightKeys) ? 1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const to = index + delta;
    if (to >= 0 && to < items.length) onMove(projectId, to);
  };

  return (
    <div className="kp-ptabs" role="toolbar" aria-label={text.label} title={text.moveHint}>
      {items.map((item, index) => {
        const isActive = item.projectId === active;
        return (
          <div
            key={item.projectId}
            className={isActive ? "kp-ptab kp-ptab--active" : "kp-ptab"}
            data-project-id={item.projectId}
            draggable
            onDragStart={(e) => {
              dragged.current = item.projectId;
              e.dataTransfer?.setData("text/plain", item.projectId);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => (dragged.current = null)}
            onDragOver={(e) => {
              if (dragged.current !== null) e.preventDefault();
            }}
            onDrop={(e) => {
              const from = dragged.current;
              dragged.current = null;
              if (from === null) return;
              e.preventDefault();
              if (from !== item.projectId) onMove(from, index);
            }}
            onMouseDown={(e) => {
              // No autoscroll cursor on middle-click.
              if (e.button === MIDDLE_BUTTON) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== MIDDLE_BUTTON) return;
              e.preventDefault();
              onClose(item.projectId);
            }}
          >
            <button
              type="button"
              className="kp-ptab__main"
              aria-current={isActive ? "page" : undefined}
              aria-keyshortcuts={`${leftKeys} ${rightKeys}`}
              title={item.location}
              onClick={() => onActivate(item.projectId)}
              onKeyDown={(e) => onKeyDown(e, index, item.projectId)}
            >
              {item.title}
            </button>
            {item.accountName !== undefined && (
              <span
                className="kp-account-badge kp-ptab__account"
                title={item.accountUsage !== undefined ? `${text.account}\n${item.accountUsage}` : text.account}
                onMouseEnter={onAccountHover ? () => onAccountHover(item.projectId) : undefined}
              >
                {item.accountName}
              </span>
            )}
            <AgentCounter projectName={item.title} count={item.count} />
            <button
              type="button"
              className="kp-ptab__close"
              aria-label={text.close(item.title)}
              title={text.close(item.title)}
              onClick={() => onClose(item.projectId)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
