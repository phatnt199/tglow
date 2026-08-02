import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService, IApplicationState } from './application-store.ts';
import type { DatabaseService, IMessageRow } from './cache/index.ts';
import type { IMessageAdapter, IRawMessage } from './message-service.ts';

// Mirrors MessageService's SEND_REFRESH_LIMIT and main.ts's HISTORY_LIMIT: the
// page size a live republish shows. UpdateService cannot see the limit
// MessageService's own loadHistory() was last called with -- that is private
// state on a different instance -- so it keeps its own, generous enough for a
// single screen of history.
const MESSAGE_REFRESH_LIMIT = 200;

export class UpdateService {
  private readonly _logger: ILogger = ApplicationLogger.get(UpdateService.name);

  constructor(
    @inject({ key: BindingKeys.MESSAGE_ADAPTER }) private readonly _adapter: IMessageAdapter,
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
    @inject({ key: BindingKeys.APPLICATION_STORE }) private readonly _store: ApplicationStoreService,
  ) {}

  /** The cache returns newest-first; a chat reads oldest-first -- same convention as MessageService.forDisplay. */
  private forDisplay = (opts: { rows: IMessageRow[] }): IMessageRow[] => {
    return [...opts.rows].reverse();
  };

  /**
   * Bumps the message's chat to the top of the dialog list and reflects it in
   * the unread count, using whatever dialog row is already cached (or the
   * zero-valued defaults a chat that has never had a dialogs row would have)
   * as the baseline. Own messages -- out, whether sent from this device or
   * another -- never count as unread, matching Telegram's own convention.
   */
  private touchDialog = (message: IRawMessage): void => {
    const existing = this._database.listDialogs().find(dialog => dialog.peerId === message.peerId);
    this._database.upsertDialog({
      peerId: message.peerId,
      pinned: existing?.pinned ?? 0,
      unreadCount: message.out ? (existing?.unreadCount ?? 0) : (existing?.unreadCount ?? 0) + 1,
      lastMessageAt: message.date,
      topMessageId: message.id,
    });
  };

  private handleMessage = (message: IRawMessage): void => {
    try {
      // Always, whatever chat it belongs to -- the cache is the only place
      // de-duplication happens, and the chat-list refresh below depends on
      // this having already run.
      this._database.insertMessages({
        messages: [{
          peerId: message.peerId,
          id: message.id,
          fromId: message.fromId,
          date: message.date,
          text: message.text,
          out: message.out,
        }],
      });
      this.touchDialog(message);

      const state = this._store.getState();
      const patch: Partial<IApplicationState> = { dialogs: this._database.listDialogs() };

      if (message.peerId === state.activePeerId) {
        // Republished from the cache rather than appended to state.messages:
        // a message can arrive mid-loadHistory, and only a cache read keeps
        // ordering and de-duplication correct in that race.
        const nextMessages = this.forDisplay({
          rows: this._database.listMessages({ peerId: message.peerId, limit: MESSAGE_REFRESH_LIMIT }),
        });

        // Follow-if-at-newest: a cursor already on the last message is being
        // used to read live, like a tailing log, so it moves to keep showing
        // the newest arrival. Any other position means the user is reading
        // back through history; the new message is appended after the
        // cursor, so leaving the index untouched leaves it on the same
        // message it was on. `>=` (not `===`) also covers the empty-history
        // case -- messageCursor's initial 0 with zero messages should still
        // count as "at the newest" and follow.
        const wasAtNewest = state.messageCursor >= state.messages.length - 1;
        patch.messages = nextMessages;
        patch.messageCursor = wasAtNewest ? Math.max(nextMessages.length - 1, 0) : state.messageCursor;
      }

      this._store.setState({ patch });
    } catch (error) {
      // This runs on GramJS's event loop, invoked outside any promise chain
      // tglow controls. An error escaping here is not caught by anything
      // upstream -- it becomes an unhandled rejection and ends the process,
      // the same failure mode App's `void onSend(...).catch(...)` exists to
      // avoid on the send path.
      this._logger.for(this.handleMessage.name).error('Could not handle live message | Reason: %s', error);
    }
  };

  start = (): (() => void) => {
    return this._adapter.subscribeToNewMessages({ onMessage: this.handleMessage });
  };
}
