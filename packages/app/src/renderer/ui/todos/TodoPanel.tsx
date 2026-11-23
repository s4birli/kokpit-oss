// Yapılacaklar: one day's list (add, check, edit, delete, reorder, project tag) and the day's note.
// The engine keeps everything and decides which day is today; other windows update through events.
import type { Project, Todo } from "@kokpit/shared";
import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { EngineClient } from "../../engine/types.ts";
import { useT, type MessageKey } from "../../../i18n/index.ts";
import { defaultTodoUiConfig } from "./config.ts";
import { daysBetween, formatDay, relativeDayName, shiftDate } from "./dates.ts";
import { useDayNote, type NoteStatus } from "./useDayNote.ts";
import { useTodos } from "./useTodos.ts";
import "./todos.css";
import { copyValue } from "../copy-menu.ts";

export interface TodoPanelProps {
  client: EngineClient;
  /** Projects a todo can be tagged with. */
  projects: readonly Project[];
  noteDebounceMs?: number;
  className?: string;
}

const DRAG_TYPE = "text/plain";

const NOTE_STATUS: Record<Exclude<NoteStatus, "idle">, MessageKey> = {
  saving: "todos.note.saving",
  saved: "todos.note.saved",
  error: "todos.note.error",
};

export function TodoPanel(props: TodoPanelProps) {
  const { client, projects, className } = props;
  const noteDebounceMs = props.noteDebounceMs ?? defaultTodoUiConfig.noteDebounceMs;
  const t = useT();
  const headingId = useId();
  const noteId = useId();
  /** null = the engine's today. */
  const [viewDate, setViewDate] = useState<string | null>(null);
  const todos = useTodos(client, viewDate);
  const note = useDayNote(client, todos.date, noteDebounceMs);
  const { date, today } = todos;

  const go = (days: number) => {
    // From the day asked for, not the one loaded, so quick repeated clicks add up.
    const base = viewDate ?? today;
    if (base === undefined) return;
    const next = shiftDate(base, days);
    setViewDate(next === today ? null : next);
  };

  const isPast = date !== undefined && today !== undefined && date < today;
  const relative = date !== undefined && today !== undefined ? relativeDayName(date, today) : null;
  const longDate = date !== undefined ? formatDay(date) : "";

  return (
    <section className={`kp-panel kp-todo${className ? ` ${className}` : ""}`} aria-labelledby={headingId}>
      <header className="kp-panel__head">
        <h3 id={headingId} className="kp-panel__title">
          {t("todos.title")}
        </h3>
        <div className="kp-panel__actions">
          {viewDate !== null && (
            <button type="button" className="kp-btn kp-btn--quiet" onClick={() => setViewDate(null)}>
              {t("todos.backToToday")}
            </button>
          )}
          <button type="button" className="kp-btn kp-btn--icon" aria-label={t("todos.previousDay")} onClick={() => go(-1)}>
            ‹
          </button>
          <button type="button" className="kp-btn kp-btn--icon" aria-label={t("todos.nextDay")} onClick={() => go(1)}>
            ›
          </button>
        </div>
      </header>
      <div className="kp-todo__body">
        <p className="kp-todo__day" data-testid="todo-day" aria-live="polite">
          {relative ? `${relative} · ${longDate}` : longDate}
        </p>

        {isPast ? (
          <p className="kp-todo__hint">{t("todos.pastDayHint")}</p>
        ) : (
          <AddTodo projects={projects} onAdd={todos.create} />
        )}

        {todos.error && (
          <p role="alert" className="kp-error">
            {todos.error}
          </p>
        )}

        <TodoList
          date={date}
          todos={todos.todos}
          projects={projects}
          onUpdate={todos.update}
          onMove={todos.move}
          onRemove={todos.remove}
        />

        <div className="kp-field kp-todo__note">
          <span className="kp-todo__note-head">
            <label htmlFor={noteId} className="kp-field__label">
              {t("todos.note.label")}
            </label>
            <span className="kp-todo__note-status" aria-live="polite">
              {note.status === "error" && note.error
                ? `${t(NOTE_STATUS.error)}: ${note.error}`
                : note.status === "idle"
                  ? ""
                  : t(NOTE_STATUS[note.status])}
            </span>
          </span>
          <textarea
            id={noteId}
            className="kp-input kp-todo__textarea"
            value={note.text}
            disabled={date === undefined}
            onChange={(e) => note.change(e.target.value)}
          />
        </div>
      </div>
    </section>
  );
}

// ---------- add ----------

