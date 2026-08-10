/**
 * The screenshot in the README, rendered rather than photographed.
 *
 * It goes through the real App, the real theme and the real renderer, and the
 * conversations in it are invented. That combination is the point: a capture
 * of the author's own running tglow would be a picture of somebody's private
 * Telegram, and a hand-drawn mock-up would be a picture of nothing. This is
 * the actual component tree, laid out by the actual layout code, with the
 * colours the palette actually produces -- read back per span, not guessed.
 *
 * Output is SVG rather than PNG: the glyphs stay text, so it scales, weighs
 * kilobytes, and can be diffed when the interface changes.
 *
 *   bun run scripts/screenshot.tsx docs/screenshot.svg
 */
import { Container, BindingScopes } from '@venizia/ignis-inversion';
import { rgbToHex } from '@opentui/core';
import { writeFileSync } from 'node:fs';

import { BindingKeys } from '../src/common/index.ts';
import { ApplicationStoreService } from '../src/core/application-store.ts';
import { createPane } from '../src/core/conversation-panes.ts';
import type { IDialogRow, IMessageRow } from '../src/core/cache/database.ts';
import { KeyNormalizerService } from '../src/keys/key-normalizer.ts';
import { KeymapService } from '../src/keys/keymap.ts';
import { VimEngineService } from '../src/keys/vim-engine.ts';
import { MessageSearchService } from '../src/core/message-search.ts';
import { buildTokens } from '../src/tui/theme/index.ts';
import { App } from '../src/tui/app.tsx';
import { renderWithKeys } from '../src/__tests__/helpers/render.tsx';

/**
 * A fixed morning, so the picture is the same every time it is generated.
 * 09:12 local on the machine that renders it -- the times are decoration, and
 * a screenshot that changed on every run would be a diff nobody could read.
 */
const AT = 1_786_327_920;

const COLUMNS = 108;
const ROWS = 30;
const CELL_WIDTH = 8.4;
const CELL_HEIGHT = 18;
const FONT_SIZE = 14;

const dialog = (opts: Partial<IDialogRow> & { peerId: string; title: string }): IDialogRow => ({
  pinned: 0, unreadCount: 0, lastMessageAt: 0, topMessageId: 0,
  readOutboxMaxId: 0, readInboxMaxId: 0, preview: null, ...opts,
});

const message = (opts: Partial<IMessageRow> & { id: number; text: string }): IMessageRow => ({
  peerId: 'alice', fromId: 'alice', date: 0, out: 0, entities: [], replyToMessageId: null,
  pinned: 0, media: null, reactions: [], ...opts,
});

const DIALOGS: IDialogRow[] = [
  dialog({ peerId: 'alice', title: 'Alice', lastMessageAt: AT + 1_140, topMessageId: 15, preview: 'merged — thanks' }),
  dialog({ peerId: 'general', title: '#general', lastMessageAt: AT + 900, topMessageId: 88, unreadCount: 2, preview: 'lee: done' }),
  dialog({ peerId: 'releases', title: '#releases', lastMessageAt: AT - 1_800, topMessageId: 12, preview: 'v0.5.0 tagged' }),
  dialog({ peerId: 'dana', title: 'Dana', lastMessageAt: AT - 5_400, topMessageId: 4, unreadCount: 1, preview: 'see you there' }),
];

const CONVERSATION: IMessageRow[] = [
  message({ id: 11, date: AT, text: 'the branch is green — CI finally agrees with us' }),
  message({ id: 12, date: AT + 120, text: 'that took a while', out: 1, fromId: 'me' }),
  message({ id: 13, date: AT + 300, text: 'it did. the flake was the pty test all along', reactions: [{ emoji: '😅', count: 1, chosen: false }] as never }),
  message({ id: 14, date: AT + 900, text: 'nice. merging it now, then tagging v0.5.0', out: 1, fromId: 'me' }),
  message({ id: 15, date: AT + 1_140, text: 'merged — thanks' }),
];

const SIDE: IMessageRow[] = [
  message({ id: 86, peerId: 'general', date: AT + 240, fromId: 'dana', text: 'ship it when you are ready' }),
  message({ id: 87, peerId: 'general', date: AT + 600, fromId: 'lee', text: 'release notes are written' }),
  message({ id: 88, peerId: 'general', date: AT + 900, fromId: 'lee', text: 'done' }),
];

const noop = async (): Promise<void> => {};

