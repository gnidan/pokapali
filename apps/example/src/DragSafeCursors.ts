/**
 * ProseMirror plugin that suppresses y-prosemirror cursor
 * decoration rebuilds during mouse drag, preventing DOM
 * mutations that disrupt native text selection.
 *
 * Root cause: y-prosemirror's cursor plugin dispatches
 * transactions via setTimeout(0) on every awareness change.
 * During drag, each mousemove → selection update →
 * awareness broadcast → queued transaction → decoration
 * rebuild → DOM mutation → broken native selection.
 *
 * Fix: filterTransaction drops cursor-plugin transactions
 * while a mouse button is held. On mouseup, a single
 * rebuild is triggered so remote cursors snap to their
 * final positions.
 */
import { Extension } from "@tiptap/core";
import { Plugin } from "prosemirror-state";
import { yCursorPluginKey } from "y-prosemirror";

let dragging = false;

export const DragSafeCursors = Extension.create({
  name: "dragSafeCursors",

  // Must run before collaborationCursor (priority 999)
  // so our filterTransaction is registered.
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown: (view) => {
              dragging = true;

              const onUp = () => {
                dragging = false;
                document.removeEventListener("mouseup", onUp);

                // Trigger one final cursor decoration
                // rebuild now that the drag is done.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- docView is internal ProseMirror API
                if ((view as any).docView) {
                  const tr = view.state.tr.setMeta(yCursorPluginKey, {
                    awarenessUpdated: true,
                  });
                  view.dispatch(tr);
                }
              };

              document.addEventListener("mouseup", onUp, { once: true });

              // Don't prevent ProseMirror's own handling.
              return false;
            },
          },
        },
        filterTransaction(tr) {
          if (dragging && tr.getMeta(yCursorPluginKey)) {
            return false;
          }
          return true;
        },
      }),
    ];
  },
});