function AddTodo({ projects, onAdd }: { projects: readonly Project[]; onAdd(text: string, projectId?: string): Promise<void> }) {
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState("");
  const t = useT();
  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    setText("");
    void onAdd(trimmed, projectId === "" ? undefined : projectId);
  };
  return (
    <div className="kp-todo__add">
      <input
        className="kp-input kp-todo__add-input"
        aria-label={t("todos.add.label")}
        placeholder={t("todos.add.placeholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <ProjectSelect
        label={t("todos.add.project")}
        projects={projects}
        value={projectId}
        onChange={setProjectId}
      />
    </div>
  );
}

function ProjectSelect(props: { label: string; projects: readonly Project[]; value: string; onChange(id: string): void }) {
  const { label, projects, value, onChange } = props;
  const t = useT();
  const known = value === "" || projects.some((p) => p.id === value);
  return (
    <select className="kp-input kp-todo__project" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("todos.project.none")}</option>
      {!known && <option value={value}>{t("todos.project.deleted")}</option>}
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

// ---------- list ----------

interface TodoListProps {
  date: string | undefined;
  todos: Todo[];
  projects: readonly Project[];
  onUpdate(patch: { id: string; text?: string; done?: boolean; projectId?: string | null }): Promise<void>;
  onMove(id: string, to: number): Promise<void>;
  onRemove(id: string): Promise<void>;
}

function TodoList({ date, todos, projects, onUpdate, onMove, onRemove }: TodoListProps) {
  const t = useT();
  const items = useRef(new Map<string, HTMLLIElement>());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (focusId === null) return;
    items.current.get(focusId)?.focus();
    setFocusId(null);
  }, [focusId, todos]);

  const move = (id: string, to: number) => {
    if (to < 0 || to >= todos.length) return;
    setFocusId(id);
    void onMove(id, to);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, id: string, index: number) => {
    if (e.target !== e.currentTarget || !e.altKey) return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      move(id, index - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(id, index + 1);
    }
  };

  const onDrop = (e: DragEvent<HTMLLIElement>, index: number) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (id && todos.some((t) => t.id === id)) move(id, index);
  };

  if (todos.length === 0) {
    return (
      <>
        <ul className="kp-todo__list" aria-label={t("todos.list.label")} data-date={date} />
        <p className="kp-todo__hint">{t("todos.list.empty")}</p>
      </>
    );
  }

  return (
    <ul className="kp-todo__list" aria-label={t("todos.list.label")} data-date={date}>
      {todos.map((todo, index) => (
        <li
          key={todo.id}
          ref={(el) => {
            if (el) items.current.set(todo.id, el);
            else items.current.delete(todo.id);
          }}
          className={`kp-todo__item${todo.done ? " kp-todo__item--done" : ""}`}
          data-text={todo.text}
          {...copyValue(todo.text)}
          tabIndex={0}
          aria-label={t("todos.item.label", { text: todo.text })}
          draggable={editing !== todo.id}
          onKeyDown={(e) => onKeyDown(e, todo.id, index)}
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, todo.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => onDrop(e, index)}
        >
          <TodoRow
            todo={todo}
            first={index === 0}
            last={index === todos.length - 1}
            projects={projects}
            editing={editing === todo.id}
            onEdit={(on) => setEditing(on ? todo.id : null)}
            onUpdate={onUpdate}
            onMove={(delta) => move(todo.id, index + delta)}
            onRemove={() => void onRemove(todo.id)}
          />
        </li>
      ))}
    </ul>
  );
}

interface TodoRowProps {
  todo: Todo;
  first: boolean;
  last: boolean;
  projects: readonly Project[];
  editing: boolean;
  onEdit(on: boolean): void;
  onUpdate: TodoListProps["onUpdate"];
  onMove(delta: number): void;
  onRemove(): void;
}

function TodoRow({ todo, first, last, projects, editing, onEdit, onUpdate, onMove, onRemove }: TodoRowProps) {
  const t = useT();
  const [draft, setDraft] = useState(todo.text);
  const project = projects.find((p) => p.id === todo.projectId);

  const startEdit = () => {
    setDraft(todo.text);
    onEdit(true);
  };
  const saveText = () => {
    const trimmed = draft.trim();
    onEdit(false);
    if (trimmed !== "" && trimmed !== todo.text) void onUpdate({ id: todo.id, text: trimmed });
  };

  return (
    <>
      <input
        type="checkbox"
        className="kp-todo__check"
        aria-label={todo.text}
        checked={todo.done}
        onChange={(e) => void onUpdate({ id: todo.id, done: e.target.checked })}
      />
      {editing ? (
        <span className="kp-todo__edit">
          <input
            className="kp-input kp-todo__edit-input"
            aria-label={t("todos.item.editText", { text: todo.text })}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                saveText();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onEdit(false);
              }
            }}
          />
          <ProjectSelect
            label={t("todos.item.project", { text: todo.text })}
            projects={projects}
            value={todo.projectId ?? ""}
            onChange={(id) => void onUpdate({ id: todo.id, projectId: id === "" ? null : id })}
          />
          <button type="button" className="kp-btn kp-btn--primary" onClick={saveText}>
            {t("todos.item.save")}
          </button>
          <button type="button" className="kp-btn kp-btn--quiet" onClick={() => onEdit(false)}>
            {t("todos.item.cancel")}
          </button>
        </span>
      ) : (
        <span className="kp-todo__text" onDoubleClick={startEdit}>
          {todo.text}
          {project && <span className="kp-todo__tag">{project.name}</span>}
          {todo.rolledFrom && (
            <span className="kp-todo__badge" title={t("todos.item.rolledFrom", { date: formatDay(todo.rolledFrom) })}>
              {daysBetween(todo.rolledFrom, todo.date) === 1 ? t("todos.item.fromYesterday") : t("todos.item.fromEarlier")}
            </span>
          )}
        </span>
      )}
      <span className="kp-todo__actions">
        {!editing && (
          <button type="button" className="kp-btn kp-btn--quiet" aria-label={t("todos.item.edit", { text: todo.text })} onClick={startEdit}>
            ✎
          </button>
        )}
        <button
          type="button"
          className="kp-btn kp-btn--quiet"
          aria-label={t("todos.item.moveUp", { text: todo.text })}
          disabled={first}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="kp-btn kp-btn--quiet"
          aria-label={t("todos.item.moveDown", { text: todo.text })}
          disabled={last}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button type="button" className="kp-btn kp-btn--quiet" aria-label={t("todos.item.delete", { text: todo.text })} onClick={onRemove}>
          ✕
        </button>
      </span>
    </>
  );
}
