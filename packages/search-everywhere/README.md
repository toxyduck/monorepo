# Search Everywhere — частичная реализация

Поиск файлов, символов и текста для Fresh 0.5.2: слева dock-панель, справа файловый редактор. Для значков нужен Nerd Font.

<!-- demo-video:start -->
[![Работа плагина](assets/demo.gif)](assets/demo.mp4)

GIF воспроизводится в README; нажмите для MP4. Native PTY автотеста: fake Kotlin LSP и тестовые file/content providers.
<!-- demo-video:end -->

## Установка и запуск

Используйте отдельную HOME/XDG-конфигурацию. Из каталога пакета скопируйте `search_everywhere.ts` и все `lib/*.ts` в `${XDG_CONFIG_HOME:-$HOME/.config}/fresh/plugins`, сохранив каталог `lib/`.
Перед копированием проверьте каждый целевой путь: при наличии файла **остановитесь**, не перезаписывайте его. Установка не настраивает LSP.
Перезапустите Fresh.

Команда **Search Everywhere** доступна через palette. Для `Alt+s` добавьте запись в существующий массив `keybindings` в `config.json`, не заменяя остальные bindings:

```json
{ "key": "s", "modifiers": ["alt"], "action": "search_everywhere_open" }
```

Введите запрос, выберите результат стрелками, откройте Enter; Esc закрывает панель.
В Grep Enter запускает поиск. Затем верните фокус к запросу (`Shift+Tab` от переключателя), выберите результат и нажмите Enter. Сам переключатель поиск не запускает.

## Providers

**Файлы и grep требуют внешних providers:** default filename backend отсутствует, builtin rg отключён. Обхода дерева и индекса нет.
В `init.ts` после загрузки плагина получите API; отсутствие API считайте ошибкой:

```ts
const api = getEditor().getPluginApi("search-everywhere");
```

Подключите свой backend через `api.registerProvider({name, kind, search})`: `kind` — `"files"`, `"symbols"` или `"grep"`; `search(query, ctx)` возвращает Promise массива результатов. Backend сам ограничивает вывод и отменяет работу.
Результат: `{kind: "file" | "symbol" | "content", path, name, line?, col?}`. Путь — внутри `ctx.root`; для symbol/content обе координаты обязательны, с 1, колонка UTF-16.
Языки LSP задаются явно: `api.configure({symbolLanguages: ["kotlin"]})`; `[]` отключает builtin symbols. Grep provider определяет семантику запроса, включая regex.

## Ограничения

- Нужен свободный shared dock; чужая панель сохраняется. Dirty preview не закрывается принудительно; открытие координат в dirty buffer блокируется.
- Saved locations проверяются в первых 64 KiB: дальние позиции отмечаются как incomplete. Проверка лексическая, не гарантия saved-only семантики LSP.
- Левые snippets без грамматики; все заголовки — `basename:line`, для file preview строка 1. Справа нативная грамматика; подсветка запроса сохраняет её foreground.
- Auto LSP не реализован; реальный Kotlin server, remote runtime и полная semantic TypeScript-проверка не подтверждены. Acceptance **BLOCKED**.

## Автотест и демо

Нужны установленные Fresh 0.5.2 и Node с `--experimental-strip-types`. Из каталога пакета один раз подготовьте venv; затем повторяйте команду теста. `--smoke-only`: native автотест, GIF/MP4 во временном каталоге, PASS для покрытых регрессий; checkout не меняется.

```sh
python3 -m venv demo-venv
demo-venv/bin/pip install -r tests/requirements-demo.txt
demo-venv/bin/python tests/check.py --smoke-only
demo-venv/bin/python tests/check.py --smoke-only --publish-demo
```

`--publish-demo` обновляет assets `demo.gif`/`demo.mp4` этого репозитория и inline Markdown: они попадут на GitHub с коммитом исходников. Без сервера и credentials; инструмент не делает коммит/push. Демо: fake LSP/custom providers. Шрифты: `DEMO_FONT_REGULAR`, `DEMO_FONT_BOLD`, `DEMO_FONT_ICONS`.
