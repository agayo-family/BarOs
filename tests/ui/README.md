# UI integration audits

These tests dispatch events to the shipped JavaScript modules in JSDOM and call a real FastAPI server with an isolated disposable SQLite database. They validate handlers, authentication, CSRF, data persistence and full learning / shift flows. They do not replace visual browser or physical-device testing.

```sh
npm ci --prefix tests/ui --ignore-scripts
python tests/ui/run.py
```

Run only the shift audit with `python tests/ui/run.py shifts.mjs`.

The runner copies the current frontend into a temporary directory and removes all test data afterward. No production credentials or database are used.
