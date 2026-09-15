import { describe, expect, it, vi } from 'vitest';
import { guardRowKeys } from '../dndRowKeys';

/** Stands in for the sortable node the listeners are attached to. */
const rowNode = { tagName: 'DIV' } as unknown as EventTarget;
/** Stands in for a nested control (the inline alias input). */
const inputNode = { tagName: 'INPUT' } as unknown as EventTarget;

function keyEvent(target: EventTarget, currentTarget: EventTarget) {
  return { target, currentTarget, nativeEvent: { code: 'Space' } };
}

describe('guardRowKeys', () => {
  it('passes undefined listeners straight through', () => {
    expect(guardRowKeys(undefined)).toBeUndefined();
  });

  it('leaves listeners without a keydown handler untouched', () => {
    const listeners = { onPointerDown: vi.fn() };
    expect(guardRowKeys(listeners)).toBe(listeners);
  });

  it('forwards the keydown when the sortable node itself is the target', () => {
    const onKeyDown = vi.fn();
    const guarded = guardRowKeys({ onKeyDown })!;

    guarded.onKeyDown(keyEvent(rowNode, rowNode));

    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it('does not forward keys pressed inside a nested control', () => {
    const onKeyDown = vi.fn();
    const guarded = guardRowKeys({ onKeyDown })!;

    // Space in the inline name/alias editor must type a space, not start a drag.
    guarded.onKeyDown(keyEvent(inputNode, rowNode));

    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('keeps the other pointer listeners intact', () => {
    const onPointerDown = vi.fn();
    const guarded = guardRowKeys({ onPointerDown, onKeyDown: vi.fn() })!;

    guarded.onPointerDown();

    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(guarded.onPointerDown).toBe(onPointerDown);
  });

  it('hands the original event to the drag handler', () => {
    const onKeyDown = vi.fn();
    const guarded = guardRowKeys({ onKeyDown })!;
    const event = keyEvent(rowNode, rowNode);

    guarded.onKeyDown(event);

    expect(onKeyDown).toHaveBeenCalledWith(event);
  });
});
