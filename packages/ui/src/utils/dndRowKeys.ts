/**
 * dndRowKeys.ts
 *
 * dnd-kit wires its KeyboardSensor to `onKeyDown` on the sortable node and
 * starts a keyboard drag on Space/Enter — calling `preventDefault()` first.
 * When the sortable node wraps interactive children (the inline name/alias
 * editors in Manage Channels / Manage Categories and their checkbox, select and
 * button controls), that handler swallowed the key before the field ever saw
 * it: pressing Space in a rename box started a drag instead of typing a space,
 * and Space/Enter on a nested button never activated it.
 *
 * `guardRowKeys` wraps a sortable row's listeners so the keydown is only
 * forwarded when the sortable node itself is the event target. Keyboard
 * dragging still works whenever the row is the focused element, while nested
 * controls keep their own keyboard behaviour.
 */

export type RowListeners = Record<string, Function> | undefined;

interface KeyLike {
  target: unknown;
  currentTarget: unknown;
  [key: string]: unknown;
}

export function guardRowKeys(listeners: RowListeners): RowListeners {
  const onKeyDown = listeners?.onKeyDown;
  if (typeof onKeyDown !== 'function') return listeners;

  return {
    ...listeners,
    onKeyDown: (event: KeyLike) => {
      // Keys pressed inside a descendant belong to that control, not to the drag.
      if (event.target !== event.currentTarget) return;
      onKeyDown(event);
    },
  };
}
