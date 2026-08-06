/**
 * "typing…", "recording a voice message", "choosing a sticker" -- what the
 * other side is doing right now, which Telegram sends as a `SendMessageAction`
 * riding on one of three typing updates.
 *
 * Phrases are written the way the graphical clients word them, in the present
 * participle, because they are read as a continuation of the person's name:
 * "Alice is typing…", "Alice is choosing a sticker".
 */

export interface ITypingStatus {
  /** The chat it belongs to -- the peer whose row and header should show it. */
  peerId: string;
  /** Who is doing it. Equal to peerId in a private chat, a group member otherwise. */
  actorId: string;
  /** Null cancels: SendMessageCancelAction means "stopped", not "is cancelling". */
  phrase: string | null;
}

/**
 * How long a status survives without renewal.
 *
 * Telegram's own clients re-send an action every few seconds while it
 * continues, and treat one as stale after roughly six. Without an expiry a
 * "typing…" left by someone who closed their app would sit in the sidebar
 * forever, which is worse than never showing it -- it is a claim about the
 * present that quietly becomes false.
 */
export const TYPING_STATUS_TTL_MS = 6_000;

/**
 * Class name to phrase. Read off the constructors teleproto actually ships
 * (seventeen of them) rather than guessed, the same discipline every other
 * shape in this project was pinned with.
 *
 * An unrecognised action becomes a generic "…", never null and never a throw:
 * Telegram adds action types, and a client that crashed or fell silent on a
 * new one would be worse than one that says something vague.
 */
const PHRASES: Readonly<Record<string, string>> = {
  SendMessageTypingAction: 'typing…',
  SendMessageRecordVideoAction: 'recording a video',
  SendMessageUploadVideoAction: 'sending a video',
  SendMessageRecordAudioAction: 'recording a voice message',
  SendMessageUploadAudioAction: 'sending a voice message',
  SendMessageUploadPhotoAction: 'sending a photo',
  SendMessageUploadDocumentAction: 'sending a file',
  SendMessageGeoLocationAction: 'sharing a location',
  SendMessageChooseContactAction: 'sharing a contact',
  SendMessageGamePlayAction: 'playing a game',
  SendMessageRecordRoundAction: 'recording a video message',
  SendMessageUploadRoundAction: 'sending a video message',
  SendMessageHistoryImportAction: 'importing history',
  SendMessageChooseStickerAction: 'choosing a sticker',
};

/**
 * Deliberately absent from PHRASES, because neither is something to announce:
 *
 * - `SendMessageCancelAction` is the *stop* signal, and resolves to null.
 * - The draft actions fire while someone types into a draft they have not sent
 *   and may never send. Announcing those would report on a message that does
 *   not exist yet, which the official clients also decline to show.
 */
const SILENT_ACTIONS: readonly string[] = [
  'SendMessageCancelAction',
  'SendMessageTextDraftAction',
  'SendMessageRichMessageDraftAction',
];

const UNKNOWN_ACTION_PHRASE = '…';

export const resolveTypingPhrase = (opts: { className: string }): string | null => {
  const { className } = opts;
  if (SILENT_ACTIONS.includes(className)) {
    return null;
  }
  return PHRASES[className] ?? UNKNOWN_ACTION_PHRASE;
};

export interface IActiveTyping {
  actorId: string;
  phrase: string;
  /** Epoch milliseconds after which this is stale and must not be drawn. */
  expiresAt: number;
}

/**
 * What the status line and sidebar should say for a chat, or null.
 *
 * Expiry is checked on read as well as cleared on a timer, so a status can
 * never outlive its welcome even if the timer that was meant to clear it never
 * ran -- a suspended laptop, say, where the timeout fires late or not at all.
 */
export const readTypingStatus = (opts: {
  typing: Map<string, IActiveTyping>;
  peerId: string;
  now: number;
}): IActiveTyping | null => {
  const entry = opts.typing.get(opts.peerId);
  if (!entry || entry.expiresAt <= opts.now) {
    return null;
  }
  return entry;
};
