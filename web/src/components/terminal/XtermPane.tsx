import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalSocketUrl } from '../../lib/ws';
import { subscribeTheme, xtermTheme } from '../../lib/themes';
import { isDoneFlashMuted } from '../../lib/useDoneFlash';

type ConnState = 'connecting' | 'open' | 'reconnecting' | 'ended';

export function XtermPane({ name }: { name: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<ConnState>('connecting');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: 'JetBrains Mono, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      fontWeightBold: '600',
      theme: xtermTheme(),
      scrollback: 5000,
      allowTransparency: false,
    });
    const unsubTheme = subscribeTheme(() => {
      term.options.theme = xtermTheme();
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // a sleeping pane must not steal focus on (re)mount — the pane's
    // focus-within brightness would override its dim
    if (!isDoneFlashMuted(name)) term.focus();

    const encoder = new TextEncoder();
    let ws: WebSocket | null = null;
    let disposed = false;
    let ended = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (disposed || ended) return;
      ws = new WebSocket(terminalSocketUrl(name, term.cols, term.rows));
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        retries = 0;
        setConn('open');
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            if (JSON.parse(ev.data)?.type === 'exit') ended = true;
          } catch { /* not a control frame */ }
        } else {
          term.write(new Uint8Array(ev.data as ArrayBuffer));
        }
      };
      ws.onclose = (ev) => {
        if (disposed) return;
        if (ended || ev.code === 4001 || ev.code === 4002) {
          setConn('ended');
          return;
        }
        setConn('reconnecting');
        retryTimer = setTimeout(connect, Math.min(500 * 2 ** retries++, 8000));
      };
    };
    connect();

    const dataSub = term.onData((d) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(d));
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed) return;
        fit.fit();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      }, 100);
    });
    observer.observe(host);

    return () => {
      disposed = true;
      unsubTheme();
      clearTimeout(retryTimer);
      clearTimeout(resizeTimer);
      observer.disconnect();
      dataSub.dispose();
      ws?.close();
      term.dispose();
    };
  }, [name]);

  return (
    <div className="relative h-full w-full bg-bg py-3 pl-4 pr-2">
      <div ref={hostRef} className="xterm-host" />
      {conn !== 'open' && (
        <div className="absolute right-3 top-2 rounded-md border border-edge bg-surface px-2 py-0.5 text-[11px] text-mut">
          {conn === 'connecting' && 'connecting…'}
          {conn === 'reconnecting' && 'reconnecting…'}
          {conn === 'ended' && 'session ended'}
        </div>
      )}
    </div>
  );
}
