# Tincture Lab: technological cards update, 2026-10-12

Continuation of the existing `tincture-lab-production` site. `main` and BarOS are separate.

## Architecture

The original static ES-module application is retained. `app.js` controls routes/forms and the existing IndexedDB database `tincture-lab-db`, version 1, object store `kv`, state key `state`. Recipes remain in `state.recipes`. Existing IDs, archive flags, custom metadata, stock, requisitions, plans, batches, statistics and settings are preserved. Optional Supabase synchronization uses the existing workspace record.

`recipes.mjs` adds text recognition, ingredient-based classification, normalization, duplicate signatures and process quantity scaling. `imports.mjs` reads JSON, CSV/TSV, TXT and Excel through a local copy of SheetJS CE 0.20.3 (license in vendor). No new backend, paid AI service or recipe storage is introduced.

New recipe fields: nullable yield, process, rawText, unparsedText, ingredientsText, photos, categoryMode, primaryAlcohol, alcoholCandidates and importSignatures. Legacy explicit categories are treated as manual to preserve existing choices. A user can explicitly request automatic sorting. Unknown alcohol bases and multiple alcohols require clarification.

## Validation and preservation

A title is the only required recipe field. A provided yield must be a positive finite number; shelf life is optional or a nonnegative integer. Uncertain text and source are retained. Imported records are previewed before saving. Exact repeats are skipped, including historical source signatures after edits. Metadata conflicts require an explicit update of the existing record and preserve manual category by default. Name-only records remain visible as unfinished cards.

Calculations never infer output from summed ingredients. If yield is missing, the user supplies a temporary base volume. Ingredient quantities and unambiguous mass/volume/piece quantities in the process scale; time, temperature, percentages and uncertain ranges remain unchanged. The original recipe is not mutated.

## Build and checks

The readable files under `tincture-site/` are the source of truth. Retained historical base64 bundles are no longer the build input. Render must not reconstruct app.js or enforce the historical 50789-byte size. Publish `tincture-site` after syntax checks, or run `bash build-tincture.sh` and publish `tincture-public`.

Run `node --test tests/*.test.mjs`. Browser acceptance tests cover the saved workflow and responsive layout. No real Supabase connection or physical iOS/Android device is assumed available; those need environment-specific verification.

## Limits

Recognition handles common text formats and units, with preserved unknowns and manual correction. OCR extraction from scanned photos/PDF is not implemented. Photographs attached to cards are stored with the existing record. JSON imports allow up to 100 MiB, Excel/text up to 10 MiB, maximum 10000 cards per import. Original source files with further unsupported structures remain available for manual conversion.