const main = async (): Promise<void> => {
  const output = process.argv[2] ?? 'docs/screenshot.svg';
  const container = new Container({ scope: 'Screenshot' });
  container.bind({ key: BindingKeys.KEY_NORMALIZER }).toClass(KeyNormalizerService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.VIM_ENGINE }).toClass(VimEngineService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.KEYMAP }).toClass(KeymapService).setScope(BindingScopes.SINGLETON);

  const tokens = buildTokens({ paletteName: 'sage' });
  const store = new ApplicationStoreService();
  store.setState({
    patch: {
      dialogs: DIALOGS,
      messages: CONVERSATION,
      activePeerId: 'alice',
      messageCursor: CONVERSATION.length - 1,
      chatCursor: 0,
      connection: 'connected',
      // Two conversations, which is what the split is for -- and the reason
      // this picture is worth taking at all.
      paneGrid: [
        [{ ...createPane({ peerId: 'alice' }), messages: CONVERSATION, messageCursor: CONVERSATION.length - 1 }],
        [{ ...createPane({ peerId: 'general' }), messages: SIDE, messageCursor: SIDE.length - 1 }],
      ],
      activePane: { column: 0, row: 0 },
      // Without these the status line calls everyone a bot, which is what it
      // does for a peer it knows nothing about.
      peerKinds: new Map([
        ['alice', { type: 'user', isBot: false }],
        ['general', { type: 'channel', isBot: false }],
        ['releases', { type: 'channel', isBot: false }],
        ['dana', { type: 'user', isBot: false }],
      ]),
      presenceByPeer: new Map([['alice', { kind: 'online', at: null }]]),
      conversationWidth: COLUMNS,
      conversationHeight: ROWS,
    },
  });

  const renderer = await renderWithKeys(
    <App
      store={store}
      engine={container.get<VimEngineService>({ key: BindingKeys.VIM_ENGINE })}
      keymapService={container.get<KeymapService>({ key: BindingKeys.KEYMAP })}
      keyNormalizer={container.get<KeyNormalizerService>({ key: BindingKeys.KEY_NORMALIZER })}
      timeoutMilliseconds={400}
      tokens={tokens}
      resolveSenderName={(opts: { fromId: string | null }) =>
        ({ alice: 'Alice', me: 'me', dana: 'dana', lee: 'lee' }[opts.fromId ?? ''] ?? 'someone')}
      messageSearchService={new MessageSearchService()}
      onSend={noop} onEdit={noop} onDelete={noop} onPin={noop} onLoadOlder={noop}
      onLogout={noop} onPinChat={noop} onReact={noop} onForward={noop} onSendFile={noop}
      onThumbnail={async () => null} onOpenMedia={noop} onQuit={() => {}}
      onOpenChat={noop} onMarkRead={noop}
    />,
    { width: COLUMNS, height: ROWS },
  );
  await renderer.flush();

  const { lines } = renderer.captureSpans();
  const width = Math.ceil(COLUMNS * CELL_WIDTH);
  const height = Math.ceil(ROWS * CELL_HEIGHT);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${FONT_SIZE}">`,
    `<rect width="${width}" height="${height}" rx="8" fill="${tokens.background}"/>`,
  ];

  const escape = (text: string): string =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

  lines.forEach((line, row) => {
    let column = 0;
    for (const span of line.spans) {
      const text = span.text ?? '';
      if (text.length === 0) {
        continue;
      }
      const background = rgbToHex(span.bg);
      // Only where it differs from the page: a rect per span would be
      // thousands of identical rectangles the size of the whole frame.
      if (background.toLowerCase() !== tokens.background.toLowerCase()) {
        parts.push(`<rect x="${(column * CELL_WIDTH).toFixed(1)}" y="${(row * CELL_HEIGHT).toFixed(1)}" width="${(text.length * CELL_WIDTH).toFixed(1)}" height="${CELL_HEIGHT}" fill="${background}"/>`);
      }
      if (text.trim() !== '') {
        parts.push(`<text x="${(column * CELL_WIDTH).toFixed(1)}" y="${(row * CELL_HEIGHT + FONT_SIZE).toFixed(1)}" fill="${rgbToHex(span.fg)}" xml:space="preserve">${escape(text)}</text>`);
      }
      column += text.length;
    }
  });

  parts.push('</svg>');
  writeFileSync(output, parts.join('\n'));
  console.log(`${output} — ${lines.length} rows, ${COLUMNS} columns`);
  process.exit(0);
};

await main();
