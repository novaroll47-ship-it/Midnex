/**
 * Периодический опрос бэкенда.
 *
 * На M2 это заменится подпиской на WebSocket — сигнатура хука останется той же,
 * поэтому экраны переписывать не придётся. Опрос ставится на паузу, когда
 * вкладка скрыта: гонять сеть в фоне на телефоне смысла нет.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
}

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled = true,
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  // Держим последнюю версию fetcher в ref, чтобы смена замыкания
  // не перезапускала таймер на каждом рендере.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    try {
      const next = await fetcherRef.current();
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      void run();
      timer = setInterval(() => void run(), intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else if (!timer) start();
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [run, intervalMs, enabled]);

  return { data, error, loading, refresh: () => void run() };
}
