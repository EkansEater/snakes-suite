// Undo and redo. Each step knows how to undo and redo itself; steps with the
// same `key` made within a moment of each other merge into one (typing, nudging).

export class History {
  constructor({ limit = 300, onChange = () => {} } = {}) {
    this.limit = limit;
    this.onChange = onChange;
    this.done = [];
    this.undone = [];
    this.savedAt = 0; // length of `done` when last saved
    this.version = 0;
  }

  /** push({ label, undo, redo, key }) — the change has already been made. */
  push(step) {
    const last = this.done[this.done.length - 1];
    const now = performance.now();
    if (step.key && last && last.key === step.key && now - last.time < 900 && this.savedAt !== this.done.length) {
      last.redo = step.redo;
      last.time = now;
    } else {
      this.done.push({ ...step, time: now });
      if (this.done.length > this.limit) {
        this.done.shift();
        this.savedAt--;
      }
    }
    this.undone = [];
    this.version++;
    this.onChange();
  }

  undo() {
    const s = this.done.pop();
    if (!s) return null;
    s.undo();
    this.undone.push(s);
    this.version++;
    this.onChange();
    return s;
  }

  redo() {
    const s = this.undone.pop();
    if (!s) return null;
    s.redo();
    this.done.push(s);
    this.version++;
    this.onChange();
    return s;
  }

  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
  get undoLabel() { return this.canUndo ? this.done[this.done.length - 1].label : ''; }
  get redoLabel() { return this.canRedo ? this.undone[this.undone.length - 1].label : ''; }
  get dirty() { return this.savedAt !== this.done.length; }

  markSaved() {
    this.savedAt = this.done.length;
    this.onChange();
  }

  clear() {
    this.done = [];
    this.undone = [];
    this.savedAt = 0;
    this.version++;
    this.onChange();
  }

  /** Go back to the state after step `index` of `done` (history panels). */
  jump(index) {
    while (this.done.length > index + 1) this.undo();
    while (this.done.length < index + 1 && this.undone.length) this.redo();
  }
}
