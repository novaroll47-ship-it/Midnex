/**
 * Настройки приложения одним источником правды.
 *
 * Изменения применяются оптимистично — переключатель срабатывает сразу, а
 * ответ сервера потом приводит состояние к каноничному. Если запрос упал,
 * возвращаем прежнее значение и показываем ошибку: молча «откатывать»
 * настройку риска нельзя.
 */
import type { BotSettings, NotificationSettings, PlanId, RiskSettings } from '@cs/shared';
import { useCallback, useEffect, useState } from 'react';

import { api, type SettingsResponse } from './api';

export interface SettingsController {
  data: SettingsResponse | null;
  error: Error | null;
  reload: () => void;
  patchBot: (body: Partial<BotSettings>) => void;
  patchRisk: (body: Partial<RiskSettings>) => void;
  patchNotifications: (body: Partial<NotificationSettings>) => void;
  patchPlan: (plan: PlanId) => void;
  /** Пройденные модули обучения — замена целиком. */
  setOnboarding: (completed: string[]) => void;
}

export function useSettings(): SettingsController {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(() => {
    api
      .settings()
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err : new Error(String(err))));
  }, []);

  useEffect(reload, [reload]);

  // Только секции-объекты: plan и apiKeys обновляются иначе.
  type ObjectSection = 'bot' | 'risk' | 'notifications';

  function apply<K extends ObjectSection>(
    section: K,
    body: Partial<SettingsResponse[K]>,
    send: () => Promise<SettingsResponse>,
  ) {
    const previous = data;
    if (previous) {
      setData({ ...previous, [section]: { ...previous[section], ...body } });
    }
    send()
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (previous) setData(previous);
        setError(err instanceof Error ? err : new Error(String(err)));
      });
  }

  return {
    data,
    error,
    reload,
    patchBot: (body) => apply('bot', body, () => api.patchBot(body)),
    patchRisk: (body) => apply('risk', body, () => api.patchRisk(body)),
    patchNotifications: (body) => apply('notifications', body, () => api.patchNotifications(body)),
    setOnboarding: (completed) => {
      setData((d) => (d ? { ...d, onboarding: { completed } } : d));
      api
        .patchOnboarding(completed)
        .then(setData)
        .catch(() => {});
    },
    patchPlan: (plan) => {
      const previous = data;
      if (previous) setData({ ...previous, plan });
      api
        .patchPlan(plan)
        .then(setData)
        .catch((err: unknown) => {
          if (previous) setData(previous);
          setError(err instanceof Error ? err : new Error(String(err)));
        });
    },
  };
}
