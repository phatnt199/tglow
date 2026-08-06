import type { IFolderRow } from '../../core/cache/index.ts';
import type { ITokens } from '../theme/index.ts';
import { padStartToWidth, padToWidth, truncateToWidth } from '../text-width.ts';

export interface IFolderRailProps {
  folders: IFolderRow[];
  activeFolderId: number;
  /** Unread totals per folder, so the rail can carry the badge the reference client shows. */
  unreadByFolder: Map<number, number>;
  tokens: ITokens;
  width: number;
  height: number;
}

/** Right-aligned, and absent entirely at zero -- the same convention the chat list's own badge follows. */
const BADGE_WIDTH = 4;
const MARKER = '▎';
const MARKER_WIDTH = 1;

const formatBadge = (opts: { unreadCount: number }): string => {
  const { unreadCount } = opts;
  if (unreadCount <= 0) {
    return '';
  }
  return unreadCount > 999 ? '999+' : String(unreadCount);
};

/**
 * The folder rail: Telegram's own chat folders down the left edge, the way
 * every graphical client shows them.
 *
 * Text, not icons. The reference client draws a glyph per folder from its own
 * icon set; a terminal has the folder's emoticon at best, and a name always --
 * and a name is what you can actually read at a glance in a column this narrow.
 * The emoticon is shown when the folder carries one and there is room, because
 * it is the thing the eye finds first in a list of similar words.
 *
 * The active folder is marked the same way the open chat is in the chat list --
 * a bar in column zero -- rather than by a background, so "which folder am I
 * in" and "which row is the cursor on" stay visually distinct concepts. The
 * rail has no cursor of its own: it is moved through with a key that changes
 * the selection directly.
 */
export const FolderRail = (props: IFolderRailProps) => {
  const { folders, activeFolderId, unreadByFolder, tokens, width, height } = props;

  const labelWidth = Math.max(1, width - MARKER_WIDTH - BADGE_WIDTH);

  return (
    <box flexDirection="column" width={width} height={height} flexShrink={0}>
      {folders.slice(0, height).map(folder => {
        const active = folder.id === activeFolderId;
        const unread = unreadByFolder.get(folder.id) ?? 0;
        const label = folder.emoticon ? `${folder.emoticon} ${folder.title}` : folder.title;

        return (
          <text key={folder.id} height={1} flexShrink={0}>
            <span fg={tokens.chatActive}>{active ? MARKER : ' '}</span>
            <span fg={active ? tokens.foreground : tokens.dim}>
              {padToWidth({ text: truncateToWidth({ text: label, width: labelWidth }), width: labelWidth })}
            </span>
            <span fg={tokens.chatUnread}>
              {padStartToWidth({ text: formatBadge({ unreadCount: unread }), width: BADGE_WIDTH })}
            </span>
          </text>
        );
      })}
    </box>
  );
};
