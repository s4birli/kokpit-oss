// Tunables of the Yapılacaklar panel.

export interface TodoUiConfig {
  /** Quiet time after the last keystroke before the day note is saved. */
  noteDebounceMs: number;
}

export const defaultTodoUiConfig: TodoUiConfig = {
  noteDebounceMs: 600,
};
