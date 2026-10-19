# UI integration audits

These tests dispatch events to the shipped JavaScript modules in JSDOM and call a real FastAPI server with an isolated disposable SQLite database. They validate handlers, authentication, CSRF, data persistence and full learning, game and shift flows. They do not replace visual browser or physical-device testing.

```sh
npm ci --prefix tests/ui --ignore-scripts
python tests/ui/run.py
```

Run only the shift audit with `python tests/ui/run.py shifts.mjs`, or the game audit with `python tests/ui/run.py games.mjs`.

The game audit checks all six formats, explanations, mistake review, pause/resume, retry after a lost response, account progress, and separation from exam attempts and theory completion.

The package audit (`python tests/ui/run.py packages.mjs`) checks file preview/import, publication, role assignment, written answers, hidden keys, escaped answer HTML, manual rubrics and an explicit score cap. It also holds the first autosave response while new text, Save and Submit overlap, proving that saves remain serial and the newest answer is submitted.

The assessment editor audit (`python tests/ui/run.py assessment-editor.mjs`) edits a published imported test through its real page: metadata and positions, section/task order and additions/removals, answer variants and key, and written grading criteria. It verifies grouped text undo, abandoned redo branches, focus after structural edits and invalid input, review confirmation (including a draft published from another tab), revisioned save payload and persisted data, employee edit denial, hidden keys, and the unchanged snapshot of an employee attempt started before the edit.

The runner copies the current frontend into a temporary directory and removes all test data afterward. No production credentials or database are used.
