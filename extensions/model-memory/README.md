# Model memory extension

Remembers the last selected model across restarts.

Upstream `/model` only persists on the explicit "set as default" key
(`persist: true`). Plain `Enter`, `/model <name>`, and cycling are
session-only. This extension subscribes to `model_select` (`set` + `cycle`)
and writes `defaultProvider`/`defaultModel` to the global `settings.json`,
so the next `pi` launch boots with the last pick.

- `restore` (startup rehydration) is ignored.
- Writes are atomic (tmp + rename), preserve all other settings keys, and
  never crash the session — failures warn once.
- Missing `settings.json` is created; corrupt JSON is left untouched.
