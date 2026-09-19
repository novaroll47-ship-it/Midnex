// Постоянный адрес для вебхука @CryptoBot, пока приложение живёт за
// временным туннелем: CryptoBot шлёт POST сюда, функция пересылает его
// как есть (тело и подпись) на текущий адрес из app_config.public_url.
// Секретный путь остаётся в URL и проверяется уже приложением.
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 });
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'public_url')
    .maybeSingle();
  const target = data?.value;
  // Приложение выключено: отвечаем не-200, чтобы CryptoBot повторил позже.
  if (!target) return new Response('offline', { status: 503 });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/cryptopay/, '');
  const body = await req.text();
  try {
    const res = await fetch(target.replace(/\/$/, '') + '/api/cryptopay/webhook' + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'crypto-pay-api-signature': req.headers.get('crypto-pay-api-signature') ?? '',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(await res.text(), { status: res.status });
  } catch {
    return new Response('upstream failed', { status: 502 });
  }
});
