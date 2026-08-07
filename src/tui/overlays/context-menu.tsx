import type { IMenuItem } from '../context-menu.ts';
import { padToWidth, padStartToWidth } from '../text-width.ts';
import type { ITokens } from '../theme/index.ts';

export interface IContextMenuProps {
  items: IMenuItem[];
  cursor: number;
  tokens: ITokens;
  width: number;
  /** Chosen by pressing Enter, or by clicking the row. */
  onChoose?: (opts: { index: number }) => void;
}

/**
 * The right-click menu.
 *
 * Drawn as a plain list rather than a bordered popup: it sits over the
 * conversation, and a border here would be the third kind of box on screen
 * after the frame and the pre-block rule. The cursorline carries which row is
 * selected, exactly as it does in both panes.
 *
 * Each row shows the key that does the same thing. That is not decoration --
 * a menu whose items are all reachable by key should say so, or the keys stay
 * invisible to whoever found the menu first.
 */
export const ContextMenu = (props: IContextMenuProps) => {
  const { items, cursor, tokens, width, onChoose } = props;

  return (
    <box flexDirection="column" width={width} flexShrink={0} backgroundColor={tokens.background}>
      {items.map((item, index) => {
        const selected = index === cursor;
        const keyWidth = Math.max(0, Math.min(item.key.length + 1, width - 2));
        const labelWidth = Math.max(0, width - 2 - keyWidth);

        return (
          <text
            key={item.action}
            height={1}
            flexShrink={0}
            bg={selected ? tokens.messageCursor : undefined}
            onMouseDown={() => { onChoose?.({ index }); }}
          >
            <span fg={tokens.border}>{' '}</span>
            <span fg={selected ? tokens.foreground : tokens.dim}>
              {padToWidth({ text: item.label, width: labelWidth })}
            </span>
            <span fg={tokens.dim}>{padStartToWidth({ text: item.key, width: keyWidth })}</span>
            <span fg={tokens.border}>{' '}</span>
          </text>
        );
      })}
    </box>
  );
};
