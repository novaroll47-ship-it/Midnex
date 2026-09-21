/**
 * Звезда на экране монеты: монета в списке для торговли и какие боты её
 * ведут. Тот же список, что и галочки в ленте; по умолчанию — все боты.
 */
import { BOT_IDS, type BotId } from '@cs/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { StarIcon } from '../icons';
import { api } from '../lib/api';
import { haptic } from '../lib/telegram';
import { CheckRow } from './Form';
import { Sheet } from './Sheet';
import { Button } from '@/components/ui/button';

export function BotStar({ base }: { base: string }) {
  const { t } = useTranslation();
  const [bots, setBots] = useState<BotId[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .watchlist()
      .then((w) => alive && setBots(w.bots[base] ?? []))
      .catch(() => alive && setBots([]));
    return () => {
      alive = false;
    };
  }, [base]);

  const active = (bots?.length ?? 0) > 0;

  async function save(next: BotId[]) {
    const prev = bots;
    setBots(next);
    setError(null);
    try {
      const w = await api.setWatchBots(base, next);
      setBots(w.bots[base] ?? []);
    } catch (e) {
      setBots(prev);
      setError(e instanceof Error ? e.message : String(e));
      haptic('error');
    }
  }

  const toggle = (id: BotId) => {
    const cur = bots ?? [];
    void save(cur.includes(id) ? cur.filter((b) => b !== id) : [...cur, id]);
  };
  const all = bots !== null && BOT_IDS.every((b) => bots.includes(b));

  return (
    <>
      <button
        type="button"
        className={`icon-btn-round bot-star${active ? ' bot-star--on' : ''}`}
        aria-label={t('botpick.title', { base })}
        aria-pressed={active}
        onClick={() => {
          haptic('tap');
          setOpen(true);
        }}
      >
        <StarIcon size={20} />
      </button>
      {open && (
        <Sheet
          title={t('botpick.title', { base })}
          description={t('botpick.hint')}
          onClose={() => setOpen(false)}
          footer={
            active ? (
              <Button variant="secondary" onClick={() => void save([]).then(() => setOpen(false))}>
                {t('botpick.remove')}
              </Button>
            ) : undefined
          }
        >
          <section className="card list">
            <CheckRow
              title={t('botpick.all')}
              sub={t('botpick.allSub')}
              checked={all}
              onToggle={() => void save(all ? [] : [...BOT_IDS])}
            />
            {BOT_IDS.map((id) => (
              <CheckRow
                key={id}
                title={t(id === 'spread' ? 'bots.spreadName' : 'bots.fundingName')}
                sub={t(id === 'spread' ? 'botpick.spreadSub' : 'botpick.fundingSub')}
                checked={bots?.includes(id) ?? false}
                onToggle={() => toggle(id)}
              />
            ))}
          </section>
          {error && <section className="card notice notice--warn">{error}</section>}
        </Sheet>
      )}
    </>
  );
}
