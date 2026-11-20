import * as assert from 'assert';

import { shouldReplacePickerHits } from '../helpers/searchHits.ts';

suite('shouldReplacePickerHits', () => {
  const hit = { path: '/ws/a.ts', root: '/ws' };

  test('true when there are hits, even if still indexing', () => {
    assert.ok(shouldReplacePickerHits([hit], { indexing: true }));
  });

  test('true when an empty snapshot is complete', () => {
    assert.ok(shouldReplacePickerHits([], { indexing: false }));
  });

  test('false for empty in-flight polls', () => {
    assert.ok(!shouldReplacePickerHits([], { indexing: true }));
    assert.ok(!shouldReplacePickerHits([]));
  });
});
