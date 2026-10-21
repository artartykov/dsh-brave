# dsh-brave

Провайдер веб-поиска [Brave Search API](https://brave.com/search/api/) для DeepSeek Harness (dsh).

Плагин регистрируется в `ctx.web` как search-провайдер `brave`. Он подменяет встроенный
DeepSeek-поиск и обслуживает встроенный инструмент `web_search`, поэтому модель вызывает
тот же инструмент, что и раньше. Fetch (`web_fetch`) не затрагивается и остаётся `http`.

## Установка

Из GitHub, с фиксацией версии тегом:

```sh
# если dsh установлен глобально
dsh plugin --profile web add github:artartykov/dsh-brave#v0.1.0

# или через npx
npx @deepseek-ai/dsh plugin --profile web add github:artartykov/dsh-brave#v0.1.0
```

Из локальной копии репозитория (для разработки):

```sh
dsh plugin --profile web add link:/path/to/dsh-brave
npx @deepseek-ai/dsh plugin --profile web add link:/path/to/dsh-brave
```

Для обновления повторите `add` с новым тегом (`#vX.Y.Z`).

Bundle-патч (`cordis.patch.yml`) делает две вещи:

- монтирует плагин с id `web-search-brave`;
- выставляет `web.searchProvider: brave`.

Если выключить бандл, поиск вернётся к `deepseek-official`.

## API-ключ

Ключ выдаётся на https://api-dashboard.search.brave.com. Плагин читает его при каждом
поиске, поэтому перезапуск не нужен. Варианты по приоритету:

1. **Литерал `apiKey`** в конфиге плагина. Не рекомендуется: секрет оказывается в конфиге.
2. **Хранилище credentials** `~/.dsh/.credentials.yaml`. Если сервис credentials
   смонтирован, учитывается только оно:
   ```yaml
   BRAVE_API_KEY: BSA...
   ```
3. **Переменная окружения** `BRAVE_API_KEY` у процесса, запускающего `dsh`.

## Настройки

Переопределяются в `~/.dsh/profiles/web/cordis.patch.yml`. Патч по id заменяет конфиг
целиком, поэтому в нём нужно перечислить все поля, которые вы хотите задать:

```yaml
- id: web-search-brave
  name: 'dsh-brave'
  config:
    apiKeyEnv: BRAVE_API_KEY
    country: US
    searchLang: en
```

| Поле | По умолчанию | Значение |
|---|---|---|
| `apiKey` | — | Ключ литералом |
| `apiKeyEnv` | `BRAVE_API_KEY` | Имя credential / переменной окружения |
| `baseURL` | `https://api.search.brave.com/res/v1` | Только https; к нему добавляется `/web/search` |
| `count` | `10` | Максимум результатов на запрос (1–20); `maxResults` инструмента может только уменьшить его |
| `country` | — | Код страны (`US`, `DE`, …) |
| `searchLang` | — | Язык результатов (`en`, `ru`, …) |
| `safesearch` | `moderate` | `off` / `moderate` / `strict` |
| `freshness` | — | `pd`, `pw`, `pm`, `py` или `YYYY-MM-DDtoYYYY-MM-DD` |
| `extraSnippets` | `false` | Дополнительные выдержки (только платные планы) |
| `timeoutMs` | `15000` | Таймаут одной HTTP-попытки |
| `minIntervalMs` | `1100` | Минимальный интервал между запросами (на free-плане 1 запрос/с) |
| `maxRetries` | `2` | Число повторов после HTTP 429 |
| `maxRetryWaitMs` | `5000` | Максимальное ожидание сброса лимита; если ждать дольше, запрос сразу падает с ошибкой |

## Поведение

- Отправляется `GET /web/search` с заголовком `X-Subscription-Token`. Редиректы запрещены,
  поэтому токен не уйдёт на другой хост.
- Каждый результат превращается в `{url, title, snippet, publishedAt}`:
  - HTML-теги и сущности вычищаются;
  - URL дедуплицируются, остаются только http(s);
  - `publishedAt` заполняется, только если `page_age` в формате ISO.
- Если Brave исправил опечатку в запросе, модель получает `content` с исправленным запросом.
- Ошибки возвращаются как `WebError`:

  | Код | Когда |
  |---|---|
  | `WEB_PROVIDER_CREDENTIAL_MISSING` | Ключ не найден |
  | `WEB_PROVIDER_RATE_LIMITED` | Исчерпан лимит или квота |
  | `WEB_ABORTED` | Запрос отменён |
  | `WEB_PROVIDER_ERROR` | Всё остальное; в сообщение попадает `error.detail` от Brave |
