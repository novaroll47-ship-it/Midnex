// Постоянный адрес приложения, пока оно живёт на ПК за временным туннелем.
//
// Бот и кнопка меню ведут сюда, а функция перенаправляет на тот адрес
// туннеля, который сейчас записан в app_config.public_url (его обновляет
// deploy/run-local.ps1 при каждом запуске). Фрагмент URL с данными Telegram
// (#tgWebAppData=...) браузер при 302 сохраняет сам, если в Location его нет.
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req) => {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'public_url')
    .maybeSingle();

  const target = data?.value;
  if (!target) {
    return new Response('Приложение сейчас выключено.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  // Сохраняем путь и query — на случай глубоких ссылок; фрагмент дойдёт сам.
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/app/, '') || '/';
  return new Response(null, {
    status: 302,
    headers: {
      location: target.replace(/\/$/, '') + path + url.search,
      'cache-control': 'no-store',
    },
  });
});
